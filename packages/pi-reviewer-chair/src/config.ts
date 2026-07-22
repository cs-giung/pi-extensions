import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const CONFIG_RELATIVE_PATH = ".pi/reviewer-chair.yaml";
export const DEFAULT_REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modelSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/\S+$/, "must use provider/model-id format");

const reviewerSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    model: modelSchema,
    thinking: thinkingSchema.default("medium"),
    systemPrompt: z.string().trim().default(""),
    tools: z.array(z.string().trim().min(1)).default([...DEFAULT_REVIEWER_TOOLS]),
  })
  .strict();

const chairSchema = z
  .object({
    model: modelSchema,
    thinking: thinkingSchema.default("high"),
    systemPrompt: z.string().trim().default(""),
    tools: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const reviewerChairConfigSchema = z
  .object({
    reviewers: z.array(reviewerSchema).min(1),
    chair: chairSchema,
    minSuccess: z.number().int().positive(),
    idleTimeoutMs: z.number().int().positive().default(120_000),
    maxDurationMs: z.number().int().positive().default(900_000),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.minSuccess > config.reviewers.length) {
      context.addIssue({
        code: "custom",
        path: ["minSuccess"],
        message: "must not exceed the number of reviewers",
      });
    }
    if (config.maxDurationMs < config.idleTimeoutMs) {
      context.addIssue({
        code: "custom",
        path: ["maxDurationMs"],
        message: "must be greater than or equal to idleTimeoutMs",
      });
    }
  });

export type ReviewerChairConfig = z.infer<typeof reviewerChairConfigSchema>;
export type ReviewerConfig = ReviewerChairConfig["reviewers"][number];
export type ChairConfig = ReviewerChairConfig["chair"];

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export function parseReviewerChairConfig(source: string): ReviewerChairConfig {
  let parsed: unknown;

  try {
    parsed = parse(source);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigurationError(`Invalid YAML: ${message}`, { cause });
  }

  const result = reviewerChairConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Invalid reviewer-chair configuration: ${issues}`);
  }

  return result.data;
}

export async function loadReviewerChairConfig(cwd: string): Promise<ReviewerChairConfig> {
  const path = resolve(cwd, CONFIG_RELATIVE_PATH);

  try {
    return parseReviewerChairConfig(await readFile(path, "utf8"));
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      throw cause;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigurationError(`Could not read ${path}: ${message}`, { cause });
  }
}


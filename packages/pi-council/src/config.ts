import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const CONFIG_RELATIVE_PATH = ".pi/council.yaml";
export const DEFAULT_REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;
// Reviewer sessions disable extensions, so only built-in tools can be selected.
export const COUNCIL_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;
const toolsSchema = z.array(z.enum(COUNCIL_TOOL_NAMES)).refine(
  (tools) => new Set(tools).size === tools.length, "must not contain duplicate tools");
const timeoutSchema = z.number().int().positive().max(2_147_483_647);
const reviewerSchema = z.object({
  name: z.string().trim().min(1).optional(),
  model: z.string().trim().regex(/^[^/\s]+\/\S+$/, "must use provider/model-id format"),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
  systemPrompt: z.string().trim().default(""),
  tools: toolsSchema.default([...DEFAULT_REVIEWER_TOOLS]),
}).strict();

export const councilConfigSchema = z.object({
  reviewers: z.array(reviewerSchema).min(1),
  // The Chair is the main session, so model/thinking/tools are not YAML settings.
  chair: z.object({ systemPrompt: z.string().trim().default("") }).strict().default({ systemPrompt: "" }),
  minSuccess: z.number().int().positive(),
  maxConcurrency: z.number().int().positive().default(4),
  idleTimeoutMs: timeoutSchema.default(120_000),
  maxDurationMs: timeoutSchema.default(900_000),
}).strict().superRefine((config, context) => {
  if (config.minSuccess > config.reviewers.length) context.addIssue({ code: "custom", path: ["minSuccess"],
    message: "must not exceed the number of reviewers" });
  if (config.maxDurationMs < config.idleTimeoutMs) context.addIssue({ code: "custom", path: ["maxDurationMs"],
    message: "must be greater than or equal to idleTimeoutMs" });
});
export type CouncilConfig = z.infer<typeof councilConfigSchema>;
export type ReviewerConfig = CouncilConfig["reviewers"][number];

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ConfigurationError"; }
}
export function parseCouncilConfig(source: string): CouncilConfig {
  let parsed: unknown;
  try { parsed = parse(source); }
  catch (cause) { throw new ConfigurationError(`Invalid YAML: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  const result = councilConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`Invalid council configuration: ${issues}. The Chair uses the main session; chair only accepts systemPrompt.`);
  }
  return result.data;
}
export async function loadCouncilConfig(cwd: string): Promise<CouncilConfig> {
  const path = resolve(cwd, CONFIG_RELATIVE_PATH);
  try { return parseCouncilConfig(await readFile(path, "utf8")); }
  catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError(`Could not read ${path}. Copy .pi/council.example.yaml from pi-council and configure its reviewers.`, { cause });
  }
}

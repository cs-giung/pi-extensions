import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import { z } from "zod";

export const CONFIG_PATH = ".pi/aufheben.yaml";
export const ROLES = ["thesizer", "antithesizer"] as const;
export type Role = typeof ROLES[number];
const tools = z.array(z.enum(["read", "grep", "find", "ls"])).max(4)
  .refine((value) => new Set(value).size === value.length, "Duplicate tools are not allowed");
const roleSchema = z.object({
  model: z.string().trim().regex(/^[^/\s]+\/\S+$/, "Expected provider/model-id"),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("high"),
  systemPrompt: z.string().trim().max(16000).default(""),
  tools: tools.default(["read", "grep", "find", "ls"]),
}).strict();
const timeout = z.number().int().positive().max(2_147_483_647);
export const configSchema = z.object({
  thesizer: roleSchema,
  antithesizer: roleSchema,
  idleTimeoutMs: timeout.default(120000),
  maxDurationMs: timeout.default(900000),
}).strict().refine((value) => value.maxDurationMs >= value.idleTimeoutMs,
  "maxDurationMs must be at least idleTimeoutMs");
export type AufhebenConfig = z.infer<typeof configSchema>;

export function parseConfig(source: string): AufhebenConfig {
  return configSchema.parse(parse(source));
}

export async function loadConfig(cwd: string): Promise<AufhebenConfig> {
  try {
    return parseConfig(await readFile(resolve(cwd, CONFIG_PATH), "utf8"));
  } catch (cause) {
    throw new Error(`Could not load ${CONFIG_PATH}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export function preflight(config: AufhebenConfig, runtime: Pick<ModelRuntime, "getModel" | "getAvailableSnapshot">): void {
  const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  const errors: string[] = [];
  for (const role of ROLES) {
    const name = config[role].model;
    const slash = name.indexOf("/");
    if (!runtime.getModel(name.slice(0, slash), name.slice(slash + 1))) errors.push(`${role}: unknown model ${name}`);
    else if (!available.has(name)) errors.push(`${role}: unavailable model ${name}; check authentication and access`);
  }
  if (errors.length) throw new Error(`Aufheben preflight failed:\n${errors.join("\n")}`);
}

export async function createRoleRuntime(ctx: ExtensionContext, signal: AbortSignal): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ signal, allowModelNetwork: false });
  // Preserve provider definitions registered by other trusted extensions, but never persist credentials.
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (native) runtime.registerNativeProvider(native);
    else if (config) runtime.registerProvider(id, config);
  }
  await runtime.getAvailable(undefined, { signal });
  signal.throwIfAborted();
  return runtime;
}

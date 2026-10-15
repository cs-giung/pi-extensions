import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 15_000;

export interface CodexUsageWindow {
  usedPercent: number;
  resetAt?: number;
  windowSeconds?: number;
}

export interface CodexUsage {
  label: "codex" | "spark";
  authSource?: "Pi openai" | "Pi openai-codex" | "Codex CLI";
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
}

export class CodexAuthUnavailableError extends Error {
  public constructor(
    message = "OpenAI Codex subscription auth is unavailable",
    readonly reason: "missing" | "incompatible_oauth" | "codex_cli_unavailable" | "codex_cli_expired" = "missing",
  ) {
    super(message);
    this.name = "CodexAuthUnavailableError";
  }
}

export class CodexUsageHttpError extends Error {
  readonly retryAfterMs: number;

  constructor(readonly status: number, retryAfter: string | null) {
    super(`Codex usage request failed with HTTP ${status}`);
    this.name = "CodexUsageHttpError";
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
    this.retryAfterMs = Number.isFinite(delay) ? Math.min(2_147_483_647, Math.max(0, delay)) : 0;
  }
}

type Fetch = typeof globalThis.fetch;
type Registry = Pick<ModelRegistry, "getProviderAuth">;

export async function fetchCodexUsage(
  registry: Registry,
  modelId: string,
  fetchImpl: Fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CodexUsage> {
  const { accessToken, accountId, authSource } = await resolveSubscriptionAuth(registry, signal);
  const response = await fetchImpl(CODEX_USAGE_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
    },
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });

  if (!response.ok) {
    throw new CodexUsageHttpError(response.status, response.headers.get("retry-after"));
  }

  const payload: unknown = await response.json();
  return { ...parseCodexUsage(payload, modelId, Date.now()), authSource };
}

async function resolveSubscriptionAuth(
  registry: Registry,
  signal?: AbortSignal,
): Promise<{ accessToken: string; accountId: string; authSource: NonNullable<CodexUsage["authSource"]> }> {
  let incompatibleOAuth = false;
  for (const provider of ["openai", "openai-codex"] as const) {
    signal?.throwIfAborted();
    const auth = await registry.getProviderAuth(provider);
    signal?.throwIfAborted();
    // API keys must never be sent to the ChatGPT subscription endpoint.
    if (auth?.source !== "OAuth") continue;
    const accessToken = auth.auth.apiKey?.trim();
    if (!accessToken) continue;
    try {
      return { accessToken, accountId: extractAccountId(accessToken), authSource: `Pi ${provider}` };
    } catch (error) {
      if (!(error instanceof CodexAuthUnavailableError)) throw error;
      // Pi's new Responses API OAuth tokens have encrypted metadata, not a Codex account ID.
      incompatibleOAuth = true;
    }
  }

  signal?.throwIfAborted();
  const codexAuthPath = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  let contents: string;
  try {
    contents = await readFile(codexAuthPath, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CodexAuthUnavailableError(undefined, "codex_cli_unavailable");
    }
    throw new CodexAuthUnavailableError(undefined, incompatibleOAuth ? "incompatible_oauth" : "missing");
  }
  signal?.throwIfAborted();
  try {
    const root = asRecord(JSON.parse(contents));
    const tokens = asRecord(root?.tokens);
    const accessToken = asString(tokens?.access_token)?.trim();
    if (!accessToken || (root?.auth_mode !== undefined && root.auth_mode !== "chatgpt")) {
      throw new CodexAuthUnavailableError(undefined, "codex_cli_unavailable");
    }
    const { accountId, expiresAt } = parseSubscriptionToken(accessToken);
    if (tokens?.account_id !== undefined && tokens.account_id !== accountId) {
      throw new CodexAuthUnavailableError(undefined, "codex_cli_unavailable");
    }
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      // Never refresh CLI-owned credentials: rotating its refresh token can break the CLI.
      throw new CodexAuthUnavailableError(undefined, "codex_cli_expired");
    }
    return { accessToken, accountId, authSource: "Codex CLI" };
  } catch (error) {
    if (error instanceof CodexAuthUnavailableError && error.reason !== "missing") throw error;
    throw new CodexAuthUnavailableError(undefined, "codex_cli_unavailable");
  }
}

export function extractAccountId(accessToken: string): string {
  return parseSubscriptionToken(accessToken).accountId;
}

function parseSubscriptionToken(accessToken: string): { accountId: string; expiresAt: number | undefined } {
  let claims: Record<string, unknown> | undefined;
  try {
    claims = asRecord(JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")));
  } catch {
    throw new CodexAuthUnavailableError("OpenAI Codex OAuth token is invalid");
  }
  const accountId = asRecord(claims?.[OPENAI_AUTH_CLAIM])?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new CodexAuthUnavailableError("OpenAI Codex OAuth token has no account ID");
  }
  return { accountId, expiresAt: typeof claims?.exp === "number" ? claims.exp * 1000 : undefined };
}

export function parseCodexUsage(payload: unknown, modelId: string, capturedAt: number): CodexUsage {
  const root = asRecord(payload);
  if (!root) throw new Error("Codex usage response was not an object");

  const spark = modelId.toLowerCase().includes("spark");
  const bucket = spark ? findSparkBucket(root.additional_rate_limits) : asRecord(root.rate_limit);
  if (!bucket) throw new Error(`Codex usage response had no ${spark ? "Spark" : "Codex"} quota bucket`);

  const primary = parseWindow(bucket.primary_window, capturedAt);
  const secondary = parseWindow(bucket.secondary_window, capturedAt);
  if (!primary && !secondary) throw new Error("Codex usage response had no quota windows");

  return {
    label: spark ? "spark" : "codex",
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function findSparkBucket(value: unknown): Record<string, unknown> | undefined {
  const limits = Array.isArray(value) ? value : Object.values(asRecord(value) ?? {});
  for (const item of limits) {
    const record = asRecord(item);
    if (!record) continue;
    const identity = `${asString(record.limit_name) ?? ""} ${asString(record.metered_feature) ?? ""}`;
    if (!identity.toLowerCase().includes("spark")) continue;
    const bucket = asRecord(record.rate_limit);
    if (bucket) return bucket;
  }
  return undefined;
}

function parseWindow(value: unknown, capturedAt: number): CodexUsageWindow | undefined {
  const window = asRecord(value);
  if (!window) return undefined;

  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;

  const resetAt = parseResetAt(window, capturedAt);
  const windowSeconds = asNumber(window.limit_window_seconds ?? window.window_seconds);
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(windowSeconds === undefined || windowSeconds <= 0 ? {} : { windowSeconds }),
  };
}

function parseResetAt(window: Record<string, unknown>, capturedAt: number): number | undefined {
  for (const value of [
    window.reset_at,
    window.resets_at,
    window.reset_time,
    window.end_time,
    window.ends_at,
    window.expires_at,
  ]) {
    const timestamp = asTimestamp(value);
    if (timestamp !== undefined) return timestamp;
  }

  const resetAfterSeconds = asNumber(window.reset_after_seconds);
  return resetAfterSeconds === undefined || resetAfterSeconds < 0
    ? undefined
    : capturedAt + resetAfterSeconds * 1000;
}

function asTimestamp(value: unknown): number | undefined {
  const numeric = asNumber(value);
  if (numeric !== undefined) {
    if (numeric <= 0) return undefined;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

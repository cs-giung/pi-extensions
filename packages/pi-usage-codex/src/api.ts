import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const SUBSCRIPTION_PROVIDERS = ["openai-codex", "openai"] as const;
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
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
}

export class CodexAuthUnavailableError extends Error {
  public constructor(message = "OpenAI Codex subscription auth is unavailable") {
    super(message);
    this.name = "CodexAuthUnavailableError";
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
  const { accessToken, accountId } = await resolveSubscriptionAuth(registry, signal);
  const response = await fetchImpl(CODEX_USAGE_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
    },
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });

  if (!response.ok) {
    throw new Error(`Codex usage request failed with HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  return parseCodexUsage(payload, modelId, Date.now());
}

async function resolveSubscriptionAuth(
  registry: Registry,
  signal?: AbortSignal,
): Promise<{ accessToken: string; accountId: string }> {
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    signal?.throwIfAborted();
    const auth = await registry.getProviderAuth(provider);
    signal?.throwIfAborted();
    // The new OpenAI provider also accepts API keys, which must never be sent to ChatGPT.
    if (provider === "openai" && auth?.source !== "OAuth") continue;
    const accessToken = auth?.auth.apiKey?.trim();
    if (!accessToken) continue;
    try {
      return { accessToken, accountId: extractAccountId(accessToken) };
    } catch (error) {
      if (!(error instanceof CodexAuthUnavailableError)) throw error;
    }
  }
  throw new CodexAuthUnavailableError();
}

export function extractAccountId(accessToken: string): string {
  const payloadPart = accessToken.split(".")[1];
  if (!payloadPart) throw new CodexAuthUnavailableError("OpenAI Codex OAuth token is invalid");

  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    const record = asRecord(payload);
    const auth = asRecord(record?.[OPENAI_AUTH_CLAIM]);
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId.trim()) throw new Error("missing account ID");
    return accountId;
  } catch (error) {
    if (error instanceof CodexAuthUnavailableError) throw error;
    throw new CodexAuthUnavailableError("OpenAI Codex OAuth token has no account ID");
  }
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

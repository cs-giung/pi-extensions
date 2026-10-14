import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Monetary account balance in USD, not Coding Plan credits. */
export interface ZaiUsage { balance: number }

export class ZaiAuthUnavailableError extends Error {
  constructor() { super("Z.ai API key is unavailable"); this.name = "ZaiAuthUnavailableError"; }
}

export class ZaiUsageHttpError extends Error {
  readonly retryAfterMs: number;

  constructor(readonly status: number, retryAfter: string | null) {
    super(`Z.ai balance request failed with HTTP ${status}`);
    this.name = "ZaiUsageHttpError";
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
    this.retryAfterMs = Number.isFinite(delay) ? Math.min(2_147_483_647, Math.max(0, delay)) : 0;
  }
}

export async function fetchZaiUsage(
  registry: Pick<ModelRegistry, "getApiKeyForProvider">,
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<ZaiUsage> {
  signal?.throwIfAborted();
  const apiKey = (await registry.getApiKeyForProvider("zai"))?.trim();
  signal?.throwIfAborted();
  if (!apiKey) throw new ZaiAuthUnavailableError();
  const response = await fetchImpl("https://api.z.ai/api/biz/account/query-customer-account-report", {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new ZaiUsageHttpError(response.status, response.headers.get("retry-after"));
  return parseZaiUsage(await response.json());
}

export function parseZaiUsage(payload: unknown): ZaiUsage {
  const root = record(payload);
  const data = record(root?.data);
  if (root?.success !== true || root.code !== 200 || !data) {
    throw new Error("Z.ai balance response had an invalid shape or reported an API error");
  }
  // Prefer spendable balance (after frozen funds); older responses may only have balance.
  // Null/missing values must not be coerced into a fictitious zero-dollar balance.
  const balance = numeric(data.availableBalance) ?? numeric(data.balance);
  if (balance === undefined) throw new Error("Z.ai response contained no monetary balance");
  return { balance };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

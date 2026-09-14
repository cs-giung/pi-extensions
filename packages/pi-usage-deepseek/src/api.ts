import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const REQUEST_TIMEOUT_MS = 15_000;

export interface DeepSeekBalance {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

export interface DeepSeekUsage {
  available: boolean;
  balances: DeepSeekBalance[];
}

export class DeepSeekAuthUnavailableError extends Error {
  public constructor() {
    super("DeepSeek API key is unavailable");
    this.name = "DeepSeekAuthUnavailableError";
  }
}

type Fetch = typeof globalThis.fetch;
type Registry = Pick<ModelRegistry, "getApiKeyForProvider">;

export async function fetchDeepSeekUsage(
  registry: Registry,
  _modelId: string,
  fetchImpl: Fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<DeepSeekUsage> {
  signal?.throwIfAborted();
  const apiKey = (await registry.getApiKeyForProvider(DEEPSEEK_PROVIDER))?.trim();
  signal?.throwIfAborted();
  if (!apiKey) throw new DeepSeekAuthUnavailableError();

  const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek balance request failed with HTTP ${response.status}`);
  }

  return parseDeepSeekUsage(await response.json());
}

export function parseDeepSeekUsage(payload: unknown): DeepSeekUsage {
  const root = asRecord(payload);
  if (!root || typeof root.is_available !== "boolean" || !Array.isArray(root.balance_infos)) {
    throw new Error("DeepSeek balance response had an invalid shape");
  }

  const balances = root.balance_infos.map((value) => {
    const balance = asRecord(value);
    const currency = balance?.currency;
    const total = asNumber(balance?.total_balance);
    const granted = asNumber(balance?.granted_balance);
    const toppedUp = asNumber(balance?.topped_up_balance);
    if (typeof currency !== "string" || !currency.trim() || total === undefined || granted === undefined || toppedUp === undefined) {
      throw new Error("DeepSeek balance response contained an invalid balance");
    }
    return {
      currency: currency.trim().toUpperCase(),
      total,
      granted,
      toppedUp,
    };
  });

  return { available: root.is_available, balances };
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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fetchZaiUsage, parseZaiUsage, ZaiAuthUnavailableError } from "../src/api.js";
import { formatZaiStatus } from "../src/format.js";

const theme = { fg: (_color: string, text: string) => text } as ExtensionContext["ui"]["theme"];
const payload = { success: true, code: 200, data: {
  balance: 12.345, availableBalance: 10.345, frozenBalance: 2, rechargeAmount: 20, giveAmount: 0,
} };

describe("Z.ai API", () => {
  it("fetches the monetary account report with Pi credentials", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(payload)));
    const usage = await fetchZaiUsage({ getApiKeyForProvider: vi.fn(async () => "key") }, request);
    expect(request).toHaveBeenCalledWith("https://api.z.ai/api/biz/account/query-customer-account-report", expect.objectContaining({
      headers: { accept: "application/json", authorization: "Bearer key" },
      signal: expect.any(AbortSignal),
    }));
    expect(usage.balance).toBe(10.345);
    expect(formatZaiStatus(usage, theme)).toBe("zai $10.35");
  });

  it("does not fetch without credentials", async () => {
    const request = vi.fn();
    await expect(fetchZaiUsage({ getApiKeyForProvider: vi.fn(async () => undefined) }, request))
      .rejects.toBeInstanceOf(ZaiAuthUnavailableError);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([{}, { success: false, code: 200, data: payload.data },
    { success: true, code: 500, data: payload.data },
    ...[{}, { availableBalance: null }, { balance: "" }, { balance: false },
      { balance: Infinity }, { balance: "not a number" }, { limits: [] }]
      .map((data) => ({ success: true, code: 200, data })),
  ])("rejects invalid or unavailable balances rather than inventing money", (value) => {
    expect(() => parseZaiUsage(value)).toThrow();
  });

  it.each([
    [{ availableBalance: "0", balance: "5" }, 0, "zai $0.00"],
    [{ availableBalance: null, balance: "2.50" }, 2.5, "zai $2.50"],
    [{ balance: -1.25 }, -1.25, "zai -$1.25"],
  ] as const)("handles zero, fallback and negative balances", (data, balance, text) => {
    const usage = parseZaiUsage({ success: true, code: 200, data });
    expect(usage.balance).toBe(balance);
    expect(formatZaiStatus(usage, theme)).toBe(text);
  });

  it("rejects HTTP errors", async () => {
    await expect(fetchZaiUsage({ getApiKeyForProvider: vi.fn(async () => "key") },
      vi.fn(async () => new Response("", { status: 401 })))).rejects.toThrow(/401/);
  });
});

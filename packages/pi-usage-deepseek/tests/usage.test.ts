import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import deepSeekUsageExtension from "../src/index.js";
import {
  fetchDeepSeekUsage,
  parseDeepSeekUsage,
  type DeepSeekUsage,
} from "../src/api.js";
import { formatDeepSeekStatus } from "../src/format.js";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as ExtensionContext["ui"]["theme"];

describe("pi-usage-deepseek", () => {
  it("uses Pi's provider key and parses numeric balance strings", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: "usd",
        total_balance: "17.35",
        granted_balance: "2.00",
        topped_up_balance: "15.35",
      }],
    }), { status: 200 }));

    const usage = await fetchDeepSeekUsage({
      getApiKeyForProvider: vi.fn(async () => "secret-key"),
    }, "deepseek-v4-pro", request as typeof fetch);

    expect(request).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer secret-key" }),
      }),
    );
    expect(usage).toEqual({
      available: true,
      balances: [{ currency: "USD", total: 17.35, granted: 2, toppedUp: 15.35 }],
    });
  });

  it("prefers USD and formats a compact balance", () => {
    const usage = parseDeepSeekUsage({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "99", granted_balance: "0", topped_up_balance: "99" },
        { currency: "USD", total_balance: "4.25", granted_balance: "1", topped_up_balance: "3.25" },
      ],
    });

    expect(formatDeepSeekStatus(usage, theme)).toBe("deepseek $4.25");
  });

  it("loads on another provider and remains visible when the provider changes", async () => {
    const handlers: Partial<Record<string, Handler>> = {};
    const setStatus = vi.fn();
    const usage: DeepSeekUsage = {
      available: true,
      balances: [{ currency: "USD", total: 17.35, granted: 0, toppedUp: 17.35 }],
    };
    const loadUsage = vi.fn(async () => usage);
    const pi = {
      on: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as ExtensionAPI;
    const model = { provider: "anthropic", id: "test" };
    const ctx = {
      hasUI: true,
      model,
      modelRegistry: {},
      ui: { setStatus, theme },
    } as unknown as ExtensionContext;

    deepSeekUsageExtension(pi, { loadUsage, refreshIntervalMs: 3_600_000 });
    handlers.session_start?.({}, ctx);
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(
      "usage-deepseek",
      "deepseek $17.35",
    ));

    handlers.model_select?.({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("usage-deepseek", "deepseek $17.35");
    handlers.session_shutdown?.({}, ctx);
  });
});

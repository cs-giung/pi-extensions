import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import codexUsageExtension from "../src/index.js";
import {
  extractAccountId,
  fetchCodexUsage,
  parseCodexUsage,
  type CodexUsage,
} from "../src/api.js";
import { formatCodexStatus } from "../src/format.js";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as ExtensionContext["ui"]["theme"];

describe("pi-usage-codex", () => {
  it("uses Pi OAuth auth and selects the regular quota windows", async () => {
    const token = jwtWithAccount("acct-123");
    const request = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 18, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: "36", reset_after_seconds: 3600 },
      },
    }), { status: 200 }));

    const usage = await fetchCodexUsage({
      getProviderAuth: vi.fn(async () => ({ auth: { apiKey: token }, source: "OAuth" })),
    }, "gpt-5.6-sol", request as typeof fetch);

    expect(extractAccountId(token)).toBe("acct-123");
    expect(request).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-123",
        }),
      }),
    );
    expect(usage).toMatchObject({
      label: "codex",
      primary: { usedPercent: 18, windowSeconds: 18_000 },
      secondary: { usedPercent: 36 },
    });
  });

  it("selects Spark's additional bucket and formats compact remaining quota", () => {
    const now = Date.UTC(2026, 6, 22, 0, 0, 0);
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 90 },
      },
      additional_rate_limits: [{
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: {
          primary_window: { used_percent: 9, limit_window_seconds: 18_000 },
          secondary_window: {
            used_percent: 27,
            limit_window_seconds: 604_800,
            reset_at: (now + 2 * 86_400_000 + 3 * 3_600_000) / 1000,
          },
        },
      }],
    }, "gpt-5.3-codex-spark", now);

    expect(formatCodexStatus(usage, theme, now)).toBe("spark 5h 91% · 7d 73% ↺2d3h");
  });

  it("loads on session start and clears when the provider changes", async () => {
    const handlers: Partial<Record<string, Handler>> = {};
    const setStatus = vi.fn();
    const usage: CodexUsage = {
      label: "codex",
      primary: { usedPercent: 20 },
      secondary: { usedPercent: 40 },
    };
    const loadUsage = vi.fn(async () => usage);
    const pi = {
      on: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as ExtensionAPI;
    const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const ctx = {
      hasUI: true,
      model,
      modelRegistry: {},
      ui: { setStatus, theme },
    } as unknown as ExtensionContext;

    codexUsageExtension(pi, { loadUsage, refreshIntervalMs: 3_600_000 });
    handlers.session_start?.({}, ctx);
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(
      "usage-codex",
      "codex 5h 80% · 7d 60%",
    ));

    handlers.model_select?.({ model: { provider: "deepseek", id: "deepseek-v4-pro" } }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("usage-codex", undefined);
    handlers.session_shutdown?.({}, ctx);
  });
});

function jwtWithAccount(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

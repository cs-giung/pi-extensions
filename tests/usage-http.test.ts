import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexUsageHttpError, fetchCodexUsage } from "../packages/pi-usage-codex/src/api.js";
import { DeepSeekUsageHttpError, fetchDeepSeekUsage } from "../packages/pi-usage-deepseek/src/api.js";
import { ZaiUsageHttpError, fetchZaiUsage } from "../packages/pi-usage-zai/src/api.js";

const token = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;
const registry = {
  getApiKeyForProvider: async () => "test-key",
  getProviderAuth: async () => ({ auth: { apiKey: token }, source: "OAuth" }),
};
const providers = [
  { name: "Codex", HttpError: CodexUsageHttpError, run: (request: typeof fetch) => fetchCodexUsage(registry, "codex", request) },
  { name: "DeepSeek", HttpError: DeepSeekUsageHttpError, run: (request: typeof fetch) => fetchDeepSeekUsage(registry, request) },
  { name: "Z.ai", HttpError: ZaiUsageHttpError, run: (request: typeof fetch) => fetchZaiUsage(registry, request) },
];

afterEach(() => vi.useRealTimers());

for (const provider of providers) {
  describe(`${provider.name} HTTP retry metadata`, () => {
    it("preserves HTTP status and Retry-After without storing response bodies", async () => {
      const request = vi.fn(async () => new Response("private upstream response", {
        status: 429, headers: { "retry-after": "60" },
      }));
      await expect(provider.run(request)).rejects.toMatchObject({ status: 429, retryAfterMs: 60_000 });
      await expect(provider.run(request)).rejects.not.toThrow(/private upstream response/);
    });

    it.each([
      [null, 0], ["", 0], ["invalid", 0], ["-5", 0], ["0", 0], ["1.5", 1500],
      ["999999999999", 2_147_483_647],
    ] as const)("handles Retry-After %s safely", (header, expected) => {
      expect(new provider.HttpError(503, header).retryAfterMs).toBe(expected);
    });

    it("supports HTTP-date values and ignores dates in the past", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      expect(new provider.HttpError(429, "Thu, 01 Jan 2026 00:02:00 GMT").retryAfterMs).toBe(120_000);
      expect(new provider.HttpError(429, "Wed, 31 Dec 2025 23:59:00 GMT").retryAfterMs).toBe(0);
    });
  });
}

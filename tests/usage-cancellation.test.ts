import { describe, expect, it, vi } from "vitest";
import { fetchCodexUsage } from "../packages/pi-usage-codex/src/api.js";
import { fetchDeepSeekUsage } from "../packages/pi-usage-deepseek/src/api.js";
import { fetchZaiUsage } from "../packages/pi-usage-zai/src/api.js";

const token = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;
const registry = (getKey: () => Promise<string>) => ({
  getApiKeyForProvider: getKey,
  getProviderAuth: async () => ({ auth: { apiKey: await getKey() }, source: "test" }),
});
type Registry = ReturnType<typeof registry>;
const providers = [
  { name: "Codex", run: (auth: Registry, fetch: typeof globalThis.fetch, signal: AbortSignal) => fetchCodexUsage(auth, "codex", fetch, signal) },
  { name: "DeepSeek", run: (auth: Registry, fetch: typeof globalThis.fetch, signal: AbortSignal) => fetchDeepSeekUsage(auth, "", fetch, signal) },
  { name: "Z.ai", run: (auth: Registry, fetch: typeof globalThis.fetch, signal: AbortSignal) => fetchZaiUsage(auth, fetch, signal) },
];

for (const provider of providers) {
  describe(`${provider.name} cancellation`, () => {
    it("does not resolve credentials or fetch when already cancelled", async () => {
      const getKey = vi.fn(async () => token);
      const fetch = vi.fn();
      await expect(provider.run(registry(getKey), fetch, AbortSignal.abort())).rejects.toThrow();
      expect(getKey).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("does not fetch if cancelled during credential resolution", async () => {
      const controller = new AbortController();
      const getKey = vi.fn(async () => { controller.abort(); return token; });
      const fetch = vi.fn();
      await expect(provider.run(registry(getKey), fetch, controller.signal)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("propagates cancellation into an active HTTP request", async () => {
      const controller = new AbortController();
      let requestStarted!: () => void;
      const started = new Promise<void>((resolve) => { requestStarted = resolve; });
      const fetch = vi.fn((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          requestStarted();
        }));
      const result = provider.run(registry(async () => token), fetch, controller.signal);
      const assertion = expect(result).rejects.toThrow();
      await started;
      controller.abort();
      await assertion;
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });
  });
}

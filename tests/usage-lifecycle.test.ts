import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import zaiExtension from "../packages/pi-usage-zai/src/index.js";
import { ZaiAuthUnavailableError } from "../packages/pi-usage-zai/src/api.js";
import codexExtension from "../packages/pi-usage-codex/src/index.js";
import { CodexAuthUnavailableError } from "../packages/pi-usage-codex/src/api.js";
import deepseekExtension from "../packages/pi-usage-deepseek/src/index.js";
import { DeepSeekAuthUnavailableError } from "../packages/pi-usage-deepseek/src/api.js";

type Handler = (event: never, ctx: ExtensionContext) => void;
const theme = { fg: (_color: string, text: string) => text } as ExtensionContext["ui"]["theme"];
const providers = [
  { key: "usage-zai", extension: zaiExtension, usage: { balance: 10 }, missing: new ZaiAuthUnavailableError() },
  { key: "usage-codex", extension: codexExtension, usage: { label: "codex", primary: { usedPercent: 20 } }, missing: new CodexAuthUnavailableError() },
  { key: "usage-deepseek", extension: deepseekExtension, usage: { available: true, balances: [{ currency: "USD", total: 10, granted: 0, toppedUp: 10 }] }, missing: new DeepSeekAuthUnavailableError() },
] as const;

function createContext(hasUI = true): ExtensionContext {
  return { hasUI, model: { provider: "anthropic", id: "test" }, modelRegistry: {},
    ui: { setStatus: vi.fn(), theme } } as unknown as ExtensionContext;
}

afterEach(() => { vi.useRealTimers(); });

it("shows all three providers together on an unrelated model", async () => {
  vi.useFakeTimers();
  const handlers: Record<string, Handler[]> = {};
  const ctx = createContext();
  const pi = { on: (name: string, handler: Handler) => {
    (handlers[name] ??= []).push(handler);
  } } as unknown as ExtensionAPI;
  for (const provider of providers) {
    provider.extension(pi, { loadUsage: vi.fn().mockResolvedValue(provider.usage) as never });
  }
  for (const handler of handlers.session_start ?? []) handler({} as never, ctx);
  await vi.advanceTimersByTimeAsync(0);
  for (const provider of providers) {
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(provider.key, expect.any(String));
  }
  for (const handler of handlers.session_shutdown ?? []) handler({} as never, ctx);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels regular Codex requests when selecting Spark and restores regular quota on other providers", async () => {
  vi.useFakeTimers();
  const handlers: Record<string, Handler> = {};
  const ctx = createContext();
  let firstSignal: AbortSignal | undefined;
  const load = vi.fn()
    .mockImplementationOnce((_registry, _model, _fetch, signal: AbortSignal) => {
      firstSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    })
    .mockResolvedValueOnce({ label: "spark", primary: { usedPercent: 10 } })
    .mockResolvedValue({ label: "codex", primary: { usedPercent: 20 } });
  codexExtension({ on: (name: string, handler: Handler) => { handlers[name] = handler; } } as unknown as ExtensionAPI,
    { loadUsage: load });
  handlers.session_start?.({} as never, ctx);
  handlers.model_select?.({ model: { provider: "openai-codex", id: "test-spark" } } as never, ctx);
  expect(firstSignal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(load.mock.calls[1]?.[1]).toBe("test-spark");
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("usage-codex", "spark 90%");
  handlers.model_select?.({ model: ctx.model } as never, ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(load.mock.calls[2]?.[1]).toBe("codex");
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("usage-codex", "codex 80%");
  handlers.session_shutdown?.({} as never, ctx);
});

for (const provider of providers) {
  describe(provider.key, () => {
    function setup(loadUsage: ReturnType<typeof vi.fn>, hasUI = true) {
      const handlers: Record<string, Handler> = {};
      const ctx = createContext(hasUI);
      const pi = { on: (name: string, handler: Handler) => { handlers[name] = handler; } } as unknown as ExtensionAPI;
      // Each fixture matches the selected provider's injected loader result.
      provider.extension(pi, { loadUsage: loadUsage as never, refreshIntervalMs: 1000 });
      const emit = (name: string) => handlers[name]?.({} as never, ctx);
      return { ctx, emit };
    }

    it("polls, marks stale data, hides missing auth, and stops on shutdown", async () => {
      vi.useFakeTimers();
      const load = vi.fn().mockResolvedValueOnce(provider.usage)
        .mockRejectedValueOnce(new Error("offline")).mockRejectedValue(provider.missing);
      const { ctx, emit } = setup(load);
      emit("session_start");
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(provider.key, expect.any(String));
      await vi.advanceTimersByTimeAsync(1000);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(provider.key, expect.stringContaining("(stale)"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(provider.key, undefined);
      emit("session_shutdown");
      await vi.advanceTimersByTimeAsync(5000);
      expect(load).toHaveBeenCalledTimes(3);
    });

    it("aborts on shutdown, ignores late results, and deduplicates pending requests", async () => {
      vi.useFakeTimers();
      let resolve!: (value: unknown) => void;
      const load = vi.fn((..._args: unknown[]) => new Promise((done) => { resolve = done; }));
      const { ctx, emit } = setup(load);
      emit("session_start");
      await vi.advanceTimersByTimeAsync(3000);
      expect(load).toHaveBeenCalledTimes(1);
      const signal = load.mock.calls[0]?.at(-1) as AbortSignal;
      expect(signal.aborted).toBe(false);
      emit("session_shutdown");
      expect(signal.aborted).toBe(true);
      resolve(provider.usage);
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(provider.key, undefined);
    });

    it("does no background work without a UI", async () => {
      vi.useFakeTimers();
      const load = vi.fn();
      const { emit } = setup(load, false);
      emit("session_start");
      await vi.advanceTimersByTimeAsync(5000);
      expect(load).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      emit("session_shutdown");
    });
  });
}

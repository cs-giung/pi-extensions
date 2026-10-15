import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zaiExtension from "../packages/pi-usage-zai/src/index.js";
import { ZaiAuthUnavailableError, ZaiUsageHttpError } from "../packages/pi-usage-zai/src/api.js";
import codexExtension from "../packages/pi-usage-codex/src/index.js";
import { CodexAuthUnavailableError, CodexUsageHttpError } from "../packages/pi-usage-codex/src/api.js";
import deepseekExtension from "../packages/pi-usage-deepseek/src/index.js";
import { DeepSeekAuthUnavailableError, DeepSeekUsageHttpError } from "../packages/pi-usage-deepseek/src/api.js";

type Handler = (event: never, ctx: ExtensionContext) => void;
const theme = { fg: (_color: string, text: string) => text } as ExtensionContext["ui"]["theme"];
const providers = [
  { key: "usage-zai", extension: zaiExtension, usage: { balance: 10 }, missing: new ZaiAuthUnavailableError(), httpError: new ZaiUsageHttpError(429, "10") },
  { key: "usage-codex", extension: codexExtension, usage: { label: "codex", primary: { usedPercent: 20 } }, missing: new CodexAuthUnavailableError(), httpError: new CodexUsageHttpError(429, "10") },
  { key: "usage-deepseek", extension: deepseekExtension, usage: { available: true, balances: [{ currency: "USD", total: 10, granted: 0, toppedUp: 10 }] }, missing: new DeepSeekAuthUnavailableError(), httpError: new DeepSeekUsageHttpError(429, "10") },
] as const;

function createContext(hasUI = true): ExtensionContext {
  return { hasUI, model: { provider: "anthropic", id: "test" }, modelRegistry: {},
    ui: { setStatus: vi.fn(), notify: vi.fn(), theme } } as unknown as ExtensionContext;
}

beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("shows all three providers together on an unrelated model", async () => {
  vi.useFakeTimers();
  const handlers: Record<string, Handler[]> = {};
  const ctx = createContext();
  const pi = { registerCommand: vi.fn(), on: (name: string, handler: Handler) => {
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

it("cancels regular Codex requests when selecting OpenAI Spark and restores regular quota on other providers", async () => {
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
  codexExtension({ registerCommand: vi.fn(), on: (name: string, handler: Handler) => { handlers[name] = handler; } } as unknown as ExtensionAPI,
    { loadUsage: load });
  handlers.session_start?.({} as never, ctx);
  handlers.model_select?.({ model: { provider: "openai", id: "test-spark" } } as never, ctx);
  expect(firstSignal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(load.mock.calls[1]?.[1]).toBe("test-spark");
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("usage-codex", "spark 90%");
  handlers.model_select?.({ model: { provider: "anthropic", id: "test-spark" } } as never, ctx);
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
      const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
      const pi = {
        on: (name: string, handler: Handler) => { handlers[name] = handler; },
        registerCommand: (name: string, command: never) => commands.set(name, command),
      } as unknown as ExtensionAPI;
      // Each fixture matches the selected provider's injected loader result.
      provider.extension(pi, { loadUsage: loadUsage as never, refreshIntervalMs: 1000 });
      const emit = (name: string) => handlers[name]?.({} as never, ctx);
      const diagnose = () => commands.get(`${provider.key}-status`)!.handler("", ctx as ExtensionCommandContext);
      return { ctx, emit, diagnose };
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
      await vi.advanceTimersByTimeAsync(2000);
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

    it("backs off exponentially and restores the normal interval after success", async () => {
      vi.useFakeTimers();
      const load = vi.fn().mockRejectedValueOnce(new Error("offline"))
        .mockRejectedValueOnce(new Error("offline")).mockResolvedValue(provider.usage);
      const { emit } = setup(load);
      emit("session_start");
      await vi.advanceTimersByTimeAsync(1999);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3999);
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(load).toHaveBeenCalledTimes(4);
      emit("session_shutdown");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("retains jitter at the backoff ceiling", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      vi.mocked(Math.random).mockReturnValue(0.5);
      const { ctx, emit, diagnose } = setup(vi.fn().mockRejectedValue(new Error("offline")));
      emit("session_start");
      await vi.advanceTimersByTimeAsync(0);
      for (const delay of [1800, 3600, 7200, 14400, 28800, 57600, 115200, 230400, 270000, 270000]) {
        await diagnose();
        expect(ctx.ui.notify).toHaveBeenLastCalledWith(
          expect.stringContaining(`Next refresh: ${new Date(Date.now() + delay).toISOString()}`), "info",
        );
        await vi.advanceTimersByTimeAsync(delay);
      }
      emit("session_shutdown");
    });

    it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid polling interval %s", (interval) => {
      expect(() => provider.extension({} as ExtensionAPI, { refreshIntervalMs: interval })).toThrow(RangeError);
    });

    it("honors Retry-After and exposes only safe diagnostics", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const load = vi.fn().mockRejectedValueOnce(provider.httpError).mockResolvedValue(provider.usage);
      const { ctx, emit, diagnose } = setup(load);
      emit("session_start");
      await vi.advanceTimersByTimeAsync(0);
      await diagnose();
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Last error: HTTP 429"), "info");
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("2026-01-01T00:00:10.000Z"), "info");
      await vi.advanceTimersByTimeAsync(9999);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(2);
      await diagnose();
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Last error: none"), "info");
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Consecutive failures: 0"), "info");
      emit("session_shutdown");
    });

    it("never includes arbitrary credential errors in diagnostics", async () => {
      vi.useFakeTimers();
      const { ctx, emit, diagnose } = setup(vi.fn().mockRejectedValue(new Error("secret-api-key")));
      emit("session_start");
      await vi.advanceTimersByTimeAsync(0);
      await diagnose();
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("credential-resolution failure"), "info");
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("secret-api-key"), expect.anything());
      emit("session_shutdown");
    });

    if (provider.key === "usage-codex") {
      it("explains incompatible OAuth safely and reports the successful fallback source", async () => {
        vi.useFakeTimers();
        const load = vi.fn()
          .mockRejectedValueOnce(new CodexAuthUnavailableError("private-token-value", "incompatible_oauth"))
          .mockResolvedValue({ ...provider.usage, authSource: "Codex CLI" });
        const { ctx, emit, diagnose } = setup(load);
        emit("session_start");
        await vi.advanceTimersByTimeAsync(0);
        await diagnose();
        expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(provider.key, undefined);
        expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Pi openai OAuth has no Codex account ID"), "info");
        expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("private-token-value"), expect.anything());
        await vi.advanceTimersByTimeAsync(1000);
        await diagnose();
        expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Auth source: Codex CLI"), "info");
        expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(provider.key, "codex 80%");
        emit("session_shutdown");
      });
    }

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

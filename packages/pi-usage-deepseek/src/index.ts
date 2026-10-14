import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DeepSeekAuthUnavailableError, DeepSeekUsageHttpError, fetchDeepSeekUsage, type DeepSeekUsage } from "./api.js";
import { formatDeepSeekError, formatDeepSeekStatus } from "./format.js";

export interface DeepSeekUsageExtensionOptions {
  loadUsage?: typeof fetchDeepSeekUsage;
  refreshIntervalMs?: number;
}

export default function deepSeekUsageExtension(pi: ExtensionAPI, options: DeepSeekUsageExtensionOptions = {}): void {
  const loadUsage = options.loadUsage ?? fetchDeepSeekUsage;
  const interval = options.refreshIntervalMs ?? 30_000;
  if (!Number.isInteger(interval) || interval <= 0 || interval > 2_147_483_647) {
    throw new RangeError("refreshIntervalMs must be an integer between 1 and 2147483647");
  }
  let lastSuccess: number | undefined;
  let lastError: string | undefined;
  let nextRefreshAt: number | undefined;
  let failures = 0;
  let retryAfterMs = 0;
  let context: ExtensionContext | undefined;
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let activeRequest: AbortController | undefined;
  let cached: DeepSeekUsage | undefined;
  const key = "usage-deepseek";

  const schedule = (): void => {
    if (!context?.hasUI) return;
    const ceiling = Math.max(interval, 300_000);
    // Apply jitter after capping so repeated failures do not synchronize at the ceiling.
    const backoff = failures === 0 ? interval : Math.max(interval,
      Math.min(ceiling, interval * 2 ** Math.min(failures, 20)) * (1 - Math.random() * 0.2));
    const delay = Math.min(2_147_483_647, Math.max(backoff, retryAfterMs));
    nextRefreshAt = Date.now() + delay;
    timer = setTimeout(() => void refresh(), delay);
    timer.unref();
  };

  pi.registerCommand("usage-deepseek-status", {
    description: "Show DeepSeek balance polling diagnostics without exposing credentials",
    handler: async (_args, ctx) => {
      ctx.ui.notify([
        `DeepSeek polling: ${inFlight ? "request in progress" : context?.hasUI ? "waiting" : "paused"}`,
        `Last success: ${lastSuccess === undefined ? "never" : new Date(lastSuccess).toISOString()}`,
        `Last error: ${lastError ?? "none"}`,
        `Consecutive failures: ${failures}`,
        `Next refresh: ${nextRefreshAt === undefined ? "not scheduled" : new Date(nextRefreshAt).toISOString()}`,
      ].join("\n"), "info");
    },
  });

  const refresh = async (): Promise<void> => {
    const ctx = context;
    if (!ctx?.hasUI || inFlight) return;
    clearTimeout(timer);
    nextRefreshAt = undefined;
    const revision = generation;
    inFlight = true;
    const request = new AbortController();
    activeRequest = request;
    try {
      const usage = await loadUsage(ctx.modelRegistry, "", undefined, request.signal);
      if (revision !== generation || !context) return;
      cached = usage;
      lastSuccess = Date.now();
      lastError = undefined;
      failures = 0;
      retryAfterMs = 0;
      context.ui.setStatus(key, formatDeepSeekStatus(usage, context.ui.theme));
    } catch (error) {
      if (revision !== generation || !context) return;
      if (error instanceof DeepSeekAuthUnavailableError) {
        cached = undefined;
        failures = 0;
        retryAfterMs = 0;
        lastError = "API credentials unavailable.";
        context.ui.setStatus(key, undefined);
      } else {
        failures += 1;
        retryAfterMs = error instanceof DeepSeekUsageHttpError ? error.retryAfterMs : 0;
        // Do not expose arbitrary credential-resolution errors or response bodies.
        lastError = error instanceof DeepSeekUsageHttpError ? `HTTP ${error.status}`
          : error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("DeepSeek balance response"))
            ? "Response parsing failed." : "Network or credential-resolution failure.";
        context.ui.setStatus(key, cached
          ? `${formatDeepSeekStatus(cached, context.ui.theme)} ${context.ui.theme.fg("dim", "(stale)")}`
          : formatDeepSeekError(context.ui.theme));
      }
    } finally {
      activeRequest = undefined;
      inFlight = false;
      if (revision !== generation && context) void refresh();
      else schedule();
    }
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    clearTimeout(timer);
    if (!ctx.hasUI) return;
    void refresh();
  });
  pi.on("model_select", (_event, ctx) => { context = ctx; });
  pi.on("turn_end", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", (_event, ctx) => {
    clearTimeout(timer);
    timer = undefined;
    nextRefreshAt = undefined;
    context = undefined;
    cached = undefined;
    generation += 1;
    activeRequest?.abort();
    if (ctx.hasUI) ctx.ui.setStatus(key, undefined);
  });
}

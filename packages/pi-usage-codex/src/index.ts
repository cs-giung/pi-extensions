import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexAuthUnavailableError, CodexUsageHttpError, fetchCodexUsage, type CodexUsage } from "./api.js";
import { formatCodexError, formatCodexStatus } from "./format.js";

export interface CodexUsageExtensionOptions {
  loadUsage?: typeof fetchCodexUsage;
  refreshIntervalMs?: number;
}

export default function codexUsageExtension(pi: ExtensionAPI, options: CodexUsageExtensionOptions = {}): void {
  const loadUsage = options.loadUsage ?? fetchCodexUsage;
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
  let modelId = "codex";
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let activeRequest: AbortController | undefined;
  let cached: CodexUsage | undefined;
  const key = "usage-codex";

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

  pi.registerCommand("usage-codex-status", {
    description: "Show Codex quota polling diagnostics without exposing credentials",
    handler: async (_args, ctx) => {
      ctx.ui.notify([
        `Codex polling: ${inFlight ? "request in progress" : context?.hasUI ? "waiting" : "paused"}`,
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
      const usage = await loadUsage(ctx.modelRegistry, modelId, undefined, request.signal);
      if (revision !== generation || !context) return;
      cached = usage;
      lastSuccess = Date.now();
      lastError = undefined;
      failures = 0;
      retryAfterMs = 0;
      context.ui.setStatus(key, formatCodexStatus(usage, context.ui.theme));
    } catch (error) {
      if (revision !== generation || !context) return;
      if (error instanceof CodexAuthUnavailableError) {
        cached = undefined;
        failures = 0;
        retryAfterMs = 0;
        lastError = "Subscription credentials unavailable.";
        context.ui.setStatus(key, undefined);
      } else {
        failures += 1;
        retryAfterMs = error instanceof CodexUsageHttpError ? error.retryAfterMs : 0;
        // Do not expose arbitrary credential-resolution errors or response bodies.
        lastError = error instanceof CodexUsageHttpError ? `HTTP ${error.status}`
          : error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Codex usage response"))
            ? "Response parsing failed." : "Network or credential-resolution failure.";
        context.ui.setStatus(key, cached
          ? `${formatCodexStatus(cached, context.ui.theme)} ${context.ui.theme.fg("dim", "(stale)")}`
          : formatCodexError(modelId.includes("spark") ? "spark" : "codex", context.ui.theme));
      }
    } finally {
      activeRequest = undefined;
      inFlight = false;
      if (revision !== generation && context) void refresh();
      else schedule();
    }
  };

  const select = (ctx: ExtensionContext, model = ctx.model): void => {
    context = ctx;
    // Keep the regular subscription visible on every provider; Spark has its own bucket.
    const next = (model?.provider === "openai-codex" || model?.provider === "openai")
      && model.id.toLowerCase().includes("spark")
      ? model.id : "codex";
    if (next !== modelId) {
      modelId = next;
      generation += 1;
      activeRequest?.abort();
      cached = undefined;
      lastSuccess = undefined;
      lastError = undefined;
      failures = 0;
      retryAfterMs = 0;
      clearTimeout(timer);
      nextRefreshAt = undefined;
      if (ctx.hasUI) ctx.ui.setStatus(key, undefined);
      void refresh();
    }
  };
  pi.on("session_start", (_event, ctx) => {
    select(ctx);
    clearTimeout(timer);
    if (!ctx.hasUI) return;
    void refresh();
  });
  pi.on("model_select", (event, ctx) => select(ctx, event.model));
  pi.on("turn_end", (_event, ctx) => select(ctx));
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

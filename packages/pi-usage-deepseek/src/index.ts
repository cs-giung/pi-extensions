import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DeepSeekAuthUnavailableError, fetchDeepSeekUsage, type DeepSeekUsage } from "./api.js";
import { formatDeepSeekError, formatDeepSeekStatus } from "./format.js";

export interface DeepSeekUsageExtensionOptions {
  loadUsage?: typeof fetchDeepSeekUsage;
  refreshIntervalMs?: number;
}

export default function deepSeekUsageExtension(pi: ExtensionAPI, options: DeepSeekUsageExtensionOptions = {}): void {
  const loadUsage = options.loadUsage ?? fetchDeepSeekUsage;
  let context: ExtensionContext | undefined;
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let activeRequest: AbortController | undefined;
  let cached: DeepSeekUsage | undefined;
  const key = "usage-deepseek";

  const refresh = async (): Promise<void> => {
    const ctx = context;
    if (!ctx?.hasUI || inFlight) return;
    const revision = generation;
    inFlight = true;
    const request = new AbortController();
    activeRequest = request;
    try {
      const usage = await loadUsage(ctx.modelRegistry, "", undefined, request.signal);
      if (revision !== generation || !context) return;
      cached = usage;
      context.ui.setStatus(key, formatDeepSeekStatus(usage, context.ui.theme));
    } catch (error) {
      if (revision !== generation || !context) return;
      if (error instanceof DeepSeekAuthUnavailableError) {
        cached = undefined;
        context.ui.setStatus(key, undefined);
      } else {
        context.ui.setStatus(key, cached
          ? `${formatDeepSeekStatus(cached, context.ui.theme)} ${context.ui.theme.fg("dim", "(stale)")}`
          : formatDeepSeekError(context.ui.theme));
      }
    } finally {
      activeRequest = undefined;
      inFlight = false;
      if (revision !== generation && context) void refresh();
    }
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    clearInterval(timer);
    if (!ctx.hasUI) return;
    void refresh();
    timer = setInterval(() => void refresh(), options.refreshIntervalMs ?? 30_000);
    timer.unref();
  });
  pi.on("model_select", (_event, ctx) => { context = ctx; });
  pi.on("turn_end", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", (_event, ctx) => {
    clearInterval(timer);
    timer = undefined;
    context = undefined;
    cached = undefined;
    generation += 1;
    activeRequest?.abort();
    if (ctx.hasUI) ctx.ui.setStatus(key, undefined);
  });
}

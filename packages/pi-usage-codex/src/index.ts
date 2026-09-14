import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexAuthUnavailableError, fetchCodexUsage, type CodexUsage } from "./api.js";
import { formatCodexError, formatCodexStatus } from "./format.js";

export interface CodexUsageExtensionOptions {
  loadUsage?: typeof fetchCodexUsage;
  refreshIntervalMs?: number;
}

export default function codexUsageExtension(pi: ExtensionAPI, options: CodexUsageExtensionOptions = {}): void {
  const loadUsage = options.loadUsage ?? fetchCodexUsage;
  let context: ExtensionContext | undefined;
  let modelId = "codex";
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let activeRequest: AbortController | undefined;
  let cached: CodexUsage | undefined;
  const key = "usage-codex";

  const refresh = async (): Promise<void> => {
    const ctx = context;
    if (!ctx?.hasUI || inFlight) return;
    const revision = generation;
    inFlight = true;
    const request = new AbortController();
    activeRequest = request;
    try {
      const usage = await loadUsage(ctx.modelRegistry, modelId, undefined, request.signal);
      if (revision !== generation || !context) return;
      cached = usage;
      context.ui.setStatus(key, formatCodexStatus(usage, context.ui.theme));
    } catch (error) {
      if (revision !== generation || !context) return;
      if (error instanceof CodexAuthUnavailableError) {
        cached = undefined;
        context.ui.setStatus(key, undefined);
      } else {
        context.ui.setStatus(key, cached
          ? `${formatCodexStatus(cached, context.ui.theme)} ${context.ui.theme.fg("dim", "(stale)")}`
          : formatCodexError(modelId.includes("spark") ? "spark" : "codex", context.ui.theme));
      }
    } finally {
      activeRequest = undefined;
      inFlight = false;
      if (revision !== generation && context) void refresh();
    }
  };

  const select = (ctx: ExtensionContext, model = ctx.model): void => {
    context = ctx;
    // Keep the regular subscription visible on every provider; Spark has its own bucket.
    const next = model?.provider === "openai-codex" && model.id.toLowerCase().includes("spark")
      ? model.id : "codex";
    if (next !== modelId) {
      modelId = next;
      generation += 1;
      activeRequest?.abort();
      cached = undefined;
      if (ctx.hasUI) ctx.ui.setStatus(key, undefined);
      void refresh();
    }
  };
  pi.on("session_start", (_event, ctx) => {
    select(ctx);
    clearInterval(timer);
    if (!ctx.hasUI) return;
    void refresh();
    timer = setInterval(() => void refresh(), options.refreshIntervalMs ?? 30_000);
    timer.unref();
  });
  pi.on("model_select", (event, ctx) => select(ctx, event.model));
  pi.on("turn_end", (_event, ctx) => select(ctx));
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

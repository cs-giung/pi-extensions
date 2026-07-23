import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CodexAuthUnavailableError,
  fetchCodexUsage,
  type CodexUsage,
} from "./api.js";
import {
  formatCodexError,
  formatCodexStatus,
  formatCodexUnavailable,
} from "./format.js";

const PROVIDER = "openai-codex";
const STATUS_KEY = "usage-codex";
const REFRESH_INTERVAL_MS = 30_000;

type Model = NonNullable<ExtensionContext["model"]>;
type UsageLoader = typeof fetchCodexUsage;
type Timer = NodeJS.Timeout;

export interface CodexUsageExtensionOptions {
  loadUsage?: UsageLoader;
  refreshIntervalMs?: number;
}

export default function codexUsageExtension(
  pi: ExtensionAPI,
  options: CodexUsageExtensionOptions = {},
): void {
  const loadUsage = options.loadUsage ?? fetchCodexUsage;
  const refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  let context: ExtensionContext | undefined;
  let activeModel: Model | undefined;
  let revision = 0;
  let timer: Timer | undefined;
  let inFlight: Promise<CodexUsage> | undefined;
  let cached: { modelId: string; usage: CodexUsage } | undefined;

  const clear = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const refresh = async (force = false): Promise<void> => {
    const ctx = context;
    const model = activeModel;
    const requestRevision = revision;
    if (!ctx?.hasUI) return;
    if (model?.provider !== PROVIDER) {
      clear(ctx);
      return;
    }

    if (!force && cached?.modelId === model.id) {
      ctx.ui.setStatus(STATUS_KEY, formatCodexStatus(cached.usage, ctx.ui.theme));
      return;
    }
    if (inFlight) return;

    const request = loadUsage(ctx.modelRegistry, model.id);
    inFlight = request;
    try {
      const usage = await request;
      cached = { modelId: model.id, usage };
      if (context !== ctx || revision !== requestRevision) return;
      ctx.ui.setStatus(STATUS_KEY, formatCodexStatus(usage, ctx.ui.theme));
    } catch (error) {
      if (context !== ctx || revision !== requestRevision) return;
      if (cached?.modelId === model.id) {
        ctx.ui.setStatus(STATUS_KEY, formatCodexStatus(cached.usage, ctx.ui.theme));
      } else if (error instanceof CodexAuthUnavailableError) {
        const label = model.id.toLowerCase().includes("spark") ? "spark" : "codex";
        ctx.ui.setStatus(STATUS_KEY, formatCodexUnavailable(label, ctx.ui.theme));
      } else {
        const label = model.id.toLowerCase().includes("spark") ? "spark" : "codex";
        ctx.ui.setStatus(STATUS_KEY, formatCodexError(label, ctx.ui.theme));
      }
    } finally {
      if (inFlight === request) {
        inFlight = undefined;
        if (revision !== requestRevision && activeModel?.provider === PROVIDER) void refresh(true);
      }
    }
  };

  const selectModel = (ctx: ExtensionContext, model: Model | undefined): void => {
    context = ctx;
    activeModel = model;
    revision += 1;
    if (model?.provider !== PROVIDER) {
      clear(ctx);
      return;
    }
    if (cached?.modelId === model.id) {
      ctx.ui.setStatus(STATUS_KEY, formatCodexStatus(cached.usage, ctx.ui.theme));
    }
    void refresh();
  };

  pi.on("session_start", (_event, ctx) => {
    clearInterval(timer);
    selectModel(ctx, ctx.model);
    timer = setInterval(() => void refresh(true), refreshIntervalMs) as Timer;
    timer.unref?.();
  });

  pi.on("model_select", (event, ctx) => selectModel(ctx, event.model));

  pi.on("turn_end", (_event, ctx) => {
    if (modelKey(activeModel) !== modelKey(ctx.model)) {
      selectModel(ctx, ctx.model);
    } else {
      context = ctx;
      void refresh();
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearInterval(timer);
    timer = undefined;
    context = undefined;
    activeModel = undefined;
    revision += 1;
    clear(ctx);
  });
}

function modelKey(model: Model | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

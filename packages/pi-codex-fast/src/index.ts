import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "pi-codex-fast";
const USAGE_WARNING = "Fast mode can consume subscription limits or credits at a higher rate. Availability and rates depend on your model and plan.";

type FastState = { version: 1; enabled: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Eligibility is deliberately conservative; API-key requests must remain untouched. */
function canRequestFast(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model || !((model.provider === "openai" && model.api === "openai-responses")
    || (model.provider === "openai-codex" && model.api === "openai-codex-responses"))) return false;
  try { return ctx.modelRegistry.isUsingOAuth(model); } catch { return false; }
}

export default function codexFast(pi: ExtensionAPI): void {
  let enabled = false;

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATE_TYPE, enabled ? (canRequestFast(ctx) ? "Fast requested" : "Fast paused") : undefined);
  }

  function restore(ctx: ExtensionContext): void {
    enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const data: unknown = entry.data;
      if (isRecord(data) && data.version === 1 && typeof data.enabled === "boolean") enabled = data.enabled;
    }
    updateStatus(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    enabled = false;
    if (ctx.hasUI) ctx.ui.setStatus(STATE_TYPE, undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    updateStatus(ctx);
    if (!enabled || !canRequestFast(ctx) || !isRecord(event.payload)) return;
    // The hook exposes the selected model, not the physical request's provider.
    // Do not modify payloads routed to a different model by another extension.
    if (event.payload.model !== ctx.model?.id) return;
    // Codex CLI 0.165.0 maps ServiceTier::Fast to the wire value "priority".
    return { ...event.payload, service_tier: "priority" };
  });

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast requests for this session (/fast [on|off|status])",
    getArgumentCompletions: (prefix) => ["on", "off", "status"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }
      if (action !== "status") {
        const next = action === "" ? !enabled : action === "on";
        if (next !== enabled) {
          // Persist first so a failed append cannot leave an unrecorded paid-tier preference.
          pi.appendEntry<FastState>(STATE_TYPE, { version: 1, enabled: next });
          enabled = next;
        }
      }
      updateStatus(ctx);
      if (!enabled) {
        ctx.ui.notify("Fast mode off. This extension leaves request tiers unchanged.", "info");
      } else if (!canRequestFast(ctx)) {
        ctx.ui.notify(`Fast mode enabled but paused: select an OpenAI Responses model with ChatGPT OAuth or a legacy Codex OAuth model. ${USAGE_WARNING}`, "warning");
      } else {
        ctx.ui.notify(`Fast mode requested (service_tier: priority). Server acceptance is not guaranteed. ${USAGE_WARNING}`, "warning");
      }
    },
  });
}

import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { CouncilController, type CouncilOptions } from "./controller.js";
import { formatToolReviews, reviewInputSchema, reviewOutputSchema, safeDisplay, toolSchema } from "./protocol.js";
import { addUsage } from "./usage.js";
export { findLastChairAnswer } from "./state.js";

export default function councilExtension(pi: ExtensionAPI, options: CouncilOptions = {}): void {
  const controller = new CouncilController(pi, options);
  const command = (name: string, description: string, handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>) => {
    pi.registerCommand(name, { description, handler: async (args, ctx) => {
      try { await handler(args, ctx); }
      catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : "Council command failed", "error"); }
    } });
  };
  command("council-cancel", "Cancel owned Council work, including queued Reviewers and main Chair synthesis", (_args, ctx) => controller.cancel(ctx));
  command("council-check", "Validate Reviewer configuration and access without inference; the main model is Chair", (_args, ctx) => controller.check(ctx));
  command("council-reviews", "Show anonymous Reviewer responses from the latest batch on this branch", (_args, ctx) => controller.reviews(ctx));
  command("council-copy", "Copy the latest completed main-session Chair answer on this branch", (_args, ctx) => controller.copy(ctx));
  command("council", "Start fresh independent Reviewers, then synthesize as Chair in this main session", (args, ctx) => controller.start(args, ctx));
  command("council-next", "Run one more review using each Reviewer's own accepted history", (args, ctx) => controller.start(args, ctx, true));

  pi.registerTool({ name: "council_review", label: "Council Reviewers",
    description: "Run the ONE user-authorized independent Reviewer batch and return anonymous evidence to you, the existing main-session Chair. Resolve conversation references into a self-contained brief before calling. Never calls a separate Chair model.",
    parameters: toolSchema(reviewInputSchema), outputSchema: toolSchema(reviewOutputSchema),
    exposure: "model-only", executionMode: "sequential", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    renderResult(result, { expanded }) {
      const parsed = reviewOutputSchema.safeParse(result.structuredContent);
      if (!parsed.success) return new Text(safeDisplay(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")), 0, 0);
      const value = parsed.data;
      return expanded ? new Markdown(formatToolReviews(value), 0, 0, getMarkdownTheme())
        : new Text(safeDisplay(value.error ?? `Council: ${value.anonymousReviews.length} reviews, ${value.failures.length} failures | ${value.phase}${value.replayed ? " | replayed; no inference" : ""}`), 0, 0);
    },
    async execute(_id, input, signal, onUpdate, ctx) {
      const { output, results } = await controller.review(input, ctx, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: { version: 1, results: [] } }));
      const usage = results.reduce((total, entry) => addUsage(total, entry.usage), undefined as Parameters<typeof addUsage>[0]);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output,
        details: { version: 1, runId: output.runId, results }, ...(usage ? { usage } : {}), ...(output.error ? { isError: true } : {}) };
    },
  });
  pi.on("before_agent_start", (event, ctx) => {
    const instructions = controller.beforeTurn(event.messageType === "user" ? event.prompt : "", ctx);
    if (instructions) event.systemPromptOptions.sections.council = instructions;
  });
  pi.on("input", (event) => { if (event.source !== "extension") controller.input(); });
  pi.on("agent_before_settle", (event, ctx) => controller.beforeSettle(event, ctx));
  pi.on("agent_settled", (_event, ctx) => controller.settled(ctx));
  const recover = async (_event: unknown, ctx: ExtensionContext) => {
    try { await controller.recover(ctx); }
    catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : "Could not restore Council state", "error"); }
  };
  pi.on("session_start", recover);
  pi.on("session_tree", recover);
  pi.on("session_shutdown", async (_event, ctx) => { await controller.shutdown(); ctx.ui.setStatus("council", undefined); });
}

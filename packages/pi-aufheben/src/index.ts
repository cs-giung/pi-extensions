import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AufhebenController, type AufhebenOptions } from "./controller.js";
import { registerTools } from "./tools.js";

export default function aufhebenExtension(pi: ExtensionAPI, options: AufhebenOptions = {}): void {
  const controller = new AufhebenController(pi, options);
  const command = (name: string, description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void) => {
    pi.registerCommand(name, { description, handler: async (args, ctx) => {
      try { await handler(args, ctx); }
      catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : "Aufheben command failed", "error"); }
    } });
  };
  command("aufheben", "Start a fresh research exploration with the current model as Synthesizer", (args, ctx) => controller.start(ctx, args));
  command("aufheben-next", "Continue the current exploration, or retry its unfinished stage", (args, ctx) => controller.next(ctx, args));
  command("aufheben-pause", "Cancel owned research work without closing the exploration", (_args, ctx) => controller.pause(ctx));
  command("aufheben-status", "Inspect recorded research state without inference", (_args, ctx) => controller.status(ctx));
  command("aufheben-stop", "Close the current exploration and preserve its history", (_args, ctx) => controller.pause(ctx, true));
  registerTools(pi, controller);

  pi.on("before_agent_start", (event, ctx) => {
    const instructions = controller.beforeTurn("prompt" in event ? event.prompt : "", ctx);
    if (instructions) event.systemPromptOptions.sections.aufheben = instructions;
  });
  pi.on("input", (event) => { if (event.source !== "extension") controller.onUserInput(); });
  pi.on("agent_settled", async (_event, ctx) => controller.settle(ctx));
  pi.on("session_start", async (_event, ctx) => {
    try { await controller.recover(ctx); }
    catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : "Could not recover Aufheben", "error"); }
  });
  pi.on("session_tree", async (_event, ctx) => {
    try { await controller.recover(ctx); }
    catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : "Could not restore this Aufheben branch", "error"); }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await controller.shutdown();
    ctx.ui.setStatus("aufheben", undefined);
  });
}

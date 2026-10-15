import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { aggregate, PERIODS, PERIOD_LABELS, type Period } from "./model.js";
import { UsageScanner } from "./scan.js";
import { textTable } from "./table.js";
import { UsageView } from "./view.js";

export default function usageExtension(pi: ExtensionAPI): void {
  const scanner = new UsageScanner();
  let active = false;
  let view: UsageView | undefined;
  let controller: AbortController | undefined;
  pi.registerCommand("usage", {
    description: "Local usage table by provider/model: /usage [today|week|last-week|30d|all]",
    handler: async (args, ctx) => {
      const period = (args.trim() || "today") as Period;
      if (!PERIODS.includes(period)) { ctx.ui.notify("Usage: /usage [today|week|last-week|30d|all]", "warning"); return; }
      if (active) { ctx.ui.notify("The usage table is already open or still cleaning up.", "warning"); return; }
      active = true;
      const abort = new AbortController(); controller = abort;
      const root = join(getAgentDir(), "sessions");
      const extraFile = ctx.sessionManager.getSessionFile();
      try {
        if (ctx.mode === "tui") {
          await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
            const component = new UsageView({ cwd: ctx.cwd, period, theme, keybindings,
              height: () => tui.terminal.rows, render: () => tui.requestRender(), close: () => done(),
              load: (signal, progress) => scanner.scan({ root, extraFile, signal: AbortSignal.any([signal, abort.signal]), progress }),
            });
            view = component;
            void component.refresh();
            return component;
          });
        } else {
          const snapshot = await scanner.scan({ root, extraFile, signal: abort.signal });
          abort.signal.throwIfAborted();
          const slice = aggregate(snapshot, { period, query: "", hidden: new Set(), cwd: null, sort: "cost" });
          ctx.ui.notify(`Pi Usage — ${PERIOD_LABELS[period]} (all projects)\n${textTable(slice)}\n${snapshot.scanned} files; ${snapshot.issues} data warnings. Tokens include caches. Recorded cost is not an invoice; >= marks unknown costs.`, "info");
        }
      } catch {
        if (!abort.signal.aborted) ctx.ui.notify("Could not read usage history. No session files were changed.", "error");
      } finally {
        abort.abort();
        view?.dispose(); view = undefined;
        if (controller === abort) controller = undefined;
        active = false;
      }
    },
  });
  pi.on("session_shutdown", () => { controller?.abort(); view?.close(); scanner.clear(); });
}

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { StashPicker, type PickerAction } from "./picker.js";
import { DEFAULT_SHORTCUT, parseShortcut, shortcutConflict } from "./shortcut.js";
import { StashStore, type State } from "./store.js";

const HELP = "Usage: /stash [save|clear|shortcut [key]]";

export default function promptStash(pi: ExtensionAPI): void {
  const store = new StashStore(join(getAgentDir(), "prompt-stash.json"));
  let activeShortcut: KeyId = DEFAULT_SHORTCUT;
  // Invalid storage must not prevent /stash from registering and explaining recovery.
  try { activeShortcut = store.read().shortcut; } catch { /* reported on session_start and commands */ }
  let operation: AbortController | undefined;
  let picker: StashPicker | undefined;

  function update(ctx: ExtensionContext, state: State): void {
    if (ctx.mode !== "tui") return;
    const count = state.stashes.length;
    ctx.ui.setWidget("prompt-stash", count ? (_tui, theme) =>
      new Text(theme.fg("accent", `${count} stashed · /stash to restore`), 0, 0) : undefined);
  }
  function report(ctx: ExtensionContext, error: unknown): void {
    ctx.ui.notify(error instanceof Error ? error.message : "Could not access prompt stash. Editor text was not changed.", "error");
  }
  function save(ctx: ExtensionContext): void {
    const text = ctx.ui.getEditorText();
    if (!text.trim()) { ctx.ui.notify("Nothing to stash. Editor is empty.", "info"); return; }
    const { state, result } = store.save(text);
    // No await between reading the editor, committing the file, and clearing it.
    ctx.ui.setEditorText(""); update(ctx, state);
    ctx.ui.notify(`Stashed prompt #${result.id}`, "info");
  }
  pi.registerShortcut(activeShortcut, {
    description: "Stash current prompt without sending it",
    handler: async (ctx) => {
      if (ctx.mode !== "tui" || operation) return;
      try { save(ctx); } catch (error) { report(ctx, error); }
    },
  });
  pi.on("session_start", (_event, ctx) => {
    try { update(ctx, store.read()); } catch (error) { report(ctx, error); }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    operation?.abort(); picker?.close();
    if (ctx.mode === "tui") ctx.ui.setWidget("prompt-stash", undefined);
  });

  pi.registerCommand("stash", {
    description: "Stash/restore editor drafts, clear saved prompts, or configure the shortcut",
    getArgumentCompletions: (prefix) => {
      const items = ["save", "clear", "shortcut"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/stash requires interactive TUI mode. No prompts were changed.", "warning"); return; }
      if (operation) { ctx.ui.notify("Prompt stash is already open.", "warning"); return; }
      const words = args.trim().split(/\s+/); const action = words[0] ?? "";
      if (!["", "save", "clear", "shortcut"].includes(action) || (action !== "shortcut" && words.length > 1)) {
        ctx.ui.notify(HELP, "warning"); return;
      }
      const controller = new AbortController(); operation = controller;
      const { signal } = controller;
      try {
        if (action === "save") { save(ctx); return; }
        let state = store.read(); update(ctx, state);
        if (action === "shortcut") {
          let value = words.slice(1).join("");
          if (!value) {
            const answer = await ctx.ui.input(`Stash shortcut (active: ${activeShortcut}; saved: ${state.shortcut})`, "e.g. alt+s; type the key name", { signal });
            if (answer === undefined || signal.aborted) return;
            value = answer;
          }
          const shortcut = parseShortcut(value);
          if (!shortcut) { ctx.ui.notify("Use a modified key (e.g. alt+s) or F1–F12, not a typing/navigation key.", "warning"); return; }
          const conflict = shortcutConflict(shortcut);
          if (conflict) { ctx.ui.notify(`Shortcut conflicts with Pi action ${conflict}. Choose another key.`, "warning"); return; }
          state = store.setShortcut(shortcut).state; update(ctx, state);
          ctx.ui.notify(`Saved stash shortcut: ${shortcut}. Run /reload to apply; active binding is still ${activeShortcut}.`, "info");
          return;
        }
        if (!state.stashes.length) { ctx.ui.notify(`No stashed prompts. Use ${activeShortcut} or /stash save.`, "info"); return; }
        if (action === "clear") {
          const ids = state.stashes.map((entry) => entry.id);
          if (!(await ctx.ui.confirm("Clear prompt stash?", `Delete ${ids.length} saved prompts? This cannot be undone.`, { signal })) || signal.aborted) return;
          const cleared = store.remove(ids); update(ctx, cleared.state);
          ctx.ui.notify(`Deleted ${cleared.result} saved prompt(s).`, "info");
          return;
        }
        while (!signal.aborted && state.stashes.length) {
          const selected = await ctx.ui.custom<PickerAction>((tui, theme, keybindings, done) => {
            picker = new StashPicker({ stashes: state.stashes, theme, keybindings, done,
              height: () => Math.max(1, Math.min(24, tui.terminal.rows - 2)), render: () => tui.requestRender() });
            return picker;
          }, { overlay: true, overlayOptions: { width: 110, margin: 1 } });
          picker = undefined;
          if (!selected || signal.aborted) return;
          if (selected.type === "restore") {
            const restored = store.restore(selected.id, ctx.ui.getEditorText());
            ctx.ui.setEditorText(restored.result.text); update(ctx, restored.state);
            ctx.ui.notify(`Restored prompt #${selected.id}${restored.result.preserved ? `; previous draft saved as #${restored.result.preserved}` : ""}.`, "info");
            return;
          }
          if (await ctx.ui.confirm("Delete saved prompt?", `Delete prompt #${selected.id}? This cannot be undone.`, { signal })) {
            if (signal.aborted) return;
            update(ctx, store.remove([selected.id]).state);
          }
          if (signal.aborted) return;
          state = store.read(); update(ctx, state);
        }
      } catch (error) { if (!signal.aborted) report(ctx, error); }
      finally { picker = undefined; if (operation === controller) operation = undefined; }
    },
  });
}

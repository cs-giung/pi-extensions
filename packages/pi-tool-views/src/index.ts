import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { parseMode, TOOL_NAMES, ToolViews, VIEW_MODES, type ViewMode } from "./render.js";

const WIDGET_KEY = "pi-tool-views-render-hook";
const STATUS_KEY = "pi-tool-views";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export default function toolViews(pi: ExtensionAPI): void {
  const views = new ToolViews();
  let interactive = false;
  let tui: TUI | undefined;
  let previousEditorFactory: EditorFactory | undefined;
  let editorFactory: EditorFactory | undefined;
  let restoreEditorInput: (() => void) | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  function showMode(ctx: ExtensionContext): void {
    clearTimeout(statusTimer);
    ctx.ui.setStatus(STATUS_KEY, `tools: ${views.mode}`);
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }, 2000);
    statusTimer.unref?.();
  }

  function apply(mode: ViewMode, ctx: ExtensionContext): void {
    views.mode = mode;
    // Clear per-row expansion overrides when selecting a global view.
    ctx.ui.setToolsExpanded(false);
    showMode(ctx);
    tui?.invalidate();
    tui?.requestRender();
  }
  function cycle(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    apply(VIEW_MODES[(VIEW_MODES.indexOf(views.mode) + 1) % VIEW_MODES.length]!, ctx);
  }

  // Presentation only: no registerTool(), factory recreation, execute wrapper,
  // prompt/schema replacement, or cwd-sensitive tool override.
  pi.registerToolRenderer((name, next) => {
    const base = next();
    return interactive && TOOL_NAMES.has(name) && base ? views.wrap(name, base) : base;
  });
  pi.registerCommand("tools", {
    description: "Set or cycle completed tool views: folded | expanded | hidden",
    getArgumentCompletions: (prefix) => VIEW_MODES.filter((mode) => mode.startsWith(prefix.trim().toLowerCase()))
      .map((mode) => ({ value: mode, label: mode })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Tool views require interactive mode.", "warning");
        return;
      }
      if (!args.trim()) { cycle(ctx); return; }
      const mode = parseMode(args);
      if (!mode) { ctx.ui.notify("Usage: /tools [folded|expanded|hidden]", "warning"); return; }
      apply(mode, ctx);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    interactive = true;
    views.mode = parseMode(process.env.PI_TOOL_VIEW_MODE ?? "") ?? "folded";
    previousEditorFactory = ctx.ui.getEditorComponent();
    editorFactory = (ui, theme, keybindings) => {
      restoreEditorInput?.();
      const editor = previousEditorFactory?.(ui, theme, keybindings) ?? new CustomEditor(ui, theme, keybindings);
      // Composed editor factories can be restored after our shutdown.
      if (!interactive) return editor;
      const originalInput = editor.handleInput;
      const handleInput = (data: string): void => {
        // app.tools.expand is reserved, so registerShortcut("ctrl+o") would be
        // skipped. Handle its effective binding only inside the main editor;
        // dialogs, tree filters, and other focused components remain untouched.
        if (interactive && keybindings.matches(data, "app.tools.expand")) {
          cycle(ctx);
          return;
        }
        originalInput.call(editor, data);
      };
      editor.handleInput = handleInput;
      restoreEditorInput = () => {
        if (editor.handleInput === handleInput) editor.handleInput = originalInput;
      };
      return editor;
    };
    ctx.ui.setEditorComponent(editorFactory);
    // Public render handle, with no added editor spacing or transcript rows.
    ctx.ui.setWidget(WIDGET_KEY, (ui) => {
      tui = ui;
      return { render: () => [], invalidate() {} };
    }, { placement: "belowEditor" });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    interactive = false;
    clearTimeout(statusTimer);
    statusTimer = undefined;
    tui = undefined;
    views.clear();
    restoreEditorInput?.();
    restoreEditorInput = undefined;
    if (ctx.mode === "tui") {
      // Do not overwrite an editor another extension installed after ours.
      if (ctx.ui.getEditorComponent() === editorFactory) ctx.ui.setEditorComponent(previousEditorFactory);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}

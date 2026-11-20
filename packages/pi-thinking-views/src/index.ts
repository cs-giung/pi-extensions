import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
export type ThinkingView = "folded" | "expanded" | "hidden";
const STATUS_KEY = "pi-thinking-views";

/** Extend the native thinking toggle; never rewrite reasoning or model settings. */
export default function thinkingViews(pi: ExtensionAPI): void {
  let interactive = false;
  let mode: ThinkingView = "folded";
  let labelOwned = false;
  let previousEditorFactory: EditorFactory | undefined;
  let editorFactory: EditorFactory | undefined;
  let restoreEditorInput: (() => void) | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  function showMode(ctx: ExtensionContext): void {
    clearTimeout(statusTimer);
    ctx.ui.setStatus(STATUS_KEY, `thinking: ${mode}`);
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }, 2000);
    statusTimer.unref?.();
  }

  function nativeFolded(): boolean {
    return pi.getSettings().hideThinkingBlock ?? false;
  }
  function currentMode(): ThinkingView {
    // Respect visibility changes made through Pi's settings between key presses.
    return !nativeFolded() ? "expanded" : mode === "hidden" ? "hidden" : "folded";
  }
  function cycle(nativeInput: () => void, ctx: ExtensionContext): void {
    const current = currentMode();
    const next = current === "folded" ? "expanded" : current === "expanded" ? "hidden" : "folded";
    const shouldFold = next !== "expanded";
    if (nativeFolded() !== shouldFold) {
      // Forward the actual key event through the original editor, so Pi updates
      // both existing/streaming components and the default for future messages.
      // Do not synthesize a key or touch private editor action-handler maps.
      nativeInput();
      if (nativeFolded() !== shouldFold) {
        ctx.ui.notify("The current editor did not toggle thinking visibility.", "warning");
        return;
      }
    }
    mode = next;
    labelOwned = true;
    // An empty native folded label removes the whole thinking run, including
    // its spacer. Resetting with no argument restores Pi's configured default.
    if (mode === "hidden") ctx.ui.setHiddenThinkingLabel("");
    else ctx.ui.setHiddenThinkingLabel();
    showMode(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    interactive = true;
    mode = nativeFolded() ? "folded" : "expanded";
    previousEditorFactory = ctx.ui.getEditorComponent();
    editorFactory = (ui, theme, keybindings) => {
      restoreEditorInput?.();
      const editor = previousEditorFactory?.(ui, theme, keybindings) ?? new CustomEditor(ui, theme, keybindings);
      // Another editor wrapper may restore this factory during shutdown. A
      // dormant factory must not reinstall a handler bound to a retired runtime.
      if (!interactive) return editor;
      const originalInput = editor.handleInput;
      const handleInput = (data: string): void => {
        if (interactive && keybindings.matches(data, "app.thinking.toggle")) {
          cycle(() => originalInput.call(editor, data), ctx);
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
  });
  pi.on("session_shutdown", (_event, ctx) => {
    interactive = false;
    clearTimeout(statusTimer);
    statusTimer = undefined;
    restoreEditorInput?.();
    restoreEditorInput = undefined;
    if (ctx.mode === "tui") {
      if (ctx.ui.getEditorComponent() === editorFactory) ctx.ui.setEditorComponent(previousEditorFactory);
      if (labelOwned) ctx.ui.setHiddenThinkingLabel();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    labelOwned = false;
  });
}

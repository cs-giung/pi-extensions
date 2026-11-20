import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import thinkingViews from "../src/index.js";

const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

function harness(options: { mode?: string; folded?: boolean; binding?: KeyId | KeyId[]; blocked?: boolean } = {}) {
  const mode = options.mode ?? "tui";
  let folded = options.folded ?? true;
  let label = "Thinking...";
  const bindings = new KeybindingsManager({ "app.thinking.toggle": options.binding ?? "ctrl+t" });
  const originalInput = vi.fn((data: string) => {
    if (!options.blocked && bindings.matches(data, "app.thinking.toggle")) folded = !folded;
  });
  const originalEditor = { handleInput: originalInput };
  const previousFactory = vi.fn(() => originalEditor as unknown as ReturnType<EditorFactory>);
  let factory: EditorFactory | undefined = previousFactory;
  let editor: ReturnType<EditorFactory> | undefined;
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const ctx = { mode, ui: {
    getEditorComponent: vi.fn(() => factory),
    setEditorComponent: vi.fn((value: EditorFactory | undefined) => {
      factory = value; editor = factory?.({} as never, {} as never, bindings);
    }),
    setHiddenThinkingLabel: vi.fn((value?: string) => { label = value ?? "Thinking..."; }),
    setStatus: vi.fn(), notify: vi.fn(),
    setWorkingIndicator: vi.fn(), setWorkingVisible: vi.fn(), setToolsExpanded: vi.fn(), onTerminalInput: vi.fn(),
  } } as unknown as ExtensionContext;
  const getSettings = vi.fn(() => ({ hideThinkingBlock: folded }));
  const registerShortcut = vi.fn(); const registerCommand = vi.fn(); const appendEntry = vi.fn(); const setThinkingLevel = vi.fn();
  thinkingViews({
    getSettings, registerShortcut, registerCommand, appendEntry, setThinkingLevel,
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) { events.set(name, handler); },
  } as unknown as ExtensionAPI);
  return { ctx, originalInput, originalEditor, previousFactory, getSettings, registerShortcut, registerCommand, appendEntry, setThinkingLevel,
    event: (name: string) => events.get(name)?.({}, ctx),
    input: (data: string) => editor?.handleInput(data), editor: () => editor,
    folded: () => folded, label: () => label, setNativeFolded: (value: boolean) => { folded = value; } };
}

afterEach(() => vi.useRealTimers());

describe("thinking views", () => {
  it("cycles folded -> expanded -> hidden -> folded and invokes the native action only twice", () => {
    const h = harness(); h.event("session_start");
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
    h.input("\u0014"); expect(h.folded()).toBe(false); expect(h.label()).toBe("Thinking...");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", "thinking: expanded");
    h.input("\u0014"); expect(h.folded()).toBe(true); expect(h.label()).toBe("");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", "thinking: hidden");
    h.input("\u0014"); expect(h.folded()).toBe(true); expect(h.label()).toBe("Thinking...");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", "thinking: folded");
    expect(h.originalInput.mock.calls).toEqual([["\u0014"], ["\u0014"]]);
    expect(h.originalInput.mock.contexts.every((value) => value === h.originalEditor)).toBe(true);
    expect(h.appendEntry).not.toHaveBeenCalled(); expect(h.setThinkingLevel).not.toHaveBeenCalled();
    expect(h.registerShortcut).not.toHaveBeenCalled(); expect(h.registerCommand).not.toHaveBeenCalled();
    expect(h.ctx.ui.setWorkingIndicator).not.toHaveBeenCalled(); expect(h.ctx.ui.setWorkingVisible).not.toHaveBeenCalled();
    expect(h.ctx.ui.setToolsExpanded).not.toHaveBeenCalled(); expect(h.ctx.ui.onTerminalInput).not.toHaveBeenCalled();
    h.event("session_shutdown");
  });

  it("inherits Pi's saved expanded preference instead of changing it on startup", () => {
    const h = harness({ folded: false }); h.event("session_start");
    expect(h.originalInput).not.toHaveBeenCalled(); expect(h.ctx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled();
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
    h.input("\u0014"); expect(h.folded()).toBe(true); expect(h.label()).toBe("");
    h.event("session_shutdown"); expect(h.label()).toBe("Thinking...");
    // Native collapsed preference remains collapsed, just as with Pi's Ctrl+T.
    expect(h.folded()).toBe(true);
  });

  it("uses remapped/disabled bindings and forwards typing and Ctrl+O unchanged", () => {
    const h = harness({ binding: "ctrl+y" }); h.event("session_start");
    h.input("draft"); h.input("\u0014"); h.input("\u000f");
    expect(h.originalInput.mock.calls).toEqual([["draft"], ["\u0014"], ["\u000f"]]);
    h.input("\u0019"); expect(h.folded()).toBe(false);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", "thinking: expanded");
    h.event("session_shutdown");
    const disabled = harness({ binding: [] }); disabled.event("session_start"); disabled.input("\u0014");
    expect(disabled.folded()).toBe(true); expect(disabled.ctx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled();
    disabled.event("session_shutdown");
  });

  it("reads native visibility again after an external settings change", () => {
    const h = harness(); h.event("session_start"); h.setNativeFolded(false);
    h.input("\u0014");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", "thinking: hidden");
    expect(h.folded()).toBe(true); h.event("session_shutdown");
  });

  it("does not claim a mode change when another custom editor blocks the native action", () => {
    const h = harness({ blocked: true }); h.event("session_start"); h.input("\u0014");
    expect(h.folded()).toBe(true); expect(h.ctx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("The current editor did not toggle thinking visibility.", "warning");
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
    h.event("session_shutdown");
  });

  it("shows feedback only for two seconds, refreshes its deadline, and cancels it on shutdown", () => {
    vi.useFakeTimers();
    const h = harness(); h.event("session_start");
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    h.input("\u0014"); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000); h.input("\u0014"); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", "thinking: hidden");
    vi.advanceTimersByTime(1);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", undefined);
    expect(vi.getTimerCount()).toBe(0);
    h.input("\u0014"); h.event("session_shutdown"); expect(vi.getTimerCount()).toBe(0);
    vi.mocked(h.ctx.ui.setStatus).mockClear(); vi.advanceTimersByTime(2000);
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("restores owned input/labels, does not remove later editors, and leaves retired handlers inert", () => {
    const h = harness({ folded: false }); h.event("session_start"); h.input("\u0014");
    const retiredInput = h.editor()!.handleInput;
    const laterFactory = vi.fn(() => h.originalEditor as never);
    h.ctx.ui.setEditorComponent(laterFactory); h.event("session_shutdown");
    expect(h.ctx.ui.getEditorComponent()).toBe(laterFactory);
    expect(h.originalEditor.handleInput).toBe(h.originalInput); expect(h.label()).toBe("Thinking...");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", undefined);
    retiredInput("\u0014"); expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-thinking-views", undefined);
  });

  it("restores a prior editor factory on shutdown and keeps a restored dormant factory passive", () => {
    const h = harness(); h.event("session_start"); const ownedFactory = h.ctx.ui.getEditorComponent()!;
    h.event("session_shutdown");
    expect(h.ctx.ui.setEditorComponent).toHaveBeenLastCalledWith(h.previousFactory);
    const restored = ownedFactory({} as never, {} as never, {} as never);
    expect(restored.handleInput).toBe(h.originalInput);
  });

  it.each(["print", "json", "rpc"])("does not alter settings, editors, or UI in %s mode", (mode) => {
    const h = harness({ mode }); h.event("session_start"); h.event("session_shutdown");
    expect(h.getSettings).not.toHaveBeenCalled(); expect(h.ctx.ui.setEditorComponent).not.toHaveBeenCalled();
    expect(h.ctx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled(); expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});

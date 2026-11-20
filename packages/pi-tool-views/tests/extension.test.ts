import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolRenderers,
  ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import toolViews from "../src/index.js";

const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

function harness(mode = "tui", binding: KeyId = "ctrl+o") {
  let resolver!: ToolRendererResolver;
  let command!: { handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
    getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> };
  type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
  const originalInput = vi.fn();
  const originalEditor = { handleInput: originalInput };
  const previousFactory = vi.fn(() => originalEditor as unknown as ReturnType<EditorFactory>);
  let editorFactory: EditorFactory | undefined = previousFactory;
  let editor: ReturnType<EditorFactory> | undefined;
  const keybindings = new KeybindingsManager({ "app.tools.expand": binding });
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const tui = { invalidate: vi.fn(), requestRender: vi.fn() };
  const ctx = { mode, hasUI: mode === "tui" || mode === "rpc", ui: {
    setWidget: vi.fn((_key, factory) => { if (typeof factory === "function") expect(factory(tui).render(80)).toEqual([]); }),
    setToolsExpanded: vi.fn(), setStatus: vi.fn(), notify: vi.fn(),
    getEditorComponent: vi.fn(() => editorFactory),
    setEditorComponent: vi.fn((factory: EditorFactory | undefined) => {
      editorFactory = factory;
      editor = factory?.(tui as never, {} as never, keybindings);
    }),
    onTerminalInput: vi.fn(),
  } } as unknown as ExtensionCommandContext;
  const registerTool = vi.fn(); const appendEntry = vi.fn();
  const registerShortcut = vi.fn();
  toolViews({
    registerTool, appendEntry,
    registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
    registerShortcut,
    registerCommand: (name: string, value: typeof command) => { expect(name).toBe("tools"); command = value; },
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) => { handlers.set(name, handler); },
  } as unknown as ExtensionAPI);
  return { ctx, tui, registerTool, appendEntry, registerShortcut, originalInput, originalEditor, previousFactory,
    event: (name: string) => handlers.get(name)?.({}, ctx),
    resolve: (name: string, base?: ToolRenderers) => resolver(name, () => base),
    command: (args = "") => command.handler(args, ctx), cycle: () => editor?.handleInput("\u000f"),
    input: (data: string) => editor?.handleInput(data),
    completions: (prefix: string) => command.getArgumentCompletions(prefix),
  };
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("tool view extension", () => {
  it("decorates only built-in rendering after TUI startup, without registering/executing tools", () => {
    const h = harness(); const base: ToolRenderers = {};
    expect(h.resolve("read", base)).toBe(base);
    h.event("session_start");
    expect(h.resolve("read", base)?.renderShell).toBe("self");
    expect(h.resolve("powershell", base)?.renderShell).toBe("self");
    expect(h.resolve("mcp__server__tool", base)).toBe(base);
    expect(h.resolve("custom", base)).toBe(base);
    expect(h.resolve("read")).toBeUndefined();
    expect(h.registerTool).not.toHaveBeenCalled(); expect(h.appendEntry).not.toHaveBeenCalled();
    expect(h.registerShortcut).not.toHaveBeenCalled();
    expect(h.ctx.ui.onTerminalInput).not.toHaveBeenCalled();
    h.event("session_shutdown"); expect(h.resolve("read", base)).toBe(base);
    expect(h.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-tool-views-render-hook", undefined);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", undefined);
    expect(h.ctx.ui.setEditorComponent).toHaveBeenLastCalledWith(h.previousFactory);
    expect(h.originalEditor.handleInput).toBe(h.originalInput);
  });

  it("cycles/rejects/sets modes, resets Ctrl+O overrides, and redraws existing rows", async () => {
    const h = harness(); h.event("session_start");
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
    await h.cycle(); expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: expanded");
    await h.command(); expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: hidden");
    await h.command(); expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: folded");
    await h.command(" EXPANDED "); expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: expanded");
    expect(h.tui.invalidate).toHaveBeenCalledTimes(4); expect(h.tui.requestRender).toHaveBeenCalledTimes(4);
    expect(h.ctx.ui.setToolsExpanded).toHaveBeenCalledWith(false);
    await h.command("bogus"); await h.command("folded extra");
    expect(h.tui.invalidate).toHaveBeenCalledTimes(4);
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /tools [folded|expanded|hidden]", "warning");
    expect(h.completions("exp")).toEqual([{ label: "expanded", value: "expanded" }]);
    h.event("session_shutdown");
  });

  it("uses the effective app.tools.expand binding and delegates other editor input exactly once", () => {
    const h = harness("tui", "ctrl+y"); h.event("session_start");
    h.input("\u000f"); h.input("text");
    expect(h.originalInput.mock.calls).toEqual([["\u000f"], ["text"]]);
    h.input("\u0019");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: expanded");
    h.input("\u0019");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: hidden");
    h.input("\u0019");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: folded");
    expect(h.originalInput).toHaveBeenCalledTimes(2);
    h.event("session_shutdown");
    h.input("\u0019"); expect(h.originalInput).toHaveBeenCalledTimes(3);
  });

  it("shows feedback only for two seconds, refreshes its deadline, and cancels it on shutdown", async () => {
    vi.useFakeTimers();
    const h = harness(); h.event("session_start");
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    h.cycle(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000); await h.command("hidden");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: hidden");
    vi.advanceTimersByTime(1);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", undefined);
    expect(vi.getTimerCount()).toBe(0);
    await h.command("folded"); h.event("session_shutdown");
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(h.ctx.ui.setStatus).mockClear(); vi.advanceTimersByTime(2000);
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("does not remove an editor installed by a later extension on shutdown", () => {
    const h = harness(); h.event("session_start");
    const laterFactory = vi.fn(() => h.originalEditor as never);
    h.ctx.ui.setEditorComponent(laterFactory);
    h.event("session_shutdown");
    expect(h.ctx.ui.getEditorComponent()).toBe(laterFactory);
    expect(h.originalEditor.handleInput).toBe(h.originalInput);
  });

  it("starts from an explicit default without sharing mutable state across instances", () => {
    vi.stubEnv("PI_TOOL_VIEW_MODE", "hidden"); const h = harness(); h.event("session_start");
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
    h.cycle(); expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: folded");
    vi.stubEnv("PI_TOOL_VIEW_MODE", "invalid"); const other = harness(); other.event("session_start");
    expect(other.ctx.ui.setStatus).not.toHaveBeenCalled();
    other.cycle(); expect(other.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tool-views", "tools: expanded");
    h.event("session_shutdown"); other.event("session_shutdown");
  });

  it.each(["print", "json", "rpc"])("does not wrap renderers or mutate tools/UI in %s mode", async (mode) => {
    const h = harness(mode); const base: ToolRenderers = {};
    h.event("session_start"); await h.command("hidden"); await h.cycle();
    expect(h.resolve("read", base)).toBe(base);
    expect(h.ctx.ui.setWidget).not.toHaveBeenCalled(); expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(h.ctx.ui.setToolsExpanded).not.toHaveBeenCalled(); expect(h.tui.invalidate).not.toHaveBeenCalled();
    expect(h.registerTool).not.toHaveBeenCalled(); expect(h.appendEntry).not.toHaveBeenCalled();
    expect(h.ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  });
});

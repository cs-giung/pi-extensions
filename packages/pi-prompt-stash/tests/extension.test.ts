import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import promptStash from "../src/index.js";
import { StashStore } from "../src/store.js";
import type { StashPicker } from "../src/picker.js";

let dir: string; let store: StashStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-stash-extension-")); vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  store = new StashStore(join(dir, "prompt-stash.json"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
function harness() {
  let text = "";
  let command!: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
  let shortcut!: { handler: (ctx: ExtensionContext) => Promise<void> };
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const registerShortcut = vi.fn((_key: string, options: typeof shortcut) => { shortcut = options; });
  const registerCommand = vi.fn((_name: string, options: typeof command) => { command = options; });
  promptStash({ registerShortcut, registerCommand,
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { events.set(event, handler); },
  } as unknown as ExtensionAPI);
  const ctx = { mode: "tui", ui: {
    getEditorText: () => text, setEditorText: vi.fn((value: string) => { text = value; }),
    setWidget: vi.fn(), notify: vi.fn(), custom: vi.fn(), confirm: vi.fn(async () => false), input: vi.fn(),
  } } as unknown as ExtensionCommandContext;
  return { ctx, registerShortcut, registerCommand, event: (name: string) => events.get(name)?.({}, ctx),
    text: () => text, setText: (value: string) => { text = value; },
    command: (args = "") => command.handler(args, ctx), save: () => shortcut.handler(ctx) };
}

describe("standalone prompt stash extension", () => {
  it("registers only a user command and shortcut; restores state after reload/new sessions", async () => {
    const h = harness(); expect(h.registerCommand).toHaveBeenCalledWith("stash", expect.any(Object));
    expect(h.registerShortcut).toHaveBeenCalledWith("ctrl+shift+s", expect.any(Object));
    h.setText("draft\n한글"); await h.save(); expect(h.text()).toBe("");
    expect(store.read().stashes[0]?.text).toBe("draft\n한글");
    h.event("session_start"); expect(h.ctx.ui.setWidget).toHaveBeenLastCalledWith("prompt-stash", expect.any(Function));
    const reloaded = harness(); reloaded.event("session_start");
    expect(reloaded.ctx.ui.setWidget).toHaveBeenLastCalledWith("prompt-stash", expect.any(Function));
    await reloaded.save(); expect(store.read().stashes).toHaveLength(1);
  });
  it("keeps editor and widget unchanged on failed saves and recovers without a reload", async () => {
    writeFileSync(store.file, "not JSON"); const h = harness(); h.event("session_start"); h.setText("do not lose me");
    await h.save(); expect(h.text()).toBe("do not lose me"); expect(h.ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid prompt stash"), "error");
    rmSync(store.file); await h.save(); expect(h.text()).toBe(""); expect(store.read().stashes).toHaveLength(1);
  });
  it("restores without sending a prompt and preserves the existing editor draft", async () => {
    store.save("saved"); const h = harness(); h.setText("unfinished");
    vi.mocked(h.ctx.ui.custom).mockResolvedValue({ type: "restore", id: 1 });
    await h.command(); expect(h.text()).toBe("saved"); expect(store.read().stashes.map((entry) => entry.text)).toEqual(["saved", "unfinished"]);
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("previous draft saved as #2"), "info");
  });
  it("leaves the editor untouched when restore cannot commit", async () => {
    store.save("saved"); const h = harness(); h.setText("unfinished");
    vi.mocked(h.ctx.ui.custom).mockImplementation(async () => {
      writeFileSync(`${store.file}.lock`, ""); return { type: "restore", id: 1 };
    });
    await h.command(); expect(h.text()).toBe("unfinished"); expect(store.read().stashes).toHaveLength(1);
  });
  it("confirms clear, retains concurrently added prompts, and never resets IDs", async () => {
    store.save("a"); const h = harness(); await h.command("clear"); expect(store.read().stashes).toHaveLength(1);
    vi.mocked(h.ctx.ui.confirm).mockImplementation(async () => { store.save("new from other process"); return true; });
    await h.command("clear"); expect(store.read().stashes.map((entry) => entry.text)).toEqual(["new from other process"]);
    expect(store.read().nextId).toBe(3);
  });
  it("confirms deletion, reopens the picker, and hides the widget when empty", async () => {
    store.save("a"); const h = harness(); vi.mocked(h.ctx.ui.custom).mockResolvedValue({ type: "delete", id: 1 });
    vi.mocked(h.ctx.ui.confirm).mockResolvedValue(true); await h.command();
    expect(store.read().stashes).toEqual([]); expect(h.ctx.ui.setWidget).toHaveBeenLastCalledWith("prompt-stash", undefined);
    store.save("b"); vi.mocked(h.ctx.ui.confirm).mockResolvedValue(false);
    vi.mocked(h.ctx.ui.custom).mockResolvedValueOnce({ type: "delete", id: 2 }).mockResolvedValueOnce(undefined);
    await h.command(); expect(store.read().stashes).toHaveLength(1);
  });
  it("changes the shortcut only on reload and rejects typing keys and Pi conflicts", async () => {
    const h = harness(); await h.command("shortcut s"); expect(store.read().shortcut).toBe("ctrl+shift+s");
    await h.command("shortcut ctrl+c"); expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("conflicts"), "warning");
    vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(undefined); await h.command("shortcut");
    vi.mocked(h.ctx.ui.input).mockResolvedValueOnce("alt+s"); await h.command("shortcut");
    expect(store.read().shortcut).toBe("alt+s"); expect(h.registerShortcut).toHaveBeenCalledTimes(1);
    expect(harness().registerShortcut).toHaveBeenCalledWith("alt+s", expect.any(Object));
  });
  it("rejects unknown arguments and guards all non-TUI modes without mutation", async () => {
    const h = harness(); h.setText("draft"); await h.command("wat"); await h.command("clear extra");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage:"), "warning");
    for (const mode of ["rpc", "print", "json"]) {
      Object.assign(h.ctx, { mode }); await h.command("save"); await h.save();
    }
    expect(h.text()).toBe("draft"); expect(store.read().stashes).toEqual([]);
    expect(h.ctx.ui.custom).not.toHaveBeenCalled(); expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it("closes an owned picker on shutdown, blocks reentrant commands, and avoids late restores", async () => {
    store.save("a"); const h = harness(); h.setText("draft"); let view: StashPicker | undefined;
    vi.mocked(h.ctx.ui.custom).mockImplementation((factory) => new Promise((done) => {
      view = factory({ terminal: { rows: 24 }, requestRender: vi.fn() } as never, {} as never, {} as never, done) as StashPicker;
    }));
    const running = h.command(); expect(view).toBeDefined();
    await h.command("clear"); expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Prompt stash is already open.", "warning");
    await h.save(); expect(h.text()).toBe("draft"); h.event("session_shutdown"); await running;
    expect(h.text()).toBe("draft"); expect(store.read().stashes).toHaveLength(1);
    expect(readFileSync(store.file, "utf8")).not.toContain("draft");
  });
  it("cancels pending confirmation on shutdown, with no late deletions", async () => {
    store.save("a"); const h = harness(); let resolve!: (value: boolean) => void;
    vi.mocked(h.ctx.ui.confirm).mockImplementation((_title, _message, options) => {
      expect(options?.signal).toBeDefined(); return new Promise((done) => { resolve = done; });
    });
    const running = h.command("clear"); h.event("session_shutdown"); resolve(true); await running;
    expect(store.read().stashes).toHaveLength(1);
  });
});

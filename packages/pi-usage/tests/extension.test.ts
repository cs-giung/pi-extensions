import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import usageExtension from "../src/index.js";
import { assistant, header, uiKeys, uiTheme } from "./fixtures.js";
import type { UsageView } from "../src/view.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-usage-extension-")); vi.stubEnv("PI_CODING_AGENT_DIR", dir); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
function harness() {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>; let shutdown!: () => void;
  const registerCommand = vi.fn((_name: string, value: { handler: typeof handler }) => { handler = value.handler; });
  usageExtension({ registerCommand, on: (_name: string, callback: () => void) => { shutdown = callback; } } as unknown as ExtensionAPI);
  const ctx = { mode: "print", cwd: "/project", sessionManager: { getSessionFile: () => undefined },
    ui: { notify: vi.fn(), custom: vi.fn() } } as unknown as ExtensionCommandContext;
  return { ctx, registerCommand, command: (args = "all") => handler(args, ctx), shutdown: () => shutdown() };
}
describe("standalone /usage command", () => {
  it("registers only /usage without loading data, calling models, or replacing quota footers", () => {
    const h = harness(); expect(h.registerCommand).toHaveBeenCalledTimes(1);
    expect(h.registerCommand).toHaveBeenCalledWith("usage", expect.any(Object));
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
  });
  it("provides a local text report outside TUI mode and validates periods", async () => {
    await mkdir(join(dir, "sessions"));
    await writeFile(join(dir, "sessions", "test.jsonl"), [header(), assistant()].map((entry) => JSON.stringify(entry)).join("\n"));
    const h = harness(); await h.command();
    expect(h.ctx.ui.custom).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TOTAL (visible slice)"), "info");
    await h.command("unexpected"); expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage: /usage"), "warning");
  });
  it("owns one TUI view and closes it on shutdown without late notifications", async () => {
    const h = harness(); Object.assign(h.ctx, { mode: "tui" });
    let view: UsageView | undefined;
    vi.mocked(h.ctx.ui.custom).mockImplementation((factory) => new Promise<void>((done) => {
      view = factory({ terminal: { rows: 24 }, requestRender: vi.fn() } as never, uiTheme, uiKeys, done as never) as UsageView;
    }) as never);
    const running = h.command(); await vi.waitFor(() => expect(view).toBeDefined());
    await h.command(); expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already open"), "warning");
    h.shutdown(); await running;
    expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Could not read"), "error");
  });
});

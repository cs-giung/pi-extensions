import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadToolDefinition, createBashToolDefinition, createPowerShellToolDefinition, createEditToolDefinition,
  createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  initTheme, ToolExecutionComponent, type ToolRenderers, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callLabel, oneLine, parseMode, resultLabel, ToolViews } from "../src/render.js";

const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-tool-views-")); initTheme("dark"); writeFileSync(join(dir, "file.ts"), "before\n"); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
const ui = { requestRender: vi.fn() } as unknown as TUI;
const result = (text = "first output\nsecond output\n", details: unknown = undefined) => ({
  content: [{ type: "text", text }], details, isError: false, durationMs: 125,
});
function create(name: string, renderers: ToolRenderers, args: unknown = { path: "file.ts", command: "printf hello" }) {
  return new ToolExecutionComponent(name, "call", args, { showImages: false }, renderers, ui, dir);
}
const plain = (component: ToolExecutionComponent, width = 80) => component.render(width).map(stripTerminalSequences).join("\n");
const definitions = () => [createReadToolDefinition(dir), createBashToolDefinition(dir), createPowerShellToolDefinition(dir),
  createEditToolDefinition(dir), createWriteToolDefinition(dir), createGrepToolDefinition(dir), createFindToolDefinition(dir), createLsToolDefinition(dir)].map((definition) => definition as unknown as ToolRenderers & { name: string });

describe("native-compatible tool views", () => {
  it("preserves exact native expanded rendering, padding, backgrounds, and diffs for all eight tools", () => {
    const views = new ToolViews(); views.mode = "expanded";
    for (const base of definitions()) {
      const args = { path: "file.ts", command: "printf hello", pattern: "test", content: "const answer = 42;", edits: [{ oldText: "before", newText: "after" }] };
      const native = create(base.name, base, args);
      const wrapped = create(base.name, views.wrap(base.name, base), args);
      const output = result(undefined, base.name === "edit" ? { diff: "-1 before\n+1 after", firstChangedLine: 1 } : undefined);
      native.setExpanded(true); native.updateResult(output); wrapped.updateResult(output);
      expect(wrapped.render(80), base.name).toEqual(native.render(80));
      views.mode = "folded"; wrapped.invalidate();
      const compact = plain(wrapped);
      expect(compact, base.name).toContain("OK");
      expect(compact, base.name).not.toContain("second output");
      const bgPrefix = themeModule.theme.bg("toolSuccessBg", "MARK").split("MARK")[0];
      expect(bgPrefix).toBeTruthy(); expect(wrapped.render(80).join("\n"), base.name).toContain(bgPrefix);
      views.mode = "expanded"; wrapped.invalidate();
      expect(wrapped.render(80), `${base.name} after folding`).toEqual(native.render(80));
    }
  });

  it("hides completed rows without leaving a shaded empty box, then restores them", () => {
    const views = new ToolViews(); const base = createReadToolDefinition(dir) as unknown as ToolRenderers;
    const component = create("read", views.wrap("read", base)); component.updateResult(result());
    const folded = component.render(80);
    views.mode = "hidden"; component.invalidate(); expect(component.render(80)).toEqual([]);
    component.setExpanded(true); expect(component.render(80)).toEqual([]);
    component.setExpanded(false); views.mode = "folded"; component.invalidate();
    expect(component.render(80)).toEqual(folded);
  });

  it("keeps running output visible in hidden mode and finalizes native clocks", () => {
    vi.useFakeTimers(); const views = new ToolViews(); views.mode = "hidden";
    const component = create("bash", views.wrap("bash", createBashToolDefinition(dir) as unknown as ToolRenderers));
    component.markExecutionStarted(); component.updateResult(result("still working"), true);
    expect(plain(component)).toContain("still working"); expect(vi.getTimerCount()).toBe(1);
    component.updateResult(result("finished"));
    expect(component.render(80)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it("retains error backgrounds and a useful compact error; Ctrl+O expands folded text", () => {
    const views = new ToolViews(); const component = create("bash", views.wrap("bash", createBashToolDefinition(dir) as unknown as ToolRenderers));
    component.updateResult({ ...result("danger detail\nCommand exited with code 7"), isError: true });
    expect(plain(component)).toContain("ERROR exit 7"); expect(plain(component)).not.toContain("danger detail");
    const bgPrefix = themeModule.theme.bg("toolErrorBg", "MARK").split("MARK")[0];
    expect(component.render(80).join("\n")).toContain(bgPrefix);
    component.setExpanded(true); expect(plain(component)).toContain("danger detail");
    component.setExpanded(false); expect(plain(component)).not.toContain("danger detail");
  });

  it("does not feed wrappers or compact summaries back into native lastComponent slots", () => {
    const seenCalls: unknown[] = []; const seenResults: unknown[] = [];
    const nativeCall = new Text("Native call", 0, 0); const nativeResult = new Container(); nativeResult.addChild(new Text("Native result", 0, 0));
    const base: ToolRenderers = {
      renderCall: (_args, _theme, ctx) => { seenCalls.push(ctx.lastComponent); return nativeCall; },
      renderResult: (_result, _options, _theme, ctx) => { seenResults.push(ctx.lastComponent); return nativeResult; },
    };
    const views = new ToolViews(); const component = create("read", views.wrap("read", base));
    component.updateResult(result(), true); component.updateResult(result());
    for (const mode of ["hidden", "expanded", "folded", "expanded"] as const) { views.mode = mode; component.invalidate(); }
    expect(seenCalls[0]).toBeUndefined(); expect(seenCalls.slice(1).every((value) => value === nativeCall)).toBe(true);
    expect(seenResults[0]).toBeUndefined(); expect(seenResults.slice(1).every((value) => value === nativeResult)).toBe(true);
    expect(plain(component)).toContain("Native result");
  });

  it("recovers native write error rendering after an empty partial result", () => {
    const views = new ToolViews(); const component = create("write", views.wrap("write", createWriteToolDefinition(dir) as unknown as ToolRenderers), { path: "file.ts", content: "test" });
    component.updateResult(result(""), true);
    component.updateResult({ ...result("Permission denied"), isError: true });
    expect(plain(component)).toContain("ERROR Permission denied");
    views.mode = "expanded"; component.invalidate(); expect(plain(component)).toContain("Permission denied");
  });

  it("uses the current theme and clips wide/Unicode headers even at zero and one columns", () => {
    const views = new ToolViews(); const component = create("bash", views.wrap("bash", createBashToolDefinition(dir) as unknown as ToolRenderers),
      { command: "echo \uD55C\uAE00 \uD83D\uDE80 e\u0301 " + "long ".repeat(30) });
    component.updateResult(result()); const dark = component.render(80).join("\n");
    initTheme("light"); component.invalidate(); expect(component.render(80).join("\n")).not.toBe(dark);
    for (const width of [0, 1, 2, 10, 24, 80]) {
      component.invalidate(); expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});

describe("compact labels", () => {
  it("validates modes and removes terminal injection/newlines from compact headers", () => {
    expect(parseMode(" EXPANDED ")).toBe("expanded"); expect(parseMode("wat")).toBeUndefined();
    expect(oneLine("\u001b[31mhello\nworld\u001b]0;title\u0007")).toBe("hello world");
    expect(callLabel("read", { path: "file", offset: 1 })).toBe("read file");
    expect(callLabel("ls", {})).toBe("ls .");
    expect(callLabel("find", { pattern: "*.ts", path: "src" })).toBe("find *.ts in src");
    expect(callLabel("grep", { pattern: "test", path: "src" })).toBe("grep test in src");
  });
  it("summarizes edits/images/empty output and keeps truncation warnings discoverable", () => {
    const context = { isError: false, durationMs: 125 };
    const asResult = (value: ReturnType<typeof result>) => value as AgentToolResult;
    expect(resultLabel("edit", asResult(result("", { diff: "--- old\n+++ new\n-1 before\n+1 after" })), context)).toBe("OK +1 -1 · 0.1s");
    expect(resultLabel("read", { content: [{ type: "image", data: "fake", mimeType: "image/png" }], details: undefined }, context)).toContain("1 image");
    expect(resultLabel("bash", asResult(result("", { truncation: { truncated: true }, fullOutputPath: "/tmp/out" })), context))
      .toBe("OK 0 lines · 0.1s · truncated · full output saved");
  });
});

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { StashPicker, displayText } from "../src/picker.js";
import type { Stash } from "../src/store.js";

export const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = { "tui.select.up": "up", "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown", "tui.select.confirm": "enter", "tui.select.cancel": "escape" } as const;
export const keybindings = { matches: (data: string, action: keyof typeof keys) => matchesKey(data, keys[action]) } as Pick<KeybindingsManager, "matches">;
const stashes: Stash[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, timestamp: i, text: `\uD504\uB86C\uD504\uD2B8 ${i + 1} 👩‍💻\n${"\uBCF8\uBB38\n".repeat(40)}` }));
function harness(entries = stashes) {
  let height = 22; const done = vi.fn(); const render = vi.fn();
  const view = new StashPicker({ stashes: entries, theme, keybindings, height: () => height, render, done });
  view.focused = true;
  return { view, done, height: (value: number) => { height = value; } };
}

describe("searchable stash picker", () => {
  it("starts newest first, navigates and restores without modifying supplied entries", () => {
    const h = harness(); h.view.render(100); h.view.handleInput("\x1b[B"); h.view.handleInput("\r");
    expect(h.done).toHaveBeenCalledWith({ type: "restore", id: 19 });
    expect(stashes).toHaveLength(20); expect(stashes[0]?.id).toBe(1);
    h.view.close(); expect(h.done).toHaveBeenCalledTimes(1);
  });
  it("keeps one selection across paging, resize, and preview rendering", () => {
    const h = harness(); h.view.render(100);
    for (let i = 0; i < 20; i++) h.view.handleInput("\x1b[6~");
    const wide = h.view.render(100).join("\n");
    expect(wide).toContain("→ #1 "); expect(wide).toContain("#1 ·"); expect(wide).toContain("20 / 20");
    h.height(5); expect(h.view.render(52).join("\n")).toContain("→ #1 ");
    h.view.handleInput("\x1b[5~"); h.view.handleInput("\r");
    expect(h.done).toHaveBeenCalledWith({ type: "restore", id: 2 });
  });
  it("gives a remapped confirm key precedence over the delete shortcut", () => {
    const done = vi.fn();
    const view = new StashPicker({ stashes, theme, height: () => 22, render: vi.fn(), done,
      keybindings: { matches: (data, action) => action === "tui.select.confirm" ? data === "d" : keybindings.matches(data, action) } });
    view.handleInput("d");
    expect(done).toHaveBeenCalledWith({ type: "restore", id: 20 });
  });
  it("filters full text and treats d as search input rather than delete", () => {
    const h = harness([{ id: 1, text: "a\nneedle", timestamp: 1 }, { id: 2, text: "other", timestamp: 2 }]);
    h.view.handleInput("/"); for (const char of "needle") h.view.handleInput(char);
    expect(h.done).not.toHaveBeenCalled(); expect(h.view.render(80).join("\n")).toContain("needle");
    h.view.handleInput("\r"); h.view.handleInput("\r");
    expect(h.done).toHaveBeenCalledWith({ type: "restore", id: 1 });
  });
  it("does not select or delete when search has no results", () => {
    const h = harness(); h.view.handleInput("/"); h.view.handleInput("zzz"); h.view.handleInput("\r");
    h.view.handleInput("\r"); h.view.handleInput("d");
    expect(h.done).not.toHaveBeenCalled(); expect(h.view.render(80).join("\n")).toContain("No matching prompts");
    h.view.handleInput("\x1b"); expect(h.done).toHaveBeenCalledWith(undefined);
  });
  it("supports delete, cancellation, disposal, and preview scrolling", () => {
    const h = harness(); h.view.render(100); h.view.handleInput("\x1b[C");
    expect(h.view.render(100).join("\n")).toContain("Preview 2/");
    h.view.handleInput("d"); expect(h.done).toHaveBeenCalledWith({ type: "delete", id: 20 });
    const cancelled = harness(); cancelled.view.handleInput("\x03"); expect(cancelled.done).toHaveBeenCalledWith(undefined);
    const disposed = harness(); disposed.view.dispose(); disposed.view.handleInput("d"); expect(disposed.done).not.toHaveBeenCalled();
  });
  it("provides scrollable help without deleting/restoring and returns to the same selection", () => {
    const h = harness(); h.view.handleInput("\x1b[B"); h.view.handleInput("?");
    expect(h.view.render(100).join("\n")).toContain("Stash / Help");
    h.view.handleInput("d"); h.view.handleInput("\r"); expect(h.done).not.toHaveBeenCalled();
    h.height(8);
    for (let i = 0; i < 30; i++) { h.view.render(50); h.view.handleInput("\x1b[B"); }
    expect(h.view.render(50).join("\n")).toContain("Ctrl+C closes");
    h.view.handleInput("\x1b"); expect(h.done).not.toHaveBeenCalled();
    h.view.handleInput("\r"); expect(h.done).toHaveBeenCalledWith({ type: "restore", id: 19 });
  });
  it("keeps selected rows and close hints visible on short terminals", () => {
    const h = harness(); h.height(5); h.view.render(52);
    for (let i = 0; i < 19; i++) h.view.handleInput("\x1b[B");
    const lines = h.view.render(52);
    expect(lines.join("\n")).toContain("→ #1 "); expect(lines.at(-1)).toContain("Esc Close");
    expect(lines).toHaveLength(5);
  });
  it("propagates search focus for IME placement and does not treat ? in a query as help", () => {
    const h = harness(); h.view.handleInput("/"); h.view.handleInput("?");
    expect(h.view.render(80).join("\n")).toContain(CURSOR_MARKER);
    expect(h.view.render(80).join("\n")).not.toContain("Stash / Help");
    h.height(4); expect(h.view.render(40).join("\n")).toContain(CURSOR_MARKER);
    expect(h.view.render(40).at(-1)).toContain("Ctrl+C Close");
    h.view.focused = false; expect(h.view.render(80).join("\n")).not.toContain(CURSOR_MARKER);
  });
  it("uses a one-line list title while keeping the entire multiline preview", () => {
    const h = harness([{ id: 1, timestamp: 1, text: "\nFirst line\nSecond line" }]);
    const lines = h.view.render(100);
    expect(lines.find((line) => line.includes("→ #1"))).not.toContain("Second line");
    expect(lines.join("\n")).toContain("Second line");
    expect(displayText("a\u202eb")).toBe("a�b");
  });
  it("keeps rendered lines bounded after narrow resize, with Unicode and terminal controls", () => {
    const h = harness([{ id: 1, timestamp: 1, text: "\uD55C\uAE00 👩‍💻 é\t\x1b[31mred\x1b]52;c;abc\x07\n".repeat(80) }]);
    for (const height of [24, 12, 6, 1]) for (const width of [120, 86, 60, 20, 5, 2, 0]) {
      h.height(height); h.view.invalidate(); const lines = h.view.render(width);
      expect(lines.length).toBeLessThanOrEqual(height);
      for (const line of lines) { expect(visibleWidth(line)).toBeLessThanOrEqual(width); expect(line.replace(/\x1b\[0m/g, "")).not.toContain("\x1b"); }
    }
    expect(displayText("\r\n\t\x1b\x07")).toBe("\n    ��");
    for (const mode of ["?", "?", "/"]) {
      h.view.handleInput(mode);
      for (const height of [24, 12, 6, 3, 1]) for (const width of [100, 40, 12, 1, 0]) {
        h.height(height); const lines = h.view.render(width);
        expect(lines.length).toBeLessThanOrEqual(height); expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  });
});

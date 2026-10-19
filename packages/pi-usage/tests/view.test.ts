import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { aggregate } from "../src/model.js";
import { safeText, tableLayout, textTable } from "../src/table.js";
import { UsageView } from "../src/view.js";
import { row, snapshot, uiKeys, uiTheme } from "./fixtures.js";

function setup() {
  const data = snapshot([row({ provider: "alpha", model: "one" }), row({ provider: "alpha", model: "two", key: "b", cost: 1 }),
    row({ provider: "beta", model: "three", cwd: "/other", key: "c", cost: 2 })]);
  const options = { cwd: "/project", period: "all" as const, theme: uiTheme, keybindings: uiKeys,
    height: () => 24, render: vi.fn(), close: vi.fn(), load: vi.fn(async (_signal: AbortSignal, _progress: (files: number) => void) => data) };
  const view = new UsageView(options); view.focused = true;
  const text = (width = 120) => view.render(width).join("\n");
  return { view, options, text };
}
describe("table-first interactive usage view", () => {
  it("starts in Table, expands providers and recomputes the filtered total", async () => {
    const h = setup(); await h.view.refresh();
    expect(h.text()).toContain("Usage"); expect(h.text()).toContain("Total"); expect(h.text()).not.toContain("    three");
    h.view.handleInput("\r"); expect(h.text()).toContain("    three");
    h.view.handleInput("/"); h.view.handleInput("two"); expect(h.text()).toContain("alpha"); expect(h.text()).not.toContain("beta");
    h.view.handleInput("\r"); expect(h.text()).toContain("Search: two");
    expect(h.text()).toContain("$1.00"); expect(h.text()).not.toContain("$3.07");
    h.view.handleInput("a"); expect(h.text()).toContain("/ Search"); expect(h.text()).toContain("beta");
  });
  it("supports hiding, project scope, period changes and sorting without inference", async () => {
    const h = setup(); await h.view.refresh(); h.view.handleInput("x");
    expect(h.text()).not.toContain("▸ beta"); expect(h.text()).toContain("1 hidden");
    h.view.handleInput("a"); h.view.handleInput("p"); expect(h.text()).toContain("Project: project"); expect(h.text()).not.toContain("▸ beta");
    h.view.handleInput("p"); h.view.handleInput("s"); expect(h.text()).toContain("Sort: tokens");
    h.view.handleInput("\t"); expect(h.text()).toContain("[Today]");
    expect(h.options.load).toHaveBeenCalledTimes(1);
    h.view.handleInput("r"); await vi.waitFor(() => expect(h.options.load).toHaveBeenCalledTimes(2));
  });
  it.each([0, 1, 8, 20, 40, 70, 100, 160])("fits every line at width %s including Unicode and hostile provider names", async (width) => {
    const h = setup(); h.options.load.mockResolvedValue(snapshot([row({ provider: "模型😀\u001b]52;c;evil\u0007", model: "é".repeat(100) })]));
    await h.view.refresh(); h.view.handleInput("\r");
    const lines = h.view.render(width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("\u001b]52");
    expect(safeText("a\u202eb")).toContain("\\u202e");
  });
  it("keeps a bounded viewport and selected rows reachable", async () => {
    const h = setup(); h.options.load.mockResolvedValue(snapshot(Array.from({ length: 80 }, (_, i) => row({ provider: `provider-${i}`, key: `${i}` }))));
    await h.view.refresh();
    for (let i = 0; i < 50; i++) h.view.handleInput("\u001b[B");
    expect(h.view.render(100).length).toBeLessThanOrEqual(24);
    expect(h.text()).not.toContain("Rows 1-"); expect(h.text()).toContain("/80");
    h.options.height = () => 5; expect(h.view.render(100).length).toBeLessThanOrEqual(5);
  });
  it("closes and aborts its scan, ignores late completion, and does not render after disposal", async () => {
    const h = setup(); let resolve!: (value: ReturnType<typeof snapshot>) => void;
    h.options.load.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const loading = h.view.refresh(); h.view.handleInput("q");
    const calls = h.options.render.mock.calls.length;
    expect(h.options.load.mock.calls[0]![0].aborted).toBe(true);
    expect(h.options.close).toHaveBeenCalledTimes(1); h.view.close(); expect(h.options.close).toHaveBeenCalledTimes(1);
    resolve(snapshot()); await loading; expect(h.options.render).toHaveBeenCalledTimes(calls);
  });
  it("clears a search with Escape before closing the view", async () => {
    const h = setup(); await h.view.refresh(); h.view.handleInput("/"); h.view.handleInput("abc"); h.view.handleInput("\u001b");
    expect(h.options.close).not.toHaveBeenCalled(); expect(h.text()).toContain("/ Search");
    h.view.handleInput("\u001b"); expect(h.options.close).toHaveBeenCalledTimes(1);
  });
  it("shows a summary by default, reveals token details on demand, and retains totals", async () => {
    const h = setup(); await h.view.refresh();
    const initial = h.text(160); expect(initial).not.toContain("Cache R"); expect(initial).toContain("Total");
    h.view.handleInput("d"); expect(h.text(160)).toContain("Cache R"); expect(h.text(160)).toContain("Input");
    expect(h.text(160)).toContain("$3.06"); expect(h.options.load).toHaveBeenCalledTimes(1);
    h.view.handleInput("d"); expect(h.text(160)).not.toContain("Cache R");
    expect(tableLayout(32).header).toContain("Cost USD");
  });
  it("keeps totals, selected rows and an exit hint visible on short terminals", async () => {
    const h = setup(); await h.view.refresh(); h.options.height = () => 5;
    const lines = h.view.render(80);
    expect(lines.join("\n")).toContain("Total"); expect(lines.join("\n")).toContain("→ ▸ beta");
    expect(lines.at(-1)).toContain("Esc Close"); expect(lines).toHaveLength(5);
  });
  it("distinguishes initial loading, errors, empty results, warnings, and stale refreshes", async () => {
    const h = setup(); expect(h.text()).toContain("Scanning local sessions");
    h.options.load.mockRejectedValueOnce(new Error("unreadable")); await h.view.refresh();
    expect(h.text()).toContain("Could not read usage history"); expect(h.text()).toContain("r Retry");
    h.options.load.mockResolvedValueOnce(snapshot([])); await h.view.refresh(); expect(h.text()).toContain("No usage in this view");
    h.options.load.mockResolvedValueOnce({ ...snapshot([row({ unknownCost: 1 })]), issues: 3 }); await h.view.refresh();
    expect(h.text()).toContain("3 data warnings"); expect(h.text()).toContain(">=$0.07");
    h.options.load.mockRejectedValueOnce(new Error("refresh failed")); await h.view.refresh();
    expect(h.text()).toContain("showing previous snapshot"); expect(h.text()).toContain("provider");
    h.options.height = () => 5; expect(h.text()).toContain("Refresh failed");
  });
  it("offers scrollable help and diagnostics without mutating filters or triggering scans", async () => {
    const h = setup(); await h.view.refresh(); h.view.handleInput("?");
    expect(h.text()).toContain("Usage / Help"); h.view.handleInput("x"); h.view.handleInput("r"); h.view.handleInput("d");
    expect(h.options.load).toHaveBeenCalledTimes(1);
    h.options.height = () => 8;
    for (let i = 0; i < 100; i++) { h.view.render(52); h.view.handleInput("\x1b[B"); }
    expect(h.text(52)).toContain("nested reports reconciled");
    h.view.handleInput("\x1b"); expect(h.options.close).not.toHaveBeenCalled();
    h.options.height = () => 24; expect(h.text()).toContain("beta"); expect(h.text(160)).not.toContain("Cache R");
  });
  it("propagates search focus and always shows the active period at intermediate widths", async () => {
    const h = setup(); await h.view.refresh();
    for (const width of [30, 40, 44, 46, 48, 50, 80]) expect(h.text(width)).toMatch(/All time|\[All\]/);
    h.view.handleInput("/"); h.view.handleInput("?");
    expect(h.text()).toContain(CURSOR_MARKER); expect(h.text()).not.toContain("Usage / Help");
    h.options.height = () => 4; expect(h.text(40)).toContain(CURSOR_MARKER);
    expect(h.view.render(40).at(-1)).toContain("Ctrl+C Close");
    h.view.focused = false; expect(h.text()).not.toContain(CURSOR_MARKER);
  });
  it("keeps help, search, and details within resized viewports", async () => {
    const h = setup(); await h.view.refresh();
    for (const mode of ["d", "?", "?", "/"]) {
      h.view.handleInput(mode);
      for (const height of [24, 12, 8, 5, 3, 1]) for (const width of [120, 70, 40, 12, 1, 0]) {
        h.options.height = () => height;
        const lines = h.view.render(width);
        expect(lines.length).toBeLessThanOrEqual(height); expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  });
  it("distinguishes unrecorded cost from zero and renders the text fallback", () => {
    const slice = aggregate(snapshot([row({ unknownCost: 1, cost: 0 })]), { period: "all", query: "", hidden: new Set(), cwd: null, sort: "cost" });
    expect(textTable(slice)).toContain(">=$0.00"); expect(textTable(slice)).toContain("TOTAL (visible slice)");
    expect(tableLayout(120).header).toContain("Cache R"); expect(tableLayout(40).header).not.toContain("Cache R");
  });
});

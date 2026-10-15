import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { aggregate, PERIODS, PERIOD_LABELS, type Filters, type Period, type Slice, type Snapshot, type Sort } from "./model.js";
import { rows, safeText, tableLayout } from "./table.js";

export interface ViewOptions {
  cwd: string; period: Period; theme: Theme; keybindings: Pick<KeybindingsManager, "matches">;
  height: () => number; render: () => void; close: () => void;
  load: (signal: AbortSignal, progress: (files: number) => void) => Promise<Snapshot>;
}
/** One view owns its scan, input focus, selection and cancellation. No process-global UI state. */
export class UsageView implements Component, Focusable {
  private filter: Filters;
  private expanded = new Set<string>();
  private selected = 0;
  private offset = 0;
  private snapshot: Snapshot | undefined;
  private slice: Slice | undefined;
  private sliceKey = "";
  private input = new Input({ prompt: "Filter: ", placeholder: "provider or model" });
  private searching = false;
  private hasFocus = false;
  private controller: AbortController | undefined;
  private closed = false;
  private status = "Loading local session usage...";
  constructor(private readonly options: ViewOptions) {
    this.filter = { period: options.period, query: "", hidden: new Set(), cwd: null, sort: "cost" };
    this.input.onSubmit = () => { this.searching = false; this.input.focused = false; };
    this.input.onEscape = () => { this.searching = false; this.input.focused = false; this.input.setValue(""); };
  }
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.input.focused = value && this.searching; }
  invalidate(): void { this.input.invalidate(); }
  private changed(): void { this.options.render(); }
  async refresh(): Promise<void> {
    if (this.closed || this.controller) return;
    const controller = new AbortController(); this.controller = controller;
    this.status = "Loading local session usage..."; this.options.render();
    try {
      const result = await this.options.load(controller.signal, (files) => {
        if (this.closed || controller.signal.aborted) return;
        this.status = `Scanning local sessions: ${files} files`; this.options.render();
      });
      if (this.closed || controller.signal.aborted) return;
      this.snapshot = result; this.slice = undefined;
      this.status = `${result.scanned} files (${result.cached} cached); ${result.duplicates} copies deduplicated; ${result.reconciled} nested reports reconciled; ${result.issues} data warnings`;
      this.changed();
    } catch {
      if (!this.closed && !controller.signal.aborted) { this.status = "Could not read session usage. Press r to retry."; this.options.render(); }
    } finally { if (this.controller === controller) this.controller = undefined; }
  }
  dispose(): void { this.closed = true; this.controller?.abort(); this.input.focused = false; }
  close(): void { if (!this.closed) { this.dispose(); this.options.close(); } }
  private visible() {
    if (!this.snapshot) return [];
    const key = JSON.stringify([this.filter.period, this.filter.query, [...this.filter.hidden], this.filter.cwd, this.filter.sort]);
    if (this.sliceKey !== key || !this.slice) { this.slice = aggregate(this.snapshot, this.filter); this.sliceKey = key; }
    const result = rows(this.slice, this.expanded);
    this.selected = Math.min(this.selected, Math.max(0, result.length - 1));
    return result;
  }
  handleInput(data: string): void {
    if (this.closed) return;
    const kb = this.options.keybindings;
    if (matchesKey(data, "ctrl+c")) { this.close(); return; }
    if (this.searching) {
      this.input.handleInput(data); this.filter.query = this.input.getValue(); this.selected = 0; this.offset = 0;
      this.changed(); return;
    }
    if (data === "q" || kb.matches(data, "tui.select.cancel")) { this.close(); return; }
    const visible = this.visible(); const selected = visible[this.selected];
    if (data === "/") { this.searching = true; this.input.focused = this.hasFocus; }
    else if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + 1);
    else if (kb.matches(data, "tui.select.pageUp")) this.selected = Math.max(0, this.selected - 10);
    else if (kb.matches(data, "tui.select.pageDown")) this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + 10);
    else if (kb.matches(data, "tui.select.confirm") || data === " ") {
      if (selected) { if (this.expanded.has(selected.provider)) this.expanded.delete(selected.provider); else this.expanded.add(selected.provider); }
    } else if (data === "x" && selected) this.filter.hidden.add(selected.provider);
    else if (data === "a") { this.filter.hidden.clear(); this.filter.query = ""; this.input.setValue(""); }
    else if (data === "p") { this.filter.cwd = this.filter.cwd === null ? this.options.cwd : null; this.selected = 0; this.offset = 0; }
    else if (data === "s") {
      const sorts: Sort[] = ["cost", "tokens", "calls"]; this.filter.sort = sorts[(sorts.indexOf(this.filter.sort) + 1) % sorts.length]!;
      this.selected = 0; this.offset = 0;
    } else if (data === "r") { void this.refresh(); }
    else if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      const direction = matchesKey(data, "left") || matchesKey(data, "shift+tab") ? -1 : 1;
      this.filter.period = PERIODS[(PERIODS.indexOf(this.filter.period) + direction + PERIODS.length) % PERIODS.length]!;
      this.selected = 0; this.offset = 0;
    }
    this.changed();
  }
  render(width: number): string[] {
    const w = Math.max(0, width); if (!w) return [""];
    const theme = this.options.theme; const layout = tableLayout(w);
    const visible = this.visible(); const available = Math.max(1, this.options.height() - 11);
    this.offset = Math.min(this.offset, Math.max(0, visible.length - available));
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + available) this.offset = this.selected - available + 1;
    const tabs = PERIODS.map((period) => period === this.filter.period ? `[${PERIOD_LABELS[period]}]` : PERIOD_LABELS[period]).join(" | ");
    const lines = [theme.fg("accent", "Pi Usage — Table"), tabs,
      safeText(`Scope: ${this.filter.cwd ?? "all projects"} | Sort: ${this.filter.sort} | Filter: ${this.filter.query || "none"} | Hidden: ${this.filter.hidden.size}`),
      this.searching ? this.input.render(w)[0]! : theme.fg("dim", safeText(this.status)),
      theme.fg("muted", layout.header)];
    if (!this.snapshot) lines.push("Reading local history; Esc cancels.");
    else if (!visible.length) lines.push("No recorded usage matches this slice.");
    else visible.slice(this.offset, this.offset + available).forEach((row, index) => {
      const line = layout.line(row.name, row.stats);
      lines.push(index + this.offset === this.selected ? theme.bg("selectedBg", line) : line);
    });
    if (this.slice) lines.push(theme.fg("accent", layout.line("TOTAL (visible slice)", this.slice.total)));
    lines.push(theme.fg("dim", `Rows ${visible.length ? this.offset + 1 : 0}-${Math.min(visible.length, this.offset + available)}/${visible.length} | Snapshot: ${this.snapshot ? new Date(this.snapshot.capturedAt).toLocaleTimeString() : "loading"}`),
      "Tokens include cache reads/writes; reasoning is already in output. Cost is recorded, not an invoice.",
      "Tab/Left/Right period | Up/Down select | Enter expand | / filter | x hide | a reset",
      "s sort | p project | r refresh | q/Esc close | >= cost means some costs are unknown");
    return lines.slice(0, Math.max(1, this.options.height())).map((line) => truncateToWidth(line, w));
  }
}

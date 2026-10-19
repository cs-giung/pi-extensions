import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { aggregate, PERIODS, PERIOD_LABELS, type Filters, type Period, type Slice, type Snapshot, type Sort } from "./model.js";
import { count, cost, rows, safeText, tableLayout } from "./table.js";
import { HelpPage, beside, heading, keyLabel, panel, rule, selectedLine, type UIKeys } from "./ui.js";

export interface ViewOptions {
  cwd: string; period: Period; theme: Theme; keybindings: UIKeys;
  height: () => number; render: () => void; close: () => void;
  load: (signal: AbortSignal, progress: (files: number) => void) => Promise<Snapshot>;
}
/** One view owns its scan, input focus, selection and cancellation. No process-global UI state. */
export class UsageView implements Component, Focusable {
  private filter: Filters;
  private expanded = new Set<string>();
  private selected = 0;
  private offset = 0;
  private pageSize = 10;
  private snapshot: Snapshot | undefined;
  private slice: Slice | undefined;
  private sliceKey = "";
  private input = new Input({ prompt: "Search: ", placeholder: "provider or model" });
  private searching = false;
  private hasFocus = false;
  private detailed = false;
  private help: HelpPage | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private phase: "loading" | "ready" | "error" = "loading";
  private scanned = 0;
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
    this.phase = "loading"; this.scanned = 0; this.changed();
    try {
      const result = await this.options.load(controller.signal, (files) => {
        if (this.closed || controller.signal.aborted) return;
        this.scanned = files; this.changed();
      });
      if (this.closed || controller.signal.aborted) return;
      this.snapshot = result; this.slice = undefined; this.phase = "ready"; this.changed();
    } catch {
      if (!this.closed && !controller.signal.aborted) { this.phase = "error"; this.changed(); }
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
    if (data === "?" || this.help && kb.matches(data, "tui.select.cancel")) {
      this.help = this.help ? undefined : new HelpPage(); this.changed(); return;
    }
    if (data === "q" || !this.help && kb.matches(data, "tui.select.cancel")) { this.close(); return; }
    if (this.help) { this.help.handleInput(data, kb); this.changed(); return; }
    const visible = this.visible(); const selected = visible[this.selected];
    if (data === "/") { this.searching = true; this.input.focused = this.hasFocus; }
    else if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + 1);
    else if (kb.matches(data, "tui.select.pageUp")) this.selected = Math.max(0, this.selected - this.pageSize);
    else if (kb.matches(data, "tui.select.pageDown")) this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + this.pageSize);
    else if (kb.matches(data, "tui.select.confirm") || data === " ") {
      if (selected) { if (this.expanded.has(selected.provider)) this.expanded.delete(selected.provider); else this.expanded.add(selected.provider); }
    } else if (data === "x" && selected) this.filter.hidden.add(selected.provider);
    else if (data === "a") { this.filter.hidden.clear(); this.filter.query = ""; this.input.setValue(""); }
    else if (data === "p") { this.filter.cwd = this.filter.cwd === null ? this.options.cwd : null; this.selected = 0; this.offset = 0; }
    else if (data === "s") {
      const sorts: Sort[] = ["cost", "tokens", "calls"]; this.filter.sort = sorts[(sorts.indexOf(this.filter.sort) + 1) % sorts.length]!;
      this.selected = 0; this.offset = 0;
    } else if (data === "d") this.detailed = !this.detailed;
    else if (data === "r") { void this.refresh(); }
    else if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      const direction = matchesKey(data, "left") || matchesKey(data, "shift+tab") ? -1 : 1;
      this.filter.period = PERIODS[(PERIODS.indexOf(this.filter.period) + direction + PERIODS.length) % PERIODS.length]!;
      this.selected = 0; this.offset = 0;
    }
    this.changed();
  }
  private helpText(): string[] {
    const key = (action: Parameters<UIKeys["matches"]>[1], fallback: string) => keyLabel(this.options.keybindings, action, fallback);
    const data = this.snapshot;
    return ["USAGE / Keyboard shortcuts", "",
      "Tab / Shift+Tab / ← / →  Change period (local timezone).", `${key("tui.select.up", "↑")} / ${key("tui.select.down", "↓")}  Select a row; PageUp / PageDown move by a page.`,
      `${key("tui.select.confirm", "Enter")} / Space  Expand or collapse provider models.`,
      "/  Search provider/model names. Enter keeps the filter; Escape clears it.",
      "s  Sort by cost, tokens, or calls.   p  Toggle this project / all projects.",
      "x  Hide selected provider.   a  Reset search and hidden providers.",
      "d  Toggle input, output, and cache columns (when width permits).   r  Refresh from disk.", "",
      `? / ${key("tui.select.cancel", "Esc")}  Back to the table. q / Ctrl+C closes it.`, "", "ACCOUNTING",
      "Totals follow the visible period, project, search, and hidden-provider slice. Models shown are already part of their provider subtotal.",
      "Tokens include cache reads and writes. Reasoning is already in output. Recorded USD cost is not a subscription invoice.",
      ">= means some costs are unknown: the displayed cost is a lower bound, not a complete bill.",
      "Data warnings indicate malformed, incomplete, unreadable, or uncertain accounting. Refresh does not repair source files.", "", "SNAPSHOT",
      safeText(`Scope: ${this.filter.cwd ?? "all projects"} · Sort: ${this.filter.sort}`),
      data ? `${data.scanned} files · ${data.cached} cached · ${data.duplicates} copies deduplicated · ${data.reconciled} nested reports reconciled · ${data.issues} data warnings` : "No snapshot yet. Reading local history only; no model calls or network requests."];
  }
  private summary(width: number): string {
    const { theme } = this.options; const stats = this.slice?.total;
    if (!stats) return theme.fg("muted", this.phase === "error" ? "Scan failed · r Retry" : "Reading local history…");
    const money = theme.fg(stats.unknownCost ? "warning" : "accent", theme.bold(cost(stats)));
    return `Total ${money}  ·  ${count(stats.tokens)} tokens` + (width >= 64 ? `  ·  ${count(stats.calls)} call${stats.calls === 1 ? "" : "s"}  ·  ${count(stats.sessions.size)} session${stats.sessions.size === 1 ? "" : "s"}` : "");
  }
  private content(width: number, height: number): string[] {
    const theme = this.options.theme;
    if (this.help) return this.help.render(theme, this.helpText(), width, height);
    if (!this.snapshot) return [theme.fg(this.phase === "error" ? "error" : "muted", this.phase === "error" ? "Could not read usage history" : "Scanning local sessions…"),
      theme.fg("dim", this.phase === "error" ? "Press r to retry. No session files were changed." : `${this.scanned} files scanned · Esc cancels`)];
    const visible = this.visible();
    if (!visible.length) return [theme.fg("muted", "No usage in this view"), theme.fg("dim", "Tab changes period · a resets search/hidden providers · p changes scope")];
    const layout = tableLayout(Math.max(0, width - 2), this.detailed);
    const available = Math.max(1, height - (height >= 3 ? 2 : 0)); this.pageSize = available;
    this.offset = Math.min(this.offset, Math.max(0, visible.length - available));
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + available) this.offset = this.selected - available + 1;
    const lines = height >= 3 ? [theme.fg("muted", `  ${layout.header}`), ""] : [];
    for (const [index, row] of visible.slice(this.offset, this.offset + available).entries()) {
      const name = row.name.replace(/^\+ /, "▸ ").replace(/^- /, "▾ ");
      const selected = index + this.offset === this.selected;
      const line = `${selected ? "→ " : "  "}${layout.line(name, row.stats)}`;
      lines.push(selected ? selectedLine(theme, line, width) : line);
    }
    return lines;
  }
  private status(width: number): string {
    const theme = this.options.theme; const data = this.snapshot;
    if (this.help) return theme.fg("dim", "Keyboard reference & accounting notes · ↑↓ to scroll");
    if (this.phase === "error") return theme.fg("warning", `Refresh failed · ${data ? "showing previous snapshot · " : ""}r Retry`);
    if (this.phase === "loading") return theme.fg("muted", `${data ? "Refreshing" : "Scanning"} local sessions · ${this.scanned} files · Esc cancels`);
    const visible = this.visible();
    const range = `Rows ${visible.length ? this.offset + 1 : 0}–${Math.min(visible.length, this.offset + this.pageSize)}/${visible.length}`;
    if (data?.issues) return theme.fg("warning", beside(`${data.issues} data warnings · ? Details`, range, width));
    return theme.fg("dim", beside(range, data ? `${data.scanned} file${data.scanned === 1 ? "" : "s"} · Updated ${new Date(data.capturedAt).toLocaleTimeString()}` : "", width));
  }
  render(width: number): string[] {
    this.visible();
    const { theme, keybindings } = this.options; const height = Math.max(1, this.options.height());
    const cancel = keyLabel(keybindings, "tui.select.cancel", "Esc");
    const close = cancel === "Unbound" ? "Ctrl+C" : cancel;
    const enter = keyLabel(keybindings, "tui.select.confirm", "Enter");
    return panel(theme, width, height, (w) => {
      const title = heading(theme, this.help ? "Usage / Help" : this.phase === "error" ? "Usage / Refresh failed" : this.snapshot && this.phase === "loading" ? "Usage / Refreshing" : "Usage", this.snapshot?.issues ? `${this.snapshot.issues} data warnings` : `${PERIOD_LABELS[this.filter.period]} · Local`, w);
      if (this.help) return [title, ...(height >= 12 ? [rule(theme, w)] : [])];
      if (this.searching && height < 5) return [this.input.render(w)[0]!];
      const tabs = w >= 74 ? PERIOD_LABELS : { today: "Today", week: "Week", "last-week": "Last wk", "30d": "30 days", all: "All" };
      const tabLine = PERIODS.map((period) => period === this.filter.period ? theme.bg("selectedBg", theme.fg("accent", `[${tabs[period]}]`)) : theme.fg("muted", ` ${tabs[period]} `)).join("  ");
      const periods = visibleWidth(tabLine) <= w ? tabLine : theme.fg("muted", `${PERIOD_LABELS[this.filter.period]} · Tab to change`);
      const scope = this.filter.cwd ? `Project: ${safeText(basename(this.filter.cwd) || this.filter.cwd)}` : "All projects";
      const filters = this.searching ? this.input.render(w)[0]! : theme.fg("muted", `${scope} · Sort: ${this.filter.sort} ↓ · ${this.filter.query ? `Search: ${safeText(this.filter.query)}` : "/ Search"}${this.filter.hidden.size ? ` · ${this.filter.hidden.size} hidden` : ""}`);
      return [title, ...(height >= 12 ? [periods] : []), ...(height >= 5 ? [this.searching && height < 12 ? filters : this.summary(w)] : []),
        ...(height >= 12 ? [filters, rule(theme, w)] : [])];
    }, (w) => [ ...(height >= 12 ? [rule(theme, w), this.status(w)] : []),
      theme.fg("muted", this.help ? (w >= 40 ? `? / ${close} Back · q Close` : "? Back · q Close") : this.searching ?
        (w >= 42 ? "Enter Apply · Esc Clear · Ctrl+C Close" : w >= 28 ? "Esc Clear · Ctrl+C Close" : "Ctrl+C Close") :
        w >= 74 ? beside(`${enter} Expand   / Search   d ${this.detailed ? "Summary" : "Details"}   Tab Period`, `? Help   ${close} Close`, w) :
          w >= 42 ? `${enter} Expand · / Search · ? Help · ${close} Close` : w >= 22 ? `? Help · ${close} Close` : `${close} Close`)],
    (w, h) => this.content(w, h));
  }
}

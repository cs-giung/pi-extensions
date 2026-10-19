import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { Stash } from "./store.js";
import { HelpPage, beside, heading, keyLabel, panel, rule, selectedLine, type UIKeys } from "./ui.js";

export type PickerAction = { type: "restore" | "delete"; id: number } | undefined;
interface Options {
  stashes: Stash[]; theme: Theme; keybindings: UIKeys;
  height: () => number; render: () => void; done: (action: PickerAction) => void;
}
/** Escape terminal controls for display only; stored and restored text stays byte-for-byte intact. */
export function displayText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "�");
}

export class StashPicker implements Component, Focusable {
  private readonly input = new Input({ prompt: "Search: " });
  private readonly entries: Stash[];
  private searching = false;
  private hasFocus = false;
  private selected = 0;
  private previewOffset = 0;
  private capacity = 6;
  private preview: { id: number; width: number; lines: string[] } | undefined;
  private help: HelpPage | undefined;
  private closed = false;
  constructor(private readonly options: Options) {
    this.entries = [...options.stashes].sort((a, b) => b.id - a.id);
    this.input.onSubmit = () => { this.searching = false; this.input.focused = false; };
    this.input.onEscape = () => { this.searching = false; this.input.focused = false; this.input.setValue(""); };
  }
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.input.focused = value && this.searching; }
  invalidate(): void { this.input.invalidate(); this.preview = undefined; }
  private filtered(): Stash[] {
    const query = this.input.getValue().toLocaleLowerCase();
    return this.entries.filter((entry) => entry.text.toLocaleLowerCase().includes(query) || `#${entry.id}`.includes(query));
  }
  private renderList(matches: Stash[], width: number): string[] {
    const theme = this.options.theme;
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.capacity / 2), matches.length - this.capacity));
    const lines = matches.slice(start, start + this.capacity).map((entry, index) => {
      const title = displayText(entry.text).split("\n").find((line) => line.trim())?.trim() || "(empty prompt)";
      const selected = start + index === this.selected;
      const line = `${selected ? "→ " : "  "}${truncateToWidth(`#${entry.id}  ${title}`, width - 4, "")}`;
      return selected ? selectedLine(theme, line, width) : line;
    });
    if (matches.length > this.capacity) lines.push(theme.fg("dim", truncateToWidth(`  (${this.selected + 1}/${matches.length})`, width - 2, "")));
    return lines;
  }
  private finish(action: PickerAction): void {
    if (this.closed) return;
    this.closed = true; this.input.focused = false; this.options.done(action);
  }
  close(): void { this.finish(undefined); }
  dispose(): void { this.closed = true; this.input.focused = false; }
  handleInput(data: string): void {
    if (this.closed) return;
    const kb = this.options.keybindings;
    if (matchesKey(data, "ctrl+c")) { this.close(); return; }
    if (this.searching) {
      this.input.handleInput(data); this.selected = 0; this.previewOffset = 0;
    } else if (data === "?" || this.help && kb.matches(data, "tui.select.cancel")) {
      this.help = this.help ? undefined : new HelpPage();
    } else if (this.help) { this.help.handleInput(data, kb); }
    else if (kb.matches(data, "tui.select.cancel")) { this.close(); return; }
    else if (data === "/") { this.searching = true; this.input.focused = this.hasFocus; }
    else if (matchesKey(data, "left")) this.previewOffset = Math.max(0, this.previewOffset - 1);
    else if (matchesKey(data, "right")) this.previewOffset++;
    else {
      const matches = this.filtered(); const count = matches.length;
      if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
      else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
      else if (kb.matches(data, "tui.select.pageUp")) this.selected = Math.max(0, this.selected - this.capacity);
      else if (kb.matches(data, "tui.select.pageDown")) this.selected = Math.min(Math.max(0, count - 1), this.selected + this.capacity);
      else if (kb.matches(data, "tui.select.confirm") || data === "d") {
        const entry = matches[this.selected];
        if (entry) this.finish({ type: kb.matches(data, "tui.select.confirm") ? "restore" : "delete", id: entry.id });
        return;
      }
      this.previewOffset = 0;
    }
    this.options.render();
  }
  private helpText(): string[] {
    const key = (action: Parameters<UIKeys["matches"]>[1], fallback: string) => keyLabel(this.options.keybindings, action, fallback);
    return ["STASH / Keyboard shortcuts", "",
      `${key("tui.select.up", "↑")} / ${key("tui.select.down", "↓")}  Select a saved prompt; PageUp / PageDown jump through the list.`,
      `${key("tui.select.confirm", "Enter")}  Restore into the editor. Saved prompts stay available for reuse.`,
      "/  Search full prompt text or an ID such as #12. Enter keeps the search; Escape clears it.",
      "← / →  Scroll the preview one line at a time.", "d  Delete the selected prompt after confirmation.", "",
      "Your current editor draft is saved before restoring a different prompt. A failed save leaves the editor untouched.",
      "Only text is saved, not attachments. Storage is plain text; do not stash secrets.", "",
      `? / ${key("tui.select.cancel", "Esc")}  Back to the list. Ctrl+C closes the picker.`];
  }
  private content(width: number, height: number): string[] {
    const theme = this.options.theme;
    if (this.help) return this.help.render(theme, this.helpText(), width, height);
    const matches = this.filtered();
    if (!matches.length) return ["", theme.fg("muted", this.entries.length ? "No matching prompts" : "No saved prompts yet"),
      theme.fg("dim", this.entries.length ? "Press / to edit your search; Escape clears it while searching." : "Write a prompt, then use the stash shortcut to save it.")].slice(height < 3 ? 1 : 0);
    const sideBySide = width >= 78 && height >= 6;
    const showPreview = sideBySide || height >= 9;
    this.capacity = Math.max(1, sideBySide || !showPreview ? height - 2 : Math.floor((height - 4) / 3));
    const entry = matches[this.selected]!;
    const leftWidth = sideBySide ? Math.floor(width * 0.4) : width;
    const items = this.renderList(matches, leftWidth);
    const list = [theme.fg("muted", beside("SAVED PROMPTS", `${this.selected + 1} / ${matches.length}`, leftWidth)), ...items];
    if (!showPreview) return height <= 2 ? items.slice(0, height) : list;
    const previewWidth = sideBySide ? width - leftWidth - 3 : width;
    const previewHeight = Math.max(1, sideBySide ? height - 3 : height - list.length - 4);
    if (this.preview?.id !== entry.id || this.preview.width !== previewWidth) {
      this.preview = { id: entry.id, width: previewWidth, lines: wrapTextWithAnsi(displayText(entry.text), Math.max(1, previewWidth)) };
    }
    const wrapped = this.preview.lines;
    this.previewOffset = Math.min(this.previewOffset, Math.max(0, wrapped.length - previewHeight));
    const date = new Date(entry.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const preview = [theme.fg("muted", `Preview ${this.previewOffset + 1}/${wrapped.length}`),
      theme.fg("dim", `#${entry.id} · ${date} · ${entry.text.split("\n").length} lines`), "", ...wrapped.slice(this.previewOffset, this.previewOffset + previewHeight)];
    if (!sideBySide) return [...list, "", ...preview];
    return Array.from({ length: height }, (_, index) => {
      const left = truncateToWidth(list[index] ?? "", leftWidth);
      return left + " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) + theme.fg("borderMuted", " │ ") + (preview[index] ?? "");
    });
  }
  render(width: number): string[] {
    const { theme, keybindings } = this.options; const height = Math.max(1, this.options.height());
    const cancel = keyLabel(keybindings, "tui.select.cancel", "Esc");
    const close = cancel === "Unbound" ? "Ctrl+C" : cancel;
    const enter = keyLabel(keybindings, "tui.select.confirm", "Enter");
    return panel(theme, width, height, (w) => this.searching && height <= 3 ? [this.input.render(w)[0]!] : [heading(theme, this.help ? "Stash / Help" : "Stash", `${this.entries.length} saved`, w),
      ...(!this.help && (height >= 7 || this.searching) ? [this.searching ? this.input.render(w)[0]! : theme.fg("muted", this.input.getValue() ? `Search: ${displayText(this.input.getValue())}` : "/  Search prompts")] : []),
      ...(height >= 12 ? [rule(theme, w)] : [])],
    (w) => [ ...(height >= 12 ? [rule(theme, w), theme.fg("dim", this.help ? "Keyboard reference · ↑↓ to scroll" : "Current draft is saved before restore")] : []),
      theme.fg("muted", this.help ? (w >= 40 ? `? / ${close} Back · Ctrl+C Close` : w >= 22 ? "? Back · Ctrl+C Close" : "Ctrl+C Close") : this.searching ?
        (w >= 42 ? "Enter Apply · Esc Clear · Ctrl+C Close" : w >= 28 ? "Esc Clear · Ctrl+C Close" : "Ctrl+C Close") :
        w >= 68 ? beside(`${enter} Restore   / Search   d Delete`, `? Help   ${close} Close`, w) :
          w >= 42 ? `${enter} Restore · / Search · ? Help · ${close} Close` : w >= 22 ? `? Help · ${close} Close` : `${close} Close`)],
    (w, h) => this.content(w, h));
  }
}

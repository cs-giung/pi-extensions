// Mirrored between Stash and Usage so each extension remains independently installable.
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Keybinding } from "@earendil-works/pi-tui";

export type UIKeys = Pick<KeybindingsManager, "matches"> & Partial<Pick<KeybindingsManager, "getKeys">>;
export function keyLabel(keys: UIKeys, action: Keybinding, fallback: string): string {
  const key = keys.getKeys?.(action)?.[0];
  if (!key) return keys.getKeys ? "Unbound" : fallback;
  return key.split("+").map((part) => ({ up: "↑", down: "↓", enter: "Enter", escape: "Esc", pageUp: "PgUp", pageDown: "PgDn" })[part] ??
    (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))).join("+");
}
/** Right-side context is optional; the primary label must remain readable. */
export function beside(left: string, right: string, width: number): string {
  if (!right || visibleWidth(left) + visibleWidth(right) + 3 > width) return truncateToWidth(left, width);
  return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}
export const rule = (theme: Theme, width: number): string => theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
export const heading = (theme: Theme, title: string, context: string, width: number): string =>
  beside(theme.fg("accent", theme.bold(title)), theme.fg("muted", context), width);
export function selectedLine(theme: Theme, text: string, width: number): string {
  // Row text is unstyled. Truncation may append SGR resets; remove them before applying
  // the selection background so a long title cannot clear the highlight halfway across.
  const clipped = stripTerminalSequences(truncateToWidth(text, width));
  return theme.bg("selectedBg", clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
}

/** Reserve the rounded frame and chrome before content. Tiny terminals retain the borderless compact layout. */
export function panel(theme: Theme, width: number, height: number, header: (width: number) => string[], footer: (width: number) => string[],
  body: (width: number, height: number) => string[]): string[] {
  const w = Math.max(0, width); const h = Math.max(1, height);
  const framed = w >= 24 && h >= 10;
  const padding = framed ? 1 : w >= 60 ? 2 : w >= 8 ? 1 : 0;
  const inner = Math.max(0, w - (framed ? 2 : 0) - padding * 2);
  const insideHeight = h - (framed ? 2 : 0);
  let top = header(inner); let bottom = footer(inner);
  if (insideHeight < top.length + bottom.length + 1) {
    bottom = insideHeight >= 2 ? bottom.slice(-1) : [];
    top = top.slice(0, Math.max(0, insideHeight - bottom.length - (insideHeight >= 3 ? 1 : 0)));
  }
  const available = Math.max(0, insideHeight - top.length - bottom.length);
  const content = available ? body(inner, available).slice(0, available) : [];
  while (content.length < available) content.push("");
  // Content may clamp scroll offsets; resolve status text after that layout pass.
  if (bottom.length) bottom = footer(inner).slice(-bottom.length);
  const lines = [...top, ...content, ...bottom].slice(0, insideHeight).map((line) => {
    const clipped = truncateToWidth(line, inner);
    const fill = framed ? " ".repeat(Math.max(0, inner - visibleWidth(clipped))) : "";
    return " ".repeat(padding) + clipped + fill + " ".repeat(padding);
  });
  if (!framed) return lines;
  const border = (text: string) => theme.fg("borderMuted", text);
  return [border(`╭${"─".repeat(w - 2)}╮`), ...lines.map((line) => border("│") + line + border("│")), border(`╰${"─".repeat(w - 2)}╯`)];
}

export class HelpPage {
  private offset = 0;
  private pageSize = 1;
  handleInput(data: string, keys: UIKeys): void {
    if (keys.matches(data, "tui.select.up")) this.offset = Math.max(0, this.offset - 1);
    else if (keys.matches(data, "tui.select.down")) this.offset++;
    else if (keys.matches(data, "tui.select.pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
    else if (keys.matches(data, "tui.select.pageDown")) this.offset += this.pageSize;
  }
  render(theme: Theme, sections: string[], width: number, height: number): string[] {
    const lines = sections.flatMap((text) => wrapTextWithAnsi(text, Math.max(1, width)));
    this.pageSize = Math.max(1, height - 1);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - this.pageSize));
    const result = lines.slice(this.offset, this.offset + this.pageSize).map((text) => theme.fg("muted", text));
    if (lines.length > this.pageSize && height > 1) result.push(theme.fg("dim", `${this.offset + 1}–${Math.min(lines.length, this.offset + this.pageSize)} / ${lines.length} · Scroll for more`));
    return result;
  }
}

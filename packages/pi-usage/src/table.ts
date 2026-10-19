import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Slice, type Stats } from "./model.js";

export const safeText = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
export function count(value: number): string {
  if (value < 1000) return String(value);
  for (const [scale, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) {
    if (value >= scale) return `${(value / scale).toFixed(1)}${suffix}`;
  }
  return String(value);
}
export function cost(stats: Stats): string {
  return `${stats.unknownCost ? ">=" : ""}$${stats.cost.toFixed(stats.cost > 0 && stats.cost < 0.01 ? 4 : 2)}`;
}
interface Column { label: string; width: number; value: (stats: Stats) => string }
const columns: Column[] = [
  { label: "Sessions", width: 8, value: (s) => count(s.sessions.size) },
  { label: "Calls", width: 7, value: (s) => count(s.calls) },
  { label: "Cost USD", width: 12, value: cost },
  { label: "Tokens", width: 9, value: (s) => count(s.tokens) },
  { label: "Input", width: 9, value: (s) => count(s.input) },
  { label: "Output", width: 9, value: (s) => count(s.output) },
  { label: "Cache R", width: 9, value: (s) => count(s.cacheRead) },
  { label: "Cache W", width: 9, value: (s) => count(s.cacheWrite) },
];
const cell = (value: string, width: number, right = false) => {
  const clipped = truncateToWidth(safeText(value), width);
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return right ? padding + clipped : clipped + padding;
};
export interface DisplayRow { name: string; provider: string; stats: Stats }
export function rows(slice: Slice, expanded: ReadonlySet<string>): DisplayRow[] {
  return slice.providers.flatMap((provider) => [{ name: `${expanded.has(provider.name) ? "-" : "+"} ${provider.name}`,
    provider: provider.name, stats: provider.stats }, ...(expanded.has(provider.name)
    ? provider.models.map((model) => ({ name: `    ${model.name}`, provider: provider.name, stats: model.stats })) : [])]);
}
export function tableLayout(width: number, detailed = true) {
  const safeWidth = Math.max(0, width);
  // Keep cost visible longest. The interactive overview hides token breakdowns until requested.
  const core = [columns[2]!, columns[3]!, columns[1]!, columns[0]!];
  const sets = [detailed ? [...core, ...columns.slice(4)] : core, core, core.slice(0, 2), core.slice(0, 1), []];
  const selected = sets.find((list) => list.reduce((sum, col) => sum + col.width + 1, 0) + 14 <= safeWidth) ?? [];
  const nameWidth = Math.max(0, safeWidth - selected.reduce((sum, col) => sum + col.width + 1, 0));
  return {
    header: cell("Provider / Model", nameWidth) + selected.map((col) => " " + cell(col.label, col.width, true)).join(""),
    line: (label: string, stats: Stats) => cell(label, nameWidth) + selected.map((col) => " " + cell(col.value(stats), col.width, true)).join(""),
  };
}
export function textTable(slice: Slice): string {
  const layout = tableLayout(118);
  return [layout.header, ...rows(slice, new Set(slice.providers.map((provider) => provider.name))).map((row) => layout.line(row.name, row.stats)),
    layout.line("TOTAL (visible slice)", slice.total)].join("\n");
}

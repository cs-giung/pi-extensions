import { getKeybindings, type KeyId } from "@earendil-works/pi-tui";

export const DEFAULT_SHORTCUT: KeyId = "ctrl+shift+s";
const modifiers = ["ctrl", "alt", "shift", "super"];
const namedKeys = new Map([
  ...["escape", "enter", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end", "up", "down", "left", "right"].map((key) => [key, key] as const),
  ["esc", "escape"], ["return", "enter"], ["pageup", "pageUp"], ["pagedown", "pageDown"],
]);

/** Accept modified keys or function keys, never ordinary typing/navigation. */
export function parseShortcut(value: unknown): KeyId | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.trim().toLowerCase().replace(/\s+/g, "").split("+");
  // The plus key is written as ctrl++ (or + on its own).
  let base = parts.pop()!;
  if (base === "" && parts.at(-1) === "") { parts.pop(); base = "+"; }
  if (parts.some((part) => !modifiers.includes(part)) || new Set(parts).size !== parts.length) return undefined;
  const functionKey = /^f(?:[1-9]|1[0-2])$/.test(base);
  const symbol = base.length === 1 && "abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".includes(base);
  if (!symbol && !functionKey && !namedKeys.has(base)) return undefined;
  if (!functionKey && !parts.some((part) => part !== "shift")) return undefined;
  return [...modifiers.filter((part) => parts.includes(part)), namedKeys.get(base) ?? base].join("+") as KeyId;
}

/** Conservative: also reserve Pi's modal bindings, not just main-editor actions. */
export function shortcutConflict(key: KeyId, bindings = getKeybindings().getResolvedBindings()): string | undefined {
  return Object.entries(bindings).find(([, value]) =>
    (Array.isArray(value) ? value : [value]).some((binding) => parseShortcut(binding) === key))?.[0];
}

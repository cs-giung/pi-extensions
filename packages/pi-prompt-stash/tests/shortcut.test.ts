import type { KeybindingsConfig } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { parseShortcut, shortcutConflict } from "../src/shortcut.js";

describe("stash shortcut configuration", () => {
  it.each([
    [" Shift + CTRL + S ", "ctrl+shift+s"], ["alt+s", "alt+s"], ["f12", "f12"],
    ["ctrl+return", "ctrl+enter"], ["ctrl+esc", "ctrl+escape"], ["alt+pageup", "alt+pageUp"],
    ["ctrl++", "ctrl++"], ["super+alt+x", "alt+super+x"],
  ])("normalizes %s", (input, expected) => { expect(parseShortcut(input)).toBe(expected); });
  it.each(["s", "shift+s", "enter", "escape", "up", "", "ctrl+", "ctrl+ctrl+s", "meta+s", "ctrl+banana", "f13", "ctrl+🐈", null])("rejects unsafe/invalid key %s", (input) => {
    expect(parseShortcut(input)).toBeUndefined();
  });
  it("checks effective remapped bindings and modifier order", () => {
    const bindings: KeybindingsConfig = { "app.clear": "ctrl+c", "app.model.select": ["shift+ctrl+s", "alt+l"], "tui.editor.undo": [] };
    expect(shortcutConflict("ctrl+shift+s", bindings)).toBe("app.model.select");
    expect(shortcutConflict("alt+s", {})).toBeUndefined();
  });
});

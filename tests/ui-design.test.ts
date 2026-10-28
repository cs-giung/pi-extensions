import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stashUI from "../packages/pi-prompt-stash/src/ui.js";
import * as usageUI from "../packages/pi-usage/src/ui.js";
import { StashPicker } from "../packages/pi-prompt-stash/src/picker.js";
import { UsageView } from "../packages/pi-usage/src/view.js";
import { row, snapshot } from "../packages/pi-usage/tests/fixtures.js";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const stashes = [
  { id: 1, timestamp: 1, text: "Review the API changes\nCheck error handling and backwards compatibility.\nKeep the public surface small." },
  { id: 2, timestamp: 2, text: "Draft release notes\nSummarize the changes and verification steps." },
  { id: 3, timestamp: 3, text: "Improve the terminal UI\n\nUse a clear hierarchy and quieter secondary text.\nKeep primary actions visible at small sizes.\nPreserve Korean text: \uD55C\uAE00\uACFC emoji 👩‍💻." },
];
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[0m/g, "").trimEnd()).join("\n");
afterEach(() => vi.restoreAllMocks());

it("keeps the small design primitives mirrored without cross-package runtime imports", () => {
  expect(readFileSync(new URL("../packages/pi-prompt-stash/src/ui.ts", import.meta.url), "utf8"))
    .toBe(readFileSync(new URL("../packages/pi-usage/src/ui.ts", import.meta.url), "utf8"));
});
describe.each([["stash", stashUI], ["usage", usageUI]] as const)("%s design primitives", (_name, ui) => {
  it("pins a body row and an exit hint at tiny heights, without overflowing Unicode widths", () => {
    for (const width of [0, 1, 8, 20, 23, 24, 40, 80, 120]) for (const height of [1, 2, 3, 5, 9, 10, 12, 24]) {
      const lines = ui.panel(theme, width, height, () => ["Title", "Search", "Rule"], () => ["Rule", "Status", "Esc Close"], () => ["\uD55C\uAE00 👩‍💻 row"]);
      expect(lines).toHaveLength(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const framed = width >= 24 && height >= 10;
      if (width >= 20 && height >= 3) {
        expect(lines[framed ? 1 : 0]).toContain("Title"); expect(lines.at(framed ? -2 : -1)).toContain("Esc Close");
        expect(lines.join("\n")).toContain("row");
      }
      if (framed) {
        expect(lines[0]).toBe(`╭${"─".repeat(width - 2)}╮`); expect(lines.at(-1)).toBe(`╰${"─".repeat(width - 2)}╯`);
        expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
        for (const line of lines.slice(1, -1)) { expect(line.startsWith("│ ")).toBe(true); expect(line.endsWith(" │")).toBe(true); }
      } else expect(lines.join("\n")).not.toContain("╭");
    }
  });
  it("budgets the frame before content and reapplies the active theme on each render", () => {
    let color = "\x1b[90m";
    const fg = vi.fn((_token: string, text: string) => `${color}${text}\x1b[39m`);
    const themed = { ...theme, fg } as unknown as Theme;
    const body = vi.fn(() => ["content"]);
    const render = () => ui.panel(themed, 40, 12, () => ["Title"], () => ["Esc Close"], body);
    expect(render()[0]).toContain("\x1b[90m╭"); expect(body).toHaveBeenCalledWith(36, 8);
    color = "\x1b[91m"; expect(render()[0]).toContain("\x1b[91m╭");
    expect(fg.mock.calls.every(([token]) => token === "borderMuted")).toBe(true);
  });
  it("reads configured key labels and distinguishes unbound actions", () => {
    const remapped = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "ctrl+y", "tui.select.cancel": [] });
    expect(ui.keyLabel(remapped, "tui.select.confirm", "Enter")).toBe("Ctrl+Y");
    expect(ui.keyLabel(remapped, "tui.select.cancel", "Esc")).toBe("Unbound");
    expect(ui.keyLabel(keys, "tui.select.up", "Up")).toBe("↑");
  });
  it("preserves the full selection background after truncating long Unicode titles", () => {
    const colored = { ...theme, bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m` } as Theme;
    const line = ui.selectedLine(colored, "\uD55C\uAE00 👩‍💻 ".repeat(50), 18);
    expect(line).toContain("\x1b[44m"); expect(line).not.toContain("\x1b[0m"); expect(visibleWidth(line)).toBe(18);
  });
  it("resolves status after the body clamps scroll positions", () => {
    let offset = 99;
    const lines = ui.panel(theme, 40, 8, () => ["Title"], () => [`Rows ${offset}`, "Esc Close"], () => { offset = 2; return ["row"]; });
    expect(lines.join("\n")).toContain("Rows 2");
  });
});

describe("UI layout previews", () => {
  it.each([100, 52])("Stash at %s columns", (width) => {
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("Oct 19, 13:00");
    const view = new StashPicker({ stashes, theme, keybindings: keys, height: () => 20, render: vi.fn(), done: vi.fn() });
    expect(plain(view.render(width))).toMatchSnapshot();
    view.handleInput("?"); const help = view.render(width);
    expect(help[0]).toMatch(/^╭.*╮$/); expect(help.at(-1)).toMatch(/^╰.*╯$/);
  });
  it.each([112, 52])("Usage at %s columns", async (width) => {
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockReturnValue("13:00");
    const view = new UsageView({ cwd: "/project", period: "all", theme, keybindings: keys, height: () => 20, render: vi.fn(), close: vi.fn(),
      load: async () => snapshot([row({ provider: "openai", model: "gpt-5", cost: 1.84 }), row({ provider: "anthropic", model: "sonnet", key: "b", cost: 0.72 })]) });
    await view.refresh(); view.handleInput("\r");
    expect(plain(view.render(width))).toMatchSnapshot();
    view.handleInput("?"); const help = view.render(width);
    expect(help[0]).toMatch(/^╭.*╮$/); expect(help.at(-1)).toMatch(/^╰.*╯$/);
  });
});

import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeEach, expect, it } from "vitest";

beforeEach(() => initTheme("dark"));
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", api: "openai-responses", provider: "fake", model: "fake", timestamp: 1, stopReason, content,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const thought = { type: "thinking" as const, thinking: "Synthetic reasoning", thinkingSignature: "opaque" };

it("uses the native empty-label contract to remove a thinking-only row, including during streaming", () => {
  const value = message([thought]); const before = JSON.stringify(value);
  const component = new AssistantMessageComponent(value, true, undefined, "");
  expect(component.render(80)).toEqual([]);
  component.updateContent(value, true); expect(component.render(80)).toEqual([]);
  component.setHiddenThinkingLabel("Thinking...");
  expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("Thinking...");
  component.setHideThinkingBlock(false);
  expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("Synthetic reasoning");
  expect(JSON.stringify(value)).toBe(before);
});

it("hides separate thinking runs without removing text or leaving inter-run spacing", () => {
  const body = [{ type: "text" as const, text: "First paragraph" }, { type: "text" as const, text: "Second paragraph" }];
  const component = new AssistantMessageComponent(message([thought, body[0]!, thought, body[1]!]), true, undefined, "");
  const bodyOnly = new AssistantMessageComponent(message(body), true);
  expect(component.render(80)).toEqual(bodyOnly.render(80));
});

it.each(["error", "aborted", "length"] as const)("keeps native %s notices visible while reasoning is hidden", (stopReason) => {
  const component = new AssistantMessageComponent(message([thought], stopReason), true, undefined, "");
  const text = component.render(80).map(stripTerminalSequences).join("\n");
  expect(text).not.toContain("Synthetic reasoning"); expect(text).not.toContain("Thinking...");
  expect(text).toMatch(/Error:|Operation aborted|truncated/);
});

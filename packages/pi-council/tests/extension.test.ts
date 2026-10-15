import { describe, expect, it } from "vitest";
import { findLastChairAnswer } from "../src/index.js";
import { harness } from "./fixtures.js";

describe("Council extension registration and historical data", () => {
  it("registers six commands and one sequential model-only Reviewer tool", () => {
    const h = harness();
    expect([...h.commands.keys()]).toEqual(["council-cancel", "council-check", "council-reviews", "council-copy", "council", "council-next"]);
    expect([...h.tools.keys()]).toEqual(["council_review"]);
    expect(h.tools.get("council_review")).toMatchObject({ exposure: "model-only", executionMode: "sequential" });
    expect(h.worker).not.toHaveBeenCalled(); expect(h.api.sendUserMessage).not.toHaveBeenCalled();
  });
  it("warns when no previous responses or completed answer exist", async () => {
    const h = harness(); await h.command("council-reviews");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("No completed Reviewer run is available. Run /council first.", "warning");
    await h.command("council-copy"); expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("No Chair answer is available. Run /council first.", "warning");
  });
  it("preserves old persisted Chair answers without retaining old inference behavior", () => {
    expect(findLastChairAnswer([
      { type: "custom_message", customType: "reviewer-chair-final", content: "Old answer" },
      { type: "custom_message", customType: "unrelated", content: "Not a Chair answer" },
    ] as never)).toBe("Old answer");
  });
  it("handles custom-message starts without inventing a text prompt or execution permit", async () => {
    const h = harness(); await h.command();
    await h.emit("before_agent_start", { messageType: "custom", systemPromptOptions: { sections: {} } });
    expect((await h.review()).isError).toBe(true); expect(h.worker).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { STATE_ENTRY_TYPE } from "../src/state.js";
import { acceptedSuccess, brief, config, harness, runtime } from "./fixtures.js";

describe("explicit Council continuation", () => {
  it("requires a saved resumable council and never grants execution from ordinary discussion", async () => {
    const h = harness(); await h.command("council-next", "Recheck");
    expect(h.api.sendUserMessage).not.toHaveBeenCalled(); expect(h.worker).not.toHaveBeenCalled();
    await h.command(); await h.activate(); await h.review(); await h.finish();
    await h.emit("input", { source: "interactive", text: "Please continue" });
    await h.emit("before_agent_start", { messageType: "user", prompt: "Please continue", systemPromptOptions: { sections: {} } });
    expect((await h.review({ runId: h.state().id, brief: "Another batch" })).isError).toBe(true);
    expect(h.worker).toHaveBeenCalledTimes(1);
  });
  it("uses the snapshotted roster/prompts and preserves prior main answers only as Chair context", async () => {
    let current = config;
    const h = harness({ loadConfig: async () => current, createRuntime: async () => runtime });
    await h.command(); await h.activate(); await h.review(); await h.finish(); const first = h.state();
    current = { ...config, chair: { systemPrompt: "Changed configuration" } };
    await h.command("council-next", "Verify the added control");
    expect(h.state()).toMatchObject({ config: first.config, continuation: { id: first.continuation!.id, round: 2, previousAnswer: first.answer, previousBrief: brief } });
    expect(h.state().id).not.toBe(first.id); expect(h.worker).toHaveBeenCalledTimes(1);
    const prompt = await h.activate(); expect(JSON.stringify(prompt.sections)).toContain("Verify the added control");
    expect((await h.review({ runId: first.id, brief })).isError).toBe(true);
    await h.review(); expect(h.worker).toHaveBeenCalledTimes(2);
    expect(h.worker.mock.calls[1]![0]).not.toContain(first.answer!);
    await h.finish(); await h.command("council-reviews");
    expect(h.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Round: 2 | Focus: Verify the added control") }), { triggerTurn: false });
    await h.command(); expect(h.state().config).toEqual(current);
    expect(h.state().continuation!.round).toBe(1); expect(h.state().continuation!.id).not.toBe(first.continuation!.id);
  });
  it("can explicitly continue cancelled rounds but not while cleanup still owns execution", async () => {
    const h = harness(); await h.command(); await h.activate();
    await h.command("council-next", "Not yet"); expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    await h.command("council-cancel"); await h.finish("", "aborted");
    await h.command("council-next", "Recheck after cancellation");
    expect(h.state().continuation).toMatchObject({ round: 2, workers: [null] });
    expect(h.worker).not.toHaveBeenCalled(); await h.activate(); await h.review(); expect(h.worker).toHaveBeenCalledTimes(1);
  });
  it("restores continuation state after reload without executing a batch", async () => {
    const h = harness(); await h.command(); await h.activate(); await h.review(); await h.finish();
    const restored = harness({}, h.manager); await restored.emit("session_start");
    expect(restored.worker).not.toHaveBeenCalled();
    await restored.command("council-next", ""); await restored.activate(); await restored.review();
    expect(restored.state().continuation!.round).toBe(2); expect(restored.worker).toHaveBeenCalledTimes(1);
  });
  it("keeps legacy reports readable but refuses to invent their missing Reviewer histories", async () => {
    const h = harness(); await h.command(); await h.activate(); await h.review(); await h.finish();
    const { continuation: _unused, ...legacy } = h.state();
    h.manager.appendCustomEntry(STATE_ENTRY_TYPE, legacy);
    await h.command("council-next", "Continue legacy");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    await h.command("council-copy"); expect(h.copyText).toHaveBeenCalledWith(legacy.answer);
  });
  it("retains stable anonymous labels when an earlier reviewer fails", async () => {
    const review = acceptedSuccess(1, 2);
    const h = harness({ loadConfig: async () => ({ ...config, reviewers: Array.from({ length: 3 }, () => config.reviewers[0]!) }),
      runReviewers: async () => ({ successes: [review], failures: [] }) });
    await h.command(); await h.activate(); const result = await h.review();
    expect(h.output(result).anonymousReviews).toEqual([{ label: "Review 3", content: null, artifact: review.artifact }]);
  });
});

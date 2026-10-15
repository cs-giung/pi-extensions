import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { formatToolReviews, reviewInputSchema, reviewOutputSchema, reviewView, toolSchema } from "../src/protocol.js";
import { readRun, runSchema, STATE_ENTRY_TYPE } from "../src/state.js";
import { addUsage } from "../src/usage.js";
import { brief, harness, usage } from "./fixtures.js";

describe("Council data contracts and ownership", () => {
  it("derives matching TypeBox and Zod interfaces", async () => {
    const h = harness(); await h.command();
    const input = { runId: h.state().id, brief };
    expect(reviewInputSchema.safeParse(input).success).toBe(true);
    expect(Value.Check(toolSchema(reviewInputSchema), input)).toBe(true);
    expect(Value.Check(toolSchema(reviewInputSchema), { ...input, model: "unauthorized/provider" })).toBe(false);
    expect(reviewInputSchema.safeParse({ ...input, model: "unauthorized/provider" }).success).toBe(false);
    const output = reviewView(h.state());
    expect(reviewOutputSchema.safeParse(output).success).toBe(true);
    expect(Value.Check(toolSchema(reviewOutputSchema), output)).toBe(true);
  });
  it("delivers the original prompt and stable anonymous labels through the actual tool view", async () => {
    const h = harness(); await h.command();
    const state = h.state();
    const output = reviewView({ ...state, report: { prompt: state.prompt, successes: [
      { index: 7, content: "Candidate alpha" }, { index: 2, content: "Candidate beta" },
    ], failures: [] } });
    expect(output.originalPrompt).toBe(state.prompt);
    expect(output.anonymousReviews).toEqual([
      { label: "Review 8", artifact: null, content: "Candidate alpha" },
      { label: "Review 3", artifact: null, content: "Candidate beta" },
    ]);
  });
  it("bounds briefs and rejects arbitrary model/session/configuration overrides", async () => {
    const h = harness(); await h.command(); await h.activate();
    for (const input of [{ runId: h.state().id, brief: "x".repeat(32001) }, { runId: h.state().id, brief, sessionFile: "/tmp/unrelated.jsonl" }]) {
      expect((await h.review(input)).isError).toBe(true);
    }
    expect(h.worker).not.toHaveBeenCalled();
  });
  it("does not record an incomplete or failed main answer as a successful synthesis", async () => {
    const h = harness(); await h.command(); await h.activate(); await h.review();
    await h.finish("A provider failed.", "error");
    expect(h.state().phase).toBe("interrupted"); expect(h.state().answer).toBeNull();
    expect(runSchema.safeParse({ ...h.state(), phase: "complete" }).success).toBe(false);
  });
  it("rejects corrupt current snapshots without silently replacing accepted state", async () => {
    const h = harness(); await h.command(); h.manager.appendCustomEntry(STATE_ENTRY_TYPE, { version: 999 });
    expect(() => readRun(h.ctx)).toThrow(/corrupt/);
    await h.command("council-cancel");
    await h.command(); expect(h.state().phase).toBe("prepare");
  });
  it("cancels owned initialization even if saved metadata has become invalid", async () => {
    const h = harness(); await h.command(); await h.activate();
    h.manager.appendCustomEntry(STATE_ENTRY_TYPE, { version: 999 });
    await h.command("council-cancel"); expect(h.ctx.abort).toHaveBeenCalledTimes(1);
  });
  it("cancels startup preflight without creating a main turn or child batch", async () => {
    const h = harness({ createRuntime: () => new Promise(() => undefined) });
    const starting = h.command(); await Promise.resolve();
    await h.command("council-cancel"); await starting;
    expect(h.api.sendUserMessage).not.toHaveBeenCalled(); expect(h.worker).not.toHaveBeenCalled();
    expect(readRun(h.ctx)).toBeUndefined();
  });
  it("rejects the start if unrelated main work begins during preflight", async () => {
    const h = harness(); const original = h.loadConfig.getMockImplementation()!;
    h.loadConfig.mockImplementation(async () => { const result = await original(); h.ctx.isIdle = () => false; return result; });
    await h.command(); expect(h.api.sendUserMessage).not.toHaveBeenCalled(); expect(h.worker).not.toHaveBeenCalled();
  });
  it("keeps failed-attempt accounting while pausing synthesis", async () => {
    const h = harness({ runReviewers: async (...args) => { args[7]?.({ sessionFile: "/tmp/failed.jsonl", usage }); throw new Error("PRIVATE_PROVIDER_BODY"); } });
    await h.command(); await h.activate(); const result = await h.review();
    expect(result).toMatchObject({ isError: true, usage });
    expect(JSON.stringify(h.output(result))).not.toContain("PRIVATE_PROVIDER_BODY"); expect(h.state().phase).toBe("failed");
  });
  it("preserves optional usage counters and escapes hostile display controls", async () => {
    expect(addUsage({ ...usage, cacheWrite1h: 4, reasoning: 5 }, usage)).toMatchObject({ cacheWrite1h: 4, reasoning: 5, totalTokens: 60 });
    const h = harness(); await h.command();
    const output = reviewView({ ...h.state(), brief: "\u001b]52;c;malicious\u0007\nResearch context" });
    const rendered = formatToolReviews(output);
    expect(rendered).not.toContain("\u001b"); expect(rendered).not.toContain("\u0007"); expect(rendered).toContain("Research context");
  });
});

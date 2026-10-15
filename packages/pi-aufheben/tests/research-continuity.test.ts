import { describe, expect, it } from "vitest";
import { rolePrompt, mainInstructions } from "../src/prompts.js";
import { currentState, STATE_ENTRY } from "../src/storage.js";
import { describeState } from "../src/progress.js";
import { brief, harness } from "./fixtures.js";

describe("research continuity rather than repeated debate", () => {
  it("passes the actual prior questions and their target claims to both roles in the next round", async () => {
    const h = harness(); await h.command("aufheben", "Does X cause Y?"); await h.activate(); await h.round();
    const first = h.state(); await h.emit("agent_settled");
    await h.command("aufheben-next", "Investigate the unresolved compute confounder"); await h.activate();
    const next = h.state();
    expect(next.previousRound).toMatchObject({ round: 1, thesis: first.thesis, antithesis: first.antithesis, synthesis: first.lastSynthesis, brief });
    for (const role of ["thesizer", "antithesizer"] as const) {
      const payload = rolePrompt(next, role, "");
      expect(payload).toContain("Could the gain instead come from extra compute?");
      expect(payload).toContain(first.thesis!.claims[0]!.statement);
      expect(payload).toContain("Run the control.");
      expect(payload).not.toContain("sessionId");
    }
    expect(mainInstructions(next, true)).toContain("Could the gain instead come from extra compute?");
    expect(describeState(next)).toContain("R1.A1: Could the gain instead come from extra compute?");
  });
  it("preserves the completed premise when the user updates the future brief", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate(); await h.round(); await h.emit("agent_settled");
    await h.call("checkpoint", { ...h.identity(), action: "update_brief", brief: { ...brief, assumptions: ["A new premise"] } });
    expect(h.state().brief!.assumptions).toEqual(["A new premise"]);
    expect(h.state().previousRound!.brief!.assumptions).toEqual([]);
    await h.command("aufheben-next"); expect(h.state().previousRound!.round).toBe(1);
  });
  it("restores completed-round meaning from the current branch after reload", async () => {
    const h = harness(); await h.command("aufheben", "Question"); const firstLeaf = h.manager.getLeafId()!;
    await h.activate(); await h.round(); await h.emit("agent_settled");
    const restored = harness({}, h.manager); await restored.emit("session_start");
    expect(restored.state().previousRound!.antithesis.questions[0]!.question).toContain("extra compute");
    expect(restored.worker).not.toHaveBeenCalled();
    h.manager.branch(firstLeaf); await restored.emit("session_tree");
    expect(restored.state().previousRound).toBeNull();
  });
  it("allows logical verification and an honest finish without forced novelty or compromise", async () => {
    const h = harness(); await h.command("aufheben", "Is 1 + 1 = 2?");
    const prompt = mainInstructions(h.state(), true);
    expect(prompt).toContain("proof obligation"); expect(prompt).toContain("recommend finish when justified");
    expect(prompt).toContain("never manufacture novelty, disagreement, or a mechanical compromise");
    expect(prompt).toContain("A recommendation is advice, not permission");
  });
  it("does not activate research if unrelated main work starts during preflight", async () => {
    const h = harness({ loadConfig: async () => { h.ctx.isIdle = () => false; return (await import("./fixtures.js")).config; } });
    await h.command("aufheben", "Question");
    expect(h.api.sendUserMessage).not.toHaveBeenCalled(); expect(currentState(h.ctx)).toBeUndefined();
  });
  it("still cancels owned work when the latest state entry is corrupt", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate();
    h.manager.appendCustomEntry(STATE_ENTRY, { version: 999 });
    await h.command("aufheben-pause");
    expect(h.ctx.abort).toHaveBeenCalledTimes(1); expect(h.worker).not.toHaveBeenCalled();
  });
});

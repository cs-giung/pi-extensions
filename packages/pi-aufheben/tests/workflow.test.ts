import { describe, expect, it, vi } from "vitest";
import { RoleRequestError, type RoleResult } from "../src/role-session.js";
import { currentState, STATE_ENTRY } from "../src/storage.js";
import { brief, config, harness, rawThesis, usage } from "./fixtures.js";

describe("Aufheben commands and orchestration", () => {
  it("registers five commands, three sequential model-only tools, and uses a normal main turn", async () => {
    const h = harness();
    expect([...h.commands.keys()]).toHaveLength(5);
    expect([...h.tools.keys()]).toEqual(["aufheben_thesis", "aufheben_antithesis", "aufheben_checkpoint"]);
    expect([...h.tools.values()].every((tool) => tool.exposure === "model-only" && tool.executionMode === "sequential")).toBe(true);
    await h.command("aufheben", "Improve the causal research design");
    expect(h.api.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Improve the causal research design"), { expandPromptTemplates: false });
    const options = await h.activate();
    expect(options.sections).toMatchObject({ existing: "Keep normal instructions", aufheben: expect.stringContaining("You are the Synthesizer") });
    await h.round();
    expect(h.worker).toHaveBeenCalledTimes(2);
    expect(h.worker.mock.calls.map(([request]) => request.role)).toEqual(["thesizer", "antithesizer"]);
    expect(h.state()).toMatchObject({ phase: "awaiting_user", lifecycle: "open", round: 1 });
    expect(h.state().reportedUsage?.cost.total).toBe(0.06);
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    await h.emit("agent_settled");
    const result = await h.call("thesis", { ...h.identity(), brief });
    expect(result.isError).toBe(true);
    expect(h.worker).toHaveBeenCalledTimes(2);
  });

  it("reuses distinct role histories across rounds and starts fresh on a new exploration", async () => {
    const h = harness(); await h.command("aufheben", "Initial question"); await h.activate(); await h.round();
    const first = h.state(); await h.emit("agent_settled");
    await h.command("aufheben-next", "Test the causal mechanism"); await h.activate(); await h.round();
    expect(h.state().round).toBe(2);
    expect(h.state().thesis!.claims[0]!.id).toBe("R2.T1");
    const resumed = h.worker.mock.calls[2]![0];
    expect(resumed.state.workers).toEqual(first.workers);
    expect(resumed.state.lastSynthesis).toEqual(first.lastSynthesis);
    expect(first.workers.thesizer?.sessionId).not.toBe(first.workers.antithesizer?.sessionId);
    await h.emit("agent_settled"); await h.command("aufheben", "A different question");
    expect(h.state().id).not.toBe(first.id);
    expect(h.state().workers).toEqual({ thesizer: null, antithesizer: null });
    expect(h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY).length).toBeGreaterThan(6);
  });

  it("uses the exploration configuration snapshot until a new exploration is started", async () => {
    let current = config;
    const h = harness({ loadConfig: async () => current });
    await h.command("aufheben", "Question"); await h.activate(); await h.round(); await h.emit("agent_settled");
    current = { ...config, thesizer: { ...config.thesizer, systemPrompt: "New instructions" } };
    await h.command("aufheben-next"); await h.activate(); await h.round(); await h.emit("agent_settled");
    expect(h.worker.mock.calls[2]![0].state.config.thesizer.systemPrompt).toBe(config.thesizer.systemPrompt);
    await h.command("aufheben", "New question");
    expect(h.state().config.thesizer.systemPrompt).toBe("New instructions");
  });

  it("supports idempotent tools, rejects stale/cross-exploration references and duplicate charging", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate();
    const input = { ...h.identity(), brief };
    const first = await h.call("thesis", input);
    const duplicate = await h.call("thesis", input);
    expect(duplicate.isError).not.toBe(true);
    expect(duplicate.usage).toBeUndefined();
    expect(duplicate.structuredContent).toMatchObject({ replayed: true });
    expect(h.worker).toHaveBeenCalledTimes(1);
    expect(first.usage?.totalTokens).toBe(30);
    expect(first.details).toMatchObject({ results: [{ sessionFile: expect.stringContaining("thesizer"), usage }] });
    expect((await h.call("antithesis", input)).isError).toBe(true);
    expect((await h.call("antithesis", { ...h.identity(), explorationId: "cf2dc1cd-e6fc-446f-b39b-c3008c435a2e" })).isError).toBe(true);
    expect(h.worker).toHaveBeenCalledTimes(1);
  });

  it("preserves an accepted thesis on unchanged retries and resets partial work on changed focus", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate();
    await h.call("thesis", { ...h.identity(), brief }); await h.emit("agent_settled");
    expect(h.state()).toMatchObject({ lifecycle: "paused", phase: "antithesis" });
    const accepted = h.state().workers.thesizer;
    await h.command("aufheben-next"); await h.activate();
    expect(h.state().workers.thesizer).toEqual(accepted);
    await h.call("antithesis", h.identity()); await h.emit("agent_settled");
    await h.command("aufheben-next", "Change the central premise");
    expect(h.state()).toMatchObject({ round: 1, phase: "thesis", thesis: null, antithesis: null });
    expect(h.state().workers).toEqual({ thesizer: null, antithesizer: null });
  });

  it("checkpoints natural-language intervention without inference or automatic continuation", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate(); await h.round(); await h.emit("agent_settled");
    const adjusted = { ...brief, constraints: ["Match the training compute."] };
    const result = await h.call("checkpoint", { ...h.identity(), action: "update_brief", brief: adjusted });
    expect(result.isError).not.toBe(true);
    expect(h.state().brief!.constraints).toEqual(adjusted.constraints);
    expect(h.worker).toHaveBeenCalledTimes(2);
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(h.state().phase).toBe("awaiting_user");
  });

  it("replays brief checkpoints idempotently and handles custom-message turns without granting permission", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate(); await h.round(); await h.emit("agent_settled");
    const input = { ...h.identity(), action: "update_brief", brief: { ...brief, constraints: ["Matched compute"] } };
    await h.call("checkpoint", input); const revision = h.state().revision;
    const replay = await h.call("checkpoint", input);
    expect(replay.structuredContent).toMatchObject({ replayed: true }); expect(h.state().revision).toBe(revision);
    await h.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    expect((await h.call("thesis", { ...h.identity(), brief })).isError).toBe(true);
    expect(h.worker).toHaveBeenCalledTimes(2);
  });

  it("halts at a tool boundary after interactive intervention", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate();
    await h.call("thesis", { ...h.identity(), brief }); await h.emit("input", { source: "interactive", text: "Change the assumption" });
    expect((await h.call("antithesis", h.identity())).isError).toBe(true);
    expect(h.state()).toMatchObject({ lifecycle: "paused", phase: "antithesis" });
    expect(h.worker).toHaveBeenCalledTimes(1);
    expect((await h.call("checkpoint", { ...h.identity(), action: "update_brief", brief: { ...brief, context: "New evidence changes the original premise." } })).isError).not.toBe(true);
    expect(h.state()).toMatchObject({ lifecycle: "paused", phase: "thesis", thesis: null });
  });

  it("saves a live user intervention directly at the next safe checkpoint boundary", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate();
    await h.call("thesis", { ...h.identity(), brief });
    await h.emit("input", { source: "rpc", text: "Use a different causal premise" });
    const result = await h.call("checkpoint", { ...h.identity(), action: "update_brief", brief: { ...brief, assumptions: ["A new premise"] } });
    expect(result.isError).not.toBe(true);
    expect(h.state()).toMatchObject({ lifecycle: "paused", phase: "thesis", thesis: null });
    expect(h.state().brief!.assumptions).toEqual(["A new premise"]);
    expect(h.worker).toHaveBeenCalledTimes(1);
    expect((await h.call("thesis", { ...h.identity(), brief })).isError).toBe(true);
  });

  it("cancels startup preflight without leaving an execution lock or authorizing inference", async () => {
    const h = harness({ createRuntime: () => new Promise(() => undefined) });
    const starting = h.command("aufheben", "Question"); await Promise.resolve();
    await h.command("aufheben-pause"); await starting;
    expect(h.api.sendUserMessage).not.toHaveBeenCalled(); expect(currentState(h.ctx)).toBeUndefined();
    expect(h.worker).not.toHaveBeenCalled();
  });

  it("does not abort unrelated main work, starts no overlapping research, and never reopens stopped exploration", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate(); await h.round(); await h.emit("agent_settled");
    await h.command("aufheben-pause"); expect(h.ctx.abort).not.toHaveBeenCalled();
    await h.command("aufheben-stop"); expect(h.state().lifecycle).toBe("closed"); expect(h.ctx.abort).not.toHaveBeenCalled();
    await h.command("aufheben-next"); expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("closed"), "error");
    await h.command("aufheben", "New question"); await h.command("aufheben", "Overlap");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("requires trust and a valid model pair before creating an exploration", async () => {
    const h = harness({ createRuntime: async () => ({ getModel: () => undefined, getAvailableSnapshot: () => [] }) as never });
    await h.command("aufheben", "Question");
    expect(currentState(h.ctx)).toBeUndefined(); expect(h.worker).not.toHaveBeenCalled();
    vi.mocked(h.ctx.isProjectTrusted).mockReturnValue(false);
    await h.command("aufheben", "Question");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Trust"), "error");
  });

  it("discards late results after pause and holds the cleanup lock", async () => {
    let resolve!: (result: RoleResult<unknown>) => void;
    const h = harness({ runRole: <T>() => new Promise<RoleResult<T>>((done) => { resolve = done as typeof resolve; }) });
    await h.command("aufheben", "Question"); await h.activate();
    const running = h.call("thesis", { ...h.identity(), brief });
    const paused = h.command("aufheben-pause");
    await h.command("aufheben-next"); expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(h.ctx.abort).toHaveBeenCalledTimes(1);
    resolve({ artifact: rawThesis, worker: { file: "/tmp/fake.jsonl", sessionId: "fake", leafId: "fake", ownerSessionId: "fake" }, usage, results: [] });
    await Promise.all([running, paused]);
    expect(h.state()).toMatchObject({ lifecycle: "paused", phase: "thesis", thesis: null, runningRole: null });
    expect(h.state().workers.thesizer).toBeNull();
    expect(h.state().reportedUsage).toEqual(usage);
  });

  it("keeps failed-call usage, pauses, and never automatically retries", async () => {
    const h = harness({ runRole: async () => { throw new RoleRequestError("Role output was invalid after one bounded repair.", usage,
      [{ sessionFile: "/tmp/failed.jsonl", usage }]); } });
    await h.command("aufheben", "Question"); await h.activate();
    const result = await h.call("thesis", { ...h.identity(), brief });
    expect(result).toMatchObject({ isError: true, usage: { totalTokens: 30 } });
    expect(h.state()).toMatchObject({ lifecycle: "paused", reportedUsage: usage });
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("restores branch-local snapshots without inference and rejects corrupt versions", async () => {
    const h = harness(); await h.command("aufheben", "Question"); const original = h.manager.getLeafId()!;
    await h.activate(); await h.round(); await h.emit("agent_settled");
    const finished = h.manager.getLeafId()!;
    h.manager.branch(original); await h.emit("session_tree");
    expect(h.state()).toMatchObject({ lifecycle: "paused", phase: "thesis", thesis: null });
    expect(h.worker).toHaveBeenCalledTimes(2);
    h.manager.branch(finished); await h.emit("session_tree"); expect(h.state().phase).toBe("awaiting_user");
    h.manager.appendCustomEntry(STATE_ENTRY, { version: 999 });
    await h.command("aufheben-status"); expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("corrupt"), "error");
    await h.command("aufheben", "Fresh question after corrupted state");
    expect(h.state()).toMatchObject({ question: "Fresh question after corrupted state", phase: "thesis" });
  });

  it("resumes no saved paid inference even when another controller is created", async () => {
    const h = harness(); await h.command("aufheben", "Question"); await h.activate();
    await h.call("thesis", { ...h.identity(), brief });
    const restored = harness({}, h.manager); await restored.emit("session_start");
    expect(restored.state()).toMatchObject({ lifecycle: "paused", phase: "antithesis" });
    expect(restored.worker).not.toHaveBeenCalled();
    await restored.command("aufheben-next"); await restored.activate();
    await restored.call("antithesis", restored.identity());
    expect(restored.worker.mock.calls[0]![0].state.workers.thesizer).toEqual(h.state().workers.thesizer);
  });
});

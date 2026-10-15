import { describe, expect, it, vi } from "vitest";
import { findLastChairAnswer, readRun } from "../src/state.js";
import { findLastReviewReport } from "../src/report-state.js";
import { brief, config, harness, runtime, success, usage } from "./fixtures.js";

describe("main-session Council workflow", () => {
  it("starts an ordinary main turn, accepts a contextual brief, and leaves synthesis to the main Chair", async () => {
    const h = harness(); await h.command();
    expect(h.worker).not.toHaveBeenCalled();
    expect(h.api.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("existing main session"), { expandPromptTemplates: false });
    const prompt = await h.activate();
    expect(prompt.sections).toMatchObject({ existing: "Keep coding instructions", council: expect.stringContaining("Never create or call a separate Chair agent") });
    const result = await h.review();
    expect(h.worker).toHaveBeenCalledTimes(1); expect(h.worker.mock.calls[0]![0]).toContain(brief);
    expect(h.worker.mock.calls[0]![0]).toContain(h.state().prompt);
    expect(h.output(result)).toMatchObject({ phase: "chair", error: null, anonymousReviews: [{ label: "Review 1" }] });
    expect(JSON.stringify(h.output(result))).not.toContain("private-reviewer"); expect(JSON.stringify(h.output(result))).not.toContain("fake/reviewer");
    expect(result.usage).toEqual(usage); expect(result.details).toMatchObject({ results: [{ sessionFile: expect.any(String), usage }] });
    await h.finish();
    expect(h.state().phase).toBe("complete"); expect(findLastChairAnswer(h.manager.getBranch())).toContain("## Final Answer");
    expect(h.api.sendMessage).not.toHaveBeenCalled();
    await h.command("council-copy"); expect(h.copyText).toHaveBeenCalledWith(h.state().answer);
  });
  it("checks only Reviewers without starting a batch or a main turn", async () => {
    const h = harness(); await h.command("council-check");
    expect(h.worker).not.toHaveBeenCalled(); expect(h.api.sendUserMessage).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("current main model is the Chair"), "info");
  });
  it("requires trust, idle ownership, valid models and explicit /council permission", async () => {
    const h = harness(); vi.mocked(h.ctx.isProjectTrusted).mockReturnValue(false);
    await h.command(); await h.command("council-check"); expect(h.loadConfig).not.toHaveBeenCalled();
    vi.mocked(h.ctx.isProjectTrusted).mockReturnValue(true); vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    await h.command(); expect(h.loadConfig).not.toHaveBeenCalled();
    vi.mocked(h.ctx.isIdle).mockReturnValue(true); await h.command();
    expect((await h.review()).isError).toBe(true); expect(h.worker).not.toHaveBeenCalled();
    const invalid = harness({ createRuntime: async () => ({ getModel: () => undefined, getAvailableSnapshot: () => [] }) as never });
    await invalid.command(); expect(readRun(invalid.ctx)).toBeUndefined(); expect(invalid.worker).not.toHaveBeenCalled();
  });
  it("replays the accepted batch without charging and rejects altered or stale requests", async () => {
    const h = harness(); await h.command(); await h.activate();
    const input = { runId: h.state().id, brief }; await h.review(input);
    expect(h.output(await h.review(input)).replayed).toBe(true); expect((await h.review(input)).usage).toBeUndefined();
    expect((await h.review({ ...input, brief: "Different premise" })).isError).toBe(true);
    expect((await h.review({ ...input, runId: "cf2dc1cd-e6fc-446f-b39b-c3008c435a2e" })).isError).toBe(true);
    expect(h.worker).toHaveBeenCalledTimes(1);
  });
  it("persists insufficient-quorum reports but never records a successful Chair answer", async () => {
    const h = harness({ runReviewers: async () => ({ successes: [], failures: [{ index: 0, kind: "model", error: "PRIVATE_PROVIDER_RESPONSE" }] }) });
    await h.command(); await h.activate(); const result = await h.review();
    expect(result.isError).toBe(true); expect(h.output(result).error).toContain("Chair skipped");
    expect(JSON.stringify(h.output(result))).not.toContain("PRIVATE_PROVIDER_RESPONSE");
    await h.finish("Insufficient reviewers; waiting."); expect(findLastChairAnswer(h.manager.getBranch())).toBeUndefined();
    await h.command("council-reviews"); expect(h.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "council-reviews" }), { triggerTurn: false });
  });
  it("does not spend child tokens when context is ambiguous or after the completed turn", async () => {
    const h = harness(); await h.command(); await h.activate(); await h.finish("Which method do you mean?");
    expect(h.state().phase).toBe("interrupted"); expect(h.worker).not.toHaveBeenCalled();
    expect((await h.review()).isError).toBe(true);
    await h.command(); await h.activate(); await h.review(); await h.finish();
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(2); expect(h.worker).toHaveBeenCalledTimes(1);
  });
  it("cancels Reviewers, holds cleanup ownership, and suppresses late success", async () => {
    let resolve!: (value: typeof success) => void;
    const h = harness({ runReviewers: () => new Promise((done) => { resolve = done; }) });
    await h.command(); await h.activate(); const pending = h.review();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const cancellation = h.command("council-cancel");
    await h.command(); expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(h.ctx.abort).toHaveBeenCalledTimes(1); resolve(success);
    await Promise.all([pending, cancellation]); await h.finish("Late answer", "aborted");
    expect(h.state().phase).toBe("cancelled"); expect(findLastReviewReport(h.manager.getBranch())).toBeUndefined();
    expect(findLastChairAnswer(h.manager.getBranch())).toBeUndefined();
  });
  it("cancels main Chair synthesis without deleting reviews or aborting unrelated work later", async () => {
    const h = harness(); await h.command(); await h.activate(); await h.review(); await h.command("council-cancel");
    expect(h.ctx.abort).toHaveBeenCalledTimes(1); await h.finish("Partial answer", "aborted");
    expect(findLastReviewReport(h.manager.getBranch())?.successes).toHaveLength(1);
    expect(findLastChairAnswer(h.manager.getBranch())).toBeUndefined();
    await h.command("council-cancel"); expect(h.ctx.abort).toHaveBeenCalledTimes(1);
  });
  it("treats interactive steering as intervention, not approval for another batch", async () => {
    const h = harness(); await h.command(); await h.activate(); await h.review();
    await h.emit("input", { source: "interactive", text: "Use a different premise" }); await h.finish("Updated discussion");
    expect(h.state().phase).toBe("interrupted"); expect(findLastChairAnswer(h.manager.getBranch())).toBeUndefined();
    expect((await h.review({ runId: h.state().id, brief: "Changed" })).isError).toBe(true); expect(h.worker).toHaveBeenCalledTimes(1);
  });
  it("restores branch-local reports/answers, survives reload, and never silently resumes inference", async () => {
    const h = harness(); await h.command(); const initial = h.manager.getLeafId()!;
    await h.activate(); await h.review(); await h.finish(); const finished = h.manager.getLeafId()!;
    const restored = harness({}, h.manager); await restored.emit("session_start"); await restored.command("council-copy");
    expect(restored.copyText).toHaveBeenCalledWith(h.state().answer); expect(restored.worker).not.toHaveBeenCalled();
    h.manager.branch(initial); await restored.emit("session_tree"); expect(restored.state().phase).toBe("interrupted");
    expect(findLastReviewReport(h.manager.getBranch())).toBeUndefined(); expect(findLastChairAnswer(h.manager.getBranch())).toBeUndefined();
    h.manager.branch(finished); await restored.emit("session_tree"); expect(restored.state().phase).toBe("complete");
  });
  it("cancels shutdown work, discards late results, and restores it as interrupted without inference", async () => {
    let resolve!: (value: typeof success) => void;
    let signal!: AbortSignal;
    const h = harness({ runReviewers: (...args) => { signal = args[5]!; return new Promise((done) => { resolve = done; }); } });
    await h.command(); await h.activate(); const pending = h.review();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const stopped = h.emit("session_shutdown"); expect(signal.aborted).toBe(true);
    resolve(success); await Promise.all([pending, stopped]);
    expect(findLastReviewReport(h.manager.getBranch())).toBeUndefined();
    const restored = harness({}, h.manager); await restored.emit("session_start");
    expect(restored.state().phase).toBe("interrupted"); expect(restored.worker).not.toHaveBeenCalled();
  });

  it("releases failures and snapshots configuration once per run", async () => {
    let nextConfig = config;
    const h = harness({ loadConfig: async () => nextConfig, createRuntime: async () => runtime });
    await h.command(); nextConfig = { ...config, chair: { systemPrompt: "New prompt" } }; await h.activate();
    expect(h.state().config.chair.systemPrompt).toBe(""); await h.review(); await h.finish();
    await h.command(); expect(h.state().config.chair.systemPrompt).toBe("New prompt");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import councilExtension from "../src/index.js";
import { findLastChairAnswer, readRun } from "../src/state.js";
import { findLastReviewReport } from "../src/report-state.js";
import { brief, config, rawReview } from "./fixtures.js";
import { answer, fakeRuntime } from "./sdk-runtime.js";

const finalAnswer = "## Concerns\n- [HIGH] Missing compute-matched baseline\n  - Scope: COMMON — Review 1, Review 2 (2/2)\n  - Reviewer severity: Review 1=HIGH; Review 2=HIGH\n  - Chair assessment: Causal attribution needs the control.\n  - Resolution: Match compute.\n\n## Final Answer\nTest the proposed mechanism against a compute-matched baseline.";
describe("real Pi SDK Council integration with fake inference", () => {
  let dir: string; let session: AgentSession | undefined;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-council-sdk-")); vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent")); });
  afterEach(async () => {
    if (session) { await session.abort(); session.dispose(); session = undefined; }
    vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
  });
  async function setup(hang: "reviewer" | "chair" | undefined = undefined) {
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    manager.appendMessage({ role: "user", content: "UNSELECTED_CONVERSATION_CONTEXT_63842", timestamp: Date.now() });
    const ctx = { cwd: dir, sessionManager: manager } as unknown as ExtensionContext;
    const models: string[] = []; const reviewerContexts: string[] = []; const mainContexts: string[] = [];
    let signalStarted!: () => void; let aborted = false;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const runtime = await fakeRuntime(async (model, context, options) => {
      models.push(model.id);
      if (model.id === "reviewer") {
        reviewerContexts.push(JSON.stringify(context));
        if (hang === "reviewer") {
          signalStarted(); return new Promise((resolve) => options!.signal!.addEventListener("abort", () => { aborted = true; resolve(answer(model, [], "aborted")); }, { once: true }));
        }
        const index = (reviewerContexts.length - 1) % 2;
        const previous = readRun(ctx)!.continuation!.reviews[index]?.activeConcerns ?? [];
        return answer(model, [{ type: "text", text: JSON.stringify(rawReview(`PRIVATE_FINDING_${reviewerContexts.length}`, previous)) }]);
      }
      mainContexts.push(JSON.stringify(context)); const state = readRun(ctx)!;
      if (state.phase === "prepare") return answer(model, [{ type: "toolCall", id: "review-call", name: "council_review", arguments: { runId: state.id, brief } }], "toolUse");
      if (hang === "chair") {
        signalStarted(); return new Promise((resolve) => options!.signal!.addEventListener("abort", () => { aborted = true; resolve(answer(model, [], "aborted")); }, { once: true }));
      }
      return answer(model, [{ type: "text", text: finalAnswer }]);
    });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const copyText = vi.fn(async (_text: string) => ({ method: "macos" as const, terminal: false }));
    const roster = { ...config, reviewers: [config.reviewers[0]!, { ...config.reviewers[0]!, name: "another-private-reviewer" }],
      minSuccess: 2, maxConcurrency: hang === "reviewer" ? 1 : 2 };
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => councilExtension(pi, { loadConfig: async () => roster, createRuntime: async () => runtime, copyText })] });
    await loader.reload(); settings.setProjectTrusted(true);
    session = (await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader, settingsManager: settings,
      modelRuntime: runtime, model: runtime.getModel("fake", "main")!, sessionManager: manager })).session;
    const errors: string[] = []; await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
    const settled = () => new Promise<void>((resolve) => {
      const unsubscribe = session!.subscribe((event) => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
    });
    return { manager, models, reviewerContexts, mainContexts, errors, copyText, started, settled,
      state: () => readRun(ctx)!, aborted: () => aborted };
  }
  it("returns independent reviews to the same main model, captures its normal answer and reports nested usage", async () => {
    const h = await setup(); const done = h.settled();
    await session!.prompt("/council Review this method using our conversation"); await done;
    expect(h.errors).toEqual([]); expect(h.models).toEqual(["main", "reviewer", "reviewer", "main"]);
    expect(h.mainContexts[0]).toContain("UNSELECTED_CONVERSATION_CONTEXT_63842");
    expect(h.reviewerContexts.every((value) => !value.includes("UNSELECTED_CONVERSATION_CONTEXT_63842"))).toBe(true);
    expect(h.reviewerContexts.every((value) => value.includes("sharedBrief"))).toBe(true);
    expect(h.mainContexts[1]).toContain('"toolName":"council_review"'); expect(h.mainContexts[1]).toContain("Review 2");
    expect(h.mainContexts[1]).not.toContain("another-private-reviewer");
    expect(h.state()).toMatchObject({ phase: "complete", answer: finalAnswer });
    expect(session!.getLastAssistantText()).toBe(finalAnswer);
    expect(findLastChairAnswer(h.manager.getBranch())).toBe(finalAnswer);
    expect(session!.getActiveToolNames()).toContain("bash");
    const tool = session!.messages.find((message) => message.role === "toolResult" && message.toolName === "council_review");
    expect(tool).toMatchObject({ usage: { totalTokens: 60 }, details: { results: expect.arrayContaining([{ sessionFile: expect.any(String), usage: expect.any(Object) }]) } });
    expect(h.manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType.includes("final"))).toBe(false);
    await session!.prompt("/council-copy"); expect(h.copyText).toHaveBeenCalledWith(finalAnswer);
  }, 15000);
  it("continues separate histories even with the same model, charges only new usage, and starts fresh on /council", async () => {
    const h = await setup(); let done = h.settled();
    await session!.prompt("/council Review the mechanism"); await done;
    const first = h.state(); const refs = first.continuation!.workers;
    expect(refs.every(Boolean)).toBe(true); expect(refs[0]!.file).not.toBe(refs[1]!.file);
    done = h.settled(); await session!.prompt("/council-next We added the control; reassess the remaining concerns."); await done;
    const second = h.state();
    expect(second.id).not.toBe(first.id);
    expect(second.continuation).toMatchObject({ id: first.continuation!.id, round: 2,
      focus: "We added the control; reassess the remaining concerns.", previousAnswer: finalAnswer });
    expect(second.continuation!.workers.map((ref) => ref!.file)).toEqual(refs.map((ref) => ref!.file));
    expect(second.continuation!.reviews.map((review) => review!.activeConcerns[0]!.id)).toEqual(["R1.V1.C1", "R1.V2.C1"]);
    expect(second.continuation!.reviews.every((review) => review!.assessments[0]!.disposition === "retained")).toBe(true);
    for (const context of h.reviewerContexts.slice(2)) {
      expect([context.includes("PRIVATE_FINDING_1"), context.includes("PRIVATE_FINDING_2")].filter(Boolean)).toHaveLength(1);
      expect(context).not.toContain(finalAnswer);
    }
    const results = session!.messages.filter((message) => message.role === "toolResult" && message.toolName === "council_review");
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ usage: { totalTokens: 60 } });
    done = h.settled(); await session!.prompt("/council Review independently from scratch"); await done;
    expect(h.state().continuation).toMatchObject({ round: 1, previousAnswer: null });
    expect(h.state().continuation!.id).not.toBe(first.continuation!.id);
    expect(h.reviewerContexts.slice(4).every((context) => !context.includes("PRIVATE_FINDING_"))).toBe(true);
    expect(h.errors).toEqual([]);
  }, 15000);

  it.each(["reviewer", "chair"] as const)("cancels owned %s work without accepting a late synthesis", async (stage) => {
    const h = await setup(stage); const done = h.settled();
    await session!.prompt("/council Test cancellation"); await h.started;
    await session!.prompt("/council-cancel"); await done;
    expect(h.errors).toEqual([]); expect(h.aborted()).toBe(true); expect(h.state().phase).toBe("cancelled");
    expect(findLastChairAnswer(h.manager.getBranch())).toBeUndefined();
    expect(findLastReviewReport(h.manager.getBranch())?.successes.length ?? 0).toBe(stage === "chair" ? 2 : 0);
    if (stage === "reviewer") expect(h.models.filter((model) => model === "reviewer")).toHaveLength(1);
  }, 15000);
});

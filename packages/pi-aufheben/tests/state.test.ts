import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { acceptRole, advance, addUsage, assertIdentity, assertStage, completeRound, continueExploration,
  pauseState, stateSchema, updateBrief } from "../src/state.js";
import { currentState, saveState, STATE_ENTRY } from "../src/storage.js";
import { describeState } from "../src/progress.js";
import { antithesis, brief, exploration, synthesis, thesis, usage } from "./fixtures.js";

const worker = { file: "/tmp/worker.jsonl", sessionId: "worker", leafId: "leaf", ownerSessionId: "parent" };
const receipt = { kind: "thesis" as const, digest: "digest" };
const withThesis = () => acceptRole(advance(exploration(), { brief }), "thesizer", thesis, worker, usage, receipt);
const finished = () => completeRound(acceptRole(withThesis(), "antithesizer", antithesis,
  { ...worker, sessionId: "other-worker" }, usage, { kind: "antithesis", digest: "other-digest" }), synthesis(), "checkpoint");

describe("pure exploration transitions", () => {
  it("retains role boundaries, configuration snapshots, and monotonically increasing revisions", () => {
    const initial = exploration(); Object.freeze(initial);
    const accepted = withThesis();
    expect(initial).toMatchObject({ revision: 0, phase: "thesis", workers: { thesizer: null } });
    expect(accepted).toMatchObject({ revision: 2, phase: "antithesis", knownClaimIds: ["R1.T1"] });
    const complete = finished(); const next = continueExploration(complete, "New direction");
    expect(next).toMatchObject({ round: 2, phase: "thesis", thesis: null, antithesis: null, config: initial.config,
      workers: complete.workers, roundStart: complete.workers, lastSynthesis: complete.lastSynthesis });
    expect(next.revision).toBeGreaterThan(complete.revision);
  });

  it("keeps accepted stages for unchanged brief/focus and invalidates changed partial premises", () => {
    const paused = pauseState(withThesis(), "Interrupted");
    const same = updateBrief(paused, brief);
    expect(same.thesis).toEqual(paused.thesis); expect(same.workers).toEqual(paused.workers);
    const retry = continueExploration(same, "");
    expect(retry.phase).toBe("antithesis");
    const changed = updateBrief(paused, { ...brief, assumptions: ["A different causal assumption"] });
    expect(changed).toMatchObject({ lifecycle: "paused", phase: "thesis", thesis: null,
      knownClaimIds: [], workers: paused.roundStart });
    expect(paused.thesis).not.toBeNull();
  });

  it("does not invalidate completed history when saving a future-round brief", () => {
    const complete = finished(); const adjusted = updateBrief(complete, { ...brief, constraints: ["Budget: two trials"] });
    expect(adjusted).toMatchObject({ phase: "awaiting_user", round: 1, thesis: complete.thesis, lastSynthesis: complete.lastSynthesis });
  });

  it("rejects stopped/running continuation, stage violations, and stale identity", () => {
    const state = exploration();
    expect(() => continueExploration(pauseState(state, "Stopped", true), "")).toThrow(/closed/);
    expect(() => continueExploration(advance(state, { runningRole: "thesizer" }), "")).toThrow(/cleanup/);
    expect(() => assertStage(state, "antithesis")).toThrow();
    expect(() => assertStage(pauseState(state, "Paused"), "thesis")).toThrow();
    expect(() => assertIdentity(state, { explorationId: state.id, round: 2, expectedRevision: 0 })).toThrow(/Stale/);
  });

  it("rejects inconsistent persisted phases instead of inventing missing artifacts", () => {
    expect(stateSchema.safeParse({ ...exploration(), phase: "synthesis" }).success).toBe(false);
    expect(stateSchema.safeParse({ ...exploration(), lifecycle: "paused", runningRole: "thesizer" }).success).toBe(false);
    expect(stateSchema.safeParse({ ...exploration(), version: 2 }).success).toBe(false);
  });

  it("adds optional usage counters and preserves unknown usage", () => {
    expect(addUsage(null, null)).toBeNull(); expect(addUsage(null, usage)).toEqual(usage);
    expect(addUsage({ ...usage, cacheWrite1h: 5, reasoning: 10 }, usage)).toMatchObject({ cacheWrite1h: 5, reasoning: 10, totalTokens: 60 });
  });

  it("bounds status output and escapes hostile terminal controls", () => {
    const text = describeState({ ...exploration(), question: "\u001b]52;c;payload\u0007" + "x".repeat(16000) });
    expect(text).not.toContain("\u001b"); expect(text).not.toContain("\u0007"); expect(text.length).toBeLessThan(3000);
    expect(text).toContain("\\u001b");
  });
});

describe("versioned branch-local storage", () => {
  function store() {
    const manager = SessionManager.inMemory("/tmp");
    const ctx = { cwd: "/tmp", sessionManager: manager } as unknown as ExtensionContext;
    const api = { appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) } as unknown as ExtensionAPI;
    return { manager, ctx, api };
  }
  it("uses canonical custom entries and restores only the selected parent branch", () => {
    const h = store(); saveState(h.api, exploration()); const first = h.manager.getLeafId()!;
    saveState(h.api, finished()); const last = h.manager.getLeafId()!;
    expect(currentState(h.ctx)?.phase).toBe("awaiting_user");
    h.manager.branch(first); expect(currentState(h.ctx)?.phase).toBe("thesis");
    h.manager.branch(last); expect(currentState(h.ctx)?.phase).toBe("awaiting_user");
    const entries = h.manager.getBranch().filter((entry) => entry.type === "custom");
    expect(entries).toHaveLength(2); expect(entries[0]).toMatchObject({ customType: STATE_ENTRY, data: { version: 1, eventId: expect.any(String) } });
  });
  it("rejects corrupt latest snapshots and cwd mismatches without falling back to stale state", () => {
    const h = store(); saveState(h.api, finished());
    h.manager.appendCustomEntry(STATE_ENTRY, { version: 999 });
    expect(() => currentState(h.ctx)).toThrow(/corrupt/);
    saveState(h.api, { ...exploration(), cwd: "/different-project" });
    expect(() => currentState(h.ctx)).toThrow(/directory/);
  });
  it("ignores unrelated custom entries and has no inference or worker I/O on a fresh branch", () => {
    const h = store(); h.manager.appendCustomEntry("unrelated", { version: 2 });
    expect(currentState(h.ctx)).toBeUndefined();
  });
});

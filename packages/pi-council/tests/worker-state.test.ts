import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectWorker, openWorker, workerCheckpoint, type WorkerRequest } from "../src/worker-state.js";
import { runReviewers } from "../src/reviewer-runner.js";
import { sessionAccounting } from "../src/usage.js";
import { config, usage, rawReview } from "./fixtures.js";
import { answer, fakeRuntime } from "./sdk-runtime.js";

describe("Council accepted child checkpoints", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "council-history-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
  const request = (): WorkerRequest => ({ councilId: "council-a", index: 0, ref: null, ownerSessionId: "parent-a", sessionDir: dir });
  function saved() {
    const input = request(); const manager = openWorker(input, dir);
    manager.appendMessage({ role: "user", content: "ACCEPTED_CONTEXT", timestamp: Date.now() });
    // The first assistant flushes a newly created Pi session to disk.
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ACCEPTED_ANSWER" }],
      api: "openai-completions", provider: "fake", model: "reviewer", usage, stopReason: "stop", timestamp: Date.now() });
    return { manager, input: { ...input, ref: workerCheckpoint(manager, input) } };
  }
  it("reopens the same file at its accepted leaf and preserves independent reviewer identity", () => {
    const h = saved(); const reopened = openWorker(h.input, dir);
    expect(reopened.getSessionFile()).toBe(h.input.ref.file);
    expect(reopened.getLeafId()).toBe(h.input.ref.leafId);
    expect(() => openWorker({ ...h.input, index: 1 }, dir)).toThrow(/ownership/);
    expect(() => openWorker({ ...h.input, councilId: "another-council" }, dir)).toThrow(/ownership/);
  });
  it("copies only accepted history after rewind, without leaking a future result or mutating the abandoned file", () => {
    const h = saved(); h.manager.appendMessage({ role: "user", content: "FUTURE_SECRET", timestamp: Date.now() });
    const future = h.manager.getLeafId(); const branched = openWorker(h.input, dir);
    expect(branched.getSessionFile()).not.toBe(h.input.ref.file);
    expect(JSON.stringify(branched.getBranch())).toContain("ACCEPTED_ANSWER");
    expect(JSON.stringify(branched.getBranch())).not.toContain("FUTURE_SECRET");
    expect(SessionManager.open(h.input.ref.file).getLeafId()).toBe(future);
    expect(sessionAccounting(branched, new Set(branched.getBranch().map((entry) => entry.id)))).toBeUndefined();
  });
  it("copies history for another parent-session owner even at an identical leaf", () => {
    const h = saved(); const branch = openWorker({ ...h.input, ownerSessionId: "forked-parent" }, dir);
    expect(branch.getSessionFile()).not.toBe(h.input.ref.file);
    expect(JSON.stringify(branch.getBranch())).toContain("ACCEPTED_CONTEXT");
  });
  it("rejects missing and mismatched memory instead of creating a replacement", async () => {
    const h = saved();
    expect(() => inspectWorker({ ...h.input, ref: { ...h.input.ref, leafId: "absent" } }, dir)).toThrow(/corrupt/);
    expect(() => inspectWorker({ ...h.input, ref: { ...h.input.ref, sessionId: "wrong" } }, dir)).toThrow(/corrupt/);
    expect(() => inspectWorker(h.input, "/another-project")).toThrow(/corrupt/);
    await rm(h.input.ref.file);
    expect(() => inspectWorker(h.input, dir)).toThrow(/Missing/);
  });
  it("validates every saved reviewer before any inference", async () => {
    let calls = 0;
    const runtime = await fakeRuntime((model) => { calls++; return answer(model, [{ type: "text", text: "Review" }]); });
    const h = saved(); await rm(h.input.ref.file);
    await expect(runReviewers("Brief", { ...config, reviewers: [config.reviewers[0]!, config.reviewers[0]!] }, runtime, dir,
      undefined, undefined, undefined, undefined,
      { councilId: "council-a", workers: [null, h.input.ref], ownerSessionId: "parent-a", sessionDir: dir })).rejects.toThrow(/Missing/);
    expect(calls).toBe(0);
  });
  it("keeps failures out of accepted memory and bills only each attempt", async () => {
    let calls = 0; const contexts: string[] = []; const accounting: number[] = [];
    const runtime = await fakeRuntime((model, context) => {
      contexts.push(JSON.stringify(context)); calls++;
      return answer(model, [{ type: "text", text: calls === 2 ? "FAILED_FUTURE" : JSON.stringify(rawReview("ACCEPTED_RESULT")) }], calls === 2 ? "error" : "stop");
    });
    let persistence = { councilId: "council-a", workers: [null] as WorkerRequest["ref"][], ownerSessionId: "parent-a", sessionDir: dir };
    const run = () => runReviewers("Inspect", config, runtime, dir, undefined, undefined, undefined,
      (entry) => accounting.push(entry.usage.totalTokens), persistence);
    const first = await run(); persistence = { ...persistence, workers: first.workers! };
    const second = await run(); expect(second.successes).toHaveLength(0);
    expect(second.workers).toEqual(first.workers);
    const third = await run(); expect(third.successes).toHaveLength(1);
    expect(third.workers![0]!.file).not.toBe(first.workers![0]!.file);
    expect(contexts[2]).toContain("ACCEPTED_RESULT"); expect(contexts[2]).not.toContain("FAILED_FUTURE");
    expect(accounting).toEqual([30, 30, 30]);
  });

  it("retains accepted compaction and excludes prior usage from subsequent accounting", () => {
    const h = saved();
    h.manager.appendCompaction("ACCEPTED_SUMMARY", h.input.ref.leafId, 100);
    const input = { ...h.input, ref: workerCheckpoint(h.manager, h.input) };
    const reopened = openWorker(input, dir);
    expect(reopened.buildSessionContext().messages.some((message) => message.role === "compactionSummary")).toBe(true);
    const oldIds = new Set(reopened.getBranch().map((entry) => entry.id));
    reopened.appendUsage("test", "fake", "reviewer", usage);
    expect(sessionAccounting(reopened, oldIds)?.usage).toEqual(usage);
  });
});

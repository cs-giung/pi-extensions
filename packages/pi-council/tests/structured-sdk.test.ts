import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReviewers } from "../src/reviewer-runner.js";
import { config, rawReview } from "./fixtures.js";
import { answer, fakeRuntime } from "./sdk-runtime.js";
import type { ReviewArtifact } from "../src/review-artifact.js";
import type { WorkerRef } from "../src/worker-state.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "council-structured-")); vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent")); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
describe("structured reviews through real SDK sessions with fake providers", () => {
  it("repairs once in the same child session, includes repair usage and accepts only the validated checkpoint", async () => {
    let calls = 0; const contexts: string[] = []; const tokens: number[] = [];
    const runtime = await fakeRuntime((model, context) => {
      calls++; contexts.push(JSON.stringify(context));
      return answer(model, [{ type: "text", text: calls === 1 ? "Not JSON" : JSON.stringify(rawReview()) }]);
    });
    const result = await runReviewers("Review the claim", config, runtime, dir, undefined, undefined, undefined,
      (entry) => tokens.push(entry.usage.totalTokens), { councilId: "repair", workers: [null], ownerSessionId: "parent", sessionDir: dir, round: 1, reviews: [null] });
    expect(calls).toBe(2); expect(result.failures).toEqual([]); expect(tokens).toEqual([60]);
    expect(contexts[1]).toContain("format/reference repair");
    expect(result.successes[0]!.artifact?.activeConcerns[0]!.id).toBe("R1.V1.C1");
    const worker = result.workers![0]!;
    expect(SessionManager.open(worker.file).getLeafId()).toBe(worker.leafId);
    expect(SessionManager.open(worker.file).getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(2);
  });
  it("preserves accepted ledgers after invalid output and carries resolution across restart and continuation", async () => {
    let mode: "first" | "invalid" | "resolved" = "first"; let calls = 0;
    const runtime = await fakeRuntime((model) => {
      calls++;
      const output = mode === "invalid" ? { ...rawReview(), assessments: [{ concernId: "R1.V99.C1", disposition: "resolved", reason: "Forged reference" }] }
        : mode === "resolved" ? { concerns: [], assessments: [{ concernId: "R1.V1.C1", disposition: "resolved", reason: "A compute-matched baseline is now supplied." }],
          proposedAnswer: "The previous confounder has been addressed.", noConcernsReason: "No further material objection is supported." }
          : rawReview();
      return answer(model, [{ type: "text", text: JSON.stringify(output) }]);
    });
    let persistence = { councilId: "continued", workers: [null] as (WorkerRef | null)[], reviews: [null] as (ReviewArtifact | null)[],
      round: 1, ownerSessionId: "parent", sessionDir: dir };
    const run = () => runReviewers("Review the current brief", config, runtime, dir, undefined, undefined, undefined, undefined, persistence);
    const first = await run(); const accepted = first.successes[0]!.artifact!;
    persistence = { ...persistence, workers: first.workers!, reviews: [accepted], round: 2 };
    mode = "invalid"; const failed = await run();
    expect(failed.successes).toHaveLength(0); expect(failed.failures[0]!.kind).toBe("invalid-output");
    expect(failed.workers).toEqual(first.workers); expect(persistence.reviews[0]).toEqual(accepted);
    // Round 3 reopens the accepted round-1 leaf, excluding both invalid round-2 responses.
    persistence = { ...JSON.parse(JSON.stringify(persistence)), round: 3 };
    mode = "resolved"; const resolved = await run();
    expect(resolved.successes[0]!.artifact).toMatchObject({ round: 3, activeConcerns: [], assessments: [{ concernId: "R1.V1.C1", disposition: "resolved" }] });
    expect(resolved.workers![0]!.file).not.toBe(first.workers![0]!.file);
    expect(JSON.stringify(SessionManager.open(resolved.workers![0]!.file).getBranch())).not.toContain("Forged reference");
    expect(calls).toBe(4);
  });
});

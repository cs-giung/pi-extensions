import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runConfiguredSession, SessionExecutionError, type RunConfiguredSessionOptions } from "../src/agent-session.js";
import { parseCouncilConfig } from "../src/config.js";
import { runReviewers } from "../src/reviewer-runner.js";
import { rawReview } from "./fixtures.js";

vi.mock("../src/agent-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-session.js")>();
  return { ...actual, runConfiguredSession: vi.fn() };
});

const config = parseCouncilConfig(`
reviewers:
  - model: provider/first
  - model: provider/second
  - model: provider/third
minSuccess: 2
maxConcurrency: 2
`);
const runtime = {} as ModelRuntime;

beforeEach(() => { vi.mocked(runConfiguredSession).mockReset(); });

describe("bounded reviewer execution", () => {
  it("limits concurrent sessions and preserves configuration order", async () => {
    const pending: Array<(value: string) => void> = [];
    vi.mocked(runConfiguredSession).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const result = runReviewers("Question", config, runtime, "/tmp");
    expect(runConfiguredSession).toHaveBeenCalledTimes(2);
    pending[1]!(JSON.stringify(rawReview("second response")));
    await vi.waitFor(() => expect(runConfiguredSession).toHaveBeenCalledTimes(3));
    pending[2]!(JSON.stringify(rawReview("third response")));
    pending[0]!(JSON.stringify(rawReview("first response")));
    expect((await result).successes.map((review) => [review.index, review.artifact?.proposedAnswer])).toEqual([
      [0, "first response"], [1, "second response"], [2, "third response"],
    ]);
  });

  it("preserves failure order and error categories when sessions finish out of order", async () => {
    const pending: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> = [];
    vi.mocked(runConfiguredSession).mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const result = runReviewers("Question", { ...config, maxConcurrency: 3 }, runtime, "/tmp");
    pending[2]!.reject(new SessionExecutionError("idle-timeout", "No activity"));
    pending[1]!.resolve(JSON.stringify(rawReview("second response")));
    pending[0]!.reject("Unavailable");
    const completed = await result;
    expect(completed.successes.map((review) => review.index)).toEqual([1]);
    expect(completed.failures).toEqual([
      { index: 0, kind: "model", error: "Unavailable" },
      { index: 2, kind: "idle-timeout", error: "No activity" },
    ]);
  });

  it("does not create queued sessions after cancellation", async () => {
    const controller = new AbortController();
    vi.mocked(runConfiguredSession).mockImplementation((options: RunConfiguredSessionOptions) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    }));
    const result = runReviewers("Question", config, runtime, "/tmp", undefined, controller.signal);
    controller.abort();
    const completed = await result;
    expect(runConfiguredSession).toHaveBeenCalledTimes(2);
    expect(completed.failures).toHaveLength(3);
    expect(completed.failures[2]).toMatchObject({ index: 2, kind: "cancelled" });
  });

  it("creates no sessions when already cancelled", async () => {
    const result = await runReviewers("Question", config, runtime, "/tmp", undefined, AbortSignal.abort());
    expect(runConfiguredSession).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(3);
    expect(result.failures.every((failure) => failure.kind === "cancelled")).toBe(true);
  });

  it("continues queued reviewers after an individual failure", async () => {
    vi.mocked(runConfiguredSession).mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce(JSON.stringify(rawReview("second"))).mockResolvedValueOnce(JSON.stringify(rawReview("third")));
    const result = await runReviewers("Question", config, runtime, "/tmp");
    expect(result.successes).toHaveLength(2);
    expect(result.failures).toEqual([{ index: 0, kind: "model", error: "Unavailable" }]);
  });
});

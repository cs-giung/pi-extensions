import { describe, expect, it } from "vitest";
import { formatReviewerProgress } from "../src/progress.js";

describe("formatReviewerProgress", () => {
  it("shows each Reviewer state and the settled count", () => {
    expect(
      formatReviewerProgress([
        { label: "correctness", phase: "completed" },
        { label: "evidence", phase: "tool", toolName: "read" },
        { label: "Reviewer 3", phase: "thinking" },
        { label: "skeptic", phase: "failed" },
      ]),
    ).toBe(
      "Reviewers 2/4 | correctness:done | evidence:tool read | Reviewer 3:thinking | skeptic:failed",
    );
  });

  it("shows waiting and answer generation states", () => {
    expect(
      formatReviewerProgress([
        { label: "Reviewer 1", phase: "waiting" },
        { label: "Reviewer 2", phase: "answering" },
      ]),
    ).toBe("Reviewers 0/2 | Reviewer 1:waiting | Reviewer 2:answering");
  });
});

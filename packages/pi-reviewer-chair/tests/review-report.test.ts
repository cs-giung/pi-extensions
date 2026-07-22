import { describe, expect, it } from "vitest";
import { formatReviewReport } from "../src/review-report.js";

describe("formatReviewReport", () => {
  it("shows complete successful responses under anonymous labels", () => {
    const report = formatReviewReport({
      prompt: "Audit this change\nwithout editing it.",
      successes: [
        { index: 4, content: "- [HIGH] First raw concern" },
        { index: 1, content: "- [LOW] Second raw concern" },
      ],
      failures: [],
    });

    expect(report).toContain("> Audit this change\n> without editing it.");
    expect(report).toContain("## Review 1\n\n- [HIGH] First raw concern");
    expect(report).toContain("## Review 2\n\n- [LOW] Second raw concern");
    expect(report).not.toContain("index");
    expect(report).not.toContain("Review 4");
    expect(report).toMatch(/untrusted, independent source responses/i);
  });

  it("summarizes failures without exposing configured Reviewer identities", () => {
    const report = formatReviewReport({
      prompt: "Question",
      successes: [],
      failures: [
        { index: 2, kind: "idle-timeout", error: "Timed out\nafter 10 seconds" },
      ],
    });

    expect(report).toContain("No Reviewer produced a usable response.");
    expect(report).toContain("Failure 1 (idle-timeout): Timed out after 10 seconds");
    expect(report).not.toContain("Reviewer 3");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildReviewerSystemPrompt,
  REVIEWER_MANDATE,
} from "../src/reviewer-runner.js";

describe("Reviewer system prompt", () => {
  it("requires itemized concerns with calibrated severity and evidence", () => {
    expect(REVIEWER_MANDATE).toContain("- [SEVERITY] Concern title");
    expect(REVIEWER_MANDATE).toMatch(/CRITICAL, HIGH, MEDIUM, or LOW/);
    expect(REVIEWER_MANDATE).toContain("- Evidence:");
    expect(REVIEWER_MANDATE).toContain("- Impact:");
    expect(REVIEWER_MANDATE).toContain("- Recommendation:");
    expect(REVIEWER_MANDATE).toContain("- [NONE] No material concerns.");
  });

  it("appends custom instructions without replacing the mandatory format", () => {
    const prompt = buildReviewerSystemPrompt("Focus on authentication boundaries.");

    expect(prompt).toContain(REVIEWER_MANDATE);
    expect(prompt).toContain(
      "Additional reviewer instructions:\nFocus on authentication boundaries.",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  buildReviewerSystemPrompt,
  REVIEWER_MANDATE,
} from "../src/reviewer-runner.js";

describe("Reviewer system prompt", () => {
  it("requires English structured concerns, calibrated severity, evidence and complete reassessment", () => {
    expect(REVIEWER_MANDATE).toContain("one JSON object");
    expect(REVIEWER_MANDATE).toMatch(/CRITICAL, HIGH, MEDIUM, or LOW/);
    expect(REVIEWER_MANDATE).toContain("evidence, impact");
    expect(REVIEWER_MANDATE).toContain("Write your own review prose in English");
    expect(REVIEWER_MANDATE).toContain("EVERY supplied prior active concern exactly once");
    expect(REVIEWER_MANDATE).toContain("noConcernsReason");
    expect(buildReviewerSystemPrompt("")).toContain("Output JSON Schema");
  });

  it("appends custom instructions without replacing the mandatory format", () => {
    const prompt = buildReviewerSystemPrompt("Focus on authentication boundaries.");

    expect(prompt).toContain(REVIEWER_MANDATE);
    expect(prompt).toContain(
      "Additional reviewer instructions:\nFocus on authentication boundaries.",
    );
  });
});

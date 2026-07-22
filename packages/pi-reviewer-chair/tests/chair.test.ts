import { describe, expect, it } from "vitest";
import {
  buildChairPrompt,
  buildChairSystemPrompt,
  CHAIR_MANDATE,
} from "../src/chair.js";
import type { ReviewerSuccess } from "../src/reviewer-runner.js";

describe("Chair aggregation", () => {
  it("includes the original prompt and anonymous reviewer content", () => {
    const reviews: ReviewerSuccess[] = [
      { index: 7, content: "Candidate alpha" },
      { index: 2, content: "Candidate beta" },
    ];

    const prompt = buildChairPrompt("What is correct?", reviews);

    expect(prompt).toContain('"originalPrompt": "What is correct?"');
    expect(prompt).toContain('"label": "Review 1"');
    expect(prompt).toContain('"label": "Review 2"');
    expect(prompt).toContain("Candidate alpha");
    expect(prompt).toContain("Candidate beta");
    expect(prompt).not.toContain('"index"');
    expect(prompt).not.toContain("Review 7");
  });

  it("requires evidence-based synthesis instead of majority voting", () => {
    const prompt = buildChairPrompt("Choose the best answer", [
      { index: 0, content: "A" },
      { index: 1, content: "A" },
      { index: 2, content: "B with proof" },
    ]);

    expect(prompt).toMatch(/correctness, evidence, impact, and completeness/i);
    expect(prompt).toMatch(/rather than vote count/i);
    expect(CHAIR_MANDATE).toMatch(/Do not use simple majority voting/i);
    expect(CHAIR_MANDATE).toMatch(/untrusted source material/i);
    expect(CHAIR_MANDATE).toMatch(/Scope: COMMON/);
    expect(CHAIR_MANDATE).toMatch(/EXCLUSIVE/);
    expect(CHAIR_MANDATE).toMatch(/Reviewer severity:/);
    expect(CHAIR_MANDATE).toMatch(/Do not infer agreement from silence/);
    expect(CHAIR_MANDATE).toMatch(/## Final Answer/);
  });

  it("appends custom Chair instructions without replacing aggregation rules", () => {
    const prompt = buildChairSystemPrompt("Keep the final answer concise.");

    expect(prompt).toContain(CHAIR_MANDATE);
    expect(prompt).toContain(
      "Additional chair instructions:\nKeep the final answer concise.",
    );
  });
});

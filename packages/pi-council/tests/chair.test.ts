import { describe, expect, it } from "vitest";
import {
  buildChairSystemPrompt,
  CHAIR_MANDATE, chairInstructions, reviewerPrompt,
} from "../src/chair.js";
describe("Chair aggregation", () => {
  it("requires evidence-based synthesis instead of majority voting", () => {
    const prompt = chairInstructions("run", "Choose the best answer", "");

    expect(prompt).toMatch(/correctness, evidence, impact, and completeness/i);
    expect(prompt).toMatch(/Do not use simple majority voting/i);
    expect(CHAIR_MANDATE).toMatch(/Do not use simple majority voting/i);
    expect(CHAIR_MANDATE).toMatch(/untrusted source material/i);
    expect(CHAIR_MANDATE).toMatch(/Scope: COMMON/);
    expect(CHAIR_MANDATE).toMatch(/EXCLUSIVE/);
    expect(CHAIR_MANDATE).toMatch(/Reviewer severity:/);
    expect(CHAIR_MANDATE).toMatch(/Do not infer agreement from silence/);
    expect(CHAIR_MANDATE).toMatch(/## Final Answer/);
  });

  it("uses English handoffs and child reviews without changing the main answer language", () => {
    expect(chairInstructions("run", "Answer in Korean", "")).toContain("Write the handoff brief in English");
    expect(chairInstructions("run", "Answer in Korean", "")).toContain("Chair-only metadata");
    expect(reviewerPrompt("Answer in Korean", "A source excerpt")).toContain("Write your review in English regardless");
    expect(CHAIR_MANDATE).toContain("Respond in the user's requested language");
    expect(CHAIR_MANDATE).toContain("translate their findings for the user");
    expect(CHAIR_MANDATE).toContain("Refer to concern IDs");
  });

  it("appends custom Chair instructions without replacing aggregation rules", () => {
    const prompt = buildChairSystemPrompt("Keep the final answer concise.");

    expect(prompt).toContain(CHAIR_MANDATE);
    expect(prompt).toContain(
      "Additional chair instructions:\nKeep the final answer concise.",
    );
  });
});

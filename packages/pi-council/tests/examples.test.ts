import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCouncilConfig, DEFAULT_REVIEWER_TOOLS } from "../src/config.js";
import { buildReviewerSystemPrompt, REVIEWER_MANDATE } from "../src/reviewer-runner.js";
const source = readFileSync(new URL("../.pi/council.example.yaml", import.meta.url), "utf8");
describe("packaged Council example", () => {
  it("keeps independent reviewer defaults without a separate Chair model", () => {
    const config = parseCouncilConfig(source);
    expect(config.reviewers.length).toBeGreaterThan(0);
    expect(config.minSuccess).toBeLessThanOrEqual(config.reviewers.length);
    for (const reviewer of config.reviewers) { expect(reviewer.model).toContain("/"); expect(reviewer.tools).toEqual(DEFAULT_REVIEWER_TOOLS); }
    expect(config.chair).toEqual({ systemPrompt: expect.any(String) });
  });
  it("uses shared correctness criteria without freezing the model roster", () => {
    const config = parseCouncilConfig(source);
    expect(new Set(config.reviewers.map((reviewer) => reviewer.systemPrompt)).size).toBe(1);
    for (const reviewer of config.reviewers) {
      expect(buildReviewerSystemPrompt(reviewer.systemPrompt)).toContain(REVIEWER_MANDATE);
    }
  });
});

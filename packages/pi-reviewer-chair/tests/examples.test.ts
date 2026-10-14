import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReviewerChairConfig } from "../src/config.js";

const source = readFileSync(new URL("../.pi/reviewer-chair.example.yaml", import.meta.url), "utf8");

describe("packaged configuration example", () => {
  it("remains valid when personal model choices or reviewer counts change", () => {
    const config = parseReviewerChairConfig(source);
    expect(config.reviewers.length).toBeGreaterThanOrEqual(config.minSuccess);
    expect(config.maxConcurrency).toBeGreaterThan(0);
    for (const agent of [...config.reviewers, config.chair]) {
      expect(agent.model).toMatch(/^[^/\s]+\/\S+$/);
    }
  });

  it("uses distinct reviewer names and a shared correctness focus", () => {
    const config = parseReviewerChairConfig(source);
    const names = config.reviewers.flatMap((reviewer) => reviewer.name ? [reviewer.name] : []);
    expect(new Set(names).size).toBe(names.length);
    const prompts = config.reviewers.map((reviewer) => reviewer.systemPrompt);
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).toMatch(/factual and technical correctness/i);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReviewerChairConfig } from "../src/config.js";

const DEFAULT_REVIEWER_MODELS = [
  "openai-codex/gpt-5.6-luna",
  "google/gemini-3.5-flash",
  "opencode/deepseek-v4-flash-free",
];
const DEFAULT_CHAIR_MODEL = "openai-codex/gpt-5.6-sol";

describe("packaged configuration examples", () => {
  it("keeps distinct additional prompts in the diverse-focus preset", () => {
    const source = readFileSync(
      new URL("../.pi/reviewer-chair.example.yaml", import.meta.url),
      "utf8",
    );
    const config = parseReviewerChairConfig(source);
    const prompts = config.reviewers.map((reviewer) => reviewer.systemPrompt);

    expect(config.reviewers).toHaveLength(3);
    expect(new Set(prompts).size).toBe(3);
    expect(prompts.every((prompt) => prompt.length > 0)).toBe(true);
  });

  it("uses one identical additional prompt in the same-focus preset", () => {
    const source = readFileSync(
      new URL("../.pi/reviewer-chair.same-focus.example.yaml", import.meta.url),
      "utf8",
    );
    const config = parseReviewerChairConfig(source);
    const prompts = config.reviewers.map((reviewer) => reviewer.systemPrompt);

    expect(config.reviewers).toHaveLength(3);
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).toMatch(/factual and technical correctness/i);
  });

  it("uses the configured default model roster in both presets", () => {
    for (const filename of [
      "reviewer-chair.example.yaml",
      "reviewer-chair.same-focus.example.yaml",
    ]) {
      const source = readFileSync(new URL(`../.pi/${filename}`, import.meta.url), "utf8");
      const config = parseReviewerChairConfig(source);

      expect(config.reviewers.map((reviewer) => reviewer.model)).toEqual(
        DEFAULT_REVIEWER_MODELS,
      );
      expect(config.chair.model).toBe(DEFAULT_CHAIR_MODEL);
    }
  });
});

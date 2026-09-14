import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReviewerChairConfig } from "../src/config.js";

const DEFAULT_REVIEWER_MODELS_BY_PRESET = {
  "reviewer-chair.example.yaml": [
    "openai-codex/gpt-5.6-luna",
    "google/gemini-3.8-flash",
    "deepseek/deepseek-flash",
    "zai/glm-5.3-flash",
  ],
};
const DEFAULT_CHAIR_MODEL = "openai-codex/gpt-5.6-terra";

describe("packaged configuration examples", () => {
  it("uses four independent reviewers with the same correctness focus", () => {
    const source = readFileSync(
      new URL("../.pi/reviewer-chair.example.yaml", import.meta.url),
      "utf8",
    );
    const config = parseReviewerChairConfig(source);
    const prompts = config.reviewers.map((reviewer) => reviewer.systemPrompt);

    expect(config.reviewers).toHaveLength(4);
    expect(new Set(config.reviewers.map((reviewer) => reviewer.name)).size).toBe(4);
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).toMatch(/factual and technical correctness/i);
  });

  it("uses the configured default model roster in each preset", () => {
    for (const [filename, reviewerModels] of Object.entries(
      DEFAULT_REVIEWER_MODELS_BY_PRESET,
    )) {
      const source = readFileSync(new URL(`../.pi/${filename}`, import.meta.url), "utf8");
      const config = parseReviewerChairConfig(source);

      expect(config.reviewers.map((reviewer) => reviewer.model)).toEqual(reviewerModels);
      expect(config.chair.model).toBe(DEFAULT_CHAIR_MODEL);
    }
  });
});

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseReviewerChairConfig } from "../src/config.js";
import { checkCouncilModels } from "../src/preflight.js";

const config = parseReviewerChairConfig(`
reviewers:
  - model: provider/reviewer
chair:
  model: provider/chair
minSuccess: 1
`);

function runtime(known: string[], available = known): Pick<ModelRuntime, "getModel" | "getAvailableSnapshot"> {
  const models = known.map((id) => ({ provider: "provider", id }));
  return {
    getModel: (_provider: string, id: string) => models.find((model) => model.id === id),
    getAvailableSnapshot: () => models.filter((model) => available.includes(model.id)),
  } as unknown as Pick<ModelRuntime, "getModel" | "getAvailableSnapshot">;
}

describe("Council preflight", () => {
  it("accepts accessible models without making inference requests", () => {
    expect(() => checkCouncilModels(config, runtime(["reviewer", "chair"]))).not.toThrow();
  });

  it("rejects an unknown Chair before any reviewers start", () => {
    expect(() => checkCouncilModels(config, runtime(["reviewer"]))).toThrow(/Chair: unknown model provider\/chair/);
  });

  it("reports all unknown and unavailable models together", () => {
    expect(() => checkCouncilModels(config, runtime(["reviewer"], [])))
      .toThrow(/Reviewer 1:.*unavailable[\s\S]*Chair: unknown model/);
  });
});

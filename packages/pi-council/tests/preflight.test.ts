import { describe, expect, it } from "vitest";
import { parseCouncilConfig } from "../src/config.js";
import { checkCouncilModels } from "../src/preflight.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const config = parseCouncilConfig(`reviewers:\n  - model: provider/reviewer\nminSuccess: 1`);
const runtime = (ids: string[], available = ids) => ({
  getModel: (_provider: string, id: string) => ids.includes(id) ? { provider: "provider", id } : undefined,
  getAvailableSnapshot: () => available.map((id) => ({ provider: "provider", id })),
}) as unknown as ModelRuntime;
describe("Council preflight", () => {
  it("only validates configured Reviewers, with no separate Chair model", () => { expect(() => checkCouncilModels(config, runtime(["reviewer"]))).not.toThrow(); });
  it("rejects unknown and unavailable Reviewers before inference", () => {
    expect(() => checkCouncilModels(config, runtime([]))).toThrow(/Reviewer 1: unknown model/);
    expect(() => checkCouncilModels(config, runtime(["reviewer"], []))).toThrow(/unavailable/);
  });
});

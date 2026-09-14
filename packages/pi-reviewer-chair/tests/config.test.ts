import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  DEFAULT_REVIEWER_TOOLS,
  parseReviewerChairConfig,
} from "../src/config.js";

const minimalConfig = `
reviewers:
  - model: anthropic/reviewer
chair:
  model: anthropic/chair
minSuccess: 1
`;

describe("parseReviewerChairConfig", () => {
  it("applies safe tool and timeout defaults", () => {
    const config = parseReviewerChairConfig(minimalConfig);

    expect(config.reviewers[0]?.tools).toEqual(DEFAULT_REVIEWER_TOOLS);
    expect(config.reviewers[0]?.thinking).toBe("medium");
    expect(config.reviewers[0]?.systemPrompt).toBe("");
    expect(config.chair.tools).toEqual([]);
    expect(config.chair.thinking).toBe("high");
    expect(config.idleTimeoutMs).toBe(120_000);
    expect(config.maxDurationMs).toBe(900_000);
  });

  it("preserves per-reviewer and Chair settings", () => {
    const config = parseReviewerChairConfig(`
reviewers:
  - name: evidence
    model: openai/reviewer-a
    thinking: xhigh
    systemPrompt: Check every claim.
    tools: [read]
  - model: google/reviewer-b
    thinking: off
    systemPrompt: Find omissions.
    tools: []
chair:
  model: anthropic/chair
  thinking: max
  systemPrompt: Resolve conflicts.
  tools: [read]
minSuccess: 2
idleTimeoutMs: 45000
maxDurationMs: 300000
`);

    expect(config.reviewers[0]).toMatchObject({
      name: "evidence",
      model: "openai/reviewer-a",
      thinking: "xhigh",
      systemPrompt: "Check every claim.",
      tools: ["read"],
    });
    expect(config.reviewers[1]?.tools).toEqual([]);
    expect(config.chair).toEqual({
      model: "anthropic/chair",
      thinking: "max",
      systemPrompt: "Resolve conflicts.",
      tools: ["read"],
    });
    expect(config.idleTimeoutMs).toBe(45_000);
    expect(config.maxDurationMs).toBe(300_000);
  });

  it("rejects a minimum success count larger than the reviewer count", () => {
    expect(() =>
      parseReviewerChairConfig(`
reviewers:
  - model: anthropic/reviewer
chair:
  model: anthropic/chair
minSuccess: 2
`),
    ).toThrowError(/minSuccess.*must not exceed/i);
  });

  it("rejects malformed YAML and unknown settings", () => {
    expect(() => parseReviewerChairConfig("reviewers: ["))
      .toThrowError(ConfigurationError);
    expect(() => parseReviewerChairConfig(`${minimalConfig}\nunknown: true`))
      .toThrowError(/unrecognized key/i);
  });

  it("rejects non-canonical model references before creating sessions", () => {
    expect(() =>
      parseReviewerChairConfig(`
reviewers:
  - model: reviewer-without-provider
chair:
  model: anthropic/chair
minSuccess: 1
`),
    ).toThrowError(/provider\/model-id/);
  });

  it.each(["idleTimeoutMs", "maxDurationMs"])("rejects overflowing %s timers", (field) => {
    expect(() => parseReviewerChairConfig(`${minimalConfig}\n${field}: 2147483648`))
      .toThrowError(/2147483647/);
  });

  it("accepts the maximum supported timer delay", () => {
    expect(parseReviewerChairConfig(`${minimalConfig}\nmaxDurationMs: 2147483647`).maxDurationMs)
      .toBe(2_147_483_647);
  });

  it("rejects a maximum duration shorter than the idle timeout", () => {
    expect(() =>
      parseReviewerChairConfig(`
reviewers:
  - model: anthropic/reviewer
chair:
  model: anthropic/chair
minSuccess: 1
idleTimeoutMs: 120000
maxDurationMs: 60000
`),
    ).toThrowError(/maxDurationMs.*greater than or equal to idleTimeoutMs/i);
  });
});

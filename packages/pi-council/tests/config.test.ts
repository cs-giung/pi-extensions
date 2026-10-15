import { describe, expect, it } from "vitest";
import { ConfigurationError, DEFAULT_REVIEWER_TOOLS, parseCouncilConfig } from "../src/config.js";

const minimalConfig = `reviewers:\n  - model: anthropic/reviewer\nminSuccess: 1\n`;
describe("parseCouncilConfig", () => {
  it("defaults to read-only Reviewers and leaves the Chair in the main session", () => {
    const config = parseCouncilConfig(minimalConfig);
    expect(config.reviewers[0]?.tools).toEqual(DEFAULT_REVIEWER_TOOLS);
    expect(config.reviewers[0]?.thinking).toBe("medium"); expect(config.reviewers[0]?.systemPrompt).toBe("");
    expect(config.chair).toEqual({ systemPrompt: "" });
    expect(config.idleTimeoutMs).toBe(120000); expect(config.maxDurationMs).toBe(900000); expect(config.maxConcurrency).toBe(4);
  });
  it("preserves Reviewer settings and additional main-Chair instructions", () => {
    const config = parseCouncilConfig(`
reviewers:
  - name: evidence
    model: openai/reviewer-a
    thinking: xhigh
    systemPrompt: Check every claim.
    tools: [read]
  - model: google/reviewer-b
    thinking: off
    tools: []
chair:
  systemPrompt: Resolve conflicts.
minSuccess: 2
idleTimeoutMs: 45000
maxDurationMs: 300000
`);
    expect(config.reviewers[0]).toMatchObject({ name: "evidence", model: "openai/reviewer-a", thinking: "xhigh", systemPrompt: "Check every claim.", tools: ["read"] });
    expect(config.reviewers[1]?.tools).toEqual([]); expect(config.chair).toEqual({ systemPrompt: "Resolve conflicts." });
    expect(config.idleTimeoutMs).toBe(45000); expect(config.maxDurationMs).toBe(300000);
  });
  it.each(["model: provider/chair", "thinking: high", "tools: []"])("rejects obsolete Chair controls: %s", (field) => {
    expect(() => parseCouncilConfig(`${minimalConfig}\nchair:\n  ${field}`)).toThrow(/Chair uses the main session/);
  });
  it("rejects insufficient rosters", () => {
    expect(() => parseCouncilConfig(minimalConfig.replace("minSuccess: 1", "minSuccess: 2"))).toThrow(/must not exceed/);
  });
  it.each([0, -1, 1.5])("rejects invalid concurrency %s", (value) => {
    expect(() => parseCouncilConfig(`${minimalConfig}\nmaxConcurrency: ${value}`)).toThrow(ConfigurationError);
  });
  it("preserves an explicit concurrency limit", () => { expect(parseCouncilConfig(`${minimalConfig}\nmaxConcurrency: 1`).maxConcurrency).toBe(1); });
  it.each(["[unknown]", "[codemode]", "[read, read]"])("rejects unsupported or duplicate tools %s", (tools) => {
    expect(() => parseCouncilConfig(minimalConfig.replace("model: anthropic/reviewer", `model: anthropic/reviewer\n    tools: ${tools}`))).toThrow(ConfigurationError);
  });
  it("rejects invalid YAML, unknown settings and noncanonical models", () => {
    expect(() => parseCouncilConfig("reviewers: [")).toThrow(ConfigurationError);
    expect(() => parseCouncilConfig(`${minimalConfig}\nunknown: true`)).toThrow(/unrecognized key/i);
    expect(() => parseCouncilConfig(minimalConfig.replace("anthropic/reviewer", "no-provider"))).toThrow(/provider\/model-id/);
  });
  it.each(["idleTimeoutMs", "maxDurationMs"])("rejects overflowing %s timers", (field) => {
    expect(() => parseCouncilConfig(`${minimalConfig}\n${field}: 2147483648`)).toThrow(/2147483647/);
  });
  it("accepts the maximum supported delay and rejects inconsistent deadlines", () => {
    expect(parseCouncilConfig(`${minimalConfig}\nmaxDurationMs: 2147483647`).maxDurationMs).toBe(2147483647);
    expect(() => parseCouncilConfig(`${minimalConfig}\nidleTimeoutMs: 120000\nmaxDurationMs: 60000`)).toThrow(/greater than or equal/);
  });
});

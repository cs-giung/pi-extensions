import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configSchema, parseConfig, preflight } from "../src/config.js";
import { config, runtime } from "./fixtures.js";

describe("Aufheben configuration", () => {
  it("applies explicit role defaults and never configures a Synthesizer model", () => {
    expect(config.thesizer.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(config.thesizer.thinking).toBe("high");
    expect(() => configSchema.parse({ ...config, synthesizer: config.thesizer })).toThrow();
  });
  it.each([0, -1, 1.5, 2147483648])("rejects invalid timeout %s", (value) => {
    expect(() => configSchema.parse({ ...config, maxDurationMs: value })).toThrow();
  });
  it("rejects unsafe tools, duplicates, malformed references and inconsistent limits", () => {
    for (const tools of [["write"], ["bash"], ["read", "read"], ["codemode"]]) {
      expect(() => configSchema.parse({ ...config, thesizer: { ...config.thesizer, tools } })).toThrow();
    }
    expect(() => configSchema.parse({ ...config, thesizer: { ...config.thesizer, model: "no-provider" } })).toThrow();
    expect(() => configSchema.parse({ ...config, idleTimeoutMs: 5000 })).toThrow();
    expect(() => parseConfig("thesizer: [")).toThrow();
  });
  it("validates both roles before inference", () => {
    expect(() => preflight(config, runtime)).not.toThrow();
    expect(() => preflight(config, { getModel: () => undefined, getAvailableSnapshot: () => [] })).toThrow(/thesizer:[\s\S]*antithesizer:/);
    expect(() => preflight(config, { getModel: runtime.getModel.bind(runtime), getAvailableSnapshot: () => [] })).toThrow(/unavailable/);
  });
  it("ships a valid, customizable example without pinning personal model IDs", () => {
    const example = parseConfig(readFileSync(new URL("../.pi/aufheben.example.yaml", import.meta.url), "utf8"));
    expect(example.thesizer.model).toContain("/");
    expect(example.antithesizer.model).toContain("/");
  });
});

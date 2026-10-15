import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { acceptAntithesis, acceptThesis, antithesisInputSchema, checkpointInputSchema, parseJson,
  thesisInputSchema, toolSchema, validateSynthesis } from "../src/protocol.js";
import { outputSchema } from "../src/tools.js";
import { antithesis, brief, exploration, rawAntithesis, rawThesis, synthesis, thesis } from "./fixtures.js";

const identity = { explorationId: exploration().id, round: 1, expectedRevision: 0 };
describe("research protocol", () => {
  it("assigns round-qualified IDs and separates hypotheses from evidence", () => {
    expect(acceptThesis(rawThesis, 3, []).claims[0]).toMatchObject({ id: "R3.T1", epistemicStatus: "hypothesis" });
  });
  it("rejects stale references and non-question challenges", () => {
    expect(() => acceptAntithesis(rawAntithesis("missing"), 1, thesis)).toThrow(/references/);
    const raw = rawAntithesis(); raw.questions[0]!.question = "This is an assertion.";
    expect(() => acceptAntithesis(raw, 1, thesis)).toThrow(/question mark/);
    expect(() => acceptThesis({ claims: [{ ...rawThesis.claims[0], revises: ["missing"] }] }, 2, [])).toThrow(/references/);
  });
  it("allows no forced opposition when explicitly explained", () => {
    expect(acceptAntithesis({ questions: [], explanation: "No material challenges found." }, 1, thesis).questions).toEqual([]);
    expect(() => acceptAntithesis({ questions: [] }, 1, thesis)).toThrow();
  });
  it("requires every claim and question to be assessed exactly once", () => {
    expect(validateSynthesis(synthesis(), thesis, antithesis).idea).toContain("compute");
    const duplicate = synthesis(); duplicate.claims.push(duplicate.claims[0]!);
    expect(() => validateSynthesis(duplicate, thesis, antithesis)).toThrow(/references/);
    const missing = synthesis(); missing.questions = [];
    expect(() => validateSynthesis(missing, thesis, antithesis)).toThrow(/references/);
    const revised = synthesis(); revised.claims[0]!.disposition = "revised";
    expect(() => validateSynthesis(revised, thesis, antithesis)).toThrow(/replacement/);
  });
  it("parses one JSON object, permits a JSON fence, and bounds output", () => {
    expect(parseJson('```json\n{"claims": []}\n```')).toEqual({ claims: [] });
    expect(() => parseJson("prefix {} suffix")).toThrow();
    expect(() => parseJson(" ".repeat(10) + JSON.stringify({ value: "x".repeat(64001) }))).toThrow(/exceeds/);
    expect(() => parseJson(" ".repeat(64001) + "{}")).toThrow(/exceeds/);
  });
  it.each([
    [thesisInputSchema, { ...identity, brief }],
    [antithesisInputSchema, identity],
    [checkpointInputSchema, { ...identity, action: "complete_round", synthesis: synthesis() }],
    [checkpointInputSchema, { ...identity, action: "update_brief", brief }],
    [outputSchema, { state: null, replayed: false, error: "No exploration" }],
  ] as const)("derives valid TypeBox interfaces from the Zod contract", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(Value.Check(toolSchema(schema), value)).toBe(true);
    expect(schema.safeParse({ ...value, unknown: true }).success).toBe(false);
    expect(Value.Check(toolSchema(schema), { ...value, unknown: true })).toBe(false);
  });
});

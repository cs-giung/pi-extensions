import { Type } from "typebox";
import { z } from "zod";

export const MAX_OUTPUT_CHARS = 64000;
const text = z.string().trim().min(1).max(4000);
const long = z.string().trim().min(1).max(12000);
const optionalText = z.string().trim().max(4000).default("");
const list = z.array(text).max(20).default([]);
export const briefSchema = z.object({
  problem: long,
  context: long,
  constraints: list,
  assumptions: list,
  sources: list,
  language: text.describe("User-facing language for the main Synthesizer. Child roles write in English."),
}).strict();
export type Brief = z.infer<typeof briefSchema>;

const claimSchema = z.object({
  statement: text,
  rationale: text,
  epistemicStatus: z.enum(["supported", "inference", "hypothesis"]),
  assumptions: list,
  prediction: optionalText,
  sources: list,
  revises: list,
}).strict();
export const thesisSchema = z.object({ claims: z.array(claimSchema).min(1).max(12) }).strict();
const questionSchema = z.object({
  targetClaimIds: z.array(text).min(1).max(12),
  question: text.regex(/[?？]$/, "A challenge must be a question ending in a question mark"),
  rationale: text,
  competingExplanation: optionalText,
  discriminatingTest: optionalText,
}).strict();
export const antithesisSchema = z.object({
  questions: z.array(questionSchema).max(16),
  explanation: optionalText,
}).strict().refine((value) => value.questions.length > 0 || value.explanation.length > 0,
  "Explain why there are no substantive challenges");
export const acceptedThesisSchema = z.object({
  claims: z.array(claimSchema.extend({ id: text })).min(1).max(12),
}).strict();
export const acceptedAntithesisSchema = z.object({
  questions: z.array(questionSchema.extend({ id: text })).max(16), explanation: z.string().max(4000),
}).strict();
export type Thesis = z.infer<typeof acceptedThesisSchema>;
export type Antithesis = z.infer<typeof acceptedAntithesisSchema>;

export const synthesisSchema = z.object({
  idea: long,
  claims: z.array(z.object({
    claimId: text,
    disposition: z.enum(["retained", "revised", "rejected", "unresolved"]),
    reason: text,
    replacement: optionalText,
  }).strict()).min(1).max(12),
  questions: z.array(z.object({
    questionId: text, disposition: z.enum(["addressed", "unresolved"]), reason: text,
  }).strict()).max(16),
  newPropositions: list,
  changes: list,
  uncertainties: list,
  experiment: z.object({ design: long, predictions: list, abandonmentCriteria: z.array(text).min(1).max(20) }).strict(),
  recommendation: z.enum(["continue", "redirect", "gather_evidence", "finish"]),
  nextFocus: optionalText,
}).strict();
export type Synthesis = z.infer<typeof synthesisSchema>;

const identity = {
  explorationId: z.string().uuid(),
  round: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
};
export const thesisInputSchema = z.object({ ...identity, brief: briefSchema }).strict();
export const antithesisInputSchema = z.object({ ...identity, instruction: optionalText }).strict();
export const checkpointInputSchema = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.literal("complete_round"), synthesis: synthesisSchema }).strict(),
  z.object({ ...identity, action: z.literal("update_brief"), brief: briefSchema }).strict(),
]);
export type ThesisInput = z.infer<typeof thesisInputSchema>;
export type AntithesisInput = z.infer<typeof antithesisInputSchema>;
export type CheckpointInput = z.infer<typeof checkpointInputSchema>;
export type ToolInput = ThesisInput | AntithesisInput | CheckpointInput;
export type ToolKind = "thesis" | "antithesis" | "checkpoint";

/** Derive Pi's TypeBox interface from the same contract used at runtime. */
export function toolSchema<T extends z.ZodType>(schema: T) {
  return Type.Unsafe<z.input<T>>(z.toJSONSchema(schema, { io: "input" }));
}

export function parseJson(source: string): unknown {
  if (source.length > MAX_OUTPUT_CHARS) throw new Error(`Role output exceeds ${MAX_OUTPUT_CHARS} characters`);
  const trimmed = source.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  return JSON.parse(trimmed) as unknown;
}

function requireReferences(actual: readonly string[], allowed: readonly string[], complete: boolean): void {
  if (new Set(actual).size !== actual.length || actual.some((id) => !allowed.includes(id))
    || (complete && actual.length !== allowed.length)) {
    throw new Error(`Invalid references. Expected ${complete ? "exactly" : "a subset of"}: ${allowed.join(", ")}`);
  }
}

export function acceptThesis(value: unknown, round: number, knownClaimIds: readonly string[]): Thesis {
  const parsed = thesisSchema.parse(value);
  for (const claim of parsed.claims) requireReferences(claim.revises, knownClaimIds, false);
  return { claims: parsed.claims.map((claim, index) => ({ ...claim, id: `R${round}.T${index + 1}` })) };
}

export function acceptAntithesis(value: unknown, round: number, thesis: Thesis): Antithesis {
  const parsed = antithesisSchema.parse(value);
  for (const question of parsed.questions) requireReferences(question.targetClaimIds, thesis.claims.map((claim) => claim.id), false);
  return { ...parsed, questions: parsed.questions.map((question, index) => ({ ...question, id: `R${round}.A${index + 1}` })) };
}

export function validateSynthesis(value: unknown, thesis: Thesis, antithesis: Antithesis): Synthesis {
  const parsed = synthesisSchema.parse(value);
  requireReferences(parsed.claims.map((claim) => claim.claimId), thesis.claims.map((claim) => claim.id), true);
  requireReferences(parsed.questions.map((question) => question.questionId), antithesis.questions.map((question) => question.id), true);
  if (parsed.claims.some((claim) => claim.disposition === "revised" && !claim.replacement)) {
    throw new Error("Revised claims require an explicit replacement");
  }
  return parsed;
}

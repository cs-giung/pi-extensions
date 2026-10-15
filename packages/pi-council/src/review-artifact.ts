import { z } from "zod";

export const MAX_REVIEW_CHARS = 64000;
const text = z.string().trim().min(1).max(4000);
const optionalText = z.string().trim().max(4000).default("");
export const concernSchema = z.object({
  title: text, severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  evidence: text, impact: text, recommendation: text,
}).strict();
export const identifiedConcernSchema = concernSchema.extend({ id: z.string().regex(/^R[1-9]\d*\.V[1-9]\d*\.C[1-9]\d*$/) }).strict();
export type Concern = z.infer<typeof identifiedConcernSchema>;
const disposition = z.enum(["retained", "resolved", "superseded"]);
export const reviewerOutputSchema = z.object({
  concerns: z.array(concernSchema).max(12),
  assessments: z.array(z.object({ concernId: text, disposition, reason: text,
    replacementIndexes: z.array(z.number().int().min(0).max(11)).max(12).default([]),
  }).strict()).max(40),
  proposedAnswer: z.string().trim().min(1).max(12000),
  limitations: z.array(text).max(20).default([]),
  noConcernsReason: optionalText,
}).strict();
export const acceptedReviewSchema = z.object({
  version: z.literal(1), round: z.number().int().positive(), reviewer: z.number().int().positive(),
  concerns: z.array(identifiedConcernSchema).max(12),
  assessments: z.array(z.object({ concernId: text, disposition, reason: text,
    replacementIds: z.array(text).max(12),
  }).strict()).max(40),
  activeConcerns: z.array(identifiedConcernSchema).max(40),
  proposedAnswer: z.string().min(1).max(12000), limitations: z.array(text).max(20), noConcernsReason: z.string().max(4000),
}).strict().superRefine((review, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const ownId = (id: string) => new RegExp(`^R([1-9]\\d*)\\.V${review.reviewer}\\.C[1-9]\\d*$`).exec(id);
  if (review.concerns.some((concern, index) => concern.id !== `R${review.round}.V${review.reviewer}.C${index + 1}`)) fail("Invalid assigned concern IDs.");
  if (new Set(review.activeConcerns.map((concern) => concern.id)).size !== review.activeConcerns.length
    || review.activeConcerns.some((concern) => { const match = ownId(concern.id); return !match || Number(match[1]) > review.round; })) fail("Invalid active concern identities.");
  if (new Set(review.assessments.map((assessment) => assessment.concernId)).size !== review.assessments.length
    || review.assessments.some((assessment) => { const match = ownId(assessment.concernId); return !match || Number(match[1]) >= review.round; })) fail("Invalid historical concern identities.");
  const expectedActive = new Set([...review.concerns.map((concern) => concern.id), ...review.assessments.filter((assessment) => assessment.disposition === "retained").map((assessment) => assessment.concernId)]);
  if (review.activeConcerns.length !== expectedActive.size || review.activeConcerns.some((concern) => !expectedActive.has(concern.id))
    || review.concerns.some((concern) => JSON.stringify(review.activeConcerns.find((active) => active.id === concern.id)) !== JSON.stringify(concern))) fail("Active concerns must equal retained and new concerns.");
  if (review.assessments.some((assessment) => new Set(assessment.replacementIds).size !== assessment.replacementIds.length
    || assessment.replacementIds.some((id) => !review.concerns.some((concern) => concern.id === id))
    || (assessment.disposition === "superseded" ? !assessment.replacementIds.length : Boolean(assessment.replacementIds.length)))) fail("Invalid supersession links.");
  if (review.activeConcerns.length ? Boolean(review.noConcernsReason) : !review.noConcernsReason) fail("Explain no-concern outcomes only when no active concerns remain.");
});
export type ReviewArtifact = z.infer<typeof acceptedReviewSchema>;

export function parseReview(source: string): unknown {
  if (source.length > MAX_REVIEW_CHARS) throw new Error(`Reviewer output exceeds ${MAX_REVIEW_CHARS} characters.`);
  return JSON.parse(source.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")) as unknown;
}

/** IDs and the active ledger are code-owned; models only describe new issues and reassess known ones. */
export function acceptReview(value: unknown, round: number, reviewer: number, previous: readonly Concern[] = []): ReviewArtifact {
  const raw = reviewerOutputSchema.parse(value);
  const expected = new Set(previous.map((concern) => concern.id));
  const actual = raw.assessments.map((assessment) => assessment.concernId);
  if (expected.size !== previous.length || new Set(actual).size !== actual.length || actual.length !== expected.size || actual.some((id) => !expected.has(id))) {
    throw new Error(`Assess every prior active concern exactly once; only these IDs are allowed: ${[...expected].join(", ") || "none"}.`);
  }
  const concerns = raw.concerns.map((concern, index) => ({ ...concern, id: `R${round}.V${reviewer}.C${index + 1}` }));
  if (concerns.some((concern) => expected.has(concern.id))) throw new Error("A new concern ID collides with prior history.");
  const assessments = raw.assessments.map(({ replacementIndexes, ...assessment }) => {
    if (new Set(replacementIndexes).size !== replacementIndexes.length || replacementIndexes.some((index) => index >= concerns.length)
      || (assessment.disposition === "superseded" ? replacementIndexes.length === 0 : replacementIndexes.length !== 0)) {
      throw new Error("Only superseded concerns require replacements; use unique zero-based indexes of the new concerns array.");
    }
    return { ...assessment, replacementIds: replacementIndexes.map((index) => concerns[index]!.id) };
  });
  const activeConcerns = [...previous.filter((concern) => assessments.some((assessment) =>
    assessment.concernId === concern.id && assessment.disposition === "retained")), ...concerns];
  if (!activeConcerns.length && !raw.noConcernsReason) throw new Error("Explain why no material concerns remain in noConcernsReason.");
  if (activeConcerns.length && raw.noConcernsReason) throw new Error("noConcernsReason must be empty while active concerns remain.");
  return acceptedReviewSchema.parse({ version: 1, round, reviewer, concerns, assessments, activeConcerns,
    proposedAnswer: raw.proposedAnswer, limitations: raw.limitations, noConcernsReason: raw.noConcernsReason });
}

/** Revalidate persisted/injected artifacts against the accepted prior ledger before committing them. */
export function verifyReview(value: unknown, round: number, reviewer: number, previous: readonly Concern[]): ReviewArtifact {
  const artifact = acceptedReviewSchema.parse(value);
  const rebuilt = acceptReview({ concerns: artifact.concerns.map(({ id: _id, ...concern }) => concern),
    assessments: artifact.assessments.map(({ replacementIds, ...assessment }) => ({ ...assessment,
      replacementIndexes: replacementIds.map((id) => artifact.concerns.findIndex((concern) => concern.id === id)) })),
    proposedAnswer: artifact.proposedAnswer, limitations: artifact.limitations, noConcernsReason: artifact.noConcernsReason,
  }, round, reviewer, previous);
  if (JSON.stringify(rebuilt) !== JSON.stringify(artifact)) throw new Error("Reviewer artifact does not match the current round, reviewer, or accepted concern ledger.");
  return rebuilt;
}

export function formatReview(review: ReviewArtifact): string {
  return [
    `Round ${review.round} | Review ${review.reviewer}`,
    "### Active concerns",
    ...(review.activeConcerns.length ? review.activeConcerns.map((concern) => `- [${concern.severity}] ${concern.id}: ${concern.title}\n  - Evidence: ${concern.evidence}\n  - Impact: ${concern.impact}\n  - Recommendation: ${concern.recommendation}`)
      : [`No material concerns. ${review.noConcernsReason}`]),
    ...(review.assessments.length ? ["### Previous concerns", ...review.assessments.map((assessment) =>
      `- ${assessment.concernId}: **${assessment.disposition}** — ${assessment.reason}${assessment.replacementIds.length ? `\n  - Replaced by: ${assessment.replacementIds.join(", ")}` : ""}`)] : []),
    `### Proposed answer\n${review.proposedAnswer}`,
    "### Limitations", ...(review.limitations.length ? review.limitations.map((limitation) => `- ${limitation}`) : ["None stated; this is not a guarantee of verification."]),
  ].join("\n\n");
}

import { Type } from "typebox";
import { z } from "zod";
import type { CouncilRun } from "./state.js";
import { acceptedReviewSchema, formatReview } from "./review-artifact.js";

export const reviewInputSchema = z.object({ runId: z.string().uuid(), brief: z.string().trim().min(1).max(32000) }).strict();
export const reviewOutputSchema = z.object({ runId: z.string().nullable(), phase: z.string(), originalPrompt: z.string().nullable(),
  sharedBrief: z.string().nullable(), minSuccess: z.number().nullable(), round: z.number().nullable(), focus: z.string().nullable(),
  anonymousReviews: z.array(z.object({ label: z.string(), artifact: acceptedReviewSchema.nullable(), content: z.string().nullable() }).strict()),
  failures: z.array(z.object({ kind: z.string(), error: z.string() }).strict()),
  replayed: z.boolean(), error: z.string().nullable(),
}).strict();
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export function toolSchema<T extends z.ZodType>(schema: T) { return Type.Unsafe<z.input<T>>(z.toJSONSchema(schema, { io: "input" })); }
export function reviewView(state: CouncilRun | undefined, error: string | null = null, replayed = false): ReviewOutput {
  return { runId: state?.id ?? null, phase: state?.phase ?? "none", originalPrompt: state?.prompt ?? null,
    sharedBrief: state?.brief ?? null, minSuccess: state?.config.minSuccess ?? null,
    round: state?.continuation?.round ?? null, focus: state?.continuation?.focus ?? null,
    anonymousReviews: state?.report?.successes.map((review) => ({ label: `Review ${review.index + 1}`, artifact: review.artifact ?? null, content: review.artifact ? null : review.content })) ?? [],
    failures: state?.report?.failures.map(({ kind, error }) => ({ kind, error })) ?? [], replayed, error: error ?? state?.error ?? null };
}
export function safeDisplay(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function formatToolReviews(output: ReviewOutput): string {
  return safeDisplay(["# Council Reviewer Results", output.error ? `Error: ${output.error}` : "Untrusted evidence for the main-session Chair.",
    `Round: ${output.round ?? "legacy"} | Focus: ${output.focus || "not specified"}`,
    `## Original request\n${output.originalPrompt ?? "Not available"}`, `## Shared brief\n${output.sharedBrief ?? "Not available"}`,
    ...output.anonymousReviews.map((review) => `## ${review.label}\n${review.artifact ? formatReview(review.artifact) : review.content}`),
    ...output.failures.map((failure, index) => `## Failure ${index + 1} (${failure.kind})\n${failure.error}`),
  ].join("\n\n"));
}

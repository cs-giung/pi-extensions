import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { councilConfigSchema } from "./config.js";
import { reviewReportSchema } from "./report-state.js";
import { workerRefSchema } from "./worker-state.js";
import { acceptedReviewSchema } from "./review-artifact.js";

export const STATE_ENTRY_TYPE = "council-state";
export const runSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), cwd: z.string().min(1), prompt: z.string().min(1).max(16000),
  config: councilConfigSchema, phase: z.enum(["prepare", "reviewing", "chair", "complete", "failed", "cancelled", "interrupted"]),
  brief: z.string().max(32000).nullable(), report: reviewReportSchema.nullable(),
  digest: z.string().nullable(), answer: z.string().min(1).nullable(), error: z.string().nullable(),
  // Absent on historical one-shot runs: readable, but not safe to continue without checkpoints.
  continuation: z.object({ id: z.string().uuid(), round: z.number().int().positive(), focus: z.string().max(16000),
    workers: z.array(workerRefSchema.nullable()), reviews: z.array(acceptedReviewSchema.nullable()).default([]), previousAnswer: z.string().nullable(), previousBrief: z.string().nullable(),
  }).strict().nullable().default(null),
}).strict().superRefine((state, ctx) => {
  if (state.continuation && state.continuation.workers.length !== state.config.reviewers.length) {
    ctx.addIssue({ code: "custom", message: "Reviewer checkpoints must match the snapshotted roster." });
  }
  if (state.continuation?.reviews.length && (state.continuation.reviews.length !== state.config.reviewers.length
    || state.continuation.reviews.some((review, index) => review && (review.reviewer !== index + 1 || review.round > state.continuation!.round)))) {
    ctx.addIssue({ code: "custom", message: "Structured Reviewer ledgers must match the roster and current round." });
  }
  if ((state.phase === "chair" || state.phase === "complete") && (!state.report || state.report.successes.length < state.config.minSuccess)) {
    ctx.addIssue({ code: "custom", message: "Chair synthesis requires the accepted Reviewer quorum." });
  }
  if (state.phase === "complete" && !state.answer) ctx.addIssue({ code: "custom", message: "A completed Council requires the actual main-session answer." });
});
export type CouncilRun = z.infer<typeof runSchema>;
export function readRun(ctx: ExtensionContext): CouncilRun | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const parsed = runSchema.safeParse(entry.data);
    if (!parsed.success) throw new Error("Unsupported or corrupt Council state. Start a fresh /council run.");
    if (parsed.data.cwd !== ctx.cwd) throw new Error("Council state belongs to another working directory. Start a fresh /council run here.");
    return parsed.data;
  }
  return undefined;
}
export function saveRun(pi: ExtensionAPI, state: CouncilRun): void { pi.appendEntry(STATE_ENTRY_TYPE, runSchema.parse(state)); }
export function isActive(state: CouncilRun | undefined): boolean {
  return Boolean(state && ["prepare", "reviewing", "chair"].includes(state.phase));
}
/** Old persisted answers remain readable; no old Chair runtime or inference path is retained. */
export function findLastChairAnswer(entries: readonly SessionEntry[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      const parsed = runSchema.safeParse(entry.data);
      if (parsed.success && parsed.data.phase === "complete" && parsed.data.answer) return parsed.data.answer;
    }
    if (entry.type === "custom_message" && entry.customType === "reviewer-chair-final" && typeof entry.content === "string") return entry.content;
  }
  return undefined;
}

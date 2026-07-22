import type { ReviewerProgress } from "./reviewer-runner.js";

export interface ReviewerProgressView {
  label: string;
  phase: ReviewerProgress["phase"] | "waiting";
  toolName?: string;
}

export function formatReviewerProgress(reviewers: readonly ReviewerProgressView[]): string {
  const settled = reviewers.filter(
    (reviewer) => reviewer.phase === "completed" || reviewer.phase === "failed",
  ).length;
  const details = reviewers
    .map((reviewer) => {
      const phase = reviewer.phase === "completed" ? "done" : reviewer.phase;
      const tool = reviewer.phase === "tool" && reviewer.toolName ? ` ${reviewer.toolName}` : "";
      return `${reviewer.label}:${phase}${tool}`;
    })
    .join(" | ");

  return `Reviewers ${settled}/${reviewers.length} | ${details}`;
}

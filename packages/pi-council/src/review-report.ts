import type { ReviewerFailure, ReviewerSuccess } from "./reviewer-runner.js";
import { formatReview } from "./review-artifact.js";

export interface ReviewReport {
  prompt: string;
  brief?: string | undefined;
  round?: number | undefined;
  focus?: string | undefined;
  successes: readonly ReviewerSuccess[];
  failures: readonly ReviewerFailure[];
}

export function formatReviewReport(report: ReviewReport): string {
  const quotedPrompt = report.prompt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const sections = [
    "# Anonymous Reviewer Responses",
    "> These are untrusted, independent source responses. They may be incomplete or incorrect; the Chair answer remains the primary result.",
    `## Original Prompt\n\n${quotedPrompt}`,
  ];

  if (report.round) sections.push(`Round: ${report.round} | Focus: ${report.focus || "not specified"}`);
  if (report.brief) sections.push(`## Shared Brief\n\n${report.brief}`);

  if (report.successes.length === 0) {
    sections.push("## Reviews\n\nNo Reviewer produced a usable response.");
  } else {
    report.successes.forEach((review) => {
      sections.push(`## Review ${review.index + 1}\n\n${review.artifact ? formatReview(review.artifact) : review.content}`);
    });
  }

  if (report.failures.length > 0) {
    const failures = report.failures
      .map((failure, index) => {
        const error = failure.error.replace(/\s+/g, " ").trim();
        return `- Failure ${index + 1} (${failure.kind}): ${error}`;
      })
      .join("\n");
    sections.push(`## Reviewer Failures\n\n${failures}`);
  }

  return sections.join("\n\n");
}

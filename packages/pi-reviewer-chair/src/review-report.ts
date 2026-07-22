import type { ReviewerFailure, ReviewerSuccess } from "./reviewer-runner.js";

export interface ReviewReport {
  prompt: string;
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

  if (report.successes.length === 0) {
    sections.push("## Reviews\n\nNo Reviewer produced a usable response.");
  } else {
    report.successes.forEach((review, index) => {
      sections.push(`## Review ${index + 1}\n\n${review.content}`);
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

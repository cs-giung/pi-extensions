import type { ToolOutput } from "./tools.js";
import { displayText } from "./progress.js";

function safe(value: string): string {
  return value.split("\n").map((line) => displayText(line, Number.MAX_SAFE_INTEGER)).join("\n");
}

export function compactResult(output: ToolOutput): string {
  if (output.error) return `Aufheben: ${displayText(output.error, 300)}`;
  const state = output.state;
  if (!state) return "No Aufheben state.";
  return `Aufheben round ${state.round} | ${state.lifecycle} | ${state.phase} | ${state.thesis?.claims.length ?? 0} claims, ${state.antithesis?.questions.length ?? 0} questions${output.replayed ? " | replayed; no new inference" : ""}`;
}

/** Human inspection is separate from the complete, validated JSON sent back to the main model. */
export function expandedResult(output: ToolOutput): string {
  const state = output.state;
  const lines = [`# Aufheben`, compactResult(output)];
  if (output.error) lines.push(`## Error\n${safe(output.error)}`);
  if (!state) return lines.join("\n\n");
  lines.push(`Exploration: ${state.explorationId}; revision: ${state.expectedRevision}`,
    `## Question\n${safe(state.question)}`);
  if (state.focus) lines.push(`## Round focus\n${safe(state.focus)}`);
  if (state.brief) {
    const brief = state.brief;
    lines.push(`## Shared research brief\n${safe(brief.problem)}\n\n${safe(brief.context)}`, `Language: ${safe(brief.language)}`);
    for (const [label, items] of [["Constraints", brief.constraints], ["Assumptions", brief.assumptions], ["Sources (not independently verified)", brief.sources]] as const) {
      if (items.length) lines.push(`### ${label}\n${items.map((item) => `- ${safe(item)}`).join("\n")}`);
    }
  }
  if (state.thesis) {
    lines.push("## Thesizer");
    for (const claim of state.thesis.claims) {
      lines.push(`### ${claim.id}: ${safe(claim.statement)}\nStatus: ${claim.epistemicStatus}\n\nReason: ${safe(claim.rationale)}`);
      if (claim.assumptions.length) lines.push(`Assumptions:\n${claim.assumptions.map((item) => `- ${safe(item)}`).join("\n")}`);
      if (claim.prediction) lines.push(`Prediction: ${safe(claim.prediction)}`);
      if (claim.sources.length) lines.push(`Sources (unverified):\n${claim.sources.map((item) => `- ${safe(item)}`).join("\n")}`);
      if (claim.revises.length) lines.push(`Revises: ${claim.revises.join(", ")}`);
    }
  }
  if (state.antithesis) {
    lines.push("## Antithesizer");
    if (state.antithesis.explanation) lines.push(safe(state.antithesis.explanation));
    for (const question of state.antithesis.questions) {
      lines.push(`### ${question.id}: ${safe(question.question)}\nTargets: ${question.targetClaimIds.join(", ")}\n\nReason: ${safe(question.rationale)}`);
      if (question.competingExplanation) lines.push(`Competing explanation: ${safe(question.competingExplanation)}`);
      if (question.discriminatingTest) lines.push(`Discriminating test: ${safe(question.discriminatingTest)}`);
    }
  }
  if (state.synthesis) {
    const synthesis = state.synthesis;
    lines.push(state.phase === "awaiting_user" ? "## Main-session synthesis" : "## Previous completed synthesis", safe(synthesis.idea));
    for (const claim of synthesis.claims) {
      lines.push(`- ${claim.claimId}: **${claim.disposition}** — ${safe(claim.reason)}${claim.replacement ? `\n  Replacement: ${safe(claim.replacement)}` : ""}`);
    }
    for (const question of synthesis.questions) lines.push(`- ${question.questionId}: **${question.disposition}** — ${safe(question.reason)}`);
    for (const [label, items] of [["New propositions", synthesis.newPropositions], ["Changes", synthesis.changes], ["Uncertainties", synthesis.uncertainties]] as const) {
      if (items.length) lines.push(`### ${label}\n${items.map((item) => `- ${safe(item)}`).join("\n")}`);
    }
    lines.push(`### Minimal informative experiment\n${safe(synthesis.experiment.design)}`,
      `Predictions:\n${synthesis.experiment.predictions.map((item) => `- ${safe(item)}`).join("\n")}`,
      `Abandonment criteria:\n${synthesis.experiment.abandonmentCriteria.map((item) => `- ${safe(item)}`).join("\n")}`,
      `Recommendation: ${synthesis.recommendation} (not authorization).`);
    if (synthesis.nextFocus) lines.push(`Proposed next focus: ${safe(synthesis.nextFocus)}`);
  }
  lines.push(state.lifecycle === "closed" ? "This exploration is closed. Start /aufheben <question> for a fresh exploration."
    : state.phase === "awaiting_user" || state.lifecycle === "paused"
      ? "Waiting for explicit user direction. Only /aufheben-next authorizes continuation."
      : "The current authorized round is in progress; no additional round is authorized.");
  return lines.join("\n\n");
}

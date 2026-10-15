import type { Exploration } from "./state.js";

export function statusText(state: Exploration | undefined, detail = ""): string {
  if (!state) return "No Aufheben exploration. Start one with /aufheben <question>.";
  return `Aufheben ${state.id.slice(0, 8)} | round ${state.round} | ${state.lifecycle} | ${state.runningRole ?? state.phase}${detail ? ` | ${displayText(detail, 120)}` : ""}`;
}

export function displayText(value: string, limit = 800): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).slice(0, limit);
}

export function describeState(state: Exploration | undefined): string {
  if (!state) return statusText(state);
  return [statusText(state), `Exploration: ${state.id}`, `Question: ${displayText(state.question)}`,
    `Revision: ${state.revision}`, `Resume phase: ${state.phase}`,
    `Accepted claims: ${state.thesis?.claims.length ?? 0}; questions: ${state.antithesis?.questions.length ?? 0}`,
    `Focus: ${displayText(state.focus || "not specified")}`,
    `Last error: ${displayText(state.lastError ?? "none")}`,
    `Reported child tokens: ${state.reportedUsage?.totalTokens ?? "unknown"}`,
    `Reported child cost: ${state.reportedUsage ? `$${state.reportedUsage.cost.total.toFixed(6)}` : "unknown"}`,
    "Usage is reported usage only, not a guaranteed complete bill.",
    `Latest idea: ${displayText(state.lastSynthesis?.idea ?? "no completed synthesis")}`,
    `Open questions: ${displayText(state.lastSynthesis?.uncertainties.join("; ") || "not recorded")}`,
    `Unresolved challenges: ${displayText(state.previousRound?.antithesis.questions.filter((question) =>
      state.previousRound!.synthesis.questions.some((decision) => decision.questionId === question.id && decision.disposition === "unresolved"))
      .map((question) => `${question.id}: ${question.question}`).join("; ") || "none recorded")}`,
    `Recommendation: ${state.lastSynthesis?.recommendation ?? "not recorded"}`,
    `Suggested next focus (not authorization): ${displayText(state.lastSynthesis?.nextFocus || "not specified")}`,
    "Use /aufheben-next to continue an open exploration; /aufheben-stop closes it without deleting history.",
  ].join("\n\n");
}

export function modelView(state: Exploration) {
  return { explorationId: state.id, round: state.round, expectedRevision: state.revision,
    phase: state.phase, lifecycle: state.lifecycle, question: state.question, brief: state.brief, focus: state.focus,
    thesis: state.thesis, antithesis: state.antithesis, synthesis: state.lastSynthesis };
}

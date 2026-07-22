import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  SessionExecutionError,
  runConfiguredSession,
  type SessionFailureKind,
  type SessionProgress,
} from "./agent-session.js";
import type { ReviewerChairConfig } from "./config.js";

export const REVIEWER_MANDATE = `You are an independent reviewer. Analyze the user's prompt for correctness, evidence, completeness, risks, and omissions.
Return concerns as a Markdown itemized list. Every concern must use this structure:
- [SEVERITY] Concern title
  - Evidence: concrete support for the concern
  - Impact: why the concern matters
  - Recommendation: how to resolve it
SEVERITY must be exactly one of CRITICAL, HIGH, MEDIUM, or LOW:
- CRITICAL: blocks a correct or safe outcome
- HIGH: a major defect that should be fixed before acceptance
- MEDIUM: a material weakness that should be addressed
- LOW: a minor improvement or non-blocking caveat
Do not merge unrelated concerns into one item. If there are no material concerns, return "- [NONE] No material concerns." After the findings, provide a concise proposed answer or resolution when the user's prompt calls for one.`;

export function buildReviewerSystemPrompt(customPrompt: string): string {
  return customPrompt.length > 0
    ? `${REVIEWER_MANDATE}\n\nAdditional reviewer instructions:\n${customPrompt}`
    : REVIEWER_MANDATE;
}

export interface ReviewerSuccess {
  index: number;
  content: string;
}

export interface ReviewerFailure {
  index: number;
  kind: SessionFailureKind;
  error: string;
}

export interface ReviewerRunResult {
  successes: ReviewerSuccess[];
  failures: ReviewerFailure[];
}

export interface ReviewerProgress {
  index: number;
  phase: SessionProgress["phase"] | "starting" | "completed" | "failed";
  toolName?: string;
}

export type ReviewerProgressListener = (progress: ReviewerProgress) => void;

export async function runReviewers(
  prompt: string,
  config: ReviewerChairConfig,
  modelRuntime: ModelRuntime,
  cwd: string,
  onProgress?: ReviewerProgressListener,
  signal?: AbortSignal,
  parentSession?: string,
): Promise<ReviewerRunResult> {
  const settled = await Promise.allSettled(
    config.reviewers.map(async (reviewer, index) => {
      onProgress?.({ index, phase: "starting" });
      try {
        const systemPrompt = buildReviewerSystemPrompt(reviewer.systemPrompt);
        const content = await runConfiguredSession({
          config: { ...reviewer, systemPrompt },
          prompt,
          sessionName: `Council Reviewer ${index + 1}`,
          parentSession,
          cwd,
          idleTimeoutMs: config.idleTimeoutMs,
          maxDurationMs: config.maxDurationMs,
          modelRuntime,
          onProgress: (progress) => onProgress?.({ index, ...progress }),
          signal,
        });
        onProgress?.({ index, phase: "completed" });
        return content;
      } catch (error) {
        onProgress?.({ index, phase: "failed" });
        throw error;
      }
    }),
  );

  const successes: ReviewerSuccess[] = [];
  const failures: ReviewerFailure[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      successes.push({ index, content: result.value });
      return;
    }

    const kind = result.reason instanceof SessionExecutionError ? result.reason.kind : "model";
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push({ index, kind, error });
  });

  return { successes, failures };
}

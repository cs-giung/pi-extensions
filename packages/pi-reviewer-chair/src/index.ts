import {
  ModelRuntime,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  copyTextPortable,
  type ClipboardCopyMethod,
  type ClipboardCopyResult,
} from "./clipboard.js";
import { runChair } from "./chair.js";
import { loadReviewerChairConfig } from "./config.js";
import { runReviewers } from "./reviewer-runner.js";
import { formatReviewerProgress, type ReviewerProgressView } from "./progress.js";
import { formatReviewReport, type ReviewReport } from "./review-report.js";
import { checkCouncilModels } from "./preflight.js";
import { findLastReviewReport, REPORT_ENTRY_TYPE } from "./report-state.js";

const STATUS_KEY = "reviewer-chair";

const CLIPBOARD_METHOD_LABEL: Record<ClipboardCopyMethod, string> = {
  macos: "macOS pbcopy",
  windows: "Windows clip",
  tmux: "tmux",
  osc52: "OSC 52",
  pi: "Pi's system clipboard",
};

export default function reviewerChairExtension(
  pi: ExtensionAPI,
  copyText: (text: string) => Promise<ClipboardCopyResult> = copyTextPortable,
): void {
  let running = false;
  let activeRun: AbortController | undefined;

  pi.on("session_shutdown", (_event, ctx) => {
    const run = activeRun;
    activeRun = undefined;
    running = false;
    run?.abort();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("council-cancel", {
    description: "Cancel the active Council run, including queued reviewers",
    handler: async (_args, ctx) => {
      if (!activeRun || activeRun.signal.aborted) {
        ctx.ui.notify("No active Council run to cancel.", "info");
        return;
      }
      activeRun.abort();
      ctx.ui.notify("Council cancellation requested. Waiting for active sessions to stop.", "info");
    },
  });

  pi.registerCommand("council-check", {
    description: "Validate Council configuration and model access without starting model runs",
    handler: async (_args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before checking its local Council configuration.", "warning");
        return;
      }
      try {
        const config = await loadReviewerChairConfig(ctx.cwd);
        const runtime = await ModelRuntime.create({ allowModelNetwork: false });
        checkCouncilModels(config, runtime);
        ctx.ui.notify(
          `Council configuration is valid: ${config.reviewers.length} reviewers, minimum ${config.minSuccess} successes, concurrency ${config.maxConcurrency}. No model runs were started.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("council-reviews", {
    description: "Show anonymous raw responses from the most recent Council run",
    handler: async (_args, ctx) => {
      if (running) {
        ctx.ui.notify("The Council is still running. Reviewer responses are not ready yet.", "warning");
        return;
      }
      const lastReviewReport = findLastReviewReport(ctx.sessionManager.getBranch());
      if (!lastReviewReport) {
        ctx.ui.notify("No completed Reviewer run is available. Run /council first.", "warning");
        return;
      }

      pi.sendMessage(
        {
          customType: "reviewer-chair-reviews",
          content: formatReviewReport(lastReviewReport),
          display: true,
          details: {
            successfulReviewers: lastReviewReport.successes.length,
            failedReviewers: lastReviewReport.failures.length,
          },
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("council-copy", {
    description: "Copy the most recent Chair answer to the clipboard",
    handler: async (_args, ctx) => {
      const answer = findLastChairAnswer(ctx.sessionManager.getBranch());
      if (!answer) {
        ctx.ui.notify("No Chair answer is available. Run /council first.", "warning");
        return;
      }

      try {
        const result = await copyText(answer);
        const method = CLIPBOARD_METHOD_LABEL[result.method];
        const message = result.terminal
          ? `Sent the most recent Chair answer via ${method}. If it is missing, allow OSC 52 clipboard writes in the terminal.`
          : `Copied the most recent Chair answer via ${method}.`;
        ctx.ui.notify(message, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not copy the Chair answer: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("council", {
    description: "Run configured reviewers and synthesize a Chair answer",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (prompt.length === 0) {
        ctx.ui.notify("Usage: /council <prompt>", "warning");
        return;
      }
      if (running) {
        ctx.ui.notify("A council run is already in progress.", "warning");
        return;
      }

      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before running /council with its local configuration.", "warning");
        return;
      }

      const runController = new AbortController();
      activeRun = runController;
      running = true;
      const parentSession = ctx.sessionManager.getSessionFile();
      try {
        const config = await loadReviewerChairConfig(ctx.cwd);
        const modelRuntime = await ModelRuntime.create({ signal: runController.signal, allowModelNetwork: false });
        if (runController.signal.aborted) return;
        checkCouncilModels(config, modelRuntime);

        const reviewerProgress: ReviewerProgressView[] = config.reviewers.map((reviewer, index) => ({
          label: reviewer.name ?? `Reviewer ${index + 1}`,
          phase: "waiting",
        }));
        ctx.ui.setStatus(STATUS_KEY, formatReviewerProgress(reviewerProgress));

        ctx.ui.notify(`Running ${config.reviewers.length} reviewers...`, "info");
        const reviewResult = await runReviewers(
          prompt,
          config,
          modelRuntime,
          ctx.cwd,
          (progress) => {
            if (runController.signal.aborted) return;
            const current = reviewerProgress[progress.index];
            if (!current) {
              return;
            }
            reviewerProgress[progress.index] = progress.toolName
              ? { label: current.label, phase: progress.phase, toolName: progress.toolName }
              : { label: current.label, phase: progress.phase };
            ctx.ui.setStatus(STATUS_KEY, formatReviewerProgress(reviewerProgress));
          },
          runController.signal,
          parentSession,
        );
        if (runController.signal.aborted) return;

        const report: ReviewReport = {
          prompt,
          successes: reviewResult.successes,
          failures: reviewResult.failures,
        };
        pi.appendEntry(REPORT_ENTRY_TYPE, { version: 1, report });

        if (reviewResult.failures.length > 0) {
          const failures = reviewResult.failures
            .map((failure) => {
              const label =
                config.reviewers[failure.index]?.name ?? `Reviewer ${failure.index + 1}`;
              return `${label} ${failure.kind}: ${failure.error}`;
            })
            .join("; ");
          ctx.ui.notify(`${reviewResult.failures.length} reviewer(s) failed: ${failures}`, "warning");
        }

        if (reviewResult.successes.length < config.minSuccess) {
          ctx.ui.notify(
            `Chair skipped: ${reviewResult.successes.length}/${config.minSuccess} required reviewers succeeded.`,
            "error",
          );
          return;
        }

        ctx.ui.setStatus(
          STATUS_KEY,
          `Reviewers ${reviewResult.successes.length}/${config.reviewers.length} succeeded | Chair:running`,
        );
        ctx.ui.notify(`Chair is aggregating ${reviewResult.successes.length} anonymous reviews...`, "info");
        const finalAnswer = await runChair(
          prompt,
          reviewResult.successes,
          config,
          modelRuntime,
          ctx.cwd,
          runController.signal,
          parentSession,
        );
        if (runController.signal.aborted) return;

        pi.sendMessage(
          {
            customType: "reviewer-chair-final",
            content: finalAnswer,
            display: true,
            details: {
              successfulReviewers: reviewResult.successes.length,
              totalReviewers: config.reviewers.length,
            },
          },
          { triggerTurn: false },
        );
      } catch (error) {
        if (!runController.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Council failed: ${message}`, "error");
        }
      } finally {
        if (activeRun === runController) {
          activeRun = undefined;
          running = false;
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
      }
    },
  });
}

export function findLastChairAnswer(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom_message" &&
      entry.customType === "reviewer-chair-final" &&
      typeof entry.content === "string"
    ) {
      return entry.content;
    }
  }
  return undefined;
}

import { createHash, randomUUID } from "node:crypto";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadCouncilConfig, type CouncilConfig } from "./config.js";
import { chairInstructions, reviewerPrompt } from "./chair.js";
import { abortable, checkCouncilModels, createCouncilRuntime } from "./preflight.js";
import { formatReviewerProgress, type ReviewerProgressView } from "./progress.js";
import { reviewInputSchema, reviewView, safeDisplay, type ReviewOutput } from "./protocol.js";
import { findLastReviewReport, REPORT_ENTRY_TYPE } from "./report-state.js";
import { formatReviewReport } from "./review-report.js";
import { runReviewers, type ReviewerRunResult } from "./reviewer-runner.js";
import { findLastChairAnswer, isActive, readRun, runSchema, saveRun, type CouncilRun } from "./state.js";
import { copyTextPortable, type ClipboardCopyResult } from "./clipboard.js";
import type { SessionAccounting } from "./usage.js";
import { inspectWorker } from "./worker-state.js";
import { formatReview, verifyReview } from "./review-artifact.js";

export interface CouncilOptions {
  loadConfig?: (cwd: string) => Promise<CouncilConfig>;
  createRuntime?: (ctx: ExtensionContext, signal: AbortSignal) => Promise<ModelRuntime>;
  runReviewers?: typeof runReviewers;
  copyText?: (text: string) => Promise<ClipboardCopyResult>;
}
export class CouncilController {
  private permission: string | undefined;
  private activation: string | undefined;
  private owned: string | undefined;
  private generation = 0;
  private preparing = false;
  private intervention = false;
  private controller: AbortController | undefined;
  private pending: Promise<ReviewerRunResult> | undefined;
  private readonly options: Required<CouncilOptions>;
  constructor(private readonly pi: ExtensionAPI, options: CouncilOptions = {}) {
    this.options = { loadConfig: options.loadConfig ?? loadCouncilConfig, createRuntime: options.createRuntime ?? createCouncilRuntime,
      runReviewers: options.runReviewers ?? runReviewers, copyText: options.copyText ?? copyTextPortable };
  }
  private trusted(ctx: ExtensionContext): void {
    if (!ctx.isProjectTrusted()) throw new Error("Trust this project before using its local Council configuration.");
  }
  private save(state: CouncilRun, ctx: ExtensionContext): void {
    saveRun(this.pi, state);
    ctx.ui.setStatus("council", isActive(state) ? `Council ${state.continuation?.id.slice(0, 8) ?? state.id.slice(0, 8)} | round ${state.continuation?.round ?? 1} | ${state.phase}` : undefined);
  }
  async check(ctx: ExtensionContext): Promise<void> {
    this.trusted(ctx);
    const config = await this.options.loadConfig(ctx.cwd);
    const runtime = await this.options.createRuntime(ctx, new AbortController().signal);
    checkCouncilModels(config, runtime);
    ctx.ui.notify(`Council configuration is valid: ${config.reviewers.length} reviewers, minimum ${config.minSuccess} successes, concurrency ${config.maxConcurrency}. The current main model is the Chair. No model runs were started.`, "info");
  }
  async start(prompt: string, ctx: ExtensionCommandContext, continuing = false): Promise<void> {
    this.trusted(ctx);
    if ((!continuing && !prompt.trim()) || prompt.length > 16000) throw new Error("Use /council <prompt> or /council-next [focus] (at most 16000 characters).");
    if (!ctx.isIdle() || this.permission || this.preparing || this.pending || this.controller) throw new Error("Wait for active work or Council cancellation cleanup before starting /council.");
    const previous = continuing ? readRun(ctx) : undefined;
    if (continuing && !previous?.continuation) throw new Error("No resumable Council on this branch. Start a fresh /council first.");
    if (previous?.continuation?.workers.some((worker, index) => worker && !previous.continuation!.reviews[index])) {
      throw new Error("This Council predates structured Reviewer ledgers. Its reports remain readable; start a fresh /council to use structured continuation.");
    }
    this.preparing = true;
    const controller = new AbortController(); this.controller = controller;
    const generation = this.generation;
    try {
      const config = previous?.config ?? await this.options.loadConfig(ctx.cwd);
      controller.signal.throwIfAborted();
      const runtime = await abortable(this.options.createRuntime(ctx, controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      if (generation !== this.generation) throw new Error("Council start was cancelled.");
      checkCouncilModels(config, runtime);
      if (!ctx.isIdle()) throw new Error("The main session started other work during preflight. Run /council again when idle.");
      const id = randomUUID();
      const prior = previous?.continuation;
      const continuation = prior ? { ...prior, round: prior.round + 1, focus: prompt.trim(),
        previousAnswer: previous!.answer ?? prior.previousAnswer, previousBrief: previous!.brief ?? prior.previousBrief }
        : { id, round: 1, focus: "", workers: config.reviewers.map(() => null), reviews: config.reviewers.map(() => null), previousAnswer: null, previousBrief: null };
      for (const [index, ref] of continuation.workers.entries()) {
        inspectWorker({ councilId: continuation.id, index, ref, ownerSessionId: ctx.sessionManager.getSessionId(),
          sessionDir: ctx.sessionManager.getSessionDir() }, ctx.cwd);
      }
      const state = runSchema.parse({ version: 1, id, cwd: ctx.cwd, prompt: previous?.prompt ?? prompt.trim(), config,
        phase: "prepare", brief: null, report: null, digest: null, answer: null, error: null, continuation });
      this.save(state, ctx);
      this.permission = state.id;
      this.activation = `The user authorized one Council Reviewer batch. Be the Chair in this existing main session.\n${JSON.stringify({ runId: state.id, originalPrompt: state.prompt, round: continuation.round, focus: continuation.focus })}`;
      this.pi.sendUserMessage(this.activation, { expandPromptTemplates: false });
    } finally {
      this.preparing = false;
      if (this.controller === controller) this.controller = undefined;
    }
  }
  beforeTurn(prompt: string, ctx: ExtensionContext): string | undefined {
    const state = readRun(ctx);
    if (!state) return undefined;
    if (this.permission === state.id && this.activation === prompt) {
      this.activation = undefined; this.owned = state.id; this.intervention = false;
      return chairInstructions(state.id, state.prompt, state.config.chair.systemPrompt, state.continuation);
    }
    return isActive(state) ? "No Council batch is authorized in this turn. Respond normally; only /council or /council-next authorizes Reviewer inference." : undefined;
  }
  input(): void { if (this.owned) this.intervention = true; }

  async review(raw: unknown, ctx: ExtensionContext, signal?: AbortSignal,
    progress?: (text: string) => void): Promise<{ output: ReviewOutput; results: SessionAccounting[] }> {
    const results: SessionAccounting[] = [];
    let state: CouncilRun | undefined;
    try {
      this.trusted(ctx); signal?.throwIfAborted();
      if (this.preparing || this.pending || this.controller) throw new Error("Another Council operation is still running or cleaning up.");
      if ((JSON.stringify(raw)?.length ?? 0) > 40000) throw new Error("Council input is too large; provide a brief of at most 32000 characters.");
      const input = reviewInputSchema.parse(raw);
      state = readRun(ctx);
      if (!state || state.id !== input.runId) throw new Error("Stale or missing Council run. Use /council for a fresh review or /council-next to continue.");
      const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (state.report && state.digest === digest) return { output: reviewView(state, null, true), results };
      if (this.permission !== state.id || this.owned !== state.id || state.phase !== "prepare") {
        throw new Error("This Council batch is not authorized. Use /council for a fresh review or /council-next to continue.");
      }
      if (this.intervention) throw new Error("User intervention changed this turn. Use /council-next with the revised focus, or /council for a fresh review.");
      state = { ...state, phase: "reviewing", brief: input.brief };
      this.save(state, ctx);
      const run = state;
      const controller = new AbortController(); this.controller = controller;
      const operationSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      const generation = this.generation;
      try {
        const runtime = await abortable(this.options.createRuntime(ctx, operationSignal), operationSignal);
        operationSignal.throwIfAborted(); checkCouncilModels(run.config, runtime);
        const views: ReviewerProgressView[] = run.config.reviewers.map((reviewer, index) => ({ label: reviewer.name ?? `Reviewer ${index + 1}`, phase: "waiting" }));
        const operation = this.options.runReviewers(reviewerPrompt(run.prompt, input.brief), run.config, runtime, ctx.cwd,
          (update) => {
            if (generation !== this.generation || operationSignal.aborted) return;
            const current = views[update.index]; if (!current) return;
            views[update.index] = { label: current.label, phase: update.phase, ...(update.toolName ? { toolName: update.toolName } : {}) };
            ctx.ui.setStatus("council", safeDisplay(formatReviewerProgress(views)).replace(/\s+/g, " ").slice(0, 1000));
            progress?.(`Council Reviewers: ${views.filter((view) => view.phase === "completed" || view.phase === "failed").length}/${views.length} settled`);
          }, operationSignal, ctx.sessionManager.getSessionFile(), (entry) => results.push(entry), run.continuation ? {
            councilId: run.continuation.id, workers: run.continuation.workers,
            round: run.continuation.round, reviews: run.continuation.reviews,
            ownerSessionId: ctx.sessionManager.getSessionId(), sessionDir: ctx.sessionManager.getSessionDir(),
          } : undefined);
        this.pending = operation;
        const result = await operation;
        operationSignal.throwIfAborted();
        if (generation !== this.generation || readRun(ctx)?.id !== run.id) throw new Error("A stale Council result was discarded.");
        const seen = new Set<number>();
        const reviews = run.config.reviewers.map((_, index) => run.continuation?.reviews[index] ?? null);
        const successes = result.successes.map((success) => {
          if (!Number.isInteger(success.index) || success.index < 0 || success.index >= reviews.length || seen.has(success.index)) {
            throw new Error("Invalid or duplicate Reviewer result index.");
          }
          seen.add(success.index);
          const artifact = verifyReview(success.artifact, run.continuation?.round ?? 1, success.index + 1,
            reviews[success.index]?.activeConcerns ?? []);
          reviews[success.index] = artifact;
          return { index: success.index, artifact, content: formatReview(artifact) };
        });
        const report = { prompt: run.prompt, brief: input.brief, round: run.continuation?.round ?? 1,
          focus: run.continuation?.focus ?? "", successes,
          failures: result.failures.map((failure) => ({ index: failure.index, kind: failure.kind, error: `Reviewer failed (${failure.kind}); inspect its saved session for diagnostics.` })) };
        this.pi.appendEntry(REPORT_ENTRY_TYPE, { version: 1, report });
        const enough = report.successes.length >= run.config.minSuccess;
        const error = this.intervention ? "User intervention received. Reviews describe the previous brief; use /council-next with the revised focus."
          : enough ? null : `Chair skipped: ${report.successes.length}/${run.config.minSuccess} required reviewers succeeded.`;
        state = runSchema.parse({ ...run, report, digest,
          continuation: run.continuation ? { ...run.continuation, workers: result.workers ?? run.continuation.workers, reviews } : null,
          phase: this.intervention ? "interrupted" : enough ? "chair" : "failed", error });
        this.save(state, ctx);
        if (error) this.permission = undefined;
        return { output: reviewView(state), results };
      } catch (cause) {
        const checkpointError = cause instanceof Error && /^(Missing Council|Mismatched or corrupt Council|Invalid Council)/.test(cause.message);
        const error = operationSignal.aborted ? "Council was cancelled." : checkpointError ? cause.message
          : "Council Reviewer execution failed. Run /council-check and inspect the saved sessions.";
        if (generation === this.generation) {
          state = { ...run, phase: operationSignal.aborted ? "cancelled" : "failed", error };
          this.permission = undefined; this.save(state, ctx);
        }
        if (generation !== this.generation) {
          try { state = readRun(ctx); } catch { state = undefined; }
          if (state?.id !== run.id) state = undefined;
        }
        return { output: reviewView(state, error), results };
      } finally {
        this.pending = undefined;
        if (this.controller === controller) this.controller = undefined;
      }
    } catch (cause) {
      return { output: reviewView(state, cause instanceof Error ? cause.message : "Council tool failed"), results };
    }
  }

  beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext): void {
    if (!this.owned || event.continue || event.context.pendingMessages.length) return;
    const state = readRun(ctx);
    if (!state || state.id !== this.owned || !isActive(state)) return;
    const last = [...event.context.contextMessages].reverse().find((message) => message.role === "assistant");
    const answer = last?.role === "assistant" && last.stopReason === "stop" && !last.content.some((part) => part.type === "toolCall")
      ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim() : "";
    if (state.phase === "chair" && event.outcome === "completed" && !this.intervention && answer) {
      this.save({ ...state, phase: "complete", answer, error: null }, ctx);
    } else this.save({ ...state, phase: "interrupted", error: "The main turn ended before a complete Chair answer. No inference was resumed; use /council-next to review again, or /council for a fresh start." }, ctx);
    this.permission = undefined;
  }
  settled(ctx: ExtensionContext): void {
    this.permission = undefined; this.activation = undefined; this.owned = undefined; this.intervention = false;
    ctx.ui.setStatus("council", undefined);
  }
  async cancel(ctx: ExtensionContext): Promise<void> {
    let state: CouncilRun | undefined;
    try { state = readRun(ctx); } catch { /* Cancellation must not depend on valid saved metadata. */ }
    if (!this.permission && !this.controller && !this.preparing && !this.pending) {
      ctx.ui.notify("No active Council run to cancel.", "info"); return;
    }
    this.generation += 1; this.permission = undefined; this.activation = undefined;
    this.controller?.abort(new Error("Council cancelled by the user"));
    if (state && isActive(state)) this.save({ ...state, phase: "cancelled", error: "Cancelled by the user." }, ctx);
    if (this.owned) ctx.abort();
    await this.pending?.catch(() => undefined);
    ctx.ui.notify("Council cancelled. Completed reports and earlier answers are preserved.", "info");
  }
  async shutdown(): Promise<void> {
    this.generation += 1; this.permission = undefined; this.activation = undefined; this.owned = undefined;
    this.controller?.abort(new Error("Council session was shut down"));
    await this.pending?.catch(() => undefined);
  }
  async recover(ctx: ExtensionContext): Promise<void> {
    await this.shutdown();
    const state = readRun(ctx);
    if (state && isActive(state)) this.save({ ...state, phase: "interrupted", error: "Restored an interrupted Council. No inference was resumed; use /council-next to review again, or /council for a fresh start." }, ctx);
    ctx.ui.setStatus("council", undefined);
  }
  reviews(ctx: ExtensionContext): void {
    if (this.permission || this.pending) throw new Error("The Council is still running. Reviewer responses are not ready yet.");
    const report = findLastReviewReport(ctx.sessionManager.getBranch());
    if (!report) { ctx.ui.notify("No completed Reviewer run is available. Run /council first.", "warning"); return; }
    this.pi.sendMessage({ customType: "council-reviews", content: safeDisplay(formatReviewReport(report)), display: true,
      details: { successfulReviewers: report.successes.length, failedReviewers: report.failures.length } }, { triggerTurn: false });
  }
  async copy(ctx: ExtensionContext): Promise<void> {
    const answer = findLastChairAnswer(ctx.sessionManager.getBranch());
    if (!answer) { ctx.ui.notify("No Chair answer is available. Run /council first.", "warning"); return; }
    const result = await this.options.copyText(answer);
    const methods = { macos: "macOS pbcopy", windows: "Windows clip", tmux: "tmux", osc52: "OSC 52", pi: "Pi's system clipboard" };
    ctx.ui.notify(result.terminal ? `Sent the most recent Chair answer via ${methods[result.method]}. If it is missing, allow OSC 52 clipboard writes in the terminal.`
      : `Copied the most recent Chair answer via ${methods[result.method]}.`, "info");
  }
}

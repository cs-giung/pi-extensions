import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRoleRuntime, loadConfig, preflight, type AufhebenConfig } from "./config.js";
import { acceptAntithesis, acceptThesis, antithesisInputSchema, checkpointInputSchema, MAX_OUTPUT_CHARS,
  parseJson, thesisInputSchema, validateSynthesis, type Antithesis, type Thesis, type ToolInput, type ToolKind } from "./protocol.js";
import { acceptRole, addUsage, advance, assertIdentity, assertStage, completeRound, continueExploration,
  createExploration, pauseState, updateBrief, type Exploration, type RecordedUsage } from "./state.js";
import { activationMessage, mainInstructions, rolePrompt } from "./prompts.js";
import { currentState, saveState } from "./storage.js";
import { describeState, displayText, modelView, statusText } from "./progress.js";
import { abortable, RoleRequestError, runRole, type Accounting, type RoleRequest, type RoleResult } from "./role-session.js";

export interface AufhebenOptions {
  loadConfig?: (cwd: string) => Promise<AufhebenConfig>;
  createRuntime?: (ctx: ExtensionContext, signal: AbortSignal) => Promise<ModelRuntime>;
  runRole?: <T>(request: RoleRequest<T>) => Promise<RoleResult<T>>;
}
export interface ToolOutcome {
  state: ReturnType<typeof modelView> | null;
  replayed: boolean;
  error: string | null;
  results: Accounting[];
}

export class AufhebenController {
  private permission: string | undefined;
  private activation: string | undefined;
  private ownedTurn = false;
  private generation = 0;
  private controller: AbortController | undefined;
  private pending: Promise<RoleResult<Thesis | Antithesis>> | undefined;
  private preparing = false;
  private intervention = false;
  private readonly options: Required<AufhebenOptions>;

  constructor(private readonly pi: ExtensionAPI, options: AufhebenOptions = {}) {
    this.options = { loadConfig: options.loadConfig ?? loadConfig,
      createRuntime: options.createRuntime ?? createRoleRuntime, runRole: options.runRole ?? runRole };
  }

  private trusted(ctx: ExtensionContext): void {
    if (!ctx.isProjectTrusted()) throw new Error("Trust this project before using Aufheben configuration or sessions.");
  }

  private publish(ctx: ExtensionContext, state: Exploration): void {
    saveState(this.pi, state);
    ctx.ui.setStatus("aufheben", statusText(state));
  }

  private state(ctx: ExtensionContext): Exploration {
    const state = currentState(ctx);
    if (!state) throw new Error("No Aufheben exploration. Start one with /aufheben <question>.");
    return state;
  }

  private activate(state: Exploration): void {
    this.permission = state.id;
    this.activation = activationMessage(state);
    this.pi.sendUserMessage(this.activation, { expandPromptTemplates: false });
  }

  async start(ctx: ExtensionCommandContext, question: string): Promise<void> {
    this.trusted(ctx);
    if (!question.trim() || question.length > 16000) throw new Error("Usage: /aufheben <question> (at most 16000 characters)");
    if (!ctx.isIdle() || this.pending || this.preparing || this.permission) throw new Error("Pause active work and wait for cleanup before starting Aufheben.");
    this.preparing = true;
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.generation;
    try {
      const config = await this.options.loadConfig(ctx.cwd);
      controller.signal.throwIfAborted();
      const runtime = await abortable(this.options.createRuntime(ctx, controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      if (generation !== this.generation) throw new Error("Aufheben start was cancelled.");
      preflight(config, runtime);
      if (!ctx.isIdle()) throw new Error("The main session started other work during preflight. Start Aufheben again when idle.");
      let old: Exploration | undefined;
      try { old = currentState(ctx); }
      catch { ctx.ui.notify("The previous Aufheben snapshot is invalid. Starting fresh without deleting history.", "warning"); }
      const state = createExploration(randomUUID(), ctx.cwd, question.trim(), config);
      this.publish(ctx, state);
      ctx.ui.notify(old ? `Started a fresh Aufheben exploration; ${old.id.slice(0, 8)} remains in session history.`
        : "Started Aufheben. The current main model is the Synthesizer.", "info");
      this.activate(state);
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.preparing = false;
    }
  }

  async next(ctx: ExtensionCommandContext, focus: string): Promise<void> {
    this.trusted(ctx);
    if (!ctx.isIdle() || this.pending || this.preparing || this.permission) throw new Error("Wait for active work or cancellation cleanup before /aufheben-next.");
    if (focus.length > 16000) throw new Error("Focus must not exceed 16000 characters.");
    const state = continueExploration(this.state(ctx), focus.trim());
    this.publish(ctx, state);
    this.activate(state);
  }

  async pause(ctx: ExtensionContext, close = false): Promise<void> {
    const active = Boolean(this.controller || this.permission || this.ownedTurn);
    let state: Exploration | undefined;
    try { state = currentState(ctx); }
    catch (cause) {
      if (!active) throw cause;
      ctx.ui.notify("Aufheben metadata is invalid; cancelling owned work without rewriting history.", "warning");
    }
    if (!state && !active) { ctx.ui.notify("No Aufheben exploration is active.", "info"); return; }
    if (state?.lifecycle === "closed" && !active) {
      ctx.ui.notify("Aufheben is already closed. Start /aufheben <question> for a fresh exploration.", "info"); return;
    }
    this.permission = undefined;
    this.activation = undefined;
    this.generation += 1;
    this.controller?.abort(new Error(close ? "Aufheben stopped" : "Aufheben paused"));
    if (active && this.ownedTurn) ctx.abort();
    if (state && state.lifecycle !== "closed" && (close || active || state.lifecycle !== "paused" && state.phase !== "awaiting_user")) {
      this.publish(ctx, pauseState(state, close ? "Stopped by the user." : "Paused by the user.", close));
    }
    // Do not clear the lock until the child SDK has actually finished abort/dispose.
    const generation = this.generation;
    let cancelledUsage: RecordedUsage | null = null;
    try { cancelledUsage = (await this.pending)?.usage ?? null; }
    catch (cause) { if (cause instanceof RoleRequestError) cancelledUsage = cause.usage; }
    if (cancelledUsage && state && generation === this.generation) {
      const current = currentState(ctx);
      if (current && current.id === state?.id) {
        this.publish(ctx, advance(current, { reportedUsage: addUsage(current.reportedUsage, cancelledUsage) }));
      }
    }
    ctx.ui.notify(close ? "Aufheben exploration closed. History is preserved."
      : active ? "Aufheben paused. Use /aufheben-next to retry the unfinished stage." : "Aufheben is already waiting or paused.", "info");
  }

  status(ctx: ExtensionContext): void { ctx.ui.notify(describeState(currentState(ctx)), "info"); }

  beforeTurn(prompt: string, ctx: ExtensionContext): string | undefined {
    const state = currentState(ctx);
    if (!state || state.lifecycle === "closed") return undefined;
    const authorized = this.permission === state.id && this.activation === prompt;
    if (authorized) { this.ownedTurn = true; this.activation = undefined; this.intervention = false; }
    return mainInstructions(state, authorized);
  }

  onUserInput(): void {
    if (this.ownedTurn) this.intervention = true;
  }

  async settle(ctx: ExtensionContext): Promise<void> {
    if (!this.ownedTurn) return;
    this.ownedTurn = false;
    this.permission = undefined;
    this.activation = undefined;
    this.intervention = false;
    const state = currentState(ctx);
    if (state?.lifecycle === "open" && state.phase !== "awaiting_user") {
      this.publish(ctx, pauseState(state, "The main turn ended before the round checkpoint. Use /aufheben-next to retry the unfinished stage."));
    }
  }

  async recover(ctx: ExtensionContext): Promise<void> {
    await this.shutdown();
    const state = currentState(ctx);
    if (!state) { ctx.ui.setStatus("aufheben", undefined); return; }
    if (state.lifecycle === "open" && state.phase !== "awaiting_user") {
      this.publish(ctx, pauseState(state, "Restored an interrupted round. No inference was resumed. Use /aufheben-next."));
    } else ctx.ui.setStatus("aufheben", statusText(state));
  }

  async shutdown(): Promise<void> {
    this.generation += 1;
    this.permission = undefined;
    this.activation = undefined;
    this.ownedTurn = false;
    this.controller?.abort(new Error("Aufheben context was shut down"));
    await this.pending?.catch(() => undefined);
  }

  async execute(kind: ToolKind, raw: unknown, ctx: ExtensionContext, signal?: AbortSignal,
    progress?: (phase: string) => void): Promise<ToolOutcome> {
    let results: Accounting[] = [];
    try {
      this.trusted(ctx);
      signal?.throwIfAborted();
      if (this.preparing || this.pending) throw new Error("Another Aufheben operation is still running or cleaning up.");
      if ((JSON.stringify(raw)?.length ?? 0) > MAX_OUTPUT_CHARS) throw new Error("Aufheben tool input exceeds 64000 characters.");
      const input = (kind === "thesis" ? thesisInputSchema.parse(raw)
        : kind === "antithesis" ? antithesisInputSchema.parse(raw) : checkpointInputSchema.parse(raw)) as ToolInput;
      if (JSON.stringify(input).length > MAX_OUTPUT_CHARS) throw new Error("Aufheben tool input exceeds 64000 characters.");
      let state = this.state(ctx);
      const digest = createHash("sha256").update(JSON.stringify({ kind, input })).digest("hex");
      if (input.explorationId === state.id && input.round === state.round
        && state.receipts.some((receipt) => receipt.kind === kind && receipt.digest === digest)) {
        return { state: modelView(state), replayed: true, error: null, results: [] };
      }
      assertIdentity(state, input);
      if (kind === "checkpoint" && "action" in input && input.action === "update_brief") {
        if (state.lifecycle === "open" && state.phase !== "awaiting_user") {
          if (!this.intervention || !this.ownedTurn) throw new Error("Pause the partial round before changing its brief.");
          this.permission = undefined;
          state = pauseState(state, "User intervention saved. Use /aufheben-next to continue.");
        }
        state = updateBrief(state, input.brief);
        state = advance(state, { receipts: [...state.receipts, { kind, digest }].slice(-8) });
        this.publish(ctx, state);
        return { state: modelView(state), replayed: false, error: null, results: [] };
      }
      if (!this.ownedTurn || this.permission !== state.id) throw new Error("Only /aufheben or /aufheben-next authorizes a research round.");
      if (this.intervention) {
        this.permission = undefined;
        this.publish(ctx, pauseState(state, "User intervention received. Update the brief and use /aufheben-next."));
        throw new Error("A user intervention requires review before another research step. No further child call was made.");
      }
      assertStage(state, kind);
      if (kind === "checkpoint" && "synthesis" in input) {
        const synthesis = validateSynthesis(input.synthesis, state.thesis!, state.antithesis!);
        state = completeRound(state, synthesis, digest);
        this.publish(ctx, state);
        this.permission = undefined;
        return { state: modelView(state), replayed: false, error: null, results: [] };
      }
      const role = kind === "thesis" ? "thesizer" : "antithesizer";
      if (kind === "thesis" && "brief" in input) state = advance(state, { brief: input.brief });
      state = advance(state, { runningRole: role });
      this.publish(ctx, state);
      const controller = new AbortController();
      this.controller = controller;
      const operationSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      const generation = this.generation;
      const request: RoleRequest<Thesis | Antithesis> = {
        state, role, ctx, signal: operationSignal,
        prompt: rolePrompt(state, role, "instruction" in input ? input.instruction : ""),
        createRuntime: this.options.createRuntime,
        parse: (text) => role === "thesizer" ? acceptThesis(parseJson(text), state.round, state.knownClaimIds)
          : acceptAntithesis(parseJson(text), state.round, state.thesis!),
        progress: (phase) => { if (generation === this.generation) {
          const detail = displayText(phase, 120);
          ctx.ui.setStatus("aufheben", statusText(state, detail)); progress?.(detail);
        } },
      };
      const operation = this.options.runRole(request);
      this.pending = operation;
      try {
        const result = await operation;
        results = result.results;
        operationSignal.throwIfAborted();
        if (generation !== this.generation) throw new Error("A stale Aufheben result was discarded.");
        state = acceptRole(state, role, result.artifact, result.worker, result.usage, { kind, digest });
        this.publish(ctx, state);
      } catch (cause) {
        if (cause instanceof RoleRequestError) results = cause.results;
        if (generation === this.generation) {
          this.permission = undefined;
          const usage = cause instanceof RoleRequestError ? cause.usage : null;
          state = pauseState(state, operationSignal.aborted ? "Aufheben role was cancelled."
            : cause instanceof RoleRequestError ? cause.message : "Aufheben role failed. Check the provider or saved worker session.");
          state = advance(state, { reportedUsage: addUsage(state.reportedUsage, usage) });
          this.publish(ctx, state);
        }
        throw cause;
      } finally {
        if (this.pending === operation) this.pending = undefined;
        if (this.controller === controller) this.controller = undefined;
      }
      return { state: modelView(state), replayed: false, error: null, results };
    } catch (cause) {
      let state: Exploration | undefined;
      try { state = currentState(ctx); } catch { /* The original diagnostic remains authoritative. */ }
      return { state: state ? modelView(state) : null, replayed: false,
        error: cause instanceof Error ? cause.message.slice(0, 8000) : "Aufheben operation failed", results };
    }
  }
}

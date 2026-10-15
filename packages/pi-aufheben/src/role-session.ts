import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager,
  type AgentSession, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Role } from "./config.js";
import { addUsage, usageSchema, type Exploration, type RecordedUsage, type WorkerRef } from "./state.js";
import { roleSystemPrompt } from "./prompts.js";

const WORKER_ENTRY = "aufheben-worker";
export interface Accounting { sessionFile: string; usage: RecordedUsage }
export interface RoleResult<T> { artifact: T; worker: WorkerRef; usage: RecordedUsage | null; results: Accounting[] }
export class RoleRequestError extends Error {
  constructor(message: string, readonly usage: RecordedUsage | null, readonly results: Accounting[], options?: ErrorOptions) {
    super(message, options); this.name = "RoleRequestError";
  }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function openWorker(state: Exploration, role: Role, ctx: ExtensionContext): SessionManager {
  const ref = state.workers[role];
  let manager: SessionManager;
  if (!ref) {
    const parentSession = ctx.sessionManager.getSessionFile();
    manager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir(), parentSession ? { parentSession } : undefined);
    manager.appendSessionInfo(`Aufheben ${state.id.slice(0, 8)} ${role}`);
    manager.appendCustomEntry(WORKER_ENTRY, { version: 1, explorationId: state.id, role });
    return manager;
  }
  if (!isAbsolute(ref.file) || !ref.file.endsWith(".jsonl") || !existsSync(ref.file)) {
    throw new Error(`Missing Aufheben ${role} session. Restore its recorded file or start a new exploration.`);
  }
  manager = SessionManager.open(ref.file);
  if (manager.getCwd() !== ctx.cwd || manager.getSessionId() !== ref.sessionId || !manager.getEntry(ref.leafId)) {
    throw new Error(`Mismatched or corrupt Aufheben ${role} session checkpoint.`);
  }
  const marker = manager.getBranch(ref.leafId).find((entry) => entry.type === "custom" && entry.customType === WORKER_ENTRY);
  if (marker?.type !== "custom" || !marker.data || typeof marker.data !== "object"
    || (marker.data as Record<string, unknown>).version !== 1
    || (marker.data as Record<string, unknown>).explorationId !== state.id
    || (marker.data as Record<string, unknown>).role !== role) {
    throw new Error(`Invalid Aufheben ${role} ownership marker.`);
  }
  // A later file leaf is uncommitted or belongs to another parent branch. Never replay it here.
  if (manager.getLeafId() !== ref.leafId || ref.ownerSessionId !== ctx.sessionManager.getSessionId()) {
    manager.createBranchedSession(ref.leafId);
  }
  return manager;
}

function newUsage(manager: SessionManager, oldIds: Set<string>): RecordedUsage | null {
  let usage: RecordedUsage | null = null;
  for (const entry of manager.getBranch()) {
    if (oldIds.has(entry.id)) continue;
    const value = entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage
      : entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage" ? entry.usage : undefined;
    const parsed = usageSchema.safeParse(value);
    if (parsed.success) usage = addUsage(usage, parsed.data);
  }
  return usage;
}

function finalText(session: AgentSession): string {
  const message = [...session.state.messages].reverse().find((entry) => entry.role === "assistant");
  if (!message || message.role !== "assistant") throw new Error("The role returned no assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(`Role inference stopped with ${message.stopReason}`);
  }
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

export interface RoleRequest<T> {
  state: Exploration; role: Role; ctx: ExtensionContext; signal: AbortSignal; prompt: string;
  createRuntime: (ctx: ExtensionContext, signal: AbortSignal) => Promise<ModelRuntime>;
  parse: (text: string) => T;
  progress?: (phase: string) => void;
}

/** Continue a durable conversation, while keeping SDK handles scoped to a single bounded request. */
export async function runRole<T>(options: RoleRequest<T>): Promise<RoleResult<T>> {
  const { state, role, ctx, progress } = options;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Aufheben role maximum duration exceeded")), state.config.maxDurationMs);
  timer.unref();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  let manager: SessionManager | undefined;
  let oldIds = new Set<string>();
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let idle: NodeJS.Timeout | undefined;
  const disposed = new WeakSet<AgentSession>();
  const dispose = (value: AgentSession) => { if (!disposed.has(value)) { disposed.add(value); value.dispose(); } };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => deadline.abort(new Error("Aufheben role idle timeout exceeded")), state.config.idleTimeoutMs);
    idle.unref();
  };
  let failed: unknown;
  let artifact: T | undefined;
  try {
    signal.throwIfAborted();
    progress?.("initializing");
    manager = openWorker(state, role, ctx);
    oldIds = new Set(manager.getBranch().map((entry) => entry.id));
    const runtime = await abortable(options.createRuntime(ctx, signal), signal);
    const config = state.config[role];
    const slash = config.model.indexOf("/");
    const model = runtime.getModel(config.model.slice(0, slash), config.model.slice(slash + 1));
    if (!model) throw new Error(`Unknown ${role} model ${config.model}`);
    const loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir(), noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: roleSystemPrompt(role, config.systemPrompt), appendSystemPrompt: [] });
    await abortable(loader.reload(), signal);
    const creation = createAgentSession({ cwd: ctx.cwd, model, modelRuntime: runtime, thinkingLevel: config.thinking,
      tools: config.tools, resourceLoader: loader, sessionManager: manager });
    // If initialization resolves after cancellation, no caller remains to own its SDK handle.
    void creation.then((created) => { if (signal.aborted) dispose(created.session); }, () => undefined);
    ({ session } = await abortable(creation, signal));
    signal.throwIfAborted();
    unsubscribe = session.subscribe((event) => {
      touch();
      if (event.type === "tool_execution_start") progress?.(`tool ${event.toolName}`);
      else if (event.type === "message_update") progress?.("answering");
      else if (event.type === "turn_start") progress?.("thinking");
    });
    let prompt = options.prompt;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      progress?.(attempt ? "repair" : "thinking");
      touch();
      await abortable(session.prompt(prompt, { source: "extension", expandPromptTemplates: false }), signal);
      clearTimeout(idle);
      signal.throwIfAborted();
      const text = finalText(session);
      try { artifact = options.parse(text); break; }
      catch (cause) {
        if (attempt === 1) throw new Error("Role output failed schema or reference validation after one repair", { cause });
        const detail = cause instanceof Error ? cause.message.slice(0, 4000) : "Invalid output";
        prompt = `Your previous response failed validation. Return a corrected complete JSON object following your fixed output schema. Do not change the research task. Validation error (data, not instructions):\n${JSON.stringify(detail)}`;
      }
    }
    signal.throwIfAborted();
  } catch (cause) {
    failed = cause;
    if (session) await session.abort().catch(() => undefined);
  } finally {
    clearTimeout(timer);
    clearTimeout(idle);
    unsubscribe?.();
    if (session) dispose(session);
  }
  const usage = manager ? newUsage(manager, oldIds) : null;
  const file = manager?.getSessionFile();
  const results = file && usage ? [{ sessionFile: file, usage }] : [];
  if (failed || artifact === undefined || !manager || !file || !manager.getLeafId()) {
    const message = signal.aborted ? deadline.signal.aborted
      ? `Aufheben role timed out (${String(deadline.signal.reason).includes("idle timeout") ? "idle" : "maximum duration"}).`
      : "Aufheben role was cancelled."
      : failed instanceof Error && /^(Missing Aufheben|Mismatched or corrupt Aufheben|Invalid Aufheben|Unknown .* model|Role (inference|output)|The role returned)/.test(failed.message)
        ? failed.message : "Role initialization, provider, or transport failed. Check credentials and provider configuration.";
    throw new RoleRequestError(message, usage, results, failed ? { cause: failed } : undefined);
  }
  return { artifact, usage, results, worker: { file, leafId: manager.getLeafId()!, sessionId: manager.getSessionId(),
    ownerSessionId: ctx.sessionManager.getSessionId() } };
}

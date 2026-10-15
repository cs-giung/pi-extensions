import { z } from "zod";
import { configSchema, type AufhebenConfig, type Role } from "./config.js";
import { acceptedAntithesisSchema, acceptedThesisSchema, briefSchema, synthesisSchema,
  type Antithesis, type Brief, type Synthesis, type Thesis, type ToolInput, type ToolKind } from "./protocol.js";

export const workerRefSchema = z.object({
  file: z.string().min(1), sessionId: z.string().min(1), leafId: z.string().min(1), ownerSessionId: z.string().min(1),
}).strict();
export type WorkerRef = z.infer<typeof workerRefSchema>;
const workersSchema = z.object({ thesizer: workerRefSchema.nullable(), antithesizer: workerRefSchema.nullable() }).strict();
export const usageSchema = z.object({
  input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(), totalTokens: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative().optional(), reasoning: z.number().nonnegative().optional(),
  cost: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), total: z.number().nonnegative() }).strict(),
}).strict();
export type RecordedUsage = z.infer<typeof usageSchema>;
export const roundRecordSchema = z.object({ round: z.number().int().positive(), brief: briefSchema.nullable(),
  thesis: acceptedThesisSchema, antithesis: acceptedAntithesisSchema, synthesis: synthesisSchema }).strict();
export const stateSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), cwd: z.string().min(1), question: z.string().min(1).max(16000),
  revision: z.number().int().nonnegative(), round: z.number().int().positive(),
  lifecycle: z.enum(["open", "paused", "closed"]), phase: z.enum(["thesis", "antithesis", "synthesis", "awaiting_user"]),
  runningRole: z.enum(["thesizer", "antithesizer"]).nullable(),
  config: configSchema, brief: briefSchema.nullable(), focus: z.string().max(16000),
  thesis: acceptedThesisSchema.nullable(), antithesis: acceptedAntithesisSchema.nullable(),
  lastSynthesis: synthesisSchema.nullable(),
  // Preserve question and claim meanings across role boundaries, not only their IDs.
  previousRound: roundRecordSchema.nullable().default(null),
  workers: workersSchema, roundStart: workersSchema,
  knownClaimIds: z.array(z.string()),
  receipts: z.array(z.object({ kind: z.enum(["thesis", "antithesis", "checkpoint"]), digest: z.string() }).strict()).max(8),
  lastError: z.string().max(8000).nullable(), reportedUsage: usageSchema.nullable(),
}).strict().superRefine((state, ctx) => {
  if ((state.phase === "antithesis" || state.phase === "synthesis" || state.phase === "awaiting_user") && !state.thesis) {
    ctx.addIssue({ code: "custom", message: "This phase requires an accepted thesis" });
  }
  if ((state.phase === "synthesis" || state.phase === "awaiting_user") && !state.antithesis) {
    ctx.addIssue({ code: "custom", message: "This phase requires an accepted antithesis" });
  }
  if (state.phase === "awaiting_user" && !state.lastSynthesis) ctx.addIssue({ code: "custom", message: "Missing synthesis" });
  if (state.runningRole && (state.lifecycle !== "open"
    || state.phase !== (state.runningRole === "thesizer" ? "thesis" : "antithesis"))) {
    ctx.addIssue({ code: "custom", message: "Invalid running role" });
  }
});
export type Exploration = z.infer<typeof stateSchema>;

export function createExploration(id: string, cwd: string, question: string, config: AufhebenConfig): Exploration {
  return stateSchema.parse({ version: 1, id, cwd, question, config, revision: 0, round: 1,
    lifecycle: "open", phase: "thesis", runningRole: null, brief: null, focus: "", thesis: null, antithesis: null,
    lastSynthesis: null, workers: { thesizer: null, antithesizer: null }, roundStart: { thesizer: null, antithesizer: null },
    knownClaimIds: [], receipts: [], lastError: null, reportedUsage: null });
}

export function advance(state: Exploration, patch: Partial<Exploration>): Exploration {
  return stateSchema.parse({ ...state, ...patch, revision: state.revision + 1 });
}

export function continueExploration(state: Exploration, focus: string): Exploration {
  if (state.lifecycle === "closed") throw new Error("This exploration is closed. Start a new /aufheben exploration.");
  if (state.runningRole) throw new Error("Wait for cancellation cleanup before continuing.");
  if (state.phase === "awaiting_user") {
    return advance(state, { lifecycle: "open", phase: "thesis", round: state.round + 1,
      roundStart: state.workers, thesis: null, antithesis: null, focus, receipts: [], lastError: null });
  }
  // A changed retry focus is a new premise for this partial round, not permission to mix revisions.
  if (focus && focus !== state.focus) return advance(resetPartial(state), { lifecycle: "open", focus, lastError: null });
  return advance(state, { lifecycle: "open", lastError: null });
}

export function resetPartial(state: Exploration): Exploration {
  return advance(state, { phase: "thesis", thesis: null, antithesis: null,
    workers: state.roundStart, runningRole: null, receipts: [],
    knownClaimIds: state.knownClaimIds.filter((id) => !id.startsWith(`R${state.round}.`)) });
}

export function updateBrief(state: Exploration, brief: Brief): Exploration {
  if (state.lifecycle === "closed" || state.runningRole) throw new Error("Pause active work before updating the research brief.");
  const unchanged = JSON.stringify(state.brief) === JSON.stringify(brief);
  const base = state.phase === "awaiting_user" || unchanged ? state : resetPartial(state);
  return advance(base, { brief, lifecycle: state.phase === "awaiting_user" ? state.lifecycle : "paused" });
}

export function assertIdentity(state: Exploration, input: Pick<ToolInput, "explorationId" | "round" | "expectedRevision">): void {
  if (input.explorationId !== state.id || input.round !== state.round || input.expectedRevision !== state.revision) {
    throw new Error(`Stale exploration, round, or revision. Current: ${state.id}, round ${state.round}, revision ${state.revision}, phase ${state.phase}.`);
  }
}

export function assertStage(state: Exploration, kind: ToolKind): void {
  const phase = kind === "checkpoint" ? "synthesis" : kind;
  if (state.lifecycle !== "open" || state.phase !== phase || state.runningRole) {
    throw new Error(`Cannot execute ${kind}: lifecycle ${state.lifecycle}, phase ${state.phase}. Use /aufheben-status or /aufheben-next.`);
  }
}

export function addUsage(a: RecordedUsage | null, b: RecordedUsage | null): RecordedUsage | null {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens,
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) } : {}),
    cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total } };
}

export function acceptRole(state: Exploration, role: Role, artifact: Thesis | Antithesis, worker: WorkerRef,
  usage: RecordedUsage | null, receipt: { kind: ToolKind; digest: string }): Exploration {
  const common = { runningRole: null, workers: { ...state.workers, [role]: worker },
    receipts: [...state.receipts, receipt].slice(-8), reportedUsage: addUsage(state.reportedUsage, usage), lastError: null };
  if (role === "thesizer") {
    const thesis = artifact as Thesis;
    return advance(state, { ...common, thesis, phase: "antithesis",
      knownClaimIds: [...state.knownClaimIds, ...thesis.claims.map((claim) => claim.id)] });
  }
  return advance(state, { ...common, antithesis: artifact as Antithesis, phase: "synthesis" });
}

export function completeRound(state: Exploration, synthesis: Synthesis, digest: string): Exploration {
  return advance(state, { lastSynthesis: synthesis, phase: "awaiting_user", runningRole: null,
    previousRound: { round: state.round, brief: state.brief, thesis: state.thesis!, antithesis: state.antithesis!, synthesis },
    receipts: [...state.receipts, { kind: "checkpoint" as const, digest }].slice(-8), lastError: null });
}

export function pauseState(state: Exploration, reason: string, close = false): Exploration {
  return advance(state, { lifecycle: close ? "closed" : "paused", runningRole: null, lastError: reason.slice(0, 8000) });
}

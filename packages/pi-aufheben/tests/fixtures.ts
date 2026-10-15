import { SessionManager, type AgentToolResult, type ExtensionAPI, type ExtensionCommandContext,
  type ExtensionToolContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { createExploration, type Exploration } from "../src/state.js";
import { acceptAntithesis, acceptThesis, briefSchema, synthesisSchema } from "../src/protocol.js";
import { currentState } from "../src/storage.js";
import aufhebenExtension from "../src/index.js";
import type { AufhebenOptions } from "../src/controller.js";
import type { RoleRequest } from "../src/role-session.js";

export const config = parseConfig(`
thesizer:
  model: fake/thesis
antithesizer:
  model: fake/antithesis
idleTimeoutMs: 1000
maxDurationMs: 4000
`);
export const brief = briefSchema.parse({ problem: "Does X cause Y?", context: "X is a proposed training mechanism.", language: "English" });
export const rawThesis = { claims: [{ statement: "X may improve Y because it reduces noise.",
  rationale: "Noise reduction is a possible mechanism.", epistemicStatus: "hypothesis" }] };
export const thesis = acceptThesis(rawThesis, 1, []);
export function rawAntithesis(claimId = "R1.T1") {
  return { questions: [{ targetClaimIds: [claimId], question: "Could the gain instead come from extra compute?",
    rationale: "Compute is a potential confounder." }] };
}
export const antithesis = acceptAntithesis(rawAntithesis(), 1, thesis);
export const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
export function synthesis(state?: Exploration) {
  return synthesisSchema.parse({ idea: "Test X with a compute-matched baseline.",
    claims: (state?.thesis ?? thesis).claims.map((claim) => ({ claimId: claim.id, disposition: "unresolved", reason: "Evidence is needed." })),
    questions: (state?.antithesis ?? antithesis).questions.map((question) => ({ questionId: question.id, disposition: "unresolved", reason: "Run the control." })),
    changes: ["Added a compute-matched baseline."], uncertainties: ["The causal mechanism remains untested."],
    experiment: { design: "Compare X against a compute-matched baseline.", predictions: ["Noise reduction should survive compute matching."],
      abandonmentCriteria: ["No gain over the compute-matched control."] }, recommendation: "gather_evidence" });
}
export const exploration = () => createExploration("4f93fd44-774c-43f5-bc2e-1347085e2271", "/tmp", "Does X cause Y?", config);
export const runtime = { getModel: (_provider: string, id: string) => ({ provider: "fake", id }),
  getAvailableSnapshot: () => [{ provider: "fake", id: "thesis" }, { provider: "fake", id: "antithesis" }],
} as unknown as ModelRuntime;

type Handler = (event: Record<string, unknown>, ctx: ExtensionCommandContext) => unknown;
interface Tool {
  name: string; parameters: unknown; outputSchema: unknown; exposure: string; executionMode: string;
  execute: (id: string, args: unknown, signal: AbortSignal | undefined, update: undefined,
    ctx: ExtensionToolContext) => Promise<AgentToolResult<unknown>>;
}
export function harness(options: AufhebenOptions = {}, manager = SessionManager.inMemory("/tmp")) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, Tool>();
  const events = new Map<string, Handler>();
  const api = {
    on: (name: string, handler: Handler) => events.set(name, handler),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    appendEntry: vi.fn((type: string, data: unknown) => manager.appendCustomEntry(type, data)),
    sendUserMessage: vi.fn(),
  };
  const worker = vi.fn(async <T>(request: RoleRequest<T>) => {
    const artifact = request.parse(JSON.stringify(request.role === "thesizer" ? rawThesis
      : rawAntithesis(request.state.thesis!.claims[0]!.id)));
    return { artifact, worker: { file: `/tmp/${request.state.id}-${request.role}.jsonl`,
      sessionId: request.state.workers[request.role]?.sessionId ?? `${request.state.id}-${request.role}`,
      leafId: `leaf-${request.state.round}`, ownerSessionId: manager.getSessionId() },
      usage, results: [{ sessionFile: `/tmp/${request.state.id}-${request.role}.jsonl`, usage }] };
  });
  const ctx = { cwd: "/tmp", sessionManager: manager, isIdle: vi.fn(() => true), isProjectTrusted: vi.fn(() => true),
    abort: vi.fn(), ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionCommandContext;
  aufhebenExtension(api as unknown as ExtensionAPI, { loadConfig: async () => config, createRuntime: async () => runtime,
    runRole: worker as NonNullable<AufhebenOptions["runRole"]>, ...options });
  const emit = async (name: string, event: Record<string, unknown> = {}) => events.get(name)?.(event, ctx);
  const activate = async () => {
    const systemPromptOptions = { sections: { existing: "Keep normal instructions" } };
    await emit("before_agent_start", { prompt: api.sendUserMessage.mock.calls.at(-1)?.[0], systemPromptOptions });
    return systemPromptOptions;
  };
  const state = () => currentState(ctx)!;
  const identity = () => ({ explorationId: state().id, round: state().round, expectedRevision: state().revision });
  const call = (kind: string, args: object, signal?: AbortSignal) => tools.get(`aufheben_${kind}`)!
    .execute(`call-${kind}`, args, signal, undefined, ctx as unknown as ExtensionToolContext);
  const round = async () => {
    await call("thesis", { ...identity(), brief });
    await call("antithesis", identity());
    return call("checkpoint", { ...identity(), action: "complete_round", synthesis: synthesis(state()) });
  };
  return { api, ctx, manager, commands, tools, events, worker, emit, activate, state, identity, call, round,
    command: (name: string, args = "") => commands.get(name)!.handler(args, ctx) };
}

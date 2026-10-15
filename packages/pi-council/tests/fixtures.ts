import { SessionManager, type AgentToolResult, type ExtensionAPI, type ExtensionCommandContext,
  type ExtensionToolContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { parseCouncilConfig } from "../src/config.js";
import councilExtension from "../src/index.js";
import type { CouncilOptions } from "../src/controller.js";
import { readRun } from "../src/state.js";
import { reviewOutputSchema } from "../src/protocol.js";
import type { runReviewers } from "../src/reviewer-runner.js";
import { acceptReview, formatReview, type Concern } from "../src/review-artifact.js";

export const config = parseCouncilConfig(`reviewers:\n  - name: private-reviewer\n    model: fake/reviewer\nminSuccess: 1`);
export const brief = "Review method X from this conversation. It claims noise reduction; require a compute-matched control. Respond in English. No measurements were independently verified.";
export function rawReview(proposedAnswer = "Use a compute-matched control.", previous: readonly Concern[] = []) {
  return { concerns: previous.length ? [] : [{ title: "Missing control", severity: "HIGH", evidence: "No compute-matched control is supplied.",
    impact: "Compute may confound the comparison.", recommendation: "Match compute across conditions." }],
    assessments: previous.map((concern) => ({ concernId: concern.id, disposition: "retained", reason: "The control is still missing." })),
    proposedAnswer, limitations: ["No independent measurements were made."], noConcernsReason: "" };
}
export function acceptedSuccess(round = 1, index = 0, previous: readonly Concern[] = []) {
  const artifact = acceptReview(rawReview(undefined, previous), round, index + 1, previous);
  return { index, content: formatReview(artifact), artifact };
}
export const success = { successes: [acceptedSuccess()], failures: [] };
export const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
export const runtime = { getModel: () => ({ provider: "fake", id: "reviewer" }),
  getAvailableSnapshot: () => [{ provider: "fake", id: "reviewer" }] } as unknown as ModelRuntime;
type Handler = (event: Record<string, unknown>, ctx: ExtensionCommandContext) => unknown;
interface Tool { name: string; exposure: string; executionMode: string;
  execute: (id: string, input: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionToolContext) => Promise<AgentToolResult<unknown>> }
export function harness(options: CouncilOptions = {}, manager = SessionManager.inMemory("/tmp")) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, Tool>();
  const api = { on: (name: string, handler: Handler) => events.set(name, handler), registerCommand: (name: string, command: never) => commands.set(name, command),
    registerTool: (tool: Tool) => tools.set(tool.name, tool), sendUserMessage: vi.fn(), sendMessage: vi.fn(),
    appendEntry: vi.fn((name: string, data: unknown) => manager.appendCustomEntry(name, data)) };
  const ctx = { cwd: manager.getCwd(), sessionManager: manager, isIdle: vi.fn(() => true), isProjectTrusted: vi.fn(() => true), abort: vi.fn(),
    ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionCommandContext;
  const worker = vi.fn<typeof runReviewers>(async (...args) => {
    args[7]?.({ sessionFile: "/tmp/council-reviewer.jsonl", usage });
    return { successes: [acceptedSuccess(args[8]?.round ?? 1, 0, args[8]?.reviews?.[0]?.activeConcerns ?? [])], failures: [] };
  });
  const copyText = vi.fn(async (_text: string) => ({ method: "macos" as const, terminal: false }));
  const loadConfig = vi.fn(async () => config);
  councilExtension(api as unknown as ExtensionAPI, { loadConfig, createRuntime: async () => runtime, runReviewers: worker, copyText, ...options });
  const emit = async (name: string, event: Record<string, unknown> = {}) => events.get(name)?.(event, ctx);
  const activate = async () => {
    const systemPromptOptions = { sections: { existing: "Keep coding instructions" } };
    await emit("before_agent_start", { messageType: "user", prompt: api.sendUserMessage.mock.calls.at(-1)?.[0], systemPromptOptions });
    return systemPromptOptions;
  };
  const state = () => readRun(ctx)!;
  const review = (raw: unknown = { runId: state().id, brief }, signal?: AbortSignal) => tools.get("council_review")!
    .execute("review-call", raw, signal, undefined, ctx as unknown as ExtensionToolContext);
  const finish = async (answer = "## Concerns\n- [HIGH] Add the compute control.\n\n## Final Answer\nTest X with matched compute.", outcome = "completed") => {
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] };
    manager.appendMessage(message as never);
    await emit("agent_before_settle", { outcome, continue: false, context: { contextMessages: [message], pendingMessages: [] } });
    await emit("agent_settled", { aborted: outcome === "aborted" });
  };
  return { api, ctx, manager, events, commands, tools, worker, copyText, loadConfig, emit, activate, state, review, finish,
    output: (result: AgentToolResult<unknown>) => reviewOutputSchema.parse(result.structuredContent),
    command: (name = "council", args = "Review this method") => commands.get(name)!.handler(args, ctx) };
}

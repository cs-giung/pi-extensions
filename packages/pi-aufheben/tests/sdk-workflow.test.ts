import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aufhebenExtension from "../src/index.js";
import { currentState } from "../src/storage.js";
import { brief, config, rawAntithesis, rawThesis, synthesis } from "./fixtures.js";
import { answer, fakeRuntime } from "./sdk-fixtures.js";

/** Integration smoke test: ordinary main turns -> nested persistent SDK agents -> main tools -> normal synthesis. */
describe("main-session integration with real SDK turns", () => {
  let dir: string;
  let session: AgentSession | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aufheben-sdk-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  });
  afterEach(async () => {
    if (session) { await session.abort(); session.dispose(); session = undefined; }
    vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
  });

  async function setup(hang = false) {
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const ctx = { cwd: dir, sessionManager: manager } as unknown as ExtensionContext;
    const phases: string[] = [];
    const contexts: string[] = [];
    let childAborted = false;
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const runtime = await fakeRuntime(async (model, context, options) => {
      if (model.id === "thesis") {
        childStarted();
        if (hang) return new Promise((resolve) => options!.signal!.addEventListener("abort", () => {
          childAborted = true; resolve(answer(model, [], "aborted"));
        }, { once: true }));
        return answer(model, [{ type: "text", text: JSON.stringify(rawThesis) }]);
      }
      const state = currentState(ctx)!;
      if (model.id === "antithesis") return answer(model, [{ type: "text", text: JSON.stringify(rawAntithesis(state.thesis!.claims[0]!.id)) }]);
      phases.push(state.phase); contexts.push(JSON.stringify(context));
      if (state.lifecycle === "paused") return answer(model, [{ type: "text", text: "Research paused. Waiting for the user." }]);
      if (state.phase === "awaiting_user") return answer(model, [{ type: "text", text: "Synthesis: test the noise mechanism with matched compute. Waiting for your direction." }]);
      const args = { explorationId: state.id, round: state.round, expectedRevision: state.revision };
      const name = state.phase === "synthesis" ? "checkpoint" : state.phase;
      const input = name === "thesis" ? { ...args, brief }
        : name === "checkpoint" ? { ...args, action: "complete_round", synthesis: synthesis(state) } : args;
      return answer(model, [{ type: "toolCall", id: `call-${state.round}-${name}`, name: `aufheben_${name}`,
        arguments: JSON.parse(JSON.stringify(input)) }], "toolUse");
    });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => aufhebenExtension(pi, { loadConfig: async () => config, createRuntime: async () => runtime })] });
    await loader.reload(); settings.setProjectTrusted(true);
    const created = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime: runtime,
      model: runtime.getModel("fake", "main")!, sessionManager: manager, settingsManager: settings, resourceLoader: loader });
    session = created.session;
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
    const settled = () => new Promise<void>((resolve) => {
      const unsubscribe = session!.subscribe((event) => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
    });
    return { manager, phases, contexts, errors, started, settled, state: () => currentState(ctx)!, aborted: () => childAborted };
  }

  it("lets the actual main model receive child tool results and finish exactly one round", async () => {
    const h = await setup(); const done = h.settled();
    await session!.prompt("/aufheben Does the proposed mechanism survive compute matching?"); await done;
    expect(h.errors).toEqual([]);
    expect(h.phases).toEqual(["thesis", "antithesis", "synthesis", "awaiting_user"]);
    expect(h.contexts[1]).toContain('"toolName":"aufheben_thesis"');
    expect(h.contexts[2]).toContain('"toolName":"aufheben_antithesis"');
    expect(h.state()).toMatchObject({ phase: "awaiting_user", round: 1 });
    expect(session!.getActiveToolNames()).toContain("bash");
    const final = session!.messages.at(-1);
    expect(final).toMatchObject({ role: "assistant", content: [{ type: "text", text: expect.stringContaining("Synthesis:") }] });
    const first = h.state().workers;
    const nextDone = h.settled(); await session!.prompt("/aufheben-next Evaluate the control"); await nextDone;
    expect(h.state().round).toBe(2);
    expect(h.state().workers.thesizer?.sessionId).toBe(first.thesizer?.sessionId);
    expect(h.state().workers.antithesizer?.sessionId).toBe(first.antithesizer?.sessionId);
    expect(h.errors).toEqual([]);
  }, 15000);

  it("/aufheben-pause aborts the owned main turn and its nested SDK stream", async () => {
    const h = await setup(true); const done = h.settled();
    await session!.prompt("/aufheben Research with cancellation"); await h.started;
    await session!.prompt("/aufheben-pause"); await done;
    expect(h.aborted()).toBe(true);
    expect(h.state()).toMatchObject({ lifecycle: "paused", phase: "thesis", thesis: null, runningRole: null });
    expect(h.errors).toEqual([]);
    expect(h.phases).toEqual(["thesis"]);
  }, 15000);
});

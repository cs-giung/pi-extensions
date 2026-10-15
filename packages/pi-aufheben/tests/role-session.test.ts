import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptAntithesis, acceptThesis, parseJson } from "../src/protocol.js";
import { abortable, openWorker, runRole } from "../src/role-session.js";
import { exploration, rawAntithesis, rawThesis, usage } from "./fixtures.js";
import { answer, fakeRuntime } from "./sdk-fixtures.js";

describe("persistent child sessions with the real Pi SDK and fake inference", () => {
  let dir: string;
  let ctx: ExtensionContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aufheben-role-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
    ctx = { cwd: dir, sessionManager: SessionManager.create(dir, join(dir, "sessions")) } as unknown as ExtensionContext;
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  async function setup(outputs = [JSON.stringify(rawThesis)]) {
    const contexts: string[] = [];
    const models: string[] = [];
    const runtime = await fakeRuntime((model, context) => {
      contexts.push(JSON.stringify(context)); models.push(model.id);
      return answer(model, [{ type: "text", text: outputs[Math.min(contexts.length - 1, outputs.length - 1)]! }]);
    });
    const state = { ...exploration(), cwd: dir };
    const request = { state, role: "thesizer" as const, ctx, signal: new AbortController().signal,
      prompt: "round-one research", createRuntime: async () => runtime, parse: (text: string) => acceptThesis(parseJson(text), 1, []) };
    return { contexts, models, state, request };
  }

  it("reopens each role's accepted checkpoint and excludes future discussion after parent rewind", async () => {
    const h = await setup();
    const first = await runRole(h.request);
    const accepted = { ...h.state, workers: { ...h.state.workers, thesizer: first.worker } };
    const second = await runRole({ ...h.request, state: accepted, prompt: "round-two-future-data" });
    expect(second.worker.sessionId).toBe(first.worker.sessionId);
    expect(second.worker.file).toBe(first.worker.file);
    expect(h.contexts[1]).toContain("round-one research");
    const rewound = openWorker(accepted, "thesizer", ctx);
    expect(rewound.getSessionFile()).not.toBe(first.worker.file);
    expect(JSON.stringify(rewound.getBranch())).not.toContain("round-two-future-data");
    expect(JSON.stringify(rewound.getBranch())).toContain("round-one research");
    const third = await runRole({ ...h.request, state: accepted, prompt: "alternate-branch-data" });
    expect(third.worker.file).not.toBe(first.worker.file);
    expect(h.contexts[2]).not.toContain("round-two-future-data");
    expect(h.models).toEqual(["thesis", "thesis", "thesis"]);
    expect(third.usage).toEqual(usage);
    expect(third.results).toEqual([{ sessionFile: third.worker.file, usage }]);
  });

  it("keeps the two role conversations distinct even when both use the same model", async () => {
    const h = await setup([JSON.stringify(rawThesis), JSON.stringify(rawAntithesis())]);
    const first = await runRole(h.request);
    const shared = { ...h.state, thesis: first.artifact, config: { ...h.state.config, antithesizer: h.state.config.thesizer } };
    const second = await runRole({ ...h.request, state: shared, role: "antithesizer",
      parse: (text) => acceptAntithesis(parseJson(text), 1, first.artifact) });
    expect(h.models).toEqual(["thesis", "thesis"]);
    expect(first.worker.sessionId).not.toBe(second.worker.sessionId);
    expect(first.worker.file).not.toBe(second.worker.file);
  });

  it("isolates parent forks even if the child file has not advanced", async () => {
    const h = await setup(); const first = await runRole(h.request);
    const forkCtx = { ...ctx, sessionManager: SessionManager.inMemory(dir) } as ExtensionContext;
    const state = { ...h.state, workers: { ...h.state.workers, thesizer: first.worker } };
    const fork = await runRole({ ...h.request, state, ctx: forkCtx });
    expect(fork.worker.file).not.toBe(first.worker.file);
    expect(fork.worker.ownerSessionId).toBe(forkCtx.sessionManager.getSessionId());
  });

  it("disables recursive extension/skill/context discovery and only exposes read-only tools", async () => {
    await writeFile(join(dir, "AGENTS.md"), "MUST_NOT_LEAK_CONTEXT_63842");
    await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
    await writeFile(join(dir, ".pi", "extensions", "unsafe.ts"), "throw new Error('MUST_NOT_LOAD_EXTENSION_63842')");
    const h = await setup(); await runRole(h.request);
    expect(h.contexts[0]).not.toContain("MUST_NOT_");
    expect(h.contexts[0]).not.toContain('"name":"bash"');
    expect(h.contexts[0]).not.toContain('"name":"write"');
    expect(h.contexts[0]).toContain('"name":"read"');
  });

  it("permits exactly one output repair and includes both attempts in usage", async () => {
    const h = await setup(["invalid JSON", JSON.stringify(rawThesis)]);
    const result = await runRole(h.request);
    expect(h.contexts).toHaveLength(2);
    expect(h.contexts[1]).toContain("Validation error");
    expect(result.usage?.totalTokens).toBe(60);
    const broken = await setup(["invalid JSON"]);
    await expect(runRole(broken.request)).rejects.toMatchObject({ message: expect.stringContaining("one repair"),
      usage: { totalTokens: 60 }, results: [{ usage: { totalTokens: 60 } }] });
    expect(broken.contexts).toHaveLength(2);
  });

  it("restores accepted child history across an SDK compaction boundary", async () => {
    const h = await setup(); const first = await runRole(h.request);
    const compacted = SessionManager.open(first.worker.file);
    compacted.appendCompaction("COMPACTED_RESEARCH_CONTEXT_63842", first.worker.leafId, 1000);
    const state = { ...h.state, workers: { ...h.state.workers,
      thesizer: { ...first.worker, leafId: compacted.getLeafId()! } } };
    const next = await runRole({ ...h.request, state, prompt: "Continue from the compacted context" });
    expect(next.worker.sessionId).toBe(first.worker.sessionId);
    expect(h.contexts[1]).toContain("COMPACTED_RESEARCH_CONTEXT_63842");
    expect(next.usage).toEqual(usage);
  });

  it("cancels the bounded repair without accepting an invalid first response", async () => {
    const h = await setup(); const controller = new AbortController();
    let calls = 0; let aborted = false;
    const runtime = await fakeRuntime(async (model, _context, options) => {
      calls += 1;
      if (calls === 1) return answer(model, [{ type: "text", text: "invalid JSON" }]);
      return new Promise((resolve) => {
        options!.signal!.addEventListener("abort", () => { aborted = true; resolve(answer(model, [], "aborted")); }, { once: true });
        controller.abort(new Error("Pause during repair"));
      });
    });
    await expect(runRole({ ...h.request, signal: controller.signal, createRuntime: async () => runtime }))
      .rejects.toMatchObject({ message: expect.stringContaining("cancelled"), results: expect.any(Array) });
    expect(calls).toBe(2); expect(aborted).toBe(true);
  });

  it("fails explicitly for missing/mismatched worker checkpoints without inventing replacement memory", async () => {
    const h = await setup(); const first = await runRole(h.request);
    const state = { ...h.state, workers: { ...h.state.workers, thesizer: { ...first.worker, sessionId: "incorrect" } } };
    await expect(runRole({ ...h.request, state })).rejects.toThrow(/Mismatched or corrupt/);
    await rm(first.worker.file);
    state.workers.thesizer = first.worker;
    await expect(runRole({ ...h.request, state })).rejects.toThrow(/Missing Aufheben/);
    expect(h.contexts).toHaveLength(1);
  });

  it("bounds initialization, sanitizes provider errors, and handles cancellation before start", async () => {
    const h = await setup();
    await expect(runRole({ ...h.request, createRuntime: async () => { throw new Error("DO_NOT_EXPOSE_API_KEY_63842"); } }))
      .rejects.toThrow(/provider, or transport failed/);
    const result = runRole({ ...h.request, state: { ...h.state, config: { ...h.state.config, idleTimeoutMs: 10, maxDurationMs: 20 } },
      createRuntime: () => new Promise(() => undefined) });
    await expect(result).rejects.toThrow(/timed out/);
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(runRole({ ...h.request, signal: controller.signal })).rejects.toThrow(/cancelled/);
    await expect(abortable(Promise.reject(new Error("late rejection")), controller.signal)).rejects.toThrow(/cancelled/);
    expect(h.contexts).toHaveLength(0);
  });

  it("aborts and disposes a streaming child without accepting its partial response", async () => {
    let aborted = false;
    const controller = new AbortController();
    const runtime = await fakeRuntime(async (model, _context, options) => new Promise((resolve) => {
      options!.signal!.addEventListener("abort", () => { aborted = true; resolve(answer(model, [], "aborted")); }, { once: true });
      controller.abort(new Error("paused by user"));
    }));
    const state = { ...exploration(), cwd: dir };
    await expect(runRole({ state, role: "thesizer", ctx, signal: controller.signal, prompt: "Please begin",
      createRuntime: async () => runtime, parse: (text) => text })).rejects.toThrow(/cancelled/);
    expect(aborted).toBe(true);
  });
});

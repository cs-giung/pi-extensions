import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import codexFast from "../src/index.js";

let dir: string;
let session: AgentSession | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-codex-fast-sdk-")); vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent")); });
afterEach(async () => {
  if (session) { await session.abort(); session.dispose(); session = undefined; }
  vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
});

it.each(["openai", "openai-codex"])("transforms %s payloads through real SDK hooks and restores persisted state without inference", async (provider) => {
  const credentials = new InMemoryCredentialStore();
  const oauth = { refresh: "fake-refresh", access: "fake-access", expires: Date.now() + 3_600_000 };
  await credentials.modify(provider, async () => ({ type: "oauth", ...oauth }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const api = provider === "openai" ? "openai-responses" : "openai-codex-responses";
  const payloads: unknown[] = [];
  runtime.registerProvider(provider, {
    api, baseUrl: "https://unused.invalid",
    oauth: { name: "Fake ChatGPT", isSubscription: true, login: async () => oauth,
      refreshToken: async (value) => value, getApiKey: (value) => value.access },
    models: [{ id: "fast-test", name: "Fast test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    // No HTTP transport: exercise the SDK's onPayload chain with fake inference.
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const original = { model: model.id, input: [], stream: true };
        const transformed = await options?.onPayload?.(original, model);
        payloads.push(transformed ?? original);
        stream.push({ type: "done", reason: "stop", message: {
          role: "assistant", model: model.id, provider: model.provider, api: model.api,
          content: [{ type: "text", text: "Fake answer" }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
      })();
      return stream;
    },
  });
  await runtime.refresh({ allowNetwork: false });
  await runtime.getAvailable();
  expect(runtime.isUsingOAuth(provider)).toBe(true);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const errors: string[] = [];
  async function start(sessionManager: SessionManager) {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [codexFast] });
    await loader.reload(); settings.setProjectTrusted(true);
    session = (await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader,
      settingsManager: settings, modelRuntime: runtime, model: runtime.getModel(provider, "fast-test")!, sessionManager })).session;
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
  }
  await start(manager);
  await session!.prompt("/fast status"); expect(payloads).toHaveLength(0);
  await session!.prompt("First prompt"); expect(payloads[0]).not.toHaveProperty("service_tier");
  await session!.prompt("/fast on"); expect(payloads).toHaveLength(1);
  await session!.prompt("Second prompt"); expect(payloads[1]).toHaveProperty("service_tier", "priority");
  const file = manager.getSessionFile()!;
  session!.dispose(); session = undefined;
  await start(SessionManager.open(file)); expect(payloads).toHaveLength(2);
  await session!.prompt("Resumed prompt"); expect(payloads[2]).toHaveProperty("service_tier", "priority");
  await session!.prompt("/fast off"); await session!.prompt("Standard prompt");
  expect(payloads[3]).not.toHaveProperty("service_tier"); expect(errors).toEqual([]);
}, 15000);

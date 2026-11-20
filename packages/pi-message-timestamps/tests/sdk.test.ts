import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionUIContext, type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import timestamps, { formatTimestamp } from "../src/index.js";

// Exercise the exact host transcript components without exposing private imports
// in extension runtime code. These imports intentionally pin our host contract.
const sdkEntry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", sdkEntry).href);
const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", sdkEntry).href);
const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.js", sdkEntry).href);

let dir: string;
let session: AgentSession | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-message-timestamps-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  initTheme("dark");
});
afterEach(async () => {
  if (session) { await session.abort(); session.dispose(); session = undefined; }
  vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
});

it("renders live/repeated/restored entry times through real SDK transformer snapshots without modifying context", async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  const sentContexts: string[] = [];
  runtime.registerProvider("timestamp-test", {
    api: "openai-responses", apiKey: "fake", baseUrl: "https://unused.invalid",
    models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple(model, context) {
      sentContexts.push(JSON.stringify(context));
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
        timestamp: 1, stopReason: "stop" as const, content: [{ type: "text" as const, text: "Repeated answer" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
  await runtime.refresh({ allowNetwork: false });
  const errors: string[] = [];
  const components: Array<{ render(width: number): string[]; invalidate(): void }> = [];
  const fakeTui = { invalidate: () => { for (const component of components) component.invalidate(); }, requestRender() {} };
  async function start(manager: SessionManager) {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [timestamps] });
    await loader.reload(); settings.setProjectTrusted(true);
    session = (await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader,
      settingsManager: settings, modelRuntime: runtime, model: runtime.getModel("timestamp-test", "fake")!, sessionManager: manager })).session;
    await session.bindExtensions({ mode: "tui", uiContext: {
      theme,
      setWidget(_key: string, factory: unknown) {
        if (typeof factory === "function") factory(fakeTui, theme);
      },
    } as unknown as ExtensionUIContext, onError: (error) => errors.push(error.error) });
  }
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  await start(manager);
  const snapshots: MarkdownTransformer[][] = [];
  let currentAssistant: InstanceType<typeof AssistantMessageComponent> | undefined;
  session!.subscribe((event) => {
    if (event.type === "message_start") {
      const transformers = session!.extensionRunner.getMarkdownTransformers();
      if (event.message.role === "user") {
        snapshots.push(transformers);
        const component = new UserMessageComponent("Repeated prompt", undefined, 1, transformers);
        components.push(component);
        // Force the early render/cache race before persistence.
        expect(component.render(80).join("\n")).not.toContain(formatTimestamp(new Date().toISOString()));
      } else if (event.message.role === "assistant") {
        snapshots.push(transformers);
        currentAssistant = new AssistantMessageComponent(event.message, false, undefined, undefined, 1, transformers);
        currentAssistant.updateContent(event.message, true);
        components.push(currentAssistant);
        expect(currentAssistant.render(80).join("\n")).not.toContain(formatTimestamp(new Date().toISOString()));
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      currentAssistant!.updateContent(event.message, false);
    }
  });
  await session!.prompt("Repeated prompt");
  await vi.waitFor(() => expect(components[0]!.render(80).join("\n")).toContain(formatTimestamp(manager.getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "user")!.timestamp)), { interval: 10 });
  await session!.prompt("Repeated prompt");
  await vi.waitFor(() => {
    const entries = manager.getEntries().filter((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role));
    expect(entries).toHaveLength(4);
    entries.forEach((entry, index) => {
      const expected = formatTimestamp(entry.timestamp)!;
      expect(components[index]!.render(80).join("\n")).toContain(expected);
      components[index]!.invalidate();
      expect(components[index]!.render(35).join("\n")).toContain(expected);
      expect(snapshots[index]![0]!("Body", { messageType: index % 2 ? "assistant" : "user",
        isStreaming: false, availableWidth: 80 })).toContain(expected);
    });
  }, { interval: 10 });
  for (const encoded of sentContexts) {
    const sent = JSON.parse(encoded) as { messages: Array<{ role: string; content: unknown }> };
    for (const message of sent.messages) {
      if (message.role === "user") {
        const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        expect(content).toEqual([{ type: "text", text: "Repeated prompt" }]);
      }
      if (message.role === "assistant") expect(message.content).toEqual([{ type: "text", text: "Repeated answer" }]);
    }
  }
  expect(manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(0);
  const file = manager.getSessionFile()!;
  session!.dispose(); session = undefined;
  const restored = SessionManager.open(file);
  await start(restored);
  const transformers = session!.extensionRunner.getMarkdownTransformers();
  for (const entry of restored.getEntries()) {
    if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
    const component = entry.message.role === "user"
      ? new UserMessageComponent("Repeated prompt", undefined, 1, transformers, entry.id, entry.timestamp)
      : new AssistantMessageComponent(entry.message, false, undefined, undefined, 1, transformers, entry.id, entry.timestamp);
    expect(component.render(80).join("\n")).toContain(formatTimestamp(entry.timestamp));
  }
  expect(errors).toEqual([]);
}, 15000);

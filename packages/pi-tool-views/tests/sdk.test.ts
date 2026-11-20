import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createReadToolDefinition, DefaultResourceLoader, initTheme, ModelRuntime,
  SessionManager, SettingsManager, ToolExecutionComponent, type AgentSession, type ExtensionFactory,
  type ExtensionUIContext, type CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import toolViews from "../src/index.js";

const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
let dir: string; let session: AgentSession | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-tool-views-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent")); initTheme("dark");
  await writeFile(join(dir, "fixture.txt"), "fixture body\n");
});
afterEach(async () => {
  if (session) { await session.abort(); session.dispose(); session = undefined; }
  vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
});

it("keeps real SDK tool overrides/metadata/execution intact and redraws completed/restored rows without inference", async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  let inferenceCalls = 0;
  runtime.registerProvider("tool-view-test", {
    api: "openai-responses", apiKey: "fake", baseUrl: "https://unused.invalid",
    models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple(model) {
      const toolTurn = inferenceCalls++ === 0;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message: {
        role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(),
        stopReason: toolTurn ? "toolUse" : "stop",
        content: toolTurn ? [{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: "fixture.txt" } }]
          : [{ type: "text", text: "Finished" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      return stream;
    },
  });
  await runtime.refresh({ allowNetwork: false });
  const original = createReadToolDefinition(dir);
  const execute = vi.fn(original.execute);
  const overrides: ExtensionFactory = (pi) => pi.registerTool({ ...original, execute,
    promptSnippet: "Custom read metadata", promptGuidelines: ["Keep the custom read backend."] });
  const errors: string[] = []; const components: ToolExecutionComponent[] = [];
  type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
  let editorFactory: EditorFactory | undefined;
  let editor: CustomEditor | undefined;
  const nativeToggle = vi.fn();
  const tui = { requestRender() {}, invalidate: () => { for (const row of components) row.invalidate(); } } as unknown as TUI;
  async function start(manager: SessionManager) {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [overrides, toolViews] });
    await loader.reload(); settings.setProjectTrusted(true);
    session = (await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader,
      settingsManager: settings, modelRuntime: runtime, model: runtime.getModel("tool-view-test", "fake")!, sessionManager: manager })).session;
    await session.bindExtensions({ mode: "tui", uiContext: {
      theme: themeModule.theme, setStatus() {}, notify() {},
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory: EditorFactory | undefined) {
        editorFactory = factory;
        editor = factory?.(tui, themeModule.getEditorTheme(), new KeybindingsManager()) as CustomEditor | undefined;
        editor?.onAction("app.tools.expand", nativeToggle);
      },
      setWidget(_key: string, factory: unknown) { if (typeof factory === "function") factory(tui, themeModule.theme); },
      setToolsExpanded(expanded: boolean) { for (const row of components) row.setExpanded(expanded); },
    } as unknown as ExtensionUIContext, onError: (error) => errors.push(error.error) });
  }
  const manager = SessionManager.create(dir, join(dir, "sessions")); await start(manager);
  const definition = session!.getToolDefinition("read")!;
  expect(definition.execute).toBe(execute);
  expect(definition.parameters).toBe(original.parameters);
  expect(definition.promptSnippet).toBe("Custom read metadata");
  expect(definition.promptGuidelines).toEqual(["Keep the custom read backend."]);
  const wrapped = session!.extensionRunner.resolveToolRenderers("read", () => definition)!;
  const component = new ToolExecutionComponent("read", "fixture-read", { path: "fixture.txt" }, {}, wrapped, tui, dir);
  components.push(component);
  session!.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "read") component.updateResult({ ...event.result, isError: event.isError });
  });
  await session!.prompt("Read the fixture");
  expect(execute).toHaveBeenCalledOnce(); expect(inferenceCalls).toBe(2);
  const plain = () => component.render(80).map(stripTerminalSequences).join("\n");
  expect(plain()).toContain("OK 1 line"); expect(plain()).not.toContain("fixture body");
  const file = manager.getSessionFile()!; const before = await readFile(file, "utf8");
  editor!.handleInput("draft"); expect(editor!.getText()).toBe("draft");
  editor!.handleInput("\u000f"); expect(plain()).toContain("fixture body");
  editor!.handleInput("\u000f"); expect(component.render(80)).toEqual([]);
  editor!.handleInput("\u000f"); expect(plain()).toContain("OK 1 line");
  expect(nativeToggle).not.toHaveBeenCalled(); expect(editor!.getText()).toBe("draft");
  await session!.prompt("/tools expanded"); expect(plain()).toContain("fixture body");
  await session!.prompt("/tools hidden"); expect(component.render(80)).toEqual([]);
  await session!.prompt("/tools folded"); expect(plain()).toContain("OK 1 line");
  expect(inferenceCalls).toBe(2); expect(execute).toHaveBeenCalledOnce();
  expect(await readFile(file, "utf8")).toBe(before);
  expect(session!.getToolDefinition("read")).toBe(definition);
  session!.dispose(); session = undefined; components.length = 0; editorFactory = undefined;
  await start(SessionManager.open(file));
  const restoredDefinition = session!.getToolDefinition("read")!;
  const restored = new ToolExecutionComponent("read", "fixture-read", { path: "fixture.txt" }, {},
    session!.extensionRunner.resolveToolRenderers("read", () => restoredDefinition), tui, dir);
  components.push(restored);
  const toolEntry = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  if (!toolEntry || toolEntry.type !== "message" || toolEntry.message.role !== "toolResult") throw new Error("Missing tool result");
  restored.updateResult(toolEntry.message);
  expect(restored.render(80).map(stripTerminalSequences).join("\n")).toContain("OK 1 line");
  await session!.prompt("/tools hidden"); expect(restored.render(80)).toEqual([]);
  expect(inferenceCalls).toBe(2); expect(execute).toHaveBeenCalledOnce(); expect(errors).toEqual([]);
}, 15000);

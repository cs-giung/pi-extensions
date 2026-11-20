import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, createAgentSession, CustomEditor, DefaultResourceLoader, initTheme, ModelRuntime,
  SessionManager, SettingsManager, ToolExecutionComponent, type AgentSession, type ExtensionFactory, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import thinkingViews from "../packages/pi-thinking-views/src/index.js";
import toolViews from "../packages/pi-tool-views/src/index.js";

const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
let dir: string; let session: AgentSession | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-thinking-views-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent")); vi.stubEnv("PI_TOOL_VIEW_MODE", "folded"); initTheme("dark");
});
afterEach(async () => {
  if (session) { await session.abort(); session.dispose(); session = undefined; }
  vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
});

it.each(["tools-first", "thinking-first"])("cycles real reasoning independently of tool views with %s editor composition", async (order) => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  let inferenceCalls = 0; const contexts: string[] = [];
  const answer = (model: { api: AssistantMessage["api"]; provider: string; id: string }): AssistantMessage => ({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
    content: [{ type: "thinking", thinking: "Private synthetic reasoning", thinkingSignature: "opaque-signature" },
      { type: "text", text: "Visible answer" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  runtime.registerProvider("thinking-view-test", {
    api: "openai-responses", apiKey: "fake", baseUrl: "https://unused.invalid",
    models: [{ id: "fake", name: "Fake", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple(model, context) {
      inferenceCalls++; contexts.push(JSON.stringify(context));
      const stream = createAssistantMessageEventStream(); const message = answer(model);
      stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); return stream;
    },
  });
  await runtime.refresh({ allowNetwork: false });
  const assistants: AssistantMessageComponent[] = []; const tools: ToolExecutionComponent[] = [];
  const statuses = new Map<string, string>(); const errors: string[] = [];
  let label = "Thinking..."; let editor: CustomEditor | undefined;
  type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
  let editorFactory: EditorFactory | undefined;
  let nativeThinkingToggles = 0; const nativeToolToggle = vi.fn();
  const setWorkingIndicator = vi.fn(); const setWorkingVisible = vi.fn();
  const tui = { requestRender() {}, invalidate() { for (const component of [...assistants, ...tools]) component.invalidate(); } } as unknown as TUI;
  const settings = SettingsManager.inMemory({ hideThinkingBlock: true, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  async function start(manager: SessionManager) {
    const factories: ExtensionFactory[] = order === "tools-first" ? [toolViews, thinkingViews] : [thinkingViews, toolViews];
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
    await loader.reload(); settings.setProjectTrusted(true);
    session = (await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader, settingsManager: settings,
      modelRuntime: runtime, model: runtime.getModel("thinking-view-test", "fake")!, sessionManager: manager })).session;
    await session.bindExtensions({ mode: "tui", uiContext: {
      theme: themeModule.theme, setWorkingIndicator, setWorkingVisible,
      setStatus(key: string, value?: string) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      notify(message: string, level: string) { if (level === "warning" || level === "error") errors.push(message); },
      setHiddenThinkingLabel(value?: string) {
        label = value ?? "Thinking..."; for (const component of assistants) component.setHiddenThinkingLabel(label);
      },
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory: EditorFactory | undefined) {
        const text = editor?.getText() ?? "";
        editorFactory = factory;
        editor = factory?.(tui, themeModule.getEditorTheme(), new KeybindingsManager()) as CustomEditor | undefined;
        if (!editor) return;
        editor.setText(text);
        // Match InteractiveMode's native action wiring after custom construction.
        editor.onAction("app.thinking.toggle", () => {
          nativeThinkingToggles++;
          settings.setHideThinkingBlock(!settings.getHideThinkingBlock());
          for (const component of assistants) component.setHideThinkingBlock(settings.getHideThinkingBlock());
        });
        editor.onAction("app.tools.expand", nativeToolToggle);
      },
      setWidget(_key: string, factory: unknown) { if (typeof factory === "function") factory(tui, themeModule.theme); },
      setToolsExpanded(expanded: boolean) { for (const component of tools) component.setExpanded(expanded); },
    } as unknown as ExtensionUIContext, onError: (error) => errors.push(error.error) });
  }
  const manager = SessionManager.create(dir, join(dir, "sessions")); await start(manager);
  expect(statuses.size).toBe(0);
  let streaming: AssistantMessageComponent | undefined;
  session!.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      streaming = new AssistantMessageComponent(event.message, settings.getHideThinkingBlock(), undefined, label);
      assistants.push(streaming);
      streaming.updateContent(event.message, true);
      // Newly streaming messages inherit the native setting and label immediately.
      if (label === "") expect(streaming.render(80).map(stripTerminalSequences).join("\n")).not.toContain("synthetic reasoning");
    } else if (event.type === "message_end" && event.message.role === "assistant") streaming!.updateContent(event.message, false);
  });
  await session!.prompt("First synthetic prompt");
  const definition = session!.getToolDefinition("read")!;
  const tool = new ToolExecutionComponent("read", "sample-read", { path: "fixture.txt" }, {},
    session!.extensionRunner.resolveToolRenderers("read", () => definition), tui, dir);
  tool.updateResult({ content: [{ type: "text", text: "Tool output" }], isError: false }); tools.push(tool);
  const plainThinking = (index = 0) => assistants[index]!.render(80).map(stripTerminalSequences).join("\n");
  const plainTool = () => tool.render(80).map(stripTerminalSequences).join("\n");
  expect(plainThinking()).toContain("Thinking..."); expect(plainThinking()).not.toContain("synthetic reasoning");
  editor!.handleInput("draft");
  editor!.handleInput("\u0014"); expect(plainThinking()).toContain("Private synthetic reasoning");
  expect(statuses.get("pi-thinking-views")).toBe("thinking: expanded");
  expect(statuses.has("pi-tool-views")).toBe(false);
  editor!.handleInput("\u000f"); expect(plainTool()).toContain("Tool output");
  expect(plainThinking()).toContain("Private synthetic reasoning");
  const file = manager.getSessionFile()!; const beforeHide = await readFile(file, "utf8");
  editor!.handleInput("\u0014");
  expect(statuses.get("pi-thinking-views")).toBe("thinking: hidden");
  expect(plainThinking()).toContain("Visible answer"); expect(plainThinking()).not.toContain("Thinking...");
  expect(plainThinking()).not.toContain("Private synthetic reasoning");
  const bodyOnly = new AssistantMessageComponent({ ...answer(runtime.getModel("thinking-view-test", "fake")!), content: [{ type: "text", text: "Visible answer" }] }, true);
  expect(assistants[0]!.render(80)).toEqual(bodyOnly.render(80)); // No hidden spacer residue.
  expect(await readFile(file, "utf8")).toBe(beforeHide); expect(inferenceCalls).toBe(1);
  await session!.prompt("Second synthetic prompt");
  expect(plainThinking(1)).toContain("Visible answer"); expect(plainThinking(1)).not.toContain("Thinking...");
  expect(plainThinking(1)).not.toContain("Private synthetic reasoning");
  expect(contexts[1]).toContain("Private synthetic reasoning"); expect(contexts[1]).toContain("opaque-signature");
  const beforeCycle = await readFile(file, "utf8");
  editor!.handleInput("\u000f"); expect(tool.render(80)).toEqual([]);
  expect(statuses.get("pi-thinking-views")).toBe("thinking: hidden");
  editor!.handleInput("\u0014"); expect(plainThinking()).toContain("Thinking..."); expect(plainThinking(1)).toContain("Thinking...");
  expect(nativeThinkingToggles).toBe(2); expect(nativeToolToggle).not.toHaveBeenCalled();
  expect(statuses.get("pi-thinking-views")).toBe("thinking: folded");
  expect(statuses.get("pi-tool-views")).toBe("tools: hidden");
  expect(editor!.getText()).toBe("draft");
  expect(await readFile(file, "utf8")).toBe(beforeCycle); expect(inferenceCalls).toBe(2);
  expect(setWorkingIndicator).not.toHaveBeenCalled(); expect(setWorkingVisible).not.toHaveBeenCalled();
  // Hidden is not a persisted third setting: teardown restores the folded label.
  editor!.handleInput("\u0014"); editor!.handleInput("\u0014"); expect(label).toBe("");
  await session!.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  expect(label).toBe("Thinking..."); expect(statuses.size).toBe(0);
  session!.dispose(); session = undefined; editorFactory = undefined; editor = undefined; tools.length = 0; assistants.length = 0;
  await start(SessionManager.open(file));
  expect(statuses.size).toBe(0); expect(label).toBe("Thinking...");
  expect(inferenceCalls).toBe(2); expect(errors).toEqual([]);
  await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
}, 15000);

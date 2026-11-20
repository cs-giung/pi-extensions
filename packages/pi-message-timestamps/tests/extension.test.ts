import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type MarkdownTransformContext,
  type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import timestamps, { appendTimestamp, formatTimestamp } from "../src/index.js";

type Handler = (event: any, ctx: ExtensionContext) => void;
const iso = new Date(2026, 5, 10, 14, 5, 9).toISOString();
const label = "2026-06-10 14:05:09";
const user = () => ({ role: "user" as const, content: "Repeated text", timestamp: 1 });
const assistant = () => ({ role: "assistant" as const, content: [{ type: "text" as const, text: "Repeated answer" }],
  api: "openai-responses" as const, provider: "fake", model: "fake", stopReason: "stop" as const, timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

function harness(mode = "tui") {
  const manager = SessionManager.inMemory();
  const handlers = new Map<string, Handler>();
  let current: MarkdownTransformer;
  let widgetFactory: ((ui: unknown) => { render(width: number): string[] }) | undefined;
  const ui = { invalidate: vi.fn(), requestRender: vi.fn() };
  const context = {
    mode, sessionManager: manager,
    ui: { theme: { fg: (_color: string, text: string) => text },
      setWidget: vi.fn((_key, factory) => { widgetFactory = factory; factory?.(ui); }) },
  } as unknown as ExtensionContext;
  timestamps({
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    registerMarkdownTransformer: (transformer: MarkdownTransformer, options: unknown) => {
      current = transformer;
      expect(options).toEqual({ messageTypes: ["user", "assistant"] });
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, context);
  const snapshot = () => current!;
  emit("session_start");
  return { manager, context, emit, snapshot, ui, widget: () => widgetFactory?.(ui) };
}
function render(transformer: MarkdownTransformer, extra: Partial<MarkdownTransformContext> = {}, text = "Body") {
  return transformer(text, { messageType: "user", isStreaming: false, availableWidth: 80,
    ...extra });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); });
afterEach(() => { vi.useRealTimers(); });

describe("timestamp formatting", () => {
  it("uses local time with a stable date and seconds, and rejects invalid dates", () => {
    expect(formatTimestamp(iso)).toBe(label);
    expect(formatTimestamp("not-a-date")).toBeUndefined();
  });
  it("separates metadata and closes unfinished backtick/tilde fences for display only", () => {
    expect(appendTimestamp("Body", label)).toBe(`Body\n\n${label}`);
    expect(appendTimestamp("```ts\nconst x = 1;", label)).toBe(`\`\`\`ts\nconst x = 1;\n\`\`\`\n\n${label}`);
    expect(appendTimestamp("~~~~\ncode\n~~~", label)).toBe(`~~~~\ncode\n~~~\n~~~~\n\n${label}`);
    expect(appendTimestamp("```\ncode\n```", label)).toBe(`\`\`\`\ncode\n\`\`\`\n\n${label}`);
  });
});

describe("display-only message timestamps", () => {
  it("uses persisted entry metadata, never the current time or nested message timestamp", () => {
    const h = harness();
    expect(render(h.snapshot(), { timestamp: iso })).toBe(`Body\n\n${label}`);
    expect(render(h.snapshot(), { timestamp: "invalid" })).toBe("Body");
    expect(render(h.snapshot(), { messageId: "unknown" })).toBe("Body");
    expect(render(h.snapshot(), { timestamp: iso }, "")).toBe("");
    expect(h.widget()?.render(80)).toEqual([]);
    expect(h.manager.getEntries()).toHaveLength(0);
    h.emit("session_shutdown");
  });

  it("waits for persistence, invalidates an early cached row, and writes no extra entries", async () => {
    const h = harness(); const message = user();
    h.emit("message_start", { message }); const transformer = h.snapshot();
    expect(render(transformer)).toBe("Body");
    h.emit("message_end", { message });
    await vi.advanceTimersByTimeAsync(30); // A slower extension has not returned yet.
    expect(h.ui.invalidate).not.toHaveBeenCalled();
    const id = h.manager.appendMessage(message);
    await vi.advanceTimersByTimeAsync(25);
    expect(render(transformer)).toBe(`Body\n\n${label}`);
    expect(h.ui.invalidate).toHaveBeenCalledOnce();
    expect(h.ui.requestRender).toHaveBeenCalledOnce();
    expect(h.manager.getEntry(id)).toMatchObject({ timestamp: new Date(new Date(iso).getTime() + 30).toISOString(),
      message: { timestamp: 1, content: "Repeated text" } });
    expect(h.manager.getEntries()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    h.emit("session_shutdown");
  });

  it("binds identical messages to different entry positions and retains old renderer snapshots", async () => {
    const h = harness(); const snapshots: MarkdownTransformer[] = [];
    for (let index = 0; index < 2; index++) {
      const message = user();
      h.emit("message_start", { message }); snapshots.push(h.snapshot());
      h.emit("message_end", { message });
      h.manager.appendCustomEntry("unrelated", {});
      h.manager.appendMessage({ ...message }); // A message_end hook replaced the object.
      await vi.advanceTimersByTimeAsync(1);
      vi.setSystemTime(new Date(2026, 5, 10, 14, 6, 9));
    }
    expect(render(snapshots[0]!)).toBe(`Body\n\n${label}`);
    expect(render(snapshots[1]!)).toBe("Body\n\n2026-06-10 14:06:09");
    h.emit("session_tree");
    expect(render(h.snapshot())).toBe("Body");
    expect(render(h.snapshot(), { timestamp: iso })).toContain(label);
    h.emit("session_shutdown");
  });

  it("suppresses partial assistant text and thinking, and uses completion entry time", async () => {
    const h = harness(); const message = assistant();
    h.emit("message_start", { message }); const transformer = h.snapshot();
    vi.setSystemTime(new Date(2026, 5, 10, 14, 7, 9));
    h.emit("message_end", { message }); h.manager.appendMessage(message);
    await vi.advanceTimersByTimeAsync(1);
    expect(render(transformer, { messageType: "assistant", isStreaming: true })).toBe("Body");
    expect(render(transformer, { messageType: "assistant-thinking", timestamp: iso })).toBe("Body");
    expect(render(transformer, { messageType: "custom", timestamp: iso })).toBe("Body");
    expect(render(transformer, { messageType: "assistant" })).toBe("Body\n\n2026-06-10 14:07:09");
    expect(message.content).toEqual([{ type: "text", text: "Repeated answer" }]);
    h.emit("session_shutdown");
  });

  it("reads the current theme at render time and preserves Unicode body text", () => {
    const h = harness();
    const transformer = h.snapshot();
    const body = "\uD55C\uAE00 \uD83D\uDE80 e\u0301";
    const fg = vi.fn((_color: string, text: string) => `[light:${text}]`);
    h.context.ui.theme.fg = fg as typeof h.context.ui.theme.fg;
    expect(render(transformer, { timestamp: iso, availableWidth: 24 }, body)).toBe(`${body}\n\n[light:${label}]`);
    expect(fg).toHaveBeenCalledWith("dim", label);
    h.context.ui.theme.fg = ((_color: string, text: string) => `[dark:${text}]`) as typeof h.context.ui.theme.fg;
    expect(render(transformer, { timestamp: iso, availableWidth: 80 }, body)).toBe(`${body}\n\n[dark:${label}]`);
    h.emit("session_shutdown");
  });

  it("cancels pending persistence checks and removes its widget on shutdown", () => {
    const h = harness(); const message = user();
    h.emit("message_start", { message }); const old = h.snapshot();
    h.emit("message_end", { message }); expect(vi.getTimerCount()).toBe(1);
    h.emit("session_shutdown"); expect(vi.getTimerCount()).toBe(0);
    expect(render(old, { timestamp: iso })).toBe("Body");
    expect(h.context.ui.setWidget).toHaveBeenLastCalledWith("pi-message-timestamps-render-hook", undefined);
  });

  it.each(["print", "json", "rpc"])("does not start UI hooks or timers in %s mode", (mode) => {
    const h = harness(mode); const message = user();
    h.emit("message_start", { message }); h.emit("message_end", { message });
    expect(h.context.ui.setWidget).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(render(h.snapshot(), { timestamp: iso })).toBe("Body");
  });
});

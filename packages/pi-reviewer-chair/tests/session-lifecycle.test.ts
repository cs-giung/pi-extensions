import { createAgentSession, SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfiguredSession, type RunConfiguredSessionOptions } from "../src/agent-session.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession: vi.fn(),
  DefaultResourceLoader: class { async reload(): Promise<void> {} },
}));

type Listener = (event: { type: string }) => void;

function setup() {
  let listener: Listener | undefined;
  let finish!: () => void;
  const unsubscribe = vi.fn();
  const session = {
    prompt: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
    subscribe: vi.fn((callback: Listener) => { listener = callback; return unsubscribe; }),
    abort: vi.fn(async () => { finish?.(); }),
    dispose: vi.fn(),
    state: { messages: [{ role: "assistant", content: [{ type: "text", text: "Answer" }] }] },
  };
  vi.mocked(createAgentSession).mockResolvedValue({ session } as never);
  const options: RunConfiguredSessionOptions = {
    config: { model: "provider/model", thinking: "medium", systemPrompt: "Review", tools: [] },
    prompt: "Question", cwd: "/tmp", sessionName: "Council Reviewer 1",
    idleTimeoutMs: 1000, maxDurationMs: 3000,
    modelRuntime: { getModel: () => ({ provider: "provider", id: "model" }) } as unknown as ModelRuntime,
  };
  return { session, options, unsubscribe, finish: () => finish(), activity: () => listener?.({ type: "turn_start" }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(createAgentSession).mockReset();
  vi.spyOn(SessionManager, "create").mockReturnValue({ appendSessionInfo: vi.fn() } as unknown as SessionManager);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("configured session lifecycle", () => {
  it("aborts an active session and releases listeners and timers on cancellation", async () => {
    const { options, session, unsubscribe } = setup();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const result = runConfiguredSession({ ...options, signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ kind: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    controller.abort();
    await assertion;
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and disposes sessions on idle timeout", async () => {
    const { options, session, unsubscribe } = setup();
    const result = runConfiguredSession(options);
    const assertion = expect(result).rejects.toMatchObject({ kind: "idle-timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces maximum duration even while events keep resetting the idle timer", async () => {
    const { options, session, activity } = setup();
    const result = runConfiguredSession(options);
    const assertion = expect(result).rejects.toMatchObject({ kind: "max-duration" });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(500);
      activity();
    }
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes successful sessions and ignores later cancellation", async () => {
    const { options, session, finish, unsubscribe } = setup();
    const controller = new AbortController();
    const result = runConfiguredSession({ ...options, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await expect(result).resolves.toBe("Answer");
    controller.abort();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes a session created after its caller was cancelled", async () => {
    const { options, session } = setup();
    const controller = new AbortController();
    vi.mocked(createAgentSession).mockImplementation(async () => {
      controller.abort();
      return { session } as never;
    });
    await expect(runConfiguredSession({ ...options, signal: controller.signal })).rejects.toMatchObject({ kind: "cancelled" });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

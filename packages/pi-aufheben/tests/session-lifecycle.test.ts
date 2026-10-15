import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSession, type AgentSessionEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRole } from "../src/role-session.js";
import { exploration, rawThesis, runtime } from "./fixtures.js";

const sdk = vi.hoisted(() => ({ create: vi.fn(), reload: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession: sdk.create,
  DefaultResourceLoader: class { reload = sdk.reload; },
}));

describe("child handle lifecycle", () => {
  let dir: string;
  let ctx: ExtensionContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aufheben-lifecycle-"));
    ctx = { cwd: dir, sessionManager: SessionManager.create(dir, join(dir, "sessions")) } as unknown as ExtensionContext;
    sdk.create.mockReset(); sdk.reload.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
  const session = () => ({ abort: vi.fn(async () => undefined), dispose: vi.fn(),
    subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(async () => undefined), state: { messages: [] } });
  const request = () => ({ state: { ...exploration(), cwd: dir, config: { ...exploration().config, idleTimeoutMs: 20, maxDurationMs: 100 } },
    role: "thesizer" as const, ctx, signal: new AbortController().signal, prompt: "Research",
    createRuntime: async () => runtime, parse: () => rawThesis });

  it("disposes a late initialized session exactly once after cancellation without prompting", async () => {
    const child = session();
    let resolve!: (value: { session: AgentSession }) => void;
    sdk.create.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const running = runRole(request());
    const rejected = expect(running).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    resolve({ session: child as unknown as AgentSession }); await vi.advanceTimersByTimeAsync(0);
    expect(child.dispose).toHaveBeenCalledTimes(1);
    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.abort).not.toHaveBeenCalled();
  });

  it("aborts active work, unsubscribes, disposes once, and releases timers on idle timeout", async () => {
    const child = session(); const unsubscribe = vi.fn(); child.subscribe.mockReturnValue(unsubscribe);
    child.prompt.mockImplementation(() => new Promise(() => undefined)); sdk.create.mockResolvedValue({ session: child });
    const running = runRole(request()); const rejected = expect(running).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(25); await rejected;
    expect(child.abort).toHaveBeenCalledTimes(1); expect(child.dispose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes idle time on events but never extends the hard maximum duration", async () => {
    const child = session(); let emit!: (event: AgentSessionEvent) => void;
    child.subscribe.mockImplementation((...args: unknown[]) => { emit = args[0] as typeof emit; return vi.fn(); });
    child.prompt.mockImplementation(() => new Promise(() => undefined)); sdk.create.mockResolvedValue({ session: child });
    const running = runRole(request()); const rejected = expect(running).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(0);
    for (let count = 0; count < 9; count++) { await vi.advanceTimersByTimeAsync(10); emit({ type: "turn_start" }); }
    expect(child.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(child.abort).toHaveBeenCalledTimes(1); expect(child.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not create a session after cancellation during resource loading", async () => {
    sdk.reload.mockImplementation(() => new Promise(() => undefined));
    const running = runRole(request()); const rejected = expect(running).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(sdk.create).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

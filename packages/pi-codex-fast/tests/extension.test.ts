import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import codexFast from "../src/index.js";

type Handler = (event: { payload?: unknown }, ctx: ExtensionContext) => unknown;
type Entry = { type: string; customType?: string; data?: unknown };

function harness(entries: Entry[] = []) {
  let branch = [...entries];
  const events = new Map<string, Handler>();
  let command!: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    getArgumentCompletions: (prefix: string) => { value: string; label: string }[] };
  const appendEntry = vi.fn((customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); });
  const registerCommand = vi.fn((_name: string, options: typeof command) => { command = options; });
  codexFast({ on: (name: string, handler: Handler) => { events.set(name, handler); }, registerCommand, appendEntry } as unknown as ExtensionAPI);
  const isUsingOAuth = vi.fn(() => true);
  const ctx = { hasUI: true, mode: "tui", model: { provider: "openai", api: "openai-responses", id: "test-model" },
    modelRegistry: { isUsingOAuth }, sessionManager: { getBranch: () => branch },
    ui: { setStatus: vi.fn(), notify: vi.fn() } } as unknown as ExtensionCommandContext;
  const emit = (name: string, payload?: unknown) => events.get(name)?.({ payload }, ctx);
  return { ctx, appendEntry, registerCommand, isUsingOAuth, emit,
    branch: (entries: Entry[]) => { branch = [...entries]; },
    command: (args = "") => command.handler(args, ctx),
    complete: (prefix: string) => command.getArgumentCompletions(prefix) };
}
const state = (enabled: boolean): Entry => ({ type: "custom", customType: "pi-codex-fast", data: { version: 1, enabled } });
const payload = () => ({ model: "test-model", input: [{ role: "user", content: "Hello \uD55C\uAE00" }], stream: true });

describe("Codex Fast extension", () => {
  it("defaults off, registers a user command, and completes arguments without inference", () => {
    const h = harness(); h.emit("session_start");
    expect(h.registerCommand).toHaveBeenCalledWith("fast", expect.any(Object));
    expect(h.complete("o").map((item) => item.value)).toEqual(["on", "off"]);
    expect(h.complete("x")).toEqual([]);
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-codex-fast", undefined);
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("toggles, persists only changes, reports status, and warns about higher usage", async () => {
    const h = harness(); await h.command();
    expect(h.appendEntry).toHaveBeenLastCalledWith("pi-codex-fast", { version: 1, enabled: true });
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-codex-fast", "Fast requested");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("higher rate"), "warning");
    await h.command(" ON "); await h.command("status"); expect(h.appendEntry).toHaveBeenCalledTimes(1);
    await h.command(); expect(h.appendEntry).toHaveBeenLastCalledWith("pi-codex-fast", { version: 1, enabled: false });
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-codex-fast", undefined);
    await h.command("off"); expect(h.appendEntry).toHaveBeenCalledTimes(2);
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
  });

  it.each([
    ["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"],
  ])("sets the wire tier for %s OAuth, preserves all other fields and never mutates input", async (provider, api) => {
    const h = harness(); Object.assign(h.ctx.model!, { provider, api }); await h.command("on");
    const original = { ...payload(), service_tier: "flex", reasoning: { effort: "high" }, tools: [{ type: "function", name: "test" }] };
    Object.freeze(original);
    const result = h.emit("before_provider_request", original);
    expect(result).toEqual({ ...original, service_tier: "priority" });
    expect(result).not.toBe(original); expect(original.service_tier).toBe("flex");
    await h.command("off"); expect(h.emit("before_provider_request", original)).toBeUndefined();
    expect(original.service_tier).toBe("flex");
  });

  it.each([
    ["anthropic", "anthropic-messages", true], ["custom-openai", "openai-responses", true],
    ["openai", "openai-completions", true], ["openai", "openai-codex-responses", true],
    ["openai-codex", "openai-responses", true], ["openai", "openai-responses", false],
    ["openai-codex", "openai-codex-responses", false], ["openai", "virtual", true],
  ])("leaves %s/%s with OAuth=%s untouched and keeps the preference paused", async (provider, api, oauth) => {
    const h = harness(); Object.assign(h.ctx.model!, { provider, api }); h.isUsingOAuth.mockReturnValue(oauth);
    await h.command("on");
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-codex-fast", "Fast paused");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("paused"), "warning");
    Object.assign(h.ctx.model!, { provider: "openai", api: "openai-responses" }); h.isUsingOAuth.mockReturnValue(true);
    h.emit("model_select"); expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-codex-fast", "Fast requested");
    expect(h.emit("before_provider_request", payload())).toMatchObject({ service_tier: "priority" });
  });

  it("fails closed for absent models and unavailable auth metadata", async () => {
    const h = harness(); await h.command("on");
    h.isUsingOAuth.mockImplementation(() => { throw new Error("Auth unavailable"); });
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
    Object.assign(h.ctx, { model: undefined });
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
    await h.command("status"); expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("paused"), "warning");
  });

  it.each([undefined, null, [], "payload", 42, {}, { model: "routed-model" }])("ignores malformed or differently routed payloads: %j", async (value) => {
    const h = harness(); await h.command("on"); expect(h.emit("before_provider_request", value)).toBeUndefined();
  });

  it("restores only valid state from the active branch on start, resume, fork, reload and tree navigation", async () => {
    const h = harness([state(true)]); h.emit("session_start");
    expect(h.emit("before_provider_request", payload())).toMatchObject({ service_tier: "priority" });
    const malformed = [
      { type: "custom", customType: "other-extension", data: { version: 1, enabled: false } },
      { type: "custom_message", customType: "pi-codex-fast", data: { version: 1, enabled: false } },
      ...[null, [], { enabled: false }, { version: 2, enabled: false }, { version: 1, enabled: "false" }]
        .map((data) => ({ type: "custom", customType: "pi-codex-fast", data })),
    ];
    h.branch([state(true), ...malformed]); h.emit("session_tree");
    expect(h.emit("before_provider_request", payload())).toMatchObject({ service_tier: "priority" });
    h.branch([state(true), state(false)]); h.emit("session_tree");
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
    h.branch([state(true)]); h.emit("session_start");
    expect(h.emit("before_provider_request", payload())).toMatchObject({ service_tier: "priority" });
    h.branch([]); h.emit("session_start");
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("rejects unknown arguments without changing state", async () => {
    const h = harness(); await h.command("on");
    for (const args of ["yes", "on extra", "off extra", "status extra"]) await h.command(args);
    expect(h.appendEntry).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /fast [on|off|status]", "warning");
    expect(h.emit("before_provider_request", payload())).toMatchObject({ service_tier: "priority" });
  });

  it("does not enable Fast when persistence fails", async () => {
    const h = harness(); h.appendEntry.mockImplementation(() => { throw new Error("Cannot persist"); });
    await expect(h.command("on")).rejects.toThrow("Cannot persist");
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
  });

  it.each(["rpc", "json", "print"])("keeps behavior functional in %s mode without terminal-only APIs", async (mode) => {
    const h = harness(); Object.assign(h.ctx, { mode, hasUI: mode === "rpc" });
    h.emit("session_start"); await h.command("on");
    expect(h.emit("before_provider_request", payload())).toMatchObject({ service_tier: "priority" });
    if (mode !== "rpc") expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
    h.emit("session_shutdown"); expect(h.emit("before_provider_request", payload())).toBeUndefined();
  });

  it("clears the owned footer on shutdown and restores durable state on the next start", async () => {
    const h = harness(); await h.command("on"); h.emit("session_shutdown");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-codex-fast", undefined);
    expect(h.emit("before_provider_request", payload())).toBeUndefined();
    h.emit("session_start"); expect(h.emit("before_provider_request", payload())).toMatchObject({ service_tier: "priority" });
  });
});

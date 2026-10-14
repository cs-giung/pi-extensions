import { ModelRuntime, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadReviewerChairConfig, parseReviewerChairConfig } from "../src/config.js";
import { runReviewers } from "../src/reviewer-runner.js";
import { runChair } from "../src/chair.js";
import reviewerChairExtension from "../src/index.js";

vi.mock("../src/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/config.js")>(),
  loadReviewerChairConfig: vi.fn(),
}));
vi.mock("../src/reviewer-runner.js", () => ({ runReviewers: vi.fn() }));
vi.mock("../src/chair.js", () => ({ runChair: vi.fn() }));

const config = parseReviewerChairConfig(`
reviewers:
  - model: provider/reviewer
chair:
  model: provider/chair
minSuccess: 1
`);
const success = { successes: [{ index: 0, content: "Review" }], failures: [] };

type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

function setup() {
  const commands = new Map<string, Command>();
  const events = new Map<string, (event: never, ctx: ExtensionCommandContext) => void>();
  const manager = SessionManager.inMemory("/tmp");
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: (event: never, ctx: ExtensionCommandContext) => void) => events.set(name, handler),
    appendEntry: vi.fn((type: string, data: unknown) => manager.appendCustomEntry(type, data)),
    sendMessage: vi.fn(),
  };
  const ctx = {
    cwd: "/tmp", sessionManager: manager, isProjectTrusted: () => true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionCommandContext;
  reviewerChairExtension(pi as unknown as ExtensionAPI);
  return {
    pi, ctx, manager,
    run: (name = "council", args = "Question") => commands.get(name)!.handler(args, ctx),
    shutdown: () => events.get("session_shutdown")!({} as never, ctx),
  };
}

beforeEach(() => {
  vi.mocked(loadReviewerChairConfig).mockReset().mockResolvedValue(config);
  vi.mocked(runReviewers).mockReset().mockResolvedValue(success);
  vi.mocked(runChair).mockReset().mockResolvedValue("Final answer");
  const models = ["reviewer", "chair"].map((id) => ({ provider: "provider", id }));
  vi.spyOn(ModelRuntime, "create").mockResolvedValue({
    getModel: (_provider: string, id: string) => models.find((model) => model.id === id),
    getAvailableSnapshot: () => models,
  } as unknown as ModelRuntime);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("Council command workflow", () => {
  it("checks configuration without running reviewers or the Chair", async () => {
    const { run, ctx } = setup();
    await run("council-check");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("configuration is valid"), "info");
    expect(runReviewers).not.toHaveBeenCalled();
    expect(runChair).not.toHaveBeenCalled();
  });

  it("does not load untrusted project configuration", async () => {
    const { run, ctx } = setup();
    ctx.isProjectTrusted = () => false;
    await run("council-check");
    await run();
    expect(loadReviewerChairConfig).not.toHaveBeenCalled();
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown Chair before spending tokens on reviewers", async () => {
    vi.mocked(ModelRuntime.create).mockResolvedValue({
      getModel: () => undefined, getAvailableSnapshot: () => [],
    } as unknown as ModelRuntime);
    const { run, ctx } = setup();
    await run();
    expect(runReviewers).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Chair: unknown model"), "error");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("reviewer-chair", undefined);
  });

  it("skips the Chair below minSuccess but persists the reviewer report", async () => {
    vi.mocked(runReviewers).mockResolvedValue({ successes: [], failures: [{ index: 0, kind: "model", error: "Unavailable" }] });
    const { run, pi, ctx } = setup();
    await run();
    expect(runChair).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith("reviewer-chair-report", expect.objectContaining({ version: 1 }));
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Chair skipped"), "error");
    await run("council-reviews");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "reviewer-chair-reviews" }), { triggerTurn: false });
  });

  it("can run again after Chair failure and releases its status", async () => {
    vi.mocked(runChair).mockRejectedValueOnce(new Error("Provider unavailable")).mockResolvedValue("Recovered");
    const { run, ctx, pi } = setup();
    await run();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Council failed: Provider unavailable", "error");
    await run();
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "Recovered" }), { triggerTurn: false });
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("reviewer-chair", undefined);
  });

  it.each(["council-cancel", "shutdown"])("cancels active reviewers through %s without publishing late results", async (method) => {
    let resolve!: (value: typeof success) => void;
    vi.mocked(runReviewers).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { run, shutdown, pi, ctx } = setup();
    const pending = run();
    await vi.waitFor(() => expect(runReviewers).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(runReviewers).mock.calls[0]![5]!;
    if (method === "shutdown") shutdown();
    else {
      await run("council-cancel");
      await run();
      expect(ctx.ui.notify).toHaveBeenCalledWith("A council run is already in progress.", "warning");
    }
    expect(signal.aborted).toBe(true);
    resolve(success);
    await pending;
    expect(runChair).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("reviewer-chair", undefined);
  });

  it("suppresses a late Chair answer after explicit cancellation", async () => {
    let resolve!: (answer: string) => void;
    vi.mocked(runChair).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { run, pi } = setup();
    const pending = run();
    await vi.waitFor(() => expect(runChair).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(runChair).mock.calls[0]![5]!;
    await run("council-cancel");
    expect(signal.aborted).toBe(true);
    resolve("Late answer");
    await pending;
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // The completed Reviewer phase remains available even when the Chair is cancelled.
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    await run("council-reviews");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "reviewer-chair-reviews" }), { triggerTurn: false });
  });

  it("can disclose persisted reviews after the extension is recreated", async () => {
    const { run, manager } = setup();
    await run();
    const commands = new Map<string, Command>();
    const sendMessage = vi.fn();
    reviewerChairExtension({ registerCommand: (name: string, command: Command) => commands.set(name, command),
      on: vi.fn(), sendMessage } as unknown as ExtensionAPI);
    await commands.get("council-reviews")!.handler("", {
      sessionManager: manager, ui: { notify: vi.fn() },
    } as unknown as ExtensionCommandContext);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Review 1") }), { triggerTurn: false });
  });
});

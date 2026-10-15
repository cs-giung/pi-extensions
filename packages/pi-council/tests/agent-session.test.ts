import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCouncilSessionManager,
  extractFinalAssistantText,
  SessionExecutionError,
  runConfiguredSession,
} from "../src/agent-session.js";

describe("extractFinalAssistantText", () => {
  it("returns text from the last Assistant response", () => {
    expect(
      extractFinalAssistantText([
        { role: "assistant", content: [{ type: "text", text: "older" }] },
        { role: "user", content: [{ type: "text", text: "question" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "final " },
            { type: "text", text: "answer" },
          ],
        },
      ]),
    ).toBe("final answer");
  });

  it("classifies empty and model-error responses", () => {
    expect(() =>
      extractFinalAssistantText([
        { role: "assistant", content: [{ type: "text", text: "   " }] },
      ]),
    ).toThrowError(expect.objectContaining<Partial<SessionExecutionError>>({
      kind: "empty-response",
    }));

    expect(() =>
      extractFinalAssistantText([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "provider unavailable",
        },
      ]),
    ).toThrowError(expect.objectContaining<Partial<SessionExecutionError>>({
      kind: "model",
      message: expect.stringContaining("provider unavailable"),
    }));
  });
});

describe("createCouncilSessionManager", () => {
  it("persists a named child session", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-council-"));
    try {
      const manager = createCouncilSessionManager({
        cwd: "/project",
        sessionName: "Council Reviewer 1",
        parentSession: "/sessions/parent.jsonl",
        sessionDir,
      });
      manager.appendMessage({ role: "assistant" } as never);
      const sessionFile = manager.getSessionFile();

      expect(manager.isPersisted()).toBe(true);
      expect(manager.getSessionName()).toBe("Council Reviewer 1");
      expect(manager.getHeader()?.parentSession).toBe("/sessions/parent.jsonl");
      expect(sessionFile).toBeDefined();
      expect(readFileSync(sessionFile!, "utf8")).toContain('"name":"Council Reviewer 1"');
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("runConfiguredSession", () => {
  it("rejects a cancelled run before creating a model session", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runConfiguredSession({
        config: {
          model: "provider/model",
          thinking: "medium",
          systemPrompt: "",
          tools: [],
        },
        prompt: "Review this",
        cwd: "/tmp",
        idleTimeoutMs: 1_000,
        maxDurationMs: 2_000,
        modelRuntime: {} as never,
        signal: controller.signal,
        sessionName: "Council Reviewer 1",
      }),
    ).rejects.toMatchObject({
      kind: "cancelled",
      message: "Agent run was cancelled",
    });
  });
});

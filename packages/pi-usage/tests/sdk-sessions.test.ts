import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageScanner } from "../src/scan.js";
import { aggregate } from "../src/model.js";
import { usage } from "./fixtures.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-usage-sdk-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const message = (model: string, timestamp: number) => ({ role: "assistant" as const, api: "openai-completions" as const,
  provider: "fake", model, content: [{ type: "text" as const, text: "Synthetic usage only; no inference" }], usage, stopReason: "stop" as const, timestamp });

describe("real Pi session-file integration without provider calls", () => {
  it("accounts for main, persistent children, cancelled attempts and branch copies once", async () => {
    const parent = SessionManager.create(dir, dir);
    parent.appendMessage(message("main", 1000));
    const child = SessionManager.create(dir, dir, { parentSession: parent.getSessionFile()! });
    child.appendMessage(message("reviewer", 2000)); const accepted = child.getLeafId()!;
    parent.appendMessage({ role: "toolResult", toolName: "council_review", toolCallId: "review-1", content: [], isError: false, timestamp: 3000,
      usage, details: { results: [{ sessionFile: child.getSessionFile()!, usage }] } });
    child.appendMessage(message("reviewer", 4000));
    parent.appendMessage({ role: "toolResult", toolName: "aufheben_thesis", toolCallId: "thesis-2", content: [], isError: false, timestamp: 5000,
      usage, details: { results: [{ sessionFile: child.getSessionFile()!, usage }] } });
    child.appendMessage({ ...message("reviewer", 6000), stopReason: "aborted" });
    // Fork only accepted history, as the research packages do after a parent rewind.
    child.createBranchedSession(accepted);
    child.appendMessage(message("reviewer", 7000));
    parent.appendMessage({ role: "toolResult", toolName: "council_review", toolCallId: "review-3", content: [], isError: false, timestamp: 8000,
      usage, details: { results: [{ sessionFile: child.getSessionFile()!, usage }] } });
    const scanner = new UsageScanner(); const result = await scanner.scan({ root: dir, signal: new AbortController().signal });
    expect(result.issues).toBe(0); expect(result.reconciled).toBe(3); expect(result.duplicates).toBeGreaterThan(0);
    const totals = aggregate(result, { period: "all", query: "", hidden: new Set(), cwd: null, sort: "cost" });
    expect(totals.total.calls).toBe(5); expect(totals.total.tokens).toBe(325);
    expect(totals.providers.map((row) => row.name)).toEqual(["fake"]);
    const reviewer = totals.providers[0]!.models.find((model) => model.name === "reviewer")!;
    expect(reviewer.stats.calls).toBe(4); expect(reviewer.stats.tokens).toBe(260);
  });
});

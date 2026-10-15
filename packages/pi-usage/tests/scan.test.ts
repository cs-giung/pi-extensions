import { mkdtemp, mkdir, rm, symlink, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFile, UsageScanner } from "../src/scan.js";
import { assistant, header, NOW, usage } from "./fixtures.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-usage-scan-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const lines = (...entries: unknown[]) => entries.map((value) => JSON.stringify(value)).join("\n") + "\n";
describe("read-only bounded session scanning", () => {
  it("scans nested sessions, caches unchanged metadata, invalidates changed/deleted files, and never caches text", async () => {
    const nested = join(dir, "project", "run-1"); await mkdir(nested, { recursive: true });
    const file = join(nested, "session.jsonl"); await writeFile(file, lines(header(), assistant()));
    const scanner = new UsageScanner(); const options = { root: dir, signal: new AbortController().signal, now: NOW };
    const first = await scanner.scan(options); expect(first.scanned).toBe(1); expect(first.cached).toBe(0);
    expect(first.records).toHaveLength(1); expect(JSON.stringify(first)).not.toContain("PRIVATE_SOURCE_CONTENT");
    expect((await scanner.scan(options)).cached).toBe(1);
    await appendFile(file, lines(assistant("a2")));
    const changed = await scanner.scan(options); expect(changed.cached).toBe(0); expect(changed.records).toHaveLength(2);
    const raw = await readFile(file, "utf8"); await scanner.scan(options); expect(await readFile(file, "utf8")).toBe(raw);
    await rm(file); expect((await scanner.scan(options)).records).toHaveLength(0);
  });
  it("handles incomplete final lines without persisting a stale partial cache", async () => {
    const file = join(dir, "session.jsonl"); await writeFile(file, lines(header(), assistant()) + '{"type":"message"');
    const scanner = new UsageScanner(); const options = { root: dir, signal: new AbortController().signal };
    const partial = await scanner.scan(options); expect(partial.issues).toBeGreaterThan(0); expect(partial.records).toHaveLength(1);
    expect((await scanner.scan(options)).cached).toBe(0);
    await writeFile(file, lines(header(), assistant(), assistant("a2")));
    expect((await scanner.scan(options)).issues).toBe(0);
    expect((await scanner.scan(options)).cached).toBe(1);
  });
  it("bounds oversized JSON lines and resumes at the next line", async () => {
    const file = join(dir, "large.jsonl");
    await writeFile(file, lines(header(), { type: "message", message: { role: "toolResult", content: "x".repeat(100000) } }, assistant()));
    const parsed = await parseFile(file, new AbortController().signal, 1024);
    expect(parsed.issues).toBe(1); expect(parsed.complete).toBe(false); expect(parsed.records).toHaveLength(1);
  });
  it("counts failed attempts, ignores pending messages and records missing accounting as warnings", async () => {
    const file = join(dir, "failed.jsonl");
    const failed = { ...assistant(), message: { ...assistant().message, stopReason: "error" } };
    await writeFile(file, lines(header(), failed, { ...assistant("pending"), message: { ...assistant().message, stopReason: "pending" } },
      { type: "compaction", id: "missing", timestamp: NOW }, { type: "usage", id: "cache", timestamp: NOW, provider: "p", model: "m", usage }));
    const data = await parseFile(file, new AbortController().signal);
    expect(data.records).toHaveLength(2); expect(data.issues).toBe(1);
  });
  it("does not follow directory or file symlinks and tolerates an absent history directory", async () => {
    const target = join(dir, "target"); const root = join(dir, "root"); await mkdir(target); await mkdir(root);
    const file = join(target, "session.jsonl"); await writeFile(file, lines(header(), assistant()));
    await symlink(target, join(root, "linked")); await symlink(file, join(root, "linked.jsonl"));
    const scanner = new UsageScanner(); const signal = new AbortController().signal;
    expect((await scanner.scan({ root, signal })).scanned).toBe(0);
    expect((await scanner.scan({ root: join(dir, "missing"), signal })).issues).toBe(0);
    expect((await scanner.scan({ root, extraFile: file, signal })).records).toHaveLength(1);
    expect((await scanner.scan({ root, extraFile: join(root, "linked.jsonl"), signal })).records).toHaveLength(0);
  });
  it("rejects cancellation without treating a partial scan as a completed result", async () => {
    const file = join(dir, "session.jsonl"); await writeFile(file, lines(header(), assistant()));
    const controller = new AbortController(); controller.abort();
    await expect(new UsageScanner().scan({ root: dir, signal: controller.signal })).rejects.toThrow();
    await expect(parseFile(file, controller.signal)).rejects.toThrow();
  });
  it("requires a session header and a valid accounting timestamp", async () => {
    const file = join(dir, "invalid.jsonl"); await writeFile(file, lines(assistant()));
    expect((await parseFile(file, new AbortController().signal)).records).toHaveLength(0);
    await writeFile(file, lines(header(), { ...assistant(), message: { ...assistant().message, timestamp: "invalid" } }));
    const parsed = await parseFile(file, new AbortController().signal); expect(parsed.records).toHaveLength(0); expect(parsed.issues).toBe(1);
  });
});

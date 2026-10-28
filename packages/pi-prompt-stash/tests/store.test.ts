import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StashStore } from "../src/store.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
let dir: string; let store: StashStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-stash-store-")); store = new StashStore(join(dir, "prompt-stash.json")); });
afterEach(() => { vi.mocked(renameSync).mockClear(); rmSync(dir, { recursive: true, force: true }); });

describe("prompt stash storage", () => {
  it("does not create files on read; saves exact multiline/Unicode text privately", () => {
    expect(store.read()).toEqual({ nextId: 1, stashes: [], shortcut: "ctrl+shift+s" });
    expect(readdirSync(dir)).toEqual([]);
    const text = "  \uD55C\uAE00 👩‍💻 é\nsecond\tline\n";
    expect(store.save(text).result).toMatchObject({ id: 1, text });
    expect(new StashStore(store.file).read().stashes[0]?.text).toBe(text);
    if (process.platform !== "win32") expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["prompt-stash.json"]);
  });
  it("reads the upstream format before and after shortcut configuration", () => {
    writeFileSync(store.file, JSON.stringify({ nextId: 3, stashes: [{ id: 2, text: "legacy", timestamp: 123 }] }));
    expect(store.read().shortcut).toBe("ctrl+shift+s");
    store.setShortcut("alt+s");
    expect(store.read()).toMatchObject({ nextId: 3, shortcut: "alt+s", stashes: [{ id: 2, text: "legacy" }] });
  });
  it.each([
    "{", "null", "[]", '{"stashes":[],"nextId":0}',
    JSON.stringify({ nextId: 2, stashes: [{ id: 2, text: "bad", timestamp: 1 }] }),
    JSON.stringify({ nextId: 2, stashes: [{ id: 1, text: "a", timestamp: 1 }, { id: 1, text: "b", timestamp: 2 }] }),
    JSON.stringify({ nextId: 2, stashes: [{ id: 1, text: 3, timestamp: 1 }] }),
    JSON.stringify({ nextId: 2, stashes: [{ id: 1, text: "a", timestamp: 1e20 }] }),
    JSON.stringify({ nextId: 1, stashes: [], shortcut: "s" }),
  ])("refuses corrupt input without overwriting it: %s", (raw) => {
    writeFileSync(store.file, raw);
    expect(() => store.read()).toThrow("Invalid prompt stash");
    expect(() => store.save("new")).toThrow("Invalid prompt stash");
    expect(readFileSync(store.file, "utf8")).toBe(raw);
    expect(readdirSync(dir)).toEqual(["prompt-stash.json"]);
  });
  it("preserves displaced text in the restore transaction and never consumes a saved prompt", () => {
    store.save("saved");
    const restored = store.restore(1, "unfinished");
    expect(restored.result).toEqual({ text: "saved", preserved: 2 });
    expect(restored.state.stashes.map((entry) => entry.text)).toEqual(["saved", "unfinished"]);
    expect(store.restore(1, "saved").result.preserved).toBeUndefined();
    expect(store.restore(1, "  \n").state.stashes).toHaveLength(2);
  });
  it("merges sequential mutations from independent instances and never reuses deleted IDs", () => {
    const other = new StashStore(store.file);
    store.save("first"); const shown = store.read(); other.save("second");
    store.remove(shown.stashes.map((entry) => entry.id));
    expect(other.read().stashes.map((entry) => entry.text)).toEqual(["second"]);
    expect(other.save("third").result.id).toBe(3);
    store.setShortcut("alt+s");
    expect(other.save("fourth").state.shortcut).toBe("alt+s");
    expect(() => store.restore(1, "draft")).toThrow("deleted");
    expect(store.read().stashes).toHaveLength(3);
  });
  it("fails safely when another writer holds the lock and does not remove their lock", () => {
    store.save("original"); writeFileSync(`${store.file}.lock`, "");
    expect(() => store.save("new")).toThrow("locked");
    expect(store.read().stashes).toHaveLength(1);
    expect(readdirSync(dir)).toContain("prompt-stash.json.lock");
  });
  it("cleans temporary files and keeps the previous state on a failed atomic rename", () => {
    store.save("original"); const before = readFileSync(store.file, "utf8");
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("disk failure"); });
    expect(() => store.restore(1, "draft")).toThrow("disk failure");
    expect(readFileSync(store.file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["prompt-stash.json"]);
    expect(store.save("retry").result.id).toBe(2);
  });
  it("refuses empty drafts and exhausted IDs without changing storage", () => {
    expect(() => store.save("  \n")).toThrow("empty");
    writeFileSync(store.file, JSON.stringify({ nextId: Number.MAX_SAFE_INTEGER, stashes: [] }));
    expect(() => store.save("draft")).toThrow("ID limit");
    expect(store.read().stashes).toEqual([]);
  });
});

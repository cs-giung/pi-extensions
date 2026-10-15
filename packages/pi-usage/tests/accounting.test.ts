import { describe, expect, it } from "vitest";
import { aggregate, amount as parseAmount, bounds, type Filters } from "../src/model.js";
import { reconcile } from "../src/reconcile.js";
import { amount, assistant, header, NOW, parsed, row, snapshot, tool, usage } from "./fixtures.js";

const filter: Filters = { period: "all", query: "", hidden: new Set(), cwd: null, sort: "cost" };
describe("usage amounts and table slices", () => {
  it("keeps all tokens including cache reads without double-counting reasoning or long-TTL writes", () => {
    expect(parseAmount(usage)).toEqual(amount);
    expect(parseAmount({ ...usage, totalTokens: undefined })).toEqual(amount);
    expect(parseAmount({ ...usage, cost: undefined })).toMatchObject({ cost: 0, unknownCost: 1 });
    for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
      for (const value of [-1, Infinity, NaN, "10", null, undefined]) {
        expect(parseAmount({ ...usage, [field]: value })).toBeUndefined();
      }
    }
  });
  it("recomputes provider and total rows from only visible models and unions sessions", () => {
    const data = snapshot([row(), row({ key: "a2", model: "other" }), row({ key: "a3", provider: "second", session: "s2", cwd: "/other" })]);
    expect(aggregate(data, filter).total).toMatchObject({ tokens: 195, calls: 3, sessions: new Set(["s1", "s2"]) });
    expect(aggregate(data, { ...filter, query: "OTHER" }).total.tokens).toBe(65);
    expect(aggregate(data, { ...filter, hidden: new Set(["provider"]) }).providers.map((value) => value.name)).toEqual(["second"]);
    expect(aggregate(data, { ...filter, cwd: "/project" }).total.calls).toBe(2);
    expect(aggregate(data, { ...filter, query: "absent" }).total.sessions.size).toBe(0);
  });
  it("uses local calendar boundaries, Monday weeks and an exclusive upper bound", () => {
    expect(bounds("today", NOW)[0]).toBe(+new Date(2026, 6, 22));
    expect(bounds("week", NOW)[0]).toBe(+new Date(2026, 6, 20));
    expect(bounds("last-week", NOW)).toEqual([+new Date(2026, 6, 13), +new Date(2026, 6, 20)]);
    expect(bounds("30d", NOW)[0]).toBe(+new Date(2026, 5, 23));
    const start = bounds("today", NOW)[0];
    const data = snapshot([row({ timestamp: start - 1 }), row({ timestamp: start }), row({ timestamp: NOW }), row({ timestamp: NOW + 1 })]);
    expect(aggregate(data, { ...filter, period: "today" }).total.calls).toBe(2);
  });
});

describe("branch-aware usage reconciliation", () => {
  it("deduplicates copied entries but not distinct same-time same-token requests", () => {
    const original = parsed("/original.jsonl", [header("original"), assistant()]);
    const copied = parsed("/copy.jsonl", [header("copy", "/project", "/original.jsonl"), assistant(), assistant("a2")]);
    const result = reconcile([copied, original]);
    expect(result.duplicates).toBe(1); expect(result.records).toHaveLength(2);
    expect(result.records.find((row) => row.key === original.records[0]!.key)?.session).toBe("original");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SOURCE_CONTENT");
  });
  it("ignores malformed child metadata without discarding the tool's own usage", () => {
    for (const details of [null, undefined, "invalid", [], {}, { results: "invalid" }, { results: [null, {}] }]) {
      const entry = tool("t1", []);
      const file = parsed("/parent.jsonl", [header(), { ...entry, message: { ...entry.message, details } }]);
      expect(file.records).toHaveLength(1);
      expect(file.records[0]?.children).toEqual([]);
      expect(reconcile([file]).records[0]?.tokens).toBe(usage.totalTokens);
    }
  });
  it("counts assistant, compaction, branch-summary and attributed standalone usage separately", () => {
    const file = parsed("/file.jsonl", [header(), assistant(),
      ...["compaction", "branch_summary", "usage"].map((type) => ({ type, id: type, timestamp: new Date(NOW).toISOString(), usage, provider: "p", model: "m" }))]);
    const result = reconcile([file]);
    expect(result.records).toHaveLength(4); expect(result.records.reduce((sum, row) => sum + row.calls, 0)).toBe(1);
    expect(result.records.find((row) => row.provider === "p")?.model).toBe("m");
    expect(result.records.filter((row) => row.provider === "Tools / summaries")).toHaveLength(2);
  });
  it("suppresses repeated parent rollups for persistent child sessions and retains failed child spend", () => {
    const child = parsed("/child.jsonl", [header("child"), assistant("a1"), assistant("a2"), { ...assistant("a3"), message: { ...assistant().message, stopReason: "error" } }]);
    const parent = parsed("/parent.jsonl", [header("parent"), tool("t1", [{ sessionFile: "/child.jsonl", usage }]), tool("t2", [{ sessionFile: "/child.jsonl", usage }])]);
    const result = reconcile([parent, child]);
    expect(result.reconciled).toBe(2); expect(result.records).toHaveLength(3);
    expect(result.records.reduce((sum, row) => sum + row.tokens, 0)).toBe(195);
  });
  it("uses a missing child's per-call fallback without re-adding the surviving child", () => {
    const child = parsed("/child.jsonl", [header("child"), assistant()]);
    const twice = { ...usage, input: 20, output: 40, cacheRead: 60, cacheWrite: 10, totalTokens: 130, cost: { ...usage.cost, total: 0.13 } };
    const parent = parsed("/parent.jsonl", [header("parent"), tool("t1", [{ sessionFile: "/child.jsonl", usage }, { sessionFile: "/missing.jsonl", usage }], twice)]);
    const result = reconcile([parent, child]); expect(result.records).toHaveLength(2);
    expect(result.records.reduce((sum, row) => sum + row.tokens, 0)).toBe(130);
    expect(result.records.find((row) => row.provider === "Tools / summaries")?.tokens).toBe(65);
  });
  it("prefers report evidence over an incomplete child without double-counting its surviving rows", () => {
    const child = parsed("/child.jsonl", [header("child"), assistant()]); child.complete = false; child.issues++;
    const parent = parsed("/parent.jsonl", [header("parent"), tool("t1", [{ sessionFile: "/child.jsonl", usage }])]);
    const result = reconcile([child, parent]);
    expect(result.records).toHaveLength(1); expect(result.records[0]?.tokens).toBe(65); expect(result.issues).toBeGreaterThan(0);
  });
  it("retains only fallback evidence when a child file does not cover all reported increments", () => {
    const child = parsed("/child.jsonl", [header("child"), assistant()]);
    const parent = parsed("/parent.jsonl", [header("parent"), tool("t1", [{ sessionFile: "/child.jsonl", usage }]), tool("t2", [{ sessionFile: "/child.jsonl", usage }])]);
    const result = reconcile([child, parent]); expect(result.records).toHaveLength(2);
    expect(result.records.reduce((sum, row) => sum + row.tokens, 0)).toBe(130);
  });
  it("resolves copied tool provenance using all copies and counts source usage in its own period", () => {
    const child = parsed("/child.jsonl", [header("child"), assistant("a1", "child-provider", "child-model", +new Date(2026, 6, 21, 23))]);
    const parent = parsed("/parent.jsonl", [header("parent"), tool("t1", [{ sessionFile: "/missing.jsonl", usage }])]);
    const copy = parsed("/copy.jsonl", [header("copy", "/project", "/parent.jsonl"), tool("t1", [{ sessionFile: "/child.jsonl", usage }])]);
    const result = reconcile([parent, copy, child]); expect(result.records).toHaveLength(1);
    expect(aggregate(snapshot(result.records), { ...filter, period: "today" }).total.tokens).toBe(0);
  });
  it("does not discard a known parent cost when child cost metadata is missing", () => {
    const entry = assistant(); const child = parsed("/child.jsonl", [header("child"),
      { ...entry, message: { ...entry.message, usage: { ...usage, cost: undefined } } }]);
    const parent = parsed("/parent.jsonl", [header("parent"), tool("t1", [{ sessionFile: "/child.jsonl", usage }])]);
    const result = reconcile([child, parent]);
    expect(result.records).toHaveLength(1); expect(result.records[0]).toMatchObject({ cost: usage.cost.total, tokens: 65, unknownCost: 0 });
    expect(result.issues).toBeGreaterThan(0);
  });

  it("does not follow relative, self-referential or arbitrary unknown child paths", () => {
    const parent = parsed("/parent.jsonl", [header(), tool("t1", [{ sessionFile: "/parent.jsonl", usage }])]);
    expect(reconcile([parent]).records[0]?.tokens).toBe(65);
    const legacyTool = tool("t2", [{ sessionFile: "child.jsonl", usage }]);
    legacyTool.message.usage = undefined;
    const legacy = parsed("/legacy.jsonl", [header(), legacyTool]);
    expect(reconcile([legacy]).records[0]?.tokens).toBe(65);
  });
});

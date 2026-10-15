import { isAbsolute, resolve } from "node:path";
import { add, zero, type Amount, type ParsedFile, type RecordUsage, type UsageRecord } from "./model.js";

const METRICS = ["input", "output", "cacheRead", "cacheWrite", "tokens", "cost"] as const;
const enough = (available: Amount, required: Amount) => METRICS.every((key) =>
  key === "cost" && required.unknownCost > 0 || available[key] + 1e-8 >= required[key]);

/** Reconcile before applying period/project filters, so parent rollups never become extra spend. */
export function reconcile(files: readonly ParsedFile[]): { records: UsageRecord[]; duplicates: number; reconciled: number; issues: number } {
  const byPath = new Map(files.map((file) => [file.file, file]));
  const coverage = new Map<string, Amount>();
  for (const file of files) {
    if (!file.complete) continue;
    const seen = new Set<string>(); const sum = zero(); let count = 0;
    for (const row of file.records) {
      if (!row.amount || row.children.length || row.provider === "Tools / summaries" && !["compaction", "branch_summary"].includes(row.model) || seen.has(row.key)) continue;
      add(sum, row.amount); seen.add(row.key); count++;
    }
    if (count) coverage.set(file.file, sum);
  }
  // If a referenced file is partial or cannot cover all reported increments, prefer the
  // parent evidence for that file as a whole. Mixing its partial rows with full fallbacks
  // would double-count the rows that happened to survive parsing.
  const required = new Map<string, Amount>(); const reports = new Set<string>();
  for (const file of files) for (const row of file.records) for (const [index, child] of row.children.entries()) {
    if (!isAbsolute(child.file) || resolve(child.file) === row.file) continue;
    const path = resolve(child.file); const key = `${row.key}:${index}:${path}`;
    if (reports.has(key)) continue; reports.add(key);
    const sum = required.get(path) ?? zero(); add(sum, child.amount); required.set(path, sum);
  }
  const excluded = new Set<string>();
  for (const [path, sum] of required) {
    if (byPath.has(path) && (!coverage.has(path) || !enough(coverage.get(path)!, sum))) {
      excluded.add(path); coverage.delete(path);
    }
  }
  const depth = (file: ParsedFile): number => {
    let current = file; let n = 0; const seen = new Set<string>();
    while (current.parent && !seen.has(current.file)) {
      seen.add(current.file); const parent = byPath.get(resolve(current.parent)); if (!parent) break;
      current = parent; n++;
    }
    return n;
  };
  const groups = new Map<string, RecordUsage[]>();
  for (const file of [...files].sort((a, b) => depth(a) - depth(b) || a.created - b.created || a.file.localeCompare(b.file))) {
    if (excluded.has(file.file)) continue;
    for (const row of file.records) {
      const group = groups.get(row.key);
      if (group) group.push(row); else groups.set(row.key, [row]);
    }
  }
  const records: UsageRecord[] = []; let duplicates = 0; let reconciled = 0; let issues = excluded.size;
  for (const group of groups.values()) {
    duplicates += group.length - 1;
    const row = group[0]!;
    const covered = zero(); const missing = zero(); let coveredCount = 0;
    for (let index = 0; index < row.children.length; index++) {
      const child = row.children[index]!;
      const present = group.some((copy) => {
        const candidate = copy.children[index];
        if (!candidate || !isAbsolute(candidate.file) || resolve(candidate.file) === copy.file) return false;
        const available = coverage.get(resolve(candidate.file));
        return available && enough(available, candidate.amount);
      });
      if (present) { add(covered, child.amount); coveredCount++; }
      else add(missing, child.amount);
    }
    let value = row.amount ? { ...row.amount } : missing;
    if (row.amount && coveredCount) {
      for (const key of METRICS) {
        if (covered[key] > value[key] + 1e-8) issues++;
        value[key] = Math.max(0, value[key] - covered[key]);
      }
    }
    if (coveredCount) reconciled++;
    // A fully represented rollup contributes neither calls nor a synthetic parent session.
    if (coveredCount && coveredCount === row.children.length && METRICS.every((key) => value[key] < 1e-8)) continue;
    if (!row.amount && !row.children.length) continue;
    records.push({ ...value, key: row.key, timestamp: row.timestamp, provider: row.provider, model: row.model,
      calls: row.calls, session: row.session, cwd: row.cwd });
  }
  return { records, duplicates, reconciled, issues };
}

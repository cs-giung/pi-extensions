import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { Amount, ParsedFile, Snapshot, UsageRecord } from "../src/model.js";
import { parseEntry } from "../src/scan.js";
export const uiTheme = { fg: (_name: string, text: string) => `\u001b[36m${text}\u001b[39m`,
  bg: (_name: string, text: string) => `\u001b[44m${text}\u001b[49m`, bold: (text: string) => `\u001b[1m${text}\u001b[22m` } as unknown as Theme;
export const uiKeys = getKeybindings() as KeybindingsManager;

export const NOW = new Date(2026, 6, 22, 12).getTime();
export const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 65,
  reasoning: 7, cacheWrite1h: 2, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.005, total: 0.065 } };
export const header = (id = "s1", cwd = "/project", parentSession = "") => ({ type: "session", version: 3, id, cwd, parentSession, timestamp: new Date(NOW - 10000).toISOString() });
export const assistant = (id = "a1", provider = "provider", model = "model", timestamp = NOW - 1000) => ({ type: "message", id, timestamp: new Date(timestamp).toISOString(),
  message: { role: "assistant", timestamp, provider, model, usage, stopReason: "stop", content: [{ type: "text", text: "PRIVATE_SOURCE_CONTENT" }] } });
export const tool = (id = "t1", children: { sessionFile: string; usage: unknown }[] = [], value: unknown = usage) => ({ type: "message", id, timestamp: new Date(NOW).toISOString(),
  message: { role: "toolResult", toolName: "council_review", timestamp: NOW, usage: value, details: { results: children } } });
export function parsed(path: string, entries: unknown[]): ParsedFile {
  const file: ParsedFile = { file: path, session: "", cwd: "", parent: "", created: 0, records: [], issues: 0, complete: false };
  for (const entry of entries) parseEntry(JSON.stringify(entry), file);
  for (const row of file.records) { row.session = file.session; row.cwd = file.cwd; }
  file.complete = file.issues === 0 && Boolean(file.session);
  return file;
}
export const amount: Amount = { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, tokens: 65, cost: 0.065, unknownCost: 0 };
export const row = (patch: Partial<UsageRecord> = {}): UsageRecord => ({ ...amount, key: "a1", timestamp: NOW - 1000,
  provider: "provider", model: "model", calls: 1, session: "s1", cwd: "/project", ...patch });
export const snapshot = (records: UsageRecord[] = [row()]): Snapshot => ({ records, scanned: 1, cached: 0, issues: 0, duplicates: 0, reconciled: 0, capturedAt: NOW });

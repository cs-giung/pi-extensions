import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { amount, object, text, type ParsedFile, type Snapshot } from "./model.js";
import { reconcile } from "./reconcile.js";

export const MAX_LINE_BYTES = 8 * 1024 * 1024;
function timestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : NaN;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Extract accounting metadata only. Prompts, responses and credentials are never cached. */
export function parseEntry(source: string, file: ParsedFile): void {
  if (!source.trim()) return;
  let entry: Record<string, unknown> | undefined;
  try { entry = object(JSON.parse(source)); } catch { file.issues++; return; }
  if (!entry) { file.issues++; return; }
  if (entry.type === "session") {
    if (file.session || !text(entry.id)) { file.issues++; return; }
    file.session = text(entry.id); file.cwd = text(entry.cwd); file.parent = text(entry.parentSession);
    file.created = timestamp(entry.timestamp); return;
  }
  const message = object(entry.message);
  const assistant = entry.type === "message" && message?.role === "assistant";
  const tool = entry.type === "message" && message?.role === "toolResult";
  const auxiliary = ["compaction", "branch_summary", "usage"].includes(text(entry.type));
  if (!assistant && !tool && !auxiliary || assistant && message?.stopReason === "pending") return;
  const data = assistant || tool ? message! : entry;
  const usage = amount(data.usage);
  const results = tool ? object(data.details)?.results : undefined;
  const children = Array.isArray(results)
    ? results.flatMap((value) => {
      const result = object(value); const parsed = amount(result?.usage);
      return parsed ? [{ file: text(result?.sessionFile), amount: parsed }] : [];
    }) : [];
  if (!usage && !children.length) {
    if (!tool || data.usage !== undefined) file.issues++;
    return;
  }
  const time = timestamp(data.timestamp ?? entry.timestamp);
  if (!Number.isFinite(time)) { file.issues++; return; }
  const provider = assistant || entry.type === "usage" ? text(data.provider) || "Unknown" : "Tools / summaries";
  const model = assistant || entry.type === "usage" ? text(data.model) || "Unknown" : tool ? text(data.toolName) || "tool" : text(entry.type);
  // IDs survive Pi branch copies. Include timestamp, attribution and amount to avoid short-ID collisions.
  // Legacy entries without IDs use a hash of the full line, not timestamp/token-count alone.
  const key = digest(JSON.stringify([text(entry.id) || digest(source), time, entry.type, provider, model, usage ?? children.map((child) => child.amount)]));
  file.records.push({ key, timestamp: time, provider, model, calls: assistant ? 1 : 0, amount: usage, children,
    file: file.file, session: "", cwd: "" });
}

export async function parseFile(path: string, signal: AbortSignal, maxLineBytes = MAX_LINE_BYTES): Promise<ParsedFile> {
  const result: ParsedFile = { file: resolve(path), session: "", cwd: "", parent: "", created: 0, records: [], issues: 0, complete: false };
  const stream = createReadStream(path, { signal, highWaterMark: 64 * 1024 });
  let parts: Buffer[] = []; let size = 0; let oversized = false;
  const consume = (fragment: Buffer, end: boolean) => {
    size += fragment.length;
    if (size > maxLineBytes) { oversized = true; parts = []; }
    else if (!oversized) parts.push(fragment);
    if (end) {
      if (oversized) result.issues++;
      else parseEntry(Buffer.concat(parts, size).toString("utf8"), result);
      parts = []; size = 0; oversized = false;
    }
  };
  try {
    for await (const raw of stream) {
      signal.throwIfAborted(); const chunk = raw as Buffer; let start = 0; let end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) { consume(chunk.subarray(start, end), true); start = end + 1; }
      if (start < chunk.length) consume(chunk.subarray(start), false);
    }
    if (size) consume(Buffer.alloc(0), true);
  } catch (cause) {
    signal.throwIfAborted(); result.issues++;
  } finally { stream.destroy(); }
  if (!result.session) { result.issues++; result.records = []; }
  for (const row of result.records) { row.session = result.session; row.cwd = result.cwd; }
  result.complete = Boolean(result.session) && result.issues === 0;
  return result;
}

interface Cached { stamp: string; file: ParsedFile }
export interface ScanOptions { root: string; extraFile?: string | undefined; signal: AbortSignal; progress?: (files: number) => void; now?: number }
/** Session-scoped, bounded metadata cache. No disk cache or background polling. */
export class UsageScanner {
  private cache = new Map<string, Cached>();
  clear(): void { this.cache.clear(); }
  async scan(options: ScanOptions): Promise<Snapshot> {
    const { signal } = options;
    const paths = new Set<string>(); let issues = 0;
    const visit = async (dir: string): Promise<void> => {
      signal.throwIfAborted();
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          signal.throwIfAborted(); const path = join(dir, entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.add(resolve(path));
        }
      } catch (cause) {
        signal.throwIfAborted();
        if (object(cause)?.code !== "ENOENT") issues++;
      }
    };
    await visit(options.root);
    if (options.extraFile && isAbsolute(options.extraFile)) paths.add(resolve(options.extraFile));
    for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
    const files: ParsedFile[] = []; let cached = 0;
    for (const path of [...paths].sort()) {
      signal.throwIfAborted();
      try {
        const stat = await lstat(path);
        if (!stat.isFile()) continue; // Never follow symbolic links from session metadata or directories.
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const previous = this.cache.get(path);
        if (previous?.stamp === stamp) { files.push(previous.file); cached++; }
        else {
          const file = await parseFile(path, signal);
          const after = await lstat(path);
          signal.throwIfAborted();
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
            file.complete = false; file.issues++; this.cache.delete(path);
          } else if (file.complete && file.records.length < 20000 && (this.cache.size < 256 || this.cache.has(path))
            && [...this.cache].reduce((sum, [key, entry]) => sum + (key === path ? 0 : entry.file.records.length), file.records.length) <= 100000) {
            this.cache.set(path, { stamp, file });
          } else this.cache.delete(path);
          files.push(file);
        }
      } catch { signal.throwIfAborted(); issues++; this.cache.delete(path); }
      options.progress?.(files.length);
      await setImmediate(undefined, { signal });
    }
    signal.throwIfAborted();
    const result = reconcile(files);
    return { ...result, scanned: files.length, cached, issues: issues + files.reduce((sum, file) => sum + file.issues, 0) + result.issues,
      capturedAt: options.now ?? Date.now() };
  }
}

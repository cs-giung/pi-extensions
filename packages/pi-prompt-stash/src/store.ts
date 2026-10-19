import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";
import { DEFAULT_SHORTCUT, parseShortcut } from "./shortcut.js";

export interface Stash { id: number; text: string; timestamp: number }
export interface State { stashes: Stash[]; nextId: number; shortcut: KeyId }
const empty = (): State => ({ stashes: [], nextId: 1, shortcut: DEFAULT_SHORTCUT });
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function decode(value: unknown): State {
  if (!record(value) || !positiveInteger(value.nextId) || !Array.isArray(value.stashes)) throw new Error("Invalid stash structure");
  const nextId = value.nextId;
  const ids = new Set<number>();
  const stashes = value.stashes.map((entry: unknown): Stash => {
    if (!record(entry) || !positiveInteger(entry.id) || entry.id >= nextId || ids.has(entry.id)
      || typeof entry.text !== "string" || typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)
      || entry.timestamp < 0 || entry.timestamp > 8.64e15) throw new Error("Invalid stash entry or ID");
    ids.add(entry.id);
    return { id: entry.id, text: entry.text, timestamp: entry.timestamp };
  });
  const shortcut = value.shortcut === undefined ? DEFAULT_SHORTCUT : parseShortcut(value.shortcut);
  if (!shortcut) throw new Error("Invalid stash shortcut");
  return { stashes, nextId: value.nextId, shortcut };
}

/** Read fresh for every operation; never repair or overwrite an unreadable file. */
export class StashStore {
  constructor(readonly file: string) {}
  read(): State {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
    try { return decode(JSON.parse(raw)); }
    catch { throw new Error(`Invalid prompt stash: ${this.file}. Back up and repair the file; it was not changed.`); }
  }
  private mutate<T>(change: (state: State) => T): { state: State; result: T } {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Prompt stash is locked: ${lock}. Retry; after a crash remove the lock only when all Pi processes are closed.`);
      throw error;
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const state = this.read();
      const result = change(state);
      decode(state);
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
      return { state, result };
    } finally {
      closeSync(fd);
      try { rmSync(temp, { force: true }); } finally { rmSync(lock, { force: true }); }
    }
  }
  private add(state: State, text: string): Stash {
    if (!text.trim()) throw new Error("Nothing to stash. Editor is empty.");
    if (state.nextId === Number.MAX_SAFE_INTEGER) throw new Error("Prompt stash ID limit reached. Back up the file before resetting it.");
    const entry = { id: state.nextId++, text, timestamp: Date.now() };
    state.stashes.push(entry);
    return entry;
  }
  save(text: string) { return this.mutate((state) => this.add(state, text)); }
  /** Restore never consumes a stash. Preserve displaced editor text in the same commit. */
  restore(id: number, current: string) {
    return this.mutate((state) => {
      const entry = state.stashes.find((stash) => stash.id === id);
      if (!entry) throw new Error("That prompt was deleted by another process. Open /stash again.");
      const preserved = current.trim() && current !== entry.text ? this.add(state, current).id : undefined;
      return { text: entry.text, preserved };
    });
  }
  /** Delete only IDs shown to the user; retain prompts another process added later. */
  remove(ids: readonly number[]) {
    const selected = new Set(ids);
    return this.mutate((state) => {
      const before = state.stashes.length;
      state.stashes = state.stashes.filter((entry) => !selected.has(entry.id));
      return before - state.stashes.length;
    });
  }
  setShortcut(shortcut: KeyId) { return this.mutate((state) => { state.shortcut = shortcut; }); }
}

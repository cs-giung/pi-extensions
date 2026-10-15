import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const workerRefSchema = z.object({ file: z.string().min(1), sessionId: z.string().min(1),
  leafId: z.string().min(1), ownerSessionId: z.string().min(1) }).strict();
export type WorkerRef = z.infer<typeof workerRefSchema>;
export interface WorkerRequest {
  councilId: string;
  index: number;
  ref: WorkerRef | null;
  ownerSessionId: string;
  sessionDir: string;
}
const MARKER = "council-worker";

/** Inspect accepted history, never the file's potentially uncommitted current leaf. */
export function inspectWorker(request: WorkerRequest, cwd: string): SessionManager | undefined {
  const { ref } = request;
  if (!ref) return undefined;
  const label = `Council Reviewer ${request.index + 1}`;
  if (!isAbsolute(ref.file) || !ref.file.endsWith(".jsonl") || !existsSync(ref.file)) {
    throw new Error(`Missing ${label} session. Restore the recorded file or start a fresh /council.`);
  }
  const manager = SessionManager.open(ref.file);
  if (manager.getCwd() !== cwd || manager.getSessionId() !== ref.sessionId || !manager.getEntry(ref.leafId)) {
    throw new Error(`Mismatched or corrupt ${label} checkpoint. Start a fresh /council.`);
  }
  const marker = manager.getBranch(ref.leafId).find((entry) => entry.type === "custom" && entry.customType === MARKER);
  const data = marker?.type === "custom" ? marker.data as Record<string, unknown> | undefined : undefined;
  if (data?.version !== 1 || data.councilId !== request.councilId || data.index !== request.index) {
    throw new Error(`Invalid ${label} ownership marker. Start a fresh /council.`);
  }
  return manager;
}

export function openWorker(request: WorkerRequest, cwd: string, parentSession?: string): SessionManager {
  const existing = inspectWorker(request, cwd);
  if (existing) {
    // Copy accepted history before writing on a divergent parent branch or fork.
    if (existing.getLeafId() !== request.ref!.leafId || request.ref!.ownerSessionId !== request.ownerSessionId) {
      existing.createBranchedSession(request.ref!.leafId);
    }
    return existing;
  }
  const manager = SessionManager.create(cwd, request.sessionDir, parentSession ? { parentSession } : undefined);
  manager.appendSessionInfo(`Council ${request.councilId.slice(0, 8)} Reviewer ${request.index + 1}`);
  manager.appendCustomEntry(MARKER, { version: 1, councilId: request.councilId, index: request.index });
  return manager;
}

export function workerCheckpoint(manager: SessionManager, request: WorkerRequest): WorkerRef {
  return workerRefSchema.parse({ file: manager.getSessionFile(), sessionId: manager.getSessionId(),
    leafId: manager.getLeafId(), ownerSessionId: request.ownerSessionId });
}

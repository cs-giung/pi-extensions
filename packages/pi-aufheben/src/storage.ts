import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { stateSchema, type Exploration } from "./state.js";

export const STATE_ENTRY = "aufheben-state";
const envelopeSchema = z.object({ version: z.literal(1), eventId: z.string().uuid(), state: stateSchema }).strict();

/** The latest snapshot on this branch is canonical, even when its producing tool was interrupted. */
export function readState(entries: readonly SessionEntry[]): Exploration | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const parsed = envelopeSchema.safeParse(entry.data);
    if (!parsed.success) throw new Error("Unsupported or corrupt Aufheben state. Inspect this branch or start a new /aufheben exploration.");
    return parsed.data.state;
  }
  return undefined;
}

export function currentState(ctx: ExtensionContext): Exploration | undefined {
  const state = readState(ctx.sessionManager.getBranch());
  if (state && state.cwd !== ctx.cwd) throw new Error("Aufheben belongs to a different working directory. Start a new exploration here.");
  return state;
}

export function saveState(pi: ExtensionAPI, state: Exploration): void {
  const checked = stateSchema.parse(state);
  pi.appendEntry(STATE_ENTRY, { version: 1, eventId: randomUUID(), state: checked });
}

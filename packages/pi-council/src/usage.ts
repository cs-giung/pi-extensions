import type { Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const counter = z.number().nonnegative();
const usageSchema = z.object({ input: counter, output: counter, cacheRead: counter, cacheWrite: counter, totalTokens: counter,
  cacheWrite1h: counter.optional(), reasoning: counter.optional(),
  cost: z.object({ input: counter, output: counter, cacheRead: counter, cacheWrite: counter, total: counter }),
});
export interface SessionAccounting { sessionFile: string; usage: Usage }
export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens,
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) } : {}),
    cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output, cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total } };
}
export function sessionAccounting(manager: SessionManager, oldIds: ReadonlySet<string> = new Set()): SessionAccounting | undefined {
  let usage: Usage | undefined;
  for (const entry of manager.getBranch()) {
    if (oldIds.has(entry.id)) continue;
    const value = entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage
      : entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage" ? entry.usage : undefined;
    const parsed = usageSchema.safeParse(value);
    if (parsed.success) usage = addUsage(usage, parsed.data as Usage);
  }
  const file = manager.getSessionFile();
  return file && usage ? { sessionFile: file, usage } : undefined;
}

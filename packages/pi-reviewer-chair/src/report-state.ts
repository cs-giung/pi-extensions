import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ReviewReport } from "./review-report.js";

export const REPORT_ENTRY_TYPE = "reviewer-chair-report";

const storedReportSchema = z.object({
  version: z.literal(1),
  report: z.object({
    prompt: z.string(),
    successes: z.array(z.object({ index: z.number().int().nonnegative(), content: z.string() })),
    failures: z.array(z.object({
      index: z.number().int().nonnegative(),
      kind: z.enum(["cancelled", "configuration", "idle-timeout", "max-duration", "empty-response", "model"]),
      error: z.string(),
    })),
  }),
});

/** Read only the active branch; abandoned reports must not leak into this view. */
export function findLastReviewReport(entries: readonly SessionEntry[]): ReviewReport | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== REPORT_ENTRY_TYPE) continue;
    const result = storedReportSchema.safeParse(entry.data);
    if (result.success) return result.data.report;
  }
  return undefined;
}

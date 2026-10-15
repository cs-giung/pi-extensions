import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ReviewReport } from "./review-report.js";
import { acceptedReviewSchema } from "./review-artifact.js";

export const REPORT_ENTRY_TYPE = "council-report";
export const reviewReportSchema = z.object({
  prompt: z.string(), brief: z.string().optional(), round: z.number().int().positive().optional(), focus: z.string().optional(),
  successes: z.array(z.object({ index: z.number().int().nonnegative(), content: z.string(), artifact: acceptedReviewSchema.optional() })),
  failures: z.array(z.object({ index: z.number().int().nonnegative(),
    kind: z.enum(["cancelled", "configuration", "idle-timeout", "max-duration", "empty-response", "invalid-output", "model"]), error: z.string() })),
});
const storedReportSchema = z.object({ version: z.literal(1), report: reviewReportSchema });

/** Historical report entries survive the package rename; read only the selected branch. */
export function findLastReviewReport(entries: readonly SessionEntry[]): ReviewReport | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "custom" || ![REPORT_ENTRY_TYPE, "reviewer-chair-report"].includes(entry.customType)) continue;
    const parsed = storedReportSchema.safeParse(entry.data);
    if (parsed.success) return parsed.data.report;
  }
  return undefined;
}

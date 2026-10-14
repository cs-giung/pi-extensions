import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { findLastReviewReport, REPORT_ENTRY_TYPE } from "../src/report-state.js";

const report = { prompt: "Question", successes: [{ index: 0, content: "Answer" }], failures: [] };

describe("persistent reviewer reports", () => {
  it("restores reports from non-context entries and follows the active branch", () => {
    const manager = SessionManager.inMemory();
    const root = manager.appendCustomEntry("unrelated", {});
    manager.appendCustomEntry(REPORT_ENTRY_TYPE, { version: 1, report });
    expect(findLastReviewReport(manager.getBranch())).toEqual(report);
    manager.branch(root);
    expect(findLastReviewReport(manager.getBranch())).toBeUndefined();
  });

  it("ignores malformed and future-version reports", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry(REPORT_ENTRY_TYPE, { version: 1, report });
    manager.appendCustomEntry(REPORT_ENTRY_TYPE, { version: 1, report: { prompt: false } });
    manager.appendCustomEntry(REPORT_ENTRY_TYPE, { version: 2, report });
    expect(findLastReviewReport(manager.getBranch())).toEqual(report);
  });
});

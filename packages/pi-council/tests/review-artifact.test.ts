import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { acceptReview, acceptedReviewSchema, formatReview, MAX_REVIEW_CHARS, parseReview, reviewerOutputSchema, verifyReview } from "../src/review-artifact.js";
import { formatToolReviews, reviewView, toolSchema } from "../src/protocol.js";
import { STATE_ENTRY_TYPE } from "../src/state.js";
import { acceptedSuccess, harness, rawReview } from "./fixtures.js";

const first = () => acceptedSuccess().artifact;
describe("structured Reviewer protocol and concern ledger", () => {
  it("assigns scoped IDs and requires severity, evidence, impact, recommendation and an answer", () => {
    const artifact = first();
    expect(artifact.concerns[0]).toMatchObject({ id: "R1.V1.C1", severity: "HIGH" });
    expect(artifact.activeConcerns).toEqual(artifact.concerns);
    expect(acceptReview(rawReview(), 1, 2).concerns[0]!.id).toBe("R1.V2.C1");
    for (const key of ["title", "severity", "evidence", "impact", "recommendation"]) {
      const raw = rawReview(); delete (raw.concerns[0] as Record<string, unknown>)[key];
      expect(() => acceptReview(raw, 1, 1)).toThrow();
    }
    expect(() => acceptReview({ ...rawReview(), proposedAnswer: "" }, 1, 1)).toThrow();
  });
  it("retains IDs, resolves old concerns and connects supersession to newly assigned IDs", () => {
    const previous = first().activeConcerns;
    const retained = acceptReview(rawReview(undefined, previous), 2, 1, previous);
    expect(retained.activeConcerns).toEqual(previous); expect(retained.concerns).toEqual([]);
    const resolved = acceptReview({ concerns: [], assessments: [{ concernId: "R1.V1.C1", disposition: "resolved", reason: "Matched compute was supplied." }],
      proposedAnswer: "The control addresses the objection.", noConcernsReason: "No other material defects were found." }, 3, 1, retained.activeConcerns);
    expect(resolved.activeConcerns).toEqual([]);
    const superseded = acceptReview({ ...rawReview(), assessments: [{ concernId: "R1.V1.C1", disposition: "superseded", reason: "A narrower confounder remains.", replacementIndexes: [0] }] }, 2, 1, previous);
    expect(superseded.assessments[0]!.replacementIds).toEqual(["R2.V1.C1"]);
    expect(superseded.activeConcerns.map((concern) => concern.id)).toEqual(["R2.V1.C1"]);
    expect(verifyReview(superseded, 2, 1, previous)).toEqual(superseded);
  });
  it("accepts a no-concerns answer without manufacturing a criticism", () => {
    expect(acceptReview({ concerns: [], assessments: [], proposedAnswer: "Under standard arithmetic, 1 + 1 = 2.", noConcernsReason: "The statement follows from the definition of addition." }, 1, 1).activeConcerns).toEqual([]);
    expect(() => acceptReview({ concerns: [], assessments: [], proposedAnswer: "Correct." }, 1, 1)).toThrow(/Explain/);
    expect(() => acceptReview({ ...rawReview(), noConcernsReason: "No issues." }, 1, 1)).toThrow(/empty/);
  });
  it("rejects missing, duplicate, foreign and already-resolved references", () => {
    const previous = first().activeConcerns;
    const raw = rawReview(undefined, previous);
    for (const assessments of [[], [raw.assessments[0], raw.assessments[0]], [{ ...raw.assessments[0], concernId: "R1.V2.C1" }]]) {
      expect(() => acceptReview({ ...raw, assessments }, 2, 1, previous)).toThrow(/exactly once/);
    }
    expect(() => acceptReview(raw, 3, 1, [])).toThrow(/exactly once/);
  });
  it.each([[], [1], [0, 0], [-1]].map((replacementIndexes) => ({ replacementIndexes })))("rejects invalid supersession indexes $replacementIndexes", ({ replacementIndexes }) => {
    expect(() => acceptReview({ ...rawReview(), assessments: [{ concernId: "R1.V1.C1", disposition: "superseded", reason: "Changed premise.", replacementIndexes }] }, 2, 1, first().activeConcerns)).toThrow();
  });
  it("rejects invented IDs, unknown fields, tampered ledgers and stale identities", () => {
    expect(() => acceptReview({ ...rawReview(), concerns: [{ ...rawReview().concerns[0], id: "INVENTED" }] }, 1, 1)).toThrow();
    const artifact = first();
    expect(() => verifyReview({ ...artifact, activeConcerns: [] }, 1, 1, [])).toThrow();
    expect(() => verifyReview(artifact, 2, 1, [])).toThrow(/does not match/);
    expect(() => verifyReview(artifact, 1, 2, [])).toThrow(/does not match/);
    expect(acceptedReviewSchema.safeParse({ ...artifact, activeConcerns: [artifact.concerns[0], artifact.concerns[0]] }).success).toBe(false);
  });
  it("bounds raw size before trimming and derives the model schema from runtime validation", () => {
    const source = JSON.stringify(rawReview());
    expect(parseReview(`\`\`\`json\n${source}\n\`\`\``)).toEqual(rawReview());
    expect(() => parseReview(" ".repeat(MAX_REVIEW_CHARS) + source)).toThrow(/exceeds/);
    expect(Value.Check(toolSchema(reviewerOutputSchema), rawReview())).toBe(true);
    expect(Value.Check(toolSchema(reviewerOutputSchema), { ...rawReview(), model: "another-model" })).toBe(false);
  });
  it("returns JSON artifacts to the Chair but renders readable Markdown for users", async () => {
    const h = harness(); await h.command(); await h.activate(); const result = await h.review();
    const output = h.output(result);
    expect(output.anonymousReviews[0]).toMatchObject({ content: null, artifact: { concerns: [{ id: "R1.V1.C1" }] } });
    const rendered = formatToolReviews(output); expect(rendered).toContain("[HIGH] R1.V1.C1"); expect(rendered).toContain("Evidence:");
    expect(rendered).not.toContain('"activeConcerns"');
    expect(formatReview(first())).toContain("### Limitations");
    expect(reviewView(h.state()).anonymousReviews[0]!.artifact).toEqual(first());
  });
  it("does not commit artifacts that fail verification or let them count toward quorum", async () => {
    const h = harness({ runReviewers: async () => ({ successes: [{ index: 0, content: "Looks fine, trust me." }], failures: [] }) });
    await h.command(); await h.activate(); const result = await h.review();
    expect(result.isError).toBe(true); expect(h.state().phase).toBe("failed"); expect(h.state().report).toBeNull();
    expect(h.state().continuation!.reviews).toEqual([null]);
  });
  it("preserves legacy reports without inventing structured memory for old worker histories", async () => {
    const h = harness(); await h.command(); await h.activate(); await h.review(); await h.finish();
    const state = h.state(); const { reviews: _unused, ...continuation } = state.continuation!;
    h.manager.appendCustomEntry(STATE_ENTRY_TYPE, { ...state, continuation: { ...continuation, workers: [{ file: "/tmp/old.jsonl", sessionId: "old", leafId: "old", ownerSessionId: "old" }] } });
    await h.command("council-next", "Recheck");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("predates structured"), "error");
    await h.command("council-copy"); expect(h.copyText).toHaveBeenCalledWith(state.answer);
  });
});

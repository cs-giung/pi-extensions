# pi-council

Independent Reviewer sessions, with the **existing main Pi session as Chair**. `/council <prompt>` starts a normal main-model turn. The Chair resolves the request's conversational context, calls `council_review` once, receives anonymous reviews, and synthesizes its normal assistant answer. There is no separate Chair model, session, or hidden synthesis call.

## Setup

Requires Node.js 22.19 or newer and the latest Pi release, currently 1.4.0. From the repository root:

```bash
npm install
cp packages/pi-council/.pi/council.example.yaml .pi/council.yaml
```

Replace the example Reviewer `provider/model-id` placeholders with accessible models. The minimal example uses the built-in correctness instructions, `medium` thinking, and read-only tools. Add optional settings only when needed; available settings are documented below. The root Pi package loads this extension after project trust. For standalone user-wide installation:

```bash
pi install ~/git/pi-extensions/packages/pi-council
```

Run `/reload` after changing source code. Reviewer configuration is snapshotted for a Council series. `/council-next` keeps that roster, prompts, tools, and deadlines; a fresh `/council` reads configuration again. Authentication is resolved normally, including trusted extension-registered providers.

## Workflow and commands

```text
/council <question or task>
  -> current main model prepares an explicit brief
  -> independent Reviewers run with bounded concurrency
  -> anonymous tool results return to the same main model
  -> main model assesses the evidence and answers normally as Chair
  -> wait for the user
```

| Command | Behavior |
| --- | --- |
| `/council <prompt>` | Authorize one fresh Reviewer batch and a main-session synthesis. Requires an idle main agent. |
| `/council-next [focus]` | Authorize one more batch using each Reviewer's own accepted history. Requires an idle main agent. |
| `/council-check` | Validate the current configuration file and model availability without inference. |
| `/council-cancel` | Cancel owned Reviewer work or main Chair synthesis; block new work until active cleanup finishes. |
| `/council-reviews` | Show the latest completed anonymous Reviewer report on this branch. |
| `/council-copy` | Copy the latest completed main-session Chair answer on this branch. |

There is no automatic repeated batch. Ordinary conversation, a model recommendation, reload, or resume never authorizes Reviewer inference. Each `/council` creates fresh, independent Reviewer conversations. `/council-next [focus]` explicitly continues the selected series, with a new batch ID and a higher round number. Unlike Aufheben's sequential proposition/question cycle, Council Reviewers work in parallel.

### Fresh versus continued review

```text
/council Is 1 + 1 = 2 under standard arithmetic?
/council-next Check the argument using the formal definition of addition.
/council Review this claim from scratch, without prior Reviewer history.
```

On continuation, each Reviewer sees only its own accepted earlier exchanges plus the main Chair's new self-contained brief. Same-model Reviewers still have separate sessions. Other reviewers' raw reports and the previous Chair answer are not automatically injected into child histories. The Chair receives its prior answer and brief as context and explicitly selects relevant changes and evidence for the next brief. No extra model is called to prepare that handoff.

Continued findings should identify resolved, still-open, superseded, and new concerns with reasons. The Chair explains material changes rather than treating repeated agreement as new evidence. Anonymous `Review N` labels stay tied to roster positions even when a Reviewer fails, so labels can have gaps. A fresh start is useful for reducing anchoring; the main Chair still retains the ordinary main conversation.

A cancelled or interrupted round can be followed by `/council-next`, but this authorizes a new complete batch, not a synthesis-only retry. Successful reviews committed in an accepted batch keep their histories even if that batch missed quorum or main synthesis was cancelled. Failed Reviewer attempts keep their earlier checkpoint; a Reviewer with no accepted response yet starts without prior history, explicitly indicated to the Chair. An entirely cancelled/uncommitted batch advances no checkpoints. Historical one-shot runs without checkpoints remain readable but require a fresh `/council` before continuation.

The main Chair can resolve "this method" or "here" against the existing conversation and select a self-contained brief, including context, constraints, provenance, and language. Reviewers do not automatically inherit the main transcript. If essential context is ambiguous, the main model should ask rather than spend Reviewer calls on invented context. The shared brief is visible in the tool input/result.

Reviewer outputs reach main-model context as validated JSON artifacts through the tool result, not only through a pasted final answer. Expanded tool results and `/council-reviews` render the artifacts as readable Markdown, including concern IDs, evidence, dispositions, proposed answers, and limitations. `/council-reviews` adds an unverified reference copy to context without triggering inference. Choose the Reviewer count and output size to fit the main model's context window; accepted artifacts are not silently truncated.

### Structured review contract

Each Reviewer returns new concerns (title, severity, evidence, impact, recommendation), assessments of prior active concerns, a proposed answer, and limitations. The extension assigns IDs such as `R1.V2.C1` (round 1, Reviewer 2, concern 1). Reviewers cannot assign IDs or refer to another Reviewer's ledger.

Every prior active concern must receive exactly one decision: `retained`, `resolved`, or `superseded`, with a reason. Retained concerns keep their IDs and descriptions. To revise a concern, the Reviewer supplies a new replacement concern and a supersession link. The raw JSON uses zero-based `replacementIndexes` into its new concerns array; the extension converts these to assigned IDs. Resolved concerns stay in history but are removed from the active ledger. Reopening a resolved issue requires a new concern with its supporting evidence; old resolved IDs are not valid active targets.

A response can legitimately contain no concerns, but must explain why in `noConcernsReason`. At most 12 new concerns and 40 active concerns are allowed per Reviewer; reference checks prevent silent omissions. Raw output is bounded to 64,000 characters before whitespace trimming, text fields to 4,000 characters, the proposed answer to 12,000, and limitations to 20 items.

Malformed or invalid output gets at most one format/reference repair in the same child session within the original Reviewer deadline. Only validated output counts toward `minSuccess` or advances its child checkpoint. Repair and failed-attempt usage is included when available. This validates structure and lineage, not evidence, truth, or the semantic correctness of a resolution.

### Language policy

Reviewers write their own prose in **English**, even when the original request or final-answer language is different. The main Chair prepares English handoffs and presents its normal final answer in the user's requested language. Source quotations, names, code, and mathematical notation may retain their original language. No extra translation session is created. English is a prompt-level contract, not a heuristic language detector; identifiers and non-English quotations are not rejected as format errors.

## Configuration

`.pi/council.yaml` accepts:

- `reviewers`: one or more entries with `model`, optional `name`, `thinking`, `systemPrompt`, and `tools`. Thinking defaults to `medium`; tools default to `read`, `grep`, `find`, and `ls`.
- `chair.systemPrompt`: optional additional instructions for the main-session Chair. No `chair.model`, `chair.thinking`, or `chair.tools` settings exist; use Pi's normal main-session controls.
- `minSuccess`: required minimum usable reviews before a successful Chair synthesis.
- `maxConcurrency`: maximum active Reviewers, default `4`.
- `idleTimeoutMs`: inactivity timeout per Reviewer, including initialization, default `120000`; session events reset it.
- `maxDurationMs`: absolute timeout for each Reviewer's resource loading, SDK session creation, initial prompt, and any format repair, default `900000`. Queueing, shared runtime preflight, and main synthesis are excluded. Neither timer bounds the whole Council.

Timer values must be positive integers no larger than `2147483647`, and maximum duration must be at least the idle timeout. Reviewer tools accept built-ins only: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. Unknown/duplicate tools are rejected. Children disable extension, skill, template, theme, and context-file discovery. Only enable mutating tools deliberately, especially with parallel Reviewers; read-only tool selection is not a filesystem sandbox.

Both `/council` and `/council-check` require project trust before reading local configuration. Every configured Reviewer must exist and be available before the batch starts. The main Chair's model/authentication is handled by the normal Pi turn. Preflight is not a live provider-health or quota guarantee; authentication refresh can still make network requests.

Fixed Reviewer instructions request severity-tagged concerns with evidence, impact, and recommendations. The Chair evaluates correctness rather than voting, groups equivalent concerns, distinguishes `COMMON` from `EXCLUSIVE`, preserves per-review severity, and provides an aggregated severity and resolution before its final answer. Additional prompts supplement these contracts. Structural schema/reference checks enforce the artifact contract, but the reasoning instructions are not proof that an output is correct.

## Cancellation, persistence, and copying

Cancellation aborts only Council-owned work, never unrelated main-session work. It stops waiting even during resource loading or SDK session creation. An SDK handle that resolves after cancellation or timeout is aborted and disposed without prompting or checkpointing; already-active sessions finish abort/cleanup before a new batch can start. Queued Reviewers do not start after cancellation. Late results cannot replace the previous report or become a successful Chair answer. Failures below `minSuccess` preserve an inspectable report, but no successful synthesis is recorded. If the user steers an active run, its former brief is not silently treated as approval for another batch.

Main-session custom entries preserve versioned run snapshots, completed reports, and the actual normally emitted Chair answer. Report/copy restoration reads only the active branch, so abandoned `/tree` branches do not leak results. Reload/resume marks unfinished work interrupted without restarting inference; use `/council-next` explicitly to review again, or `/council` to start fresh. Cancelling main synthesis preserves already completed reviews. Ordinary discussion after a completed Council does not replace its recorded Chair answer.

Pi's built-in `/copy` now works on the normal Chair assistant response. `/council-copy` remains useful after subsequent unrelated conversation and restores the latest successful Council answer from this branch. It chooses `pbcopy` on macOS, `clip`/`clip.exe` on Windows/WSL, tmux, OSC 52 for remote terminals, or Pi's clipboard helper. Terminal policy can still block OSC 52 writes. Notifications identify the transport.

Each Reviewer is saved as a named child Pi session, including the selected brief and raw response. SDK handles are disposed after each request; continuation reopens accepted file/leaf checkpoints. The parent run snapshot is the commit authority. Rewinding or forking copies only the accepted child history before writing, so later abandoned exchanges cannot leak into earlier parent branches. Missing/mismatched child files fail explicitly before Reviewer inference; restore them or start fresh, rather than silently replacing memory. The main answer remains in the existing main session. Only newly incurred child usage, when available, is returned as tool `usage` with `details.results[].sessionFile` provenance, including failed attempts. The local `pi-usage` table recognizes that form and reconciles parent rollups against scanned child usage. Other dashboards may double-count overlapping views. Unknown usage is not a guarantee of zero cost.

The original prompt, brief and research outputs are persisted and sent to the configured providers. Runtime credentials are not saved in run snapshots. Provider failures returned to the main model use safe categories, not raw provider response bodies.

## Migration from pi-reviewer-chair

For a project with the previous configuration:

```bash
mv .pi/reviewer-chair.yaml .pi/council.yaml
```

Keep `reviewers`, thresholds, timeouts, and `chair.systemPrompt`. Remove `chair.model`, `chair.thinking`, and `chair.tools`. The old configuration path is not read automatically. No personal configuration is overwritten by this repository change.

The root package manifest already points to `packages/pi-council`. If you installed the old standalone directory separately, remove that old package declaration and install the renamed directory to avoid duplicate commands. Old persisted Reviewer reports and final Chair messages remain readable; no old Chair inference path is retained. A series created before structured concern ledgers must start fresh with `/council` before using structured continuation: the extension does not invent IDs or unresolved-issue mappings from historical prose.

## Development

```bash
npm run check
```

Tests use fake providers and temporary session files; no live model credentials or paid research calls are needed. Keep this package standalone: never import sibling package runtime sources.

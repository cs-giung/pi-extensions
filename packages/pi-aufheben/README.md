# pi-aufheben

Develop research ideas with two persistent partners. The current Pi main-session model is the Synthesizer: it calls a Thesizer for reasoned claims, calls an Antithesizer for reasoned questions, then synthesizes a better-supported understanding and an appropriate verification as its normal assistant response. There is no fourth agent or hidden synthesis model.

## Setup

Requires Node.js 22.19 or newer and Pi. From this repository:

```bash
npm install
cp packages/pi-aufheben/.pi/aufheben.example.yaml .pi/aufheben.yaml
```

Replace both example model references with accessible `provider/model-id` values. The root Pi package includes this extension. For standalone installation:

```bash
pi install ~/pi-extensions/packages/pi-aufheben
```

Project trust is required. `/aufheben` validates both configured models before starting child inference. There is no model fallback. Additional role prompts supplement fixed contracts; the main Synthesizer uses the current session's model. Role configuration is snapshotted per exploration, so edits apply to new explorations only.

## Commands

| Command | Behavior |
| --- | --- |
| `/aufheben <question>` | Start a fresh exploration and authorize its first round. |
| `/aufheben-next [focus]` | Continue with the same child histories, or retry an interrupted stage. |
| `/aufheben-pause` | Cancel owned work without closing the exploration. |
| `/aufheben-status` | Inspect recorded state without model inference. |
| `/aufheben-stop` | Close the exploration and preserve history. |

Each completed round waits for the user. Ordinary conversation or coding does not authorize another round. Ask the main model to save a research adjustment, then use `/aufheben-next`. A changed focus or brief in a partial round invalidates that round's partial artifacts and restarts from its round-start checkpoints; unchanged retries preserve accepted stages.

Starting again creates a fresh child pair and supersedes the active selection, not its historical records. Start/next require an idle main agent; pause/stop can cancel active research without aborting unrelated work. Closed explorations cannot be continued with next. No automatic multi-round loop is enabled.

## Research context and contracts

The main model resolves references from the current conversation into an inspectable research brief; children do not automatically receive the entire transcript. Ambiguous context should be clarified before inference. The Thesizer and Antithesizer write their own research prose in **English**. The main Synthesizer prepares English briefs/instructions and presents the accepted synthesis in the user's requested language. `brief.language` refers only to that user-facing answer; it does not change the child roles' working language. A previous synthesis may be in the user's language, but child replies remain English. Exact quotations, names, code, and mathematical notation may retain their original language. No extra translation session is used. This is a prompt-level language contract, not a language detector. Built-in prompts and diagnostics are English.

- Thesizer: reasoned propositions and hypotheses, with assumptions, epistemic status, and predictions.
- Antithesizer: questions tied to claim IDs, with rationale and optional competing explanations/tests. Questions are not proven refutations.
- Synthesizer: claim/question dispositions, revisions, changed ideas, uncertainties, a minimal informative verification, abandonment criteria, and a recommendation.

The next round receives the complete latest completed-round record: the original brief, actual claims and questions, and their synthesis decisions. This is important because the Thesizer has not seen the Antithesizer's private conversation; question IDs alone do not explain what remains unresolved. Editing the future brief does not rewrite the completed record. `/aufheben-status` includes unresolved challenge text and the suggested next focus, neither of which authorizes execution.

Do not force controversy, novelty, or a compromise. For example:

```text
/aufheben Is 1 + 1 = 2 under standard arithmetic?
/aufheben-next Give a proof from the definition of addition.
```

For mathematical claims, the existing `experiment` field can specify a proof obligation or counterexample search. For empirical hypotheses it can specify a discriminating experiment; for factual claims, a source check. A settled claim can warrant `finish`, with no invented objections or artificial measurement. The user still decides whether to continue.

Strict schemas validate structure and references, not truth or novelty. Child output permits one bounded format repair, never an unbounded retry. Claims and questions have round-qualified IDs. Unverified sources remain unverified; no automatic literature search or experiment execution is included.

A child response or tool input is limited to 64,000 characters. Each thesis has at most 12 claims; each antithesis has at most 16 questions. Most text fields allow 4,000 characters, while brief problem/context, synthesis idea, and experiment design allow 12,000. General research lists allow 20 items. Oversized or invalid child output must be repaired within the original deadline or the stage pauses. Tool results are compact by default; expand them to inspect the complete shared brief and accepted research artifacts.

## Persistence, interruption, and privacy

Versioned custom entries in the main session are authoritative. Child session files preserve conversations; SDK handles are released between requests and reopened at accepted checkpoints. Reload/resume never silently resumes inference. `/aufheben-next` retries the missing stage. Branches/forks and aborted partial exchanges are isolated by copying from the recorded accepted child position rather than reading a file's latest future history.

Missing/corrupt worker files cause an explicit error, not a claim that replacement agents retained memory. Sessions and main-state entries contain the original question, selected context, and research outputs. These are sent to the configured providers; credentials are not stored in research state. Read-only tools are not a filesystem sandbox.

Children disable extension/skill/context-file discovery and only support `read`, `grep`, `find`, and `ls`, or no tools. No source mutations are performed by children. The main session's existing tools are not replaced.

`idleTimeoutMs` defaults to `120000` while a child prompt executes. `maxDurationMs` defaults to `900000` for the whole child request, including initialization and one repair. User waiting time and main-model synthesis are excluded. Both must be positive integers within Node's timer range, with maximum duration at least the idle timeout. Deadlines request cancellation; start/retry remains blocked until active SDK cleanup finishes.

Reported child usage, including failed/repair attempts when available, is returned in parent tool usage with `details.results[].sessionFile` provenance. The local `pi-usage` table recognizes that form and reconciles parent aggregates against scanned child usage. Other dashboards may double-count parent rollups plus direct child records; do not sum those overlapping views blindly. Unknown usage is not a zero-cost guarantee.

## Development

```bash
npm run check
```

Automated tests use fake providers and temporary session files. Live research calls are opt-in. The package must remain standalone and must not import sibling package sources.

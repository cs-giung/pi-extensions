# Pi extensions

This repository contains six personal Pi packages. It keeps local extension code, package choices, examples, and verification commands together.

## Included packages

| Source | Commands | Purpose |
| --- | --- | --- |
| `packages/pi-aufheben` | `/aufheben`, `/aufheben-next`, `/aufheben-pause`, `/aufheben-status`, `/aufheben-stop` | Develop research ideas with persistent Thesizer/Antithesizer partners and the current main model as Synthesizer. |
| `packages/pi-council` | `/council`, `/council-next`, `/council-check`, `/council-cancel`, `/council-reviews`, `/council-copy` | Start fresh or continue independent Reviewer histories; the current main-session model synthesizes as Chair. |
| `packages/pi-usage-codex` | `/usage-codex-status` | Show Codex subscription quota windows (Spark when selected) and polling diagnostics. |
| `packages/pi-usage-deepseek` | `/usage-deepseek-status` | Show the current DeepSeek account balance and polling diagnostics. |
| `packages/pi-usage-zai` | `/usage-zai-status` | Show the available Z.ai pay-as-you-go USD balance and polling diagnostics. |
| `packages/pi-usage` | `/usage [today\|week\|last-week\|30d\|all]` | Inspect historical usage in a local provider/model table with filtering and nested-session accounting. |

## Repository layout

```text
.pi/settings.json                    Project-local Pi package list
packages/pi-aufheben/                Persistent dialectical research workflow
packages/pi-council/                 Independent reviews with main-session Chair
packages/pi-usage/                   Local historical usage table
packages/pi-usage-codex/             Personal Codex quota status package
packages/pi-usage-deepseek/          Personal DeepSeek balance status package
packages/pi-usage-zai/               Personal Z.ai cash balance status package
packages/pi-council/.pi/             Example Council configuration
package.json                         Root Pi package and development commands
```

The root Pi manifest loads all six local packages. `.pi/settings.json` loads only that root package when Pi runs in this repository.

## Setup

Node.js 22.19 or newer is required. Only the latest Pi release is targeted, currently v1.2.0. Development dependencies pin that version for reproducible checks; older Pi versions are not maintained. Install the local package dependencies:

```bash
npm install
```

Start Pi in this repository and trust the project when prompted. Pi loads the six local extensions.

### Provider quota and balances

The footer indicators appear together whenever compatible credentials are available, regardless of the selected model. They refresh 30 seconds after completed requests, back off on failures, and honor `Retry-After`. Missing credentials hide an indicator; refresh failures mark cached values `(stale)`. Use `/usage-*-status` for safe polling diagnostics.

- [Codex](packages/pi-usage-codex/README.md): subscription quota via compatible Pi OAuth or read-only Codex CLI credentials. Pi 1.2.0's new `openai` OAuth needs the legacy `openai-codex` provider or CLI fallback. API keys are never used, and CLI credentials are never refreshed or modified.
- [DeepSeek](packages/pi-usage-deepseek/README.md): the authenticated account's monetary balance.
- [Z.ai](packages/pi-usage-zai/README.md): spendable pay-as-you-go USD balance, not Coding Plan quota. Set `ZAI_API_KEY` or authenticate the `zai` provider.

### Aufheben research workflow

Create `.pi/aufheben.yaml` and replace both role model references with available `provider/model-id` values:

```bash
cp packages/pi-aufheben/.pi/aufheben.example.yaml .pi/aufheben.yaml
```

Start `/aufheben <question>` in the current conversation. The main model resolves its context, calls two separate persistent research partners, synthesizes their claims and questions, and waits. `/aufheben-next [focus]` explicitly authorizes the next round or an interrupted-stage retry; ordinary discussion does not. `/aufheben-pause` preserves an open exploration; `/aufheben-stop` closes it without deleting history. Reload/resume and tree navigation never silently restart inference, and child checkpoints follow the active main branch. Children only have configured read-only tools. Both child roles write in English; the main Synthesizer answers in the user's requested language.

See [`packages/pi-aufheben/README.md`](packages/pi-aufheben/README.md) for intervention, configuration snapshots, recovery, usage accounting, and privacy limits.

### Council with the main session as Chair

Before running `/council`, create a project configuration from the example:

```bash
cp packages/pi-council/.pi/council.example.yaml .pi/council.yaml
```

The example uses independent Reviewers with built-in correctness criteria and read-only tools. Replace the model placeholders with accessible models and add optional settings only when needed. Runtime files under `.pi/` are ignored by Git; only repository installation settings are public.

Run `/council-check` to validate configuration and model availability without inference. `/council <prompt>` starts fresh independent Reviewers; the existing main session prepares the brief and synthesizes their anonymous results as Chair. `/council-next [focus]` authorizes one further batch using each Reviewer's accepted history. Nothing runs automatically between batches.

`/council-cancel` cancels owned work without aborting unrelated tasks. `/council-reviews` redisplays the latest report, and `/council-copy` copies the latest completed Chair answer on the active branch. See [`packages/pi-council/README.md`](packages/pi-council/README.md) for structured concern tracking, concurrency, deadlines, recovery, privacy, and migration from `pi-reviewer-chair`.

### Historical usage table

`/usage` opens the local Table dashboard. Use Tab or Left/Right to change periods, Enter to expand a provider's models, `/` to search, `s` to sort, `p` to filter to the current project, and `r` to refresh. Totals follow the visible slice. `/usage all` starts with all recorded history.

The dashboard reads local session accounting without model calls or network requests. It includes recorded child/summary usage and reconciles Council/Aufheben parent rollups against child session records. Tokens include cache reads and writes; cost is recorded usage, not a subscription invoice. See [`packages/pi-usage/README.md`](packages/pi-usage/README.md) for data warnings and accounting limits. The old external dashboard and raw-paste package are no longer registered by this repository; remove separately installed personal copies if needed to avoid duplicate commands.

### Optional user-wide installation

To load the extensions independently outside this repository, install each package from its directory:

```bash
pi install ~/pi-extensions/packages/pi-aufheben
pi install ~/pi-extensions/packages/pi-council
pi install ~/pi-extensions/packages/pi-usage
pi install ~/pi-extensions/packages/pi-usage-codex
pi install ~/pi-extensions/packages/pi-usage-deepseek
pi install ~/pi-extensions/packages/pi-usage-zai
```

The local packages remain linked to this repository; run `/reload` after changing their code. `/council` reads `.pi/council.yaml` from the directory where Pi is running, so each project may keep a separate council configuration.

## Maintenance

Validate all personal packages after changing code or configuration examples:

```bash
npm run check
```

Checks cover TypeScript, provider parsing, polling/backoff/cancellation, Council preflight and concurrency, Aufheben rounds/intervention/recovery, real-SDK integration with fake providers, active-session cleanup, branch-aware restoration, package-manifest consistency, and package contents. Cross-package integration tests live in `tests/`; each package keeps its own API/unit tests. GitHub Actions runs the suite on Node.js 22 and 24 against the current Pi target. When a new Pi release becomes the target, update the root and all package development dependencies, regenerate the lockfile, and run the full checks. A separate older-version compatibility matrix is not maintained. Example tests validate structural invariants rather than exact model IDs or reviewer counts.

Usage requests are cancelled on session shutdown or reload. Codex also cancels obsolete requests when switching between regular and Spark quotas. No live credentials are needed for automated tests.

Pi extensions execute with full system access. Review local changes and installed package updates before loading them.

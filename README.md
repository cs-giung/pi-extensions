# Pi extensions

This repository contains eleven personal Pi packages. It keeps local extension code, package choices, examples, and verification commands together.

## Included packages

| Source | Commands | Purpose |
| --- | --- | --- |
| `packages/pi-aufheben` | `/aufheben`, `/aufheben-next`, `/aufheben-pause`, `/aufheben-status`, `/aufheben-stop` | Develop research ideas with persistent Thesizer/Antithesizer partners and the current main model as Synthesizer. |
| `packages/pi-council` | `/council`, `/council-next`, `/council-check`, `/council-cancel`, `/council-reviews`, `/council-copy` | Start fresh or continue independent Reviewer histories; the current main-session model synthesizes as Chair. |
| `packages/pi-codex-fast` | `/fast [on\|off\|status]` | Request Codex Fast mode for eligible ChatGPT OAuth requests, with branch-local persistence. |
| `packages/pi-tool-views` | `/tools [folded\|expanded\|hidden]`, Ctrl+O | Fold completed tools while preserving native shaded backgrounds and rich renderers. |
| `packages/pi-thinking-views` | Ctrl+T | Cycle reasoning through folded, expanded, and fully hidden independently of tool views. |
| `packages/pi-message-timestamps` | None | Show session-entry times below completed user and assistant text. |
| `packages/pi-prompt-stash` | `/stash [save\|clear\|shortcut [key]]` | Save unfinished editor drafts and restore them from a searchable local picker without losing current input. |
| `packages/pi-usage-codex` | `/usage-codex-status` | Show Codex subscription quota windows (Spark when selected) and polling diagnostics. |
| `packages/pi-usage-deepseek` | `/usage-deepseek-status` | Show the current DeepSeek account balance and polling diagnostics. |
| `packages/pi-usage-zai` | `/usage-zai-status` | Show the available Z.ai pay-as-you-go USD balance and polling diagnostics. |
| `packages/pi-usage` | `/usage [today\|week\|last-week\|30d\|all]` | Inspect historical usage in a local provider/model table with filtering and nested-session accounting. |

## Repository layout

```text
.pi/settings.json                    Project-local Pi package list
packages/pi-aufheben/                Persistent dialectical research workflow
packages/pi-council/                 Independent reviews with main-session Chair
packages/pi-codex-fast/              Session-scoped Codex Fast request toggle
packages/pi-tool-views/              Foldable tools with native-style shaded backgrounds
packages/pi-thinking-views/          Independent three-state thinking display
packages/pi-message-timestamps/      Completed-message session-entry timestamps
packages/pi-prompt-stash/            Persistent editor draft stash and picker
packages/pi-usage/                   Local historical usage table
packages/pi-usage-codex/             Personal Codex quota status package
packages/pi-usage-deepseek/          Personal DeepSeek balance status package
packages/pi-usage-zai/               Personal Z.ai cash balance status package
packages/pi-council/.pi/             Example Council configuration
package.json                         Root Pi package and development commands
```

The root Pi manifest loads all eleven local packages. `.pi/settings.json` loads only that root package when Pi runs in this repository.

## Setup

The default checkout location is `~/git/pi-extensions`. Installation examples below use that path; adjust it if your checkout lives elsewhere.

Node.js 22.19 or newer is required. This repository targets Pi v1.6.0. Development dependencies pin that version for reproducible checks; older Pi versions are not maintained. Install the local package dependencies:

```bash
cd ~/git/pi-extensions
npm ci
```

Start Pi in this repository and trust the project when prompted. Pi loads the eleven local extensions.

### Codex Fast mode

`/fast` toggles Fast requests for the active session branch; `/fast on`, `/fast off`, and `/fast status` provide explicit controls. The default is off. Eligible `openai` and legacy `openai-codex` ChatGPT OAuth requests receive `service_tier: "priority"`; API-key and unrelated provider requests remain unchanged. **Fast requested** indicates intent, not confirmed server activation; **Fast paused** preserves the preference while another model/auth combination is selected. Fast mode can consume subscription limits or credits at a higher rate. See [`packages/pi-codex-fast/README.md`](packages/pi-codex-fast/README.md) for persistence, pricing cautions, and routing limits.

### Provider quota and balances

The footer indicators appear together whenever compatible credentials are available, regardless of the selected model. They refresh 30 seconds after completed requests, back off on failures, and honor `Retry-After`. Missing credentials hide an indicator; refresh failures mark cached values `(stale)`. Use `/usage-*-status` for safe polling diagnostics.

- [Codex](packages/pi-usage-codex/README.md): subscription quota via compatible Pi OAuth or read-only Codex CLI credentials. New `openai` OAuth tokens without a Codex account ID need the legacy `openai-codex` provider or CLI fallback. On a new machine, authenticate separately with `/login openai-codex` or Codex CLI; a working `/login openai` alone may not show quota. Use `/usage-codex-status` to diagnose a hidden indicator. API keys are never used, and CLI credentials are never refreshed or modified.
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

### Tool views

**Ctrl+O** in the main editor or `/tools` cycles completed built-in tool text through folded, expanded, and hidden modes. Folded cards retain Pi's shaded backgrounds; expanded views delegate to native renderers, including edit diffs and syntax highlighting. Running tools remain visible. No persistent footer indicator is added; selecting a mode shows two-second feedback only. The extension follows the effective `app.tools.expand` binding, replaces only its main-editor behavior, and leaves picker/tree shortcuts unchanged. This extension changes presentation only, not tool execution or model context. Remove `npm:pi-foldable-tools` before reloading to avoid competing overrides and `/tools` commands. See [`packages/pi-tool-views/README.md`](packages/pi-tool-views/README.md) for controls, migration, and the host-owned image limitation in hidden mode.

### Thinking views

**Ctrl+T** in the main editor cycles thinking through folded (`Thinking...`), expanded reasoning, and fully hidden, independently of Ctrl+O's tool views. Normal answers, tool output, and the working spinner remain visible. No persistent footer indicator is added; a successful cycle shows two-second feedback only. The extension follows the effective `app.thinking.toggle` key and delegates native visibility changes, preserving Pi's saved collapsed/visible preference. The extra hidden state resets to folded after reload; messages, signatures, model context, and reasoning budgets are unchanged. See [`packages/pi-thinking-views/README.md`](packages/pi-thinking-views/README.md) for editor compatibility and lifecycle details.

### Message timestamps

Completed user and assistant text shows its session-entry time below the body in a dim `YYYY-MM-DD HH:mm:ss` line, using the local time zone. Assistant timestamps stay hidden during streaming. Restored sessions use their saved entry times; no message content or additional session data is written. See [`packages/pi-message-timestamps/README.md`](packages/pi-message-timestamps/README.md) for live-rendering behavior and text-block limitations.

### Prompt stash

Press **Ctrl+Shift+S** to save and clear an unfinished editor prompt. `/stash` opens a searchable newest-first list with a multiline preview; Enter restores, `d` confirms deletion, and Escape closes it. A different nonempty editor draft is automatically stashed before restoration. `/stash clear` confirms bulk deletion; `/stash shortcut alt+s` changes the shortcut after `/reload`.

Prompts live in the agent directory's `prompt-stash.json`, survive sessions/restarts, and are never sent to a model by this extension. Storage is plain text, so do not stash secrets. See [`packages/pi-prompt-stash/README.md`](packages/pi-prompt-stash/README.md) for safety, terminal support, and recovery. Disable any other `/stash` extension before loading this one.

### Historical usage table

`/usage` opens the local usage dashboard with visible totals above an expandable provider/model table. Use Tab or Left/Right to change periods, Enter to expand a provider's models, `/` to search, `s` to sort, `p` to filter to the current project, and `r` to refresh. `d` reveals token-breakdown columns; `?` opens help and scan diagnostics. Totals follow the visible slice. `/usage all` starts with all recorded history.

Stash and Usage share a quieter header, clear row selection, responsive centered panels, and a pinned action bar. See [UI design notes](docs/ui-design.md) for layout conventions and wide/narrow preview snapshots.

The dashboard reads local session accounting without model calls or network requests. It includes recorded child/summary usage and reconciles Council/Aufheben parent rollups against child session records. Tokens include cache reads and writes; cost is recorded usage, not a subscription invoice. See [`packages/pi-usage/README.md`](packages/pi-usage/README.md) for data warnings and accounting limits. The old external dashboard and raw-paste package are no longer registered by this repository; remove separately installed personal copies if needed to avoid duplicate commands.

### Optional user-wide installation

To load the extensions independently outside this repository, install each package from its directory:

```bash
pi install ~/git/pi-extensions/packages/pi-aufheben
pi install ~/git/pi-extensions/packages/pi-council
pi install ~/git/pi-extensions/packages/pi-codex-fast
pi install ~/git/pi-extensions/packages/pi-tool-views
pi install ~/git/pi-extensions/packages/pi-thinking-views
pi install ~/git/pi-extensions/packages/pi-message-timestamps
pi install ~/git/pi-extensions/packages/pi-prompt-stash
pi install ~/git/pi-extensions/packages/pi-usage
pi install ~/git/pi-extensions/packages/pi-usage-codex
pi install ~/git/pi-extensions/packages/pi-usage-deepseek
pi install ~/git/pi-extensions/packages/pi-usage-zai
```

The local packages remain linked to this repository; run `/reload` after changing their code. `/council` reads `.pi/council.yaml` from the directory where Pi is running, so each project may keep a separate council configuration.

## Maintenance

Validate all personal packages after changing code or configuration examples:

```bash
npm run check
```

Checks cover TypeScript, prompt stash persistence/locking/restoration and picker behavior, provider parsing, polling/backoff/cancellation, Council preflight and concurrency, Aufheben rounds/intervention/recovery, real-SDK integration with fake providers, active-session cleanup, branch-aware restoration, message timestamps and independent tool/thinking views with real transcript rendering and composed editor controls, package-manifest consistency, and package contents. Cross-package integration tests live in `tests/`; each package keeps its own API/unit tests. GitHub Actions runs the suite on Node.js 22, 24, and 26 against the current Pi target and audits dependencies for high-severity advisories. When a new Pi release becomes the target, update the root and all package development dependencies, regenerate the lockfile, and run the full checks. A separate older-version compatibility matrix is not maintained. Example tests validate structural invariants rather than exact model IDs or reviewer counts.

Run `npm audit` from the repository root to check both runtime and development dependencies. The lockfile covers the development install, not the separately installed Pi CLI. Update the host through Pi's supported installer/update flow.

Usage requests are cancelled on session shutdown or reload. Codex also cancels obsolete requests when switching between regular and Spark quotas. No live credentials are needed for automated tests.

Pi extensions execute with full system access. Review local changes and installed package updates before loading them.

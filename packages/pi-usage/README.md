# pi-usage

A local, table-first usage dashboard for Pi. `/usage` reads saved session accounting, groups it by provider and model, and opens an interactive table. It makes no model calls, credential lookups, or network requests, and does not alter session files or add messages to model context.

This is an independently implemented package. The expandable provider/model Table view in [Thomas Mustier's usage extension](https://github.com/tmustier/pi-extensions) informed the interaction design; that package is not a dependency and its implementation is not vendored. Graphs, insights, and raw-paste functionality are intentionally not included.

## Installation

Requires Node.js 22.19+ and the current Pi target, 1.2.0. The root repository manifest loads this package automatically. For standalone use:

```bash
pi install ~/pi-extensions/packages/pi-usage
```

Run `/reload` after changing source. If the former third-party dashboard was installed separately in personal Pi settings, remove that installation before loading this package to avoid duplicate `/usage` commands. Removing a project declaration does not modify personal settings or delete npm caches.

## Commands and navigation

```text
/usage
/usage today
/usage week
/usage last-week
/usage 30d
/usage all
```

The default is Today, across all projects. Periods use the local timezone (`TZ` is respected): today starts at midnight, weeks start on Monday, last week excludes this Monday, and 30d includes today and the preceding 29 calendar days.

| Key | Action |
| --- | --- |
| Tab / Shift+Tab / Left / Right | Change period |
| Up / Down / PageUp / PageDown | Move through visible rows |
| Enter / Space | Expand or collapse a provider's models |
| `/` | Search provider and model names; Enter keeps the filter, Escape clears it |
| `x` | Hide the selected provider |
| `a` | Clear search and hidden providers |
| `s` | Sort by recorded cost, tokens, or calls |
| `p` | Toggle all projects / exact current working directory |
| `r` | Refresh from disk |
| `d` | Toggle summary / token-breakdown columns |
| `?` | Open keyboard help, accounting notes, and scan diagnostics; Up/Down/PageUp/PageDown scroll |
| `q` / Escape / Ctrl+C | Close and cancel any pending scan |

The screen uses the same visual language as Prompt Stash: a rounded floating frame in Pi's active border color, a quiet header, clear selection marker and background, minimal separators, and a pinned action bar. Below 24 columns or 10 rows, the frame is omitted to preserve space for content. Totals sit above the table. The default overview shows recorded cost, tokens, calls, and sessions; `d` reveals the input/output/cache breakdown when width permits. Columns adapt to terminal width with cost given priority. The centered overlay is capped at 132 columns and 30 rows, shrinking to fit smaller terminals.

Pi's configured selection/navigation keybindings are honored, and the primary action/close hints reflect remappings. Search uses Pi's input component and focus handling. Rows scroll within the available height; short terminals prioritize the selected row and exit hint. `?` opens scrollable help without changing filters or selection; `?` or Escape returns to the table, while `q` or Ctrl+C closes it. While searching, `?` is ordinary text.

The total always reflects the current period, project, search, and hidden-provider slice. Filtering a model also recomputes its provider subtotal from only matching models. Loading, empty results, data warnings, and refresh failures have distinct states. A failed refresh keeps the previous snapshot visible and marks it as stale; detailed cache/deduplication/reconciliation diagnostics live in help rather than crowding the default screen.

Non-TUI modes use a text-table notification rather than a custom screen. No assistant response or inference is triggered. Display-only state resets when the table closes. The screen is a snapshot: press `r` to see later activity.

## Columns and accounting

- **Sessions**: distinct session IDs represented by the counted records. Copied entries belong to their original session when available; fresh calls in the copy belong to the new session. Provider/model counts overlap and must not be added to get the global session total.
- **Calls**: finalized assistant messages with recorded usage, including failed attempts. Tool reports, cache warming, and summaries do not inflate this count.
- **Cost USD**: the recorded cost total, not a subscription invoice or quota estimate. A `>=` prefix means some records have unknown costs; known zero is different from missing cost. Zero rates supplied by providers can still understate actual billing.
- **Tokens**: recorded `totalTokens`, or input + output + cache read + cache write when it is absent. **Cache reads are included**, unlike the former dashboard's fresh-token metric.
- **Input / Output / Cache R / Cache W**: recorded counters. Reasoning is already part of output; long-TTL cache writes are already part of cache writes. Neither is added again.

All branches are included: abandoning a branch does not undo its cost. Copied entries are deduplicated by stable entry identity, timestamp, attribution, and accounting values, not timestamp/token count alone. Legacy records without entry IDs use a full-line hash. Content edits do not undo previously incurred usage. Standalone `usage` entries retain provider/model attribution; unattributed tool, compaction, and branch-summary usage appears under `Tools / summaries` rather than being assigned to the current main model.

### Council and Aufheben

`details.results[].sessionFile` and per-call `usage` link parent reports to saved child histories. Reconciliation happens **before** time/project filtering:

- Readable, sufficiently complete child records take precedence over the corresponding portion of the parent's rollup.
- Only the unrepresented remainder is counted under `Tools / summaries`, including when just some child files are missing.
- Repeated rounds use the per-call increments, never the child's entire lifetime total as a subtraction.
- Copies of a parent report are reconciled together, and copied child histories are deduplicated.
- If a referenced file is incomplete or cannot cover its reported increments, its partial rows are omitted in favor of parent report evidence. A data warning makes that fallback visible.

Provenance without per-child usage, unrecognized tool-specific formats, or modified/deleted files cannot always be reconciled. Tool usage without recognized provenance remains an unattributed reported amount and may overlap separately scanned sessions. Fallback amounts use the parent report's timestamp/project because the original attribution is unavailable. This is recorded accounting, not an exact bill or a guarantee of complete coverage.

## Data source, privacy, and limits

The scanner reads `.jsonl` files recursively under `getAgentDir()/sessions`, respecting `PI_CODING_AGENT_DIR`. It also includes the current session file when it resides outside that tree. It does not search arbitrary referenced child paths outside the scan, follow symlinked entries, read credentials, fetch prices, or automatically export anything. Other custom session roots are not included.

Reading is streamed and cancellable. Lines larger than 8 MiB are skipped with a data warning to bound allocation. Malformed lines, missing accounting, unreadable files/directories, files changing during a scan, and uncertain reconciliation produce warnings, not invented zero-cost completeness. Headerless files are ignored. Unreferenced partial files still contribute their valid accounting records; a referenced incomplete file uses the fallback rule above. Large histories may take time on their first open.

An in-memory metadata cache is keyed by file identity, size, modification time, and change time. It stores no prompts, responses, credentials, or raw JSON. Up to 256 files with fewer than 20,000 accounting records each, and at most 100,000 cached records in total, are cached; unchanged cached files avoid reparsing. The cache is cleared at session shutdown/reload. There is no persistent cache, background polling, or external dependency on another local package.

The existing Codex, DeepSeek, and Z.ai quota/balance footer extensions remain separate and unchanged. This package reports historical usage, not provider balances.

## Development

```bash
npm run check
```

Tests cover parsing, cache invalidation, cancellation, nested provenance, copied history, period boundaries, filtered totals, narrow/Unicode terminal rendering, keyboard interaction, and command lifecycle. Shared visual conventions and wide/narrow layout snapshots are covered by `tests/ui-design.test.ts` at the repository root; see [UI design notes](../../docs/ui-design.md). Fixtures are synthetic; no live provider calls are required.

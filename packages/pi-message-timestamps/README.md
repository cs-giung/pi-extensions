# Message timestamps

Display the session-entry time below completed user and assistant text in Pi 1.5.2. No commands, model calls, network access, or additional session records are needed.

```text
Your message

2026-06-10 14:05:09

Assistant answer

2026-06-10 14:05:18
```

Times use the machine's local time zone, a full date, and 24-hour time with seconds (`YYYY-MM-DD HH:mm:ss`). Metadata uses the active theme's `dim` color. Reopening a session in another time zone displays the same instant in that zone.

## Install

The repository's root package loads this extension automatically. Reload Pi after updating the checkout. For standalone user-wide installation:

```bash
pi install ~/git/pi-extensions/packages/pi-message-timestamps
```

Do not also load a second copy of the extension. Node.js 22.19+ and Pi 1.5.2 are required; older host versions are not maintained.

## Behavior

- Both roles use the outer session entry's ISO `timestamp`, **not** the nested message's numeric `timestamp` or a new clock reading.
- User text receives its time once the message is recorded. Assistant timestamps remain hidden during streaming and appear after the finalized message is recorded, including persisted partial/error/aborted text.
- Resumed history, reloads, forks, tree navigation, and compaction redraws use the metadata attached to each persisted component. Old sessions need no migration.
- Original messages, model context, usage accounting, and session files remain unchanged. Print, JSON, and RPC modes are unaffected. Thinking, tools, summaries, and custom messages are not decorated.
- This is a text-rendering hook, not a replacement message component: image-only and tool-only messages have no timestamp row. Pi renders separate assistant text blocks independently, so a multi-block message can display the same timestamp under each text block. User skill wrappers retain Pi's own rendering; only the ordinary user-text portion is decorated.
- An unfinished top-level fenced code block is closed in the display copy before adding the time. No closing fence is written to the original message.

## Implementation and compatibility

`registerMarkdownTransformer()` receives session metadata for restored components, but not live ones. In Pi 1.5.2, each newly created message component snapshots the registered transformers after the `message_start` handlers. This extension registers a per-message closure at that boundary and resolves its session entry by append position and role after `message_end`. It does not guess from text, so identical prompts/answers do not share timestamps, and finalized message-object replacements are supported.

A zero-height widget below the editor obtains the public TUI invalidation handle without replacing the footer or editor. A short, session-scoped timer waits for actual persistence, then invalidates cached Markdown once. This handles another extension delaying `message_end`, even if the user row was already rendered. The timer stops when persistence is found and is cancelled on shutdown/reload/session replacement. No background resources start during extension discovery.

The live association relies on Pi's component snapshot and message append ordering. Tests exercise those behaviors with the real SDK and transcript components. Recheck them when upgrading Pi. Extensions that directly insert extra user/assistant session records outside the normal message lifecycle, or replace message rendering, are not supported. Earlier Markdown transformers may change the body; timestamp metadata is added to their display result only.

## Verify

Run from the repository root:

```bash
npm run check
npm audit --audit-level=high
git diff --check
```

Tests cover persisted versus nested times, streaming, delayed persistence/cache invalidation, identical messages, finalized-object replacement, theme/width redraws, code fences, reload restoration, non-TUI modes, cleanup, and unchanged session/model content. No credentials or personal session files are used.

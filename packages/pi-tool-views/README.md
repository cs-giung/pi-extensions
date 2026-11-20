# Tool views

Fold, expand, or hide completed built-in tool text in Pi **without losing Pi's shaded tool backgrounds**. This is a presentation-only replacement for `pi-foldable-tools`, not a tool implementation override.

## Controls

| Control | Action |
| --- | --- |
| **Ctrl+O** | Cycle `folded → expanded → hidden → folded` in the main editor |
| `/tools` | Cycle the same modes |
| `/tools folded` | Compact completed cards; clear per-row expansion overrides |
| `/tools expanded` | Full native tool rendering |
| `/tools hidden` | Hide completed tool text, including errors |
| Clicking a completed tool | Use Pi's existing per-row expansion toggle inside folded mode |

There is no persistent footer indicator. After Ctrl+O or a valid `/tools` command, the footer briefly shows `tools: folded`, `tools: expanded`, or `tools: hidden` for two seconds. Further selections replace the text and restart the timeout; startup/reload stays quiet. Running tools remain visible in every mode. Ctrl+O replaces the main editor's original two-state tool expansion with the three-state cycle; it does not perform both actions. `/tools` is an equivalent keyboard-independent control. Alt+O is no longer registered.

The extension follows the effective `app.tools.expand` binding, so a user remapping replaces Ctrl+O here too. Tree navigation and dialogs keep their own bindings (for example, Ctrl+O still cycles `/tree` filters). No personal keybinding file is changed.

Default mode is `folded`. Set `PI_TOOL_VIEW_MODE=expanded` or `PI_TOOL_VIEW_MODE=hidden` before starting Pi to change it. Unknown values fall back to folded. Modes are instance-local and reset on reload/session replacement; no settings or session records are written.

## Appearance

- **Folded:** one compact call header and a result summary inside the native-style shaded shell. Summaries include failure/exit status, edit additions/removals, line/image counts, recorded duration, and truncation/saved-output markers where available. Long metadata is truncated to the available width.
- **Expanded:** delegate to Pi's own renderers, preserving syntax highlighting, edit previews/diffs, links, streaming previews, warnings, timing, and native self-shell layouts. Normal renderers receive Pi's `toolPendingBg`, `toolSuccessBg`, or `toolErrorBg` box with the configured `outputPad`.
- **Hidden:** completed text renders zero lines, not a blank colored box. **Images may remain visible:** Pi owns image rendering outside extension text renderers. Use Pi's image-display setting if you need images hidden too. This mode is a layout preference, not a privacy/redaction feature; output remains in model context, sessions, and exports.

Covered tool names: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. Custom/MCP tools, assistant text, user messages, and `!`/`!!` shell transcript components retain their existing rendering. Print, JSON, and RPC modes are unaffected.

## Install and migrate

The repository's root package loads this extension automatically in this project. For independent user-wide installation:

```bash
pi remove npm:pi-foldable-tools
pi install ~/git/pi-extensions/packages/pi-tool-views
```

Then run `/reload` (or restart Pi). Do not leave the old tool override loaded: otherwise its renderers, execution overrides, and `/tools` command remain in the chain. Also remove separately configured copies if you installed that package in more than one scope. Node.js 22.19+ and Pi 1.6.0 are required.

## Implementation boundary

`registerToolRenderer()` wraps the existing renderer resolver via `next()`. No tool is re-registered, reconstructed for another cwd, activated, or executed by this extension. Schemas, output schemas, hooks, remote/custom backends, prompt metadata, structured results, and tool permissions stay with their existing owners.

Pi requires `renderShell: "self"` to hide the entire text shell. The wrapper therefore restores the original themed box for default renderers in visible modes; native self-shell renderers are delegated without adding another box. The native call/result components share their original row state, but keep **separate native `lastComponent` slots**. Compact cards and wrapper containers are never handed back as native components. Native renderers still finalize in folded/hidden mode so their clocks and edit state can settle.

Row state lives in a `WeakMap` keyed by Pi's renderer-state object; there is no permanent map of old component invalidators. A zero-height widget below the editor provides the public TUI invalidation handle. Switching modes invalidates current UI components without replacing the footer or adding layout spacing. Temporary footer feedback uses one unreferenced timeout, cancelled on shutdown.

Pi reserves `app.tools.expand`, so a plain `registerShortcut("ctrl+o")` would be skipped. At startup this extension composes the existing editor factory (or a standard `CustomEditor`) and intercepts that action's effective binding in its `handleInput()`. All other input goes to the original editor handler. This is not a global terminal-input listener: pickers and overlays retain their own shortcuts. Shutdown restores the original input handler and prior factory if this extension still owns it, without removing editors installed later by another extension. No extension-owned timers, subprocesses, network calls, or background discovery resources are created.

## Verification

Run from the repository root:

```bash
npm run check
npm audit --audit-level=high
git diff --check
```

Tests compare full rendering against Pi's real `ToolExecutionComponent` for all eight built-ins, including backgrounds and edit diffs. They cover streaming/finalization, hidden zero-line output, the real editor's Ctrl+O cycle without double dispatch, remapped bindings, editor composition/cleanup, partial-to-error component transitions, theme changes, narrow widths, Unicode/control-safe compact headers, lifecycle isolation, and non-TUI guards. Real-SDK tests preserve an existing tool backend and metadata, execute a synthetic read once, and toggle/restore its view without additional inference or session-file changes. No personal credentials/history are used.

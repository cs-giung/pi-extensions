# pi-prompt-stash

Keep an unfinished prompt out of the way while responding to an interruption, then restore it later. This is an independently implemented personal package inspired by [Utpal Singh's pi-prompt-stash](https://github.com/utpalsinghdev/pi-extensions/tree/main/packages/pi-prompt-stash), not a dependency on or a vendored copy of that package.

## Use

| Action | Effect |
| --- | --- |
| **Ctrl+Shift+S** | Save the current editor text, then clear the editor. Works while Pi is responding. |
| `/stash save` | Same operation, without needing a terminal-supported shortcut. |
| `/stash` | Open a searchable, newest-first picker with multiline preview. |
| `/stash clear` | Confirm deletion of all prompts shown at confirmation time. |
| `/stash shortcut` | Ask for a new shortcut name, e.g. `alt+s`. |
| `/stash shortcut alt+s` | Save the shortcut directly. Run `/reload` to apply it. |

In the picker:

- **Up/Down** selects; **PageUp/PageDown** jumps through the list.
- **Enter** restores the selected prompt without removing it from storage or sending it to the model.
- **d** asks for confirmation before deleting the selected prompt.
- **/** edits a full-text search (or search for `#12`). Enter returns to navigation; Escape clears search and returns to navigation. While searching, `d` is just text.
- **Left/Right** scrolls the preview by one line.
- **?** opens scrollable keyboard help and safety notes. Up/Down/PageUp/PageDown scroll; **?** or Escape returns to the list without changing the selection. While searching, `?` is ordinary text.
- **Escape/Ctrl+C** closes the picker (Escape returns from search/help first). Pi's configured selection/navigation actions are honored; primary action and close hints reflect remappings.

A count widget appears above the editor while prompts are saved. The centered picker shares Usage's rounded outer frame, quiet header, highlighted selection, minimal separators, and pinned action bar. The frame uses Pi's active border color and is omitted below 24 columns or 10 rows to keep content usable. Its size is capped at 110 columns and 24 rows, shrinking to fit the terminal. List titles use the first nonempty line; the preview keeps the complete text and shows the date, original line count, and scroll position. Wide terminals show list and preview side by side; narrow terminals stack them. Very short terminals prioritize the selected prompt and exit hint over the preview. Raw terminal controls and bidirectional formatting controls are replaced for display only.

### Safety differences from the inspiration

**Restoring preserves a nonempty, different editor draft as another stash before replacing it.** If that commit fails, the editor is left untouched. Restored prompts stay saved for reuse. Whitespace-only displaced input is not saved.

Deletion and clear require confirmation. Clear never resets IDs, and prompts added by another cooperating Pi process during the confirmation remain saved. Every mutation reads the latest file under an exclusive lock and replaces it atomically. A failed save never clears the editor.

Only editor **text** is supported, not image/file attachments or queued steering/follow-up messages. This package does not call models, send messages, install tools, or perform network requests. Commands require interactive TUI mode; RPC/print/JSON modes do not mutate storage.

## Installation

The repository root already registers this extension. In this repository, run `/reload` after adding or changing it.

For user-wide loading outside this repository:

```bash
pi install ~/git/pi-extensions/packages/pi-prompt-stash
```

Or try it once:

```bash
pi -e ./packages/pi-prompt-stash/src/index.ts
```

Disable any other extension that registers `/stash` or the same shortcut first. Do not run the upstream package against the same storage concurrently: it does not participate in this package's locking protocol.

Ctrl+Shift+S requires a terminal that distinguishes it from Ctrl+S. If it does not work, use `/stash shortcut alt+s`, then `/reload`. Shortcut names accept Pi's modifiers and special/function keys, but reject unmodified typing/navigation keys and Pi keybinding conflicts (conservatively including modal actions). Other extensions' shortcut conflicts are reported by Pi. Changing the setting does **not** automatically reload or interrupt an active response.

## Storage and recovery

Storage is `~/.pi/agent/prompt-stash.json`, or `prompt-stash.json` under `PI_CODING_AGENT_DIR`. It is global to that agent directory, not tied to a project, session, or tree branch. It survives `/reload`, `/new`, session switches, and restarts. The count refreshes on session start and stash operations, not continuously across processes.

The upstream `{ stashes: [{ id, text, timestamp }], nextId, shortcut? }` JSON format is readable without migration. Existing files without a shortcut use Ctrl+Shift+S. Invalid JSON, IDs, timestamps, or shortcut settings are reported rather than silently repaired or overwritten. Back up and repair an invalid file, then retry. No personal data is stored in this repository.

Files are written as plain text with mode `0600` on POSIX systems. Do not stash secrets; this is not encrypted storage. The atomic rename prevents partially written JSON from replacing the previous file, but is not a power-loss durability guarantee. Manual edits and noncooperating writers are not protected by the lock.

A busy lock (`prompt-stash.json.lock`) fails the operation immediately so the editor stays intact; retry. If a process crashed and left a lock, **close all Pi processes using that agent directory before removing only the lock file**. The package never guesses whether another writer is stale. Temporary `.tmp` files after a crash can be removed at the same time; do not remove the actual JSON file without a backup.

## Verification

From the repository root:

```bash
npm run check
```

Package-only checks:

```bash
cd packages/pi-prompt-stash
npm run check
```

Manual smoke test, isolated from personal prompts (run from the repository root):

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" pi --no-extensions -e ./packages/pi-prompt-stash/src/index.ts
```

1. Write a multiline Korean/Unicode prompt, stash it, and check the editor clears only after saving.
2. Write a different draft, open `/stash`, restore the first prompt, and check the second draft is now saved too.
3. Search, scroll a long preview, resize to a narrow terminal, cancel deletion, then confirm deletion.
4. Run `/reload` and `/new`; verify saved prompts remain. Change the shortcut, reload, and test the new binding.
5. Cancel `/stash clear`, verify nothing changed, then confirm it and check the widget disappears.

Automated tests cover persistence and upstream format reads, invalid-file refusal, rename failures, cooperating writers and locks, lossless restoration, destructive confirmations, shortcut validation, mode guards, shutdown cancellation, Unicode width, narrow layouts, preview scrolling, search, and picker actions. Interactive rendering/terminal shortcut behavior should also be smoke-tested in a real terminal. Wide/narrow layout snapshots and the shared presentation rules are tested in the repository root's `tests/ui-design.test.ts`; see [UI design notes](../../docs/ui-design.md).

## License

MIT. See [LICENSE](LICENSE).

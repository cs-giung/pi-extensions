# Terminal UI conventions

Stash and Usage are the first two screens using these conventions. They use Pi's active theme, not a new fixed palette, and remain independently installable. This pass changes presentation and display-only controls, not prompt persistence, usage accounting, or provider footers.

## Visual hierarchy

1. **Title:** short, accent-colored and bold. Secondary context sits at the right when it fits.
2. **Controls and summary:** search/scope are muted; Usage's visible total is emphasized above the table. Active period has a selected background and brackets, so it is identifiable without color.
3. **Content:** selected rows have a full-width theme selection background and a text marker. Stash uses one-line titles and a dedicated preview; Usage uses expandable provider/model rows and right-aligned numbers.
4. **Status:** scan warnings and refresh failures are distinct from neutral file counts. Stash's draft-preservation assurance stays brief. No long diagnostic paragraphs on the default screen.
5. **Action bar:** primary action, search, help, and close remain at the bottom. Additional shortcuts and explanatory notes live in scrollable `?` help.

Use `accent` for primary identity/actions, `selectedBg` for selection, `muted` for secondary text, `dim` for metadata, `borderMuted` for restrained separators, and `warning` / `error` for data quality or failures. Do not encode meaning in color alone or hard-code RGB values. Compute styled strings during rendering so theme invalidation does not leave cached old colors.

## Layout and responsiveness

- Rounded floating frame: `╭─╮`, `│ │`, `╰─╯` in Pi's `borderMuted` color, with one-cell inner padding. The frame encloses the whole screen, including header and action bar, without shadows or a separate color palette.
- Reserve the frame, header, and action bar **before** allocating body rows. The border counts toward both size caps; never add it after layout and truncate away the footer or bottom corners.
- Below 24 columns or 10 rows, fall back to the borderless compact layout so decoration does not displace the selected row or exit hint. That layout uses two columns of padding on wide screens, one on smaller screens, and none when extremely narrow.
- The panels are centered overlays with one-cell terminal margins. Stash caps at 110 columns / 24 rows; Usage at 132 columns / 30 rows. Actual available space can be smaller.
- Stash shows two panes when the body is at least 78 columns and six rows. Otherwise it stacks the panes, or uses a compact list without preview on very short terminals.
- Usage starts with cost, tokens, calls, and sessions. `d` reveals input/output/cache columns when they fit. Cost is the last metric hidden as the table narrows; the total stays above the table.
- Use Pi's visible-width, truncation, and wrapping helpers for Korean text, emoji, combining marks, and ANSI styling. Sanitize untrusted controls for display without changing stored text.
- Search keeps Pi's input component and propagates focus/IME cursor positioning. On short terminals, the active search input takes precedence over secondary header metadata.

## Interaction

Common behavior:

| Key | Behavior |
| --- | --- |
| Up / Down / PageUp / PageDown | Navigate the list/table; scroll while help is open |
| Enter | Perform the primary action (restore or expand) |
| `/` | Edit search; Enter applies it, Escape clears it and returns to navigation |
| `?` | Toggle help without changing selection/filter state; ordinary text during search |
| Escape | Return from help/search before closing the screen |
| Ctrl+C | Always close and release owned resources |

Primary action and cancel hints read Pi's effective selection bindings when available. Keep a keyboard path for all actions. Domain-specific keys remain distinct: Left/Right scrolls Stash's preview but changes Usage's period; `d` deletes with confirmation in Stash but changes column density in Usage. Full help explains these differences.

## Implementation boundary

Each package owns a small `src/ui.ts` with the same heading, selection, panel, key-label, and help-page helpers. The files are deliberately mirrored and checked together. Neither package imports a sibling at runtime or needs an additional shared package to install. Extract a dedicated UI dependency only if more screens adopt a stable, sufficiently large API.

## Verification and previews

Run the full suite with `npm run check`. `tests/ui-design.test.ts` checks mirrored helpers, rounded corners and aligned edges, frame-aware size budgets, theme changes, remapped key labels, reserved footer space, and wide/narrow layout snapshots. Its [snapshot file](../tests/__snapshots__/ui-design.test.ts.snap) is a deterministic text preview of both screens. Review these snapshots deliberately when changing layout; do not update them blindly.

Package-level tests exercise help navigation, details toggles, filtered totals, preserved selection, terminal controls, resize, focus/IME markers, loading/empty/error/warning states, and stale refreshes. They also cover one-line and zero-column edge cases; meaningful presentation still requires a practical terminal size.

For a real-terminal check without personal prompts/history, use a temporary `PI_CODING_AGENT_DIR` and load only these extensions:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" pi --no-extensions \
  -e ./packages/pi-prompt-stash/src/index.ts \
  -e ./packages/pi-usage/src/index.ts
```

Use synthetic prompts/history. Check regular and fullscreen modes, light and dark themes, long names, Korean/emoji text, active search, help, details, and live resize. Automated snapshots cannot establish visual contrast or terminal-protocol shortcut support.

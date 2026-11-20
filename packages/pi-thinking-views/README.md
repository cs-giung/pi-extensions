# Thinking views

Extend Pi's **Ctrl+T** thinking-display control from two states to three, independently of tool views:

```text
folded -> expanded -> hidden -> folded
```

| Mode | Thinking display |
| --- | --- |
| `folded` | Pi's normal `Thinking...` label |
| `expanded` | Native reasoning text |
| `hidden` | Neither reasoning text nor its folded label; no extra spacer |

There is no persistent footer indicator. After a successful Ctrl+T cycle, the footer briefly shows `thinking: folded`, `thinking: expanded`, or `thinking: hidden` for two seconds. Further cycles replace the text and restart the timeout; startup/reload stays quiet. The active working spinner, normal assistant text, tool output, and error/abort/truncation notices remain unchanged. This affects both existing messages and new/streaming replies. Empty or provider-redacted reasoning remains subject to Pi's normal display rules.

## Install

The repository's root package loads this extension automatically. For independent user-wide installation:

```bash
pi install ~/git/pi-extensions/packages/pi-thinking-views
```

Run `/reload` afterward. Requires Node.js 22.19+ and Pi 1.6.0. No configuration file, extra command, network access, or model call is needed.

## Keys and preferences

The main editor follows Pi's effective `app.thinking.toggle` binding (Ctrl+T by default). Remapping or disabling that action in Pi's keybindings also remaps/disables this cycle. There is no global input listener: trees, dialogs, and other focused components retain their own shortcuts. Other editor input is forwarded unchanged.

The starting mode inherits Pi's saved `hideThinkingBlock` preference: collapsed starts folded, visible starts expanded. Cycling from folded to expanded, or expanded to hidden, invokes the **existing native toggle** through the original editor input handler. Pi therefore updates both rendered messages and the default for future messages. Hidden to folded only restores the label; it does not toggle reasoning open accidentally.

Pi continues saving its ordinary collapsed/visible preference, just as it does with native Ctrl+T. The new hidden state is session-runtime-only and is not saved as an additional preference: after reload or session replacement, a previously hidden view returns to folded. The extension does not modify session messages, reasoning signatures, model context, provider thinking level, or thinking budget. Hiding reasoning does not prevent its generation or reduce its token usage, and is not a privacy/redaction feature.

Use this alongside [`pi-tool-views`](../pi-tool-views/README.md) for independent controls:

- **Ctrl+O:** tool cards, full tool output, or hidden tool text.
- **Ctrl+T:** thinking label, full reasoning, or hidden reasoning.

## Implementation boundary

The extension composes the current main-editor factory, or creates a standard `CustomEditor`, and intercepts only `app.thinking.toggle`. It forwards the actual key event when a native visibility change is needed, then uses `ctx.ui.setHiddenThinkingLabel("")` for the additional hidden state. Resetting the label with no argument restores Pi's native default. No private action-handler maps, transcript traversal, message rewriting, prototype patches, or rendering replacements are used. A single unreferenced timeout clears the temporary footer feedback; it does not control reasoning visibility.

The native setting is checked at each key press so visibility changes made through Pi's settings are respected on the next cycle. The footer is updated when the extension cycles. A custom editor that swallows the native thinking action cannot support the cycle; the extension reports a warning instead of claiming visibility changed. Another extension that takes over the editor without composing the prior factory, or independently owns the hidden-thinking label, may conflict.

Shutdown restores the owned input handler and the prior factory only if this extension still owns the factory; it does not remove editors installed later. An owned label is reset, the feedback timeout is cancelled, and any temporary footer status is removed. Print, JSON, and RPC modes do not install handlers or change UI/settings. Editor composition with tool views is tested in both load orders, including shutdown/reload.

## Verify

Run from the repository root:

```bash
npm run check
npm audit --audit-level=high
git diff --check
```

Package tests cover transitions, native-toggle counts, saved initial preferences, remapped/disabled keys, input delegation, blocked custom editors, lifecycle cleanup, non-TUI guards, and native reasoning-only/multi-run/error rendering. `tests/thinking-tool-views.test.ts` uses the real SDK, editor, and assistant/tool components to test both extension load orders, streamed/future replies, unchanged reasoning signatures/context/session files, independent key cycles, and spinner preservation. All test data is synthetic.

# pi-reviewer-chair

A minimal Reviewer–Chair extension for Pi. `/council <prompt>` sends the same prompt to independent Reviewer sessions in parallel, then asks a Chair to synthesize only the successful anonymous responses for correctness, evidence, and completeness. The council tolerates individual Reviewer failures and does not start the Chair when fewer than `minSuccess` Reviewers succeed.

## Setup

Node.js 22.19 or newer and Pi are required. From the `pi-extensions` repository root, install dependencies and copy one example:

```bash
npm install
cp packages/pi-reviewer-chair/.pi/reviewer-chair.example.yaml .pi/reviewer-chair.yaml
```

Use `reviewer-chair.same-focus.example.yaml` instead when every Reviewer should independently check the same correctness criteria. Edit the copied configuration with `provider/model-id` values and additional prompts appropriate for the environment.

The repository's `.pi/settings.json` loads this package automatically after the project is trusted. For user-wide access from other directories, run `pi install ~/pi-extensions`. Model authentication comes from the existing Pi configuration.

## Configuration

`.pi/reviewer-chair.yaml` supports:

- `reviewers`: One or more Reviewers. Each entry may set `model`, `thinking`, `systemPrompt`, and `tools`.
- `chair`: The Chair's `model`, `thinking`, `systemPrompt`, and `tools` settings.
- `minSuccess`: Minimum number of successful Reviewer responses required to run the Chair.
- `idleTimeoutMs`: Maximum inactivity after the last Reviewer or Chair event, in milliseconds. The default is `120000`. Model, message, tool, retry, and other session events reset this timer.
- `maxDurationMs`: Absolute limit for one Reviewer or Chair run regardless of activity, in milliseconds. The default is `900000`.

`model` uses the `provider/model-id` format. Reviewers receive `read`, `grep`, `find`, and `ls` by default. The Chair receives no tools by default. Update the example model IDs for the installed Pi model catalog and authentication environment.

Both example presets use Reviewer 1 `openai-codex/gpt-5.6-luna`, Reviewer 2 `google/gemini-3.5-flash`, Reviewer 3 `opencode/deepseek-v4-flash-free`, and Chair `openai-codex/gpt-5.6-sol`.

The fixed Reviewer instructions require every concern to use a `- [CRITICAL|HIGH|MEDIUM|LOW]` item with evidence, impact, and a fix. The Chair merges semantically equivalent concerns, labels each as `COMMON` or `EXCLUSIVE`, reports each anonymous Reviewer's severity, assigns a synthesized Chair severity and fix, and ends with the final answer. A YAML `systemPrompt` appends extra instructions; it does not replace this fixed contract.

## Use

Start Pi, then run:

```text
/council <question or task to review>
```

Only the Chair's final answer is added to the main conversation. Supporting commands:

```text
/council-reviews   Show anonymous Reviewer responses from the latest run
/council-copy      Copy the latest successful Chair answer to the clipboard
```

Pi's built-in `/copy` targets normal Assistant messages. Chair answers are extension messages, so use `/council-copy` for them.

The command chooses the clipboard transport automatically: `pbcopy` on local macOS, `clip` on native Windows, `clip.exe` in local WSL, `tmux load-buffer -w` inside tmux, OSC 52 over SSH or Mosh, and Pi's clipboard utility elsewhere. Its notification names the selected transport.

Terminal clipboard transports can be blocked by terminal policy even after the sequence is sent. For kitty, allow `write-clipboard` in [`clipboard_control`](https://sw.kovidgoyal.net/kitty/conf/#opt-kitty.clipboard_control). For tmux, enable `set-clipboard` as documented in the [`tmux(1)` manual](https://man.openbsd.org/tmux.1#set-clipboard).

While the council runs, the footer reports each Reviewer's `waiting`, `starting`, `thinking`, `answering`, `tool <name>`, `done`, or `failed` state and the overall completion count. It uses the configured `name` when present and otherwise displays `Reviewer N`. Start, failure, and Chair transitions also use `ctx.ui.notify()`.

Reloading Pi, switching sessions, or quitting cancels active Reviewer and Chair sessions before the old extension instance is discarded.

Every Reviewer and Chair run is saved as a named Pi session. When the main session has a file, these additional sessions record it as their parent. This lets `/usage` account for every council model. The files contain the original prompt and raw model responses.

The extension keeps the latest Reviewer report in memory for `/council-reviews`. That command adds anonymized copies to the main conversation only when requested; the copies are unverified reference material and do not trigger another main-agent response.

## Development

Run the repository-wide checks from the `pi-extensions` root:

```bash
npm run check
```

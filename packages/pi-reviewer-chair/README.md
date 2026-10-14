# pi-reviewer-chair

A minimal Reviewer–Chair extension for Pi. `/council <prompt>` sends the same prompt to independent Reviewer sessions in parallel, then asks a Chair to synthesize only the successful anonymous responses for correctness, evidence, and completeness. The council tolerates individual Reviewer failures and does not start the Chair when fewer than `minSuccess` Reviewers succeed.

## Setup

Node.js 22.19 or newer and Pi are required. From the `pi-extensions` repository root, install dependencies and copy the example:

```bash
npm install
cp packages/pi-reviewer-chair/.pi/reviewer-chair.example.yaml .pi/reviewer-chair.yaml
```

The example uses independent Reviewers with identical correctness criteria. Their number and model choices can change without changing the example tests. Customize their prompts if you prefer different review focuses. Edit the copied configuration with `provider/model-id` values and additional prompts appropriate for the environment.

The repository's `.pi/settings.json` loads this package automatically after the project is trusted. For user-wide access from other directories, run `pi install ~/pi-extensions`. Model authentication comes from the existing Pi configuration.

## Configuration

`.pi/reviewer-chair.yaml` supports:

- `reviewers`: One or more Reviewers. Each entry may set `model`, `thinking`, `systemPrompt`, and `tools`.
- `chair`: The Chair's `model`, `thinking`, `systemPrompt`, and `tools` settings.
- `minSuccess`: Minimum number of successful Reviewer responses required to run the Chair.
- `maxConcurrency`: Maximum number of active Reviewer sessions. The default is `4`. Queued Reviewers start when a slot becomes available; the Chair starts only after all Reviewers settle.
- `idleTimeoutMs`: Maximum inactivity after the last Reviewer or Chair event during its prompt, in milliseconds. The default is `120000`. Model, message, tool, retry, and other session events reset this timer.
- `maxDurationMs`: Absolute limit for each Reviewer or Chair prompt regardless of activity, in milliseconds. The default is `900000`. Queueing and session setup are excluded. This is not a deadline for the entire Council.

`model` uses the `provider/model-id` format. Reviewers receive `read`, `grep`, `find`, and `ls` by default. The Chair receives no tools by default. Nested sessions disable extensions, so `tools` accepts only built-ins: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. Unknown and duplicate tool names are rejected. Only enable file-mutating tools when intended, especially with parallel Reviewers.

Update the example model IDs for the installed Pi model catalog and authentication environment. The YAML file is the source of truth for the current model roster. The extension uses a fresh SDK model runtime and does not load extension-provided models or tools in child sessions.

The fixed Reviewer instructions require every concern to use a `- [CRITICAL|HIGH|MEDIUM|LOW]` item with evidence, impact, and a fix. The Chair merges semantically equivalent concerns, labels each as `COMMON` or `EXCLUSIVE`, reports each anonymous Reviewer's severity, assigns a synthesized Chair severity and fix, and ends with the final answer. A YAML `systemPrompt` appends extra instructions; it does not replace this fixed contract.

## Use

Start Pi, then run:

```text
/council <question or task to review>
```

Only the Chair's final answer is added to the main conversation. Supporting commands:

```text
/council-check     Validate configuration and model availability without inference
/council-cancel    Cancel active agents and prevent queued Reviewers from starting
/council-reviews   Show anonymous Reviewer responses from the latest run on this branch
/council-copy      Copy the latest successful Chair answer to the clipboard
```

`/council` and `/council-check` only read project configuration in a trusted project. Before any inference, all configured models, including the Chair, must exist and be available in the SDK runtime's authentication snapshot. Invalid configuration fails fast instead of spending tokens on Reviewers first. Runtime provider failures still count toward `minSuccess`. These checks do not verify live provider health or guarantee quota; credential resolution may refresh authentication, but neither check starts model inference. Timeout values must not exceed `2147483647` milliseconds (Node's timer limit).

`/council-cancel` requests cancellation and keeps the run locked until active child sessions finish cleanup. A cancelled run does not publish a late Chair answer or start queued Reviewers.

`/council-copy` searches the active branch, so it does not copy an answer from an abandoned `/tree` branch. Pi's built-in `/copy` targets normal Assistant messages. Chair answers are extension messages, so use `/council-copy` for them.

The command chooses the clipboard transport automatically: `pbcopy` on local macOS, `clip` on native Windows, `clip.exe` in local WSL, `tmux load-buffer -w` inside tmux, OSC 52 over SSH or Mosh, and Pi's clipboard utility elsewhere. Its notification names the selected transport.

Terminal clipboard transports can be blocked by terminal policy even after the sequence is sent. For kitty, allow `write-clipboard` in [`clipboard_control`](https://sw.kovidgoyal.net/kitty/conf/#opt-kitty.clipboard_control). For tmux, enable `set-clipboard` as documented in the [`tmux(1)` manual](https://man.openbsd.org/tmux.1#set-clipboard).

While the council runs, the footer reports each Reviewer's `waiting`, `starting`, `thinking`, `answering`, `tool <name>`, `done`, or `failed` state and the overall completion count. It uses the configured `name` when present and otherwise displays `Reviewer N`. Start, failure, and Chair transitions also use `ctx.ui.notify()`.

Reloading Pi, switching sessions, or quitting cancels active Reviewer and Chair sessions before the old extension instance is discarded.

Every Reviewer and Chair run is saved as a named Pi session. When the main session has a file, these additional sessions record it as their parent. This lets `/usage` account for every council model. The files contain the original prompt and raw model responses.

The extension persists each completed Reviewer report in a versioned custom entry in the main session, including reports below `minSuccess`. These entries contain the original prompt and raw responses, but do not participate in model context. `/council-reviews` restores the latest report from the active branch after reload or resume; reports from abandoned branches are excluded. That command adds anonymized copies to model context only when requested; the copies are unverified reference material and do not trigger another main-agent response. Cancelling before the Reviewer phase completes does not replace the previous report.

## Development

Run the repository-wide checks from the `pi-extensions` root:

```bash
npm run check
```

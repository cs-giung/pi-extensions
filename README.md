# Pi extensions

This repository contains four personal Pi packages and project configuration for two third-party packages. It keeps local extension code, package choices, examples, and verification commands together.

## Included packages

| Source | Commands | Purpose |
| --- | --- | --- |
| `packages/pi-reviewer-chair` | `/council`, `/council-reviews`, `/council-copy` | Run independent Reviewers, synthesize a Chair answer, and copy the latest result. |
| `packages/pi-usage-codex` | — | Show Codex subscription quota windows (Spark when selected), on any provider. |
| `packages/pi-usage-deepseek` | — | Show the current DeepSeek account balance. |
| `packages/pi-usage-zai` | — | Show the available Z.ai pay-as-you-go USD balance. |
| `npm:@tmustier/pi-usage-extension` | `/usage` | Display the interactive historical usage dashboard. |
| `npm:@tmustier/pi-raw-paste` | `/paste` | Arm a one-shot raw paste so large clipboard contents remain fully visible and editable instead of being condensed into paste markers. |

## Repository layout

```text
.pi/settings.json                    Project-local Pi package list
packages/pi-reviewer-chair/          Personal Reviewer–Chair package
packages/pi-usage-codex/             Personal Codex quota status package
packages/pi-usage-deepseek/          Personal DeepSeek balance status package
packages/pi-usage-zai/               Personal Z.ai cash balance status package
packages/pi-reviewer-chair/.pi/      Example Reviewer–Chair configurations
package.json                         Root Pi package and development commands
```

The root Pi manifest loads all four local packages. `.pi/settings.json` loads that root package and both npm packages when Pi runs in this repository.

## Setup

Node.js 22.19 or newer is required. These extensions are developed and tested against Pi v1.0.3. Install the local package dependencies:

```bash
npm install
```

Start Pi in this repository and trust the project when prompted. Pi then installs the missing project npm packages and loads all six extensions.

The Codex, DeepSeek, and Z.ai footer indicators appear together whenever their Pi credentials are configured, regardless of the selected model. They refresh every 30 seconds. Codex supports both legacy `openai-codex` credentials and ChatGPT sign-in through `/login openai`; OpenAI API keys are not subscription credentials. Missing credentials hide the corresponding indicator; transient failures mark cached values `(stale)`. Z.ai displays the available pay-as-you-go monetary balance, not Coding Plan quota. Configure `ZAI_API_KEY` or authenticate the `zai` provider through Pi.

Before running `/council`, create a project configuration from the example:

```bash
cp packages/pi-reviewer-chair/.pi/reviewer-chair.example.yaml .pi/reviewer-chair.yaml
```

The example uses four independent Reviewers with the same correctness criteria. Customize their prompts for different review focuses if desired, and edit the copied file with model IDs available in the current Pi installation. The local configuration is ignored by Git.

Each Reviewer and Chair run is stored as a named Pi session, allowing `/usage` to include every configured model. Use `/council-copy` to copy the latest successful Chair answer from the current main session.

Run `/paste` immediately before a normal terminal paste to keep the next clipboard payload as raw, editable text. The command is one-shot and has no default keybinding. Terminal.app and Warp intercept `Cmd+V` and `Cmd+Shift+V`, so in those terminals the command must be used before pasting.

### Optional user-wide installation

To load the extensions independently outside this repository, install each package from its directory:

```bash
pi install ~/pi-extensions/packages/pi-reviewer-chair
pi install ~/pi-extensions/packages/pi-usage-codex
pi install ~/pi-extensions/packages/pi-usage-deepseek
pi install ~/pi-extensions/packages/pi-usage-zai
pi install npm:@tmustier/pi-usage-extension
pi install npm:@tmustier/pi-raw-paste
```

The local packages remain linked to this repository; run `/reload` after changing their code. `/council` reads `.pi/reviewer-chair.yaml` from the directory where Pi is running, so each project may keep a separate council configuration.

## Maintenance

Update third-party packages with Pi's package manager rather than editing its npm cache:

```bash
pi update --extensions
```

Validate all personal packages after changing code or configuration examples:

```bash
npm run check
```

Checks cover TypeScript, provider parsing, polling/cancellation, package-manifest consistency, and package contents. Cross-package integration tests live in `tests/`; each package keeps its own API/unit tests. GitHub Actions runs the suite on Node.js 22 and 24. Keep root and package development dependencies aligned when updating Pi.

Usage requests are cancelled on session shutdown or reload. Codex also cancels obsolete requests when switching between regular and Spark quotas. No live credentials are needed for automated tests.

## Third-party packages

`@tmustier/pi-usage-extension` and `@tmustier/pi-raw-paste` are MIT-licensed packages maintained by Thomas Mustier. They are installed from npm and are not vendored in this repository. Pi extensions execute with full system access; review package updates before loading them.

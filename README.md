# Pi extensions

This repository contains one personal Pi package and the project configuration for two third-party packages. It keeps the local extension code, package choices, examples, and verification commands together without copying third-party source code.

## Included packages

| Source | Commands | Purpose |
| --- | --- | --- |
| `packages/pi-reviewer-chair` | `/council`, `/council-reviews`, `/council-copy` | Run independent Reviewers, synthesize a Chair answer, and copy the latest result. |
| `npm:@tmustier/pi-usage-extension` | `/usage` | Display the interactive historical usage dashboard. |
| `npm:@tmustier/pi-raw-paste` | `/paste` | Arm a one-shot raw paste so large clipboard contents remain fully visible and editable instead of being condensed into paste markers. |

## Repository layout

```text
.pi/settings.json                    Project-local Pi package list
packages/pi-reviewer-chair/          Personal Reviewer–Chair package
packages/pi-reviewer-chair/.pi/      Example Reviewer–Chair configurations
package.json                         Root Pi package and development commands
```

The root Pi manifest loads `packages/pi-reviewer-chair/src/index.ts`. `.pi/settings.json` loads that root package and both npm packages when Pi runs in this repository.

## Setup

Node.js 22.19 or newer and Pi are required. Install the local package dependencies:

```bash
npm install
```

Start Pi in this repository and trust the project when prompted. Pi then installs the missing project npm packages and loads all three extensions.

Before running `/council`, create a project configuration from one of the examples:

```bash
cp packages/pi-reviewer-chair/.pi/reviewer-chair.example.yaml .pi/reviewer-chair.yaml
```

Use `reviewer-chair.same-focus.example.yaml` instead when every Reviewer should independently check the same correctness criteria. Edit the copied file with model IDs available in the current Pi installation. The local configuration is ignored by Git.

Each Reviewer and Chair run is stored as a named Pi session, allowing `/usage` to include every configured model. Use `/council-copy` to copy the latest successful Chair answer from the current main session.

Run `/paste` immediately before a normal terminal paste to keep the next clipboard payload as raw, editable text. The command is one-shot and has no default keybinding. Terminal.app and Warp intercept `Cmd+V` and `Cmd+Shift+V`, so in those terminals the command must be used before pasting.

### Optional user-wide installation

To load these extensions from directories outside this repository, install each package in the user scope:

```bash
pi install ~/pi-extensions
pi install npm:@tmustier/pi-usage-extension
pi install npm:@tmustier/pi-raw-paste
```

The local package remains linked to this repository; run `/reload` after changing its code. `/council` reads `.pi/reviewer-chair.yaml` from the directory where Pi is running, so each project may keep a separate council configuration.

## Maintenance

Update third-party packages with Pi's package manager rather than editing its npm cache:

```bash
pi update --extensions
```

Validate the personal package after changing code or configuration examples:

```bash
npm run check
```

## Third-party packages

`@tmustier/pi-usage-extension` and `@tmustier/pi-raw-paste` are MIT-licensed packages maintained by Thomas Mustier. They are installed from npm and are not vendored in this repository. Pi extensions execute with full system access; review package updates before loading them.

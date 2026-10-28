# pi-codex-fast

Session-scoped Codex Fast mode requests for Pi 1.4.0. Disabled by default; no model calls are made by the extension itself.

## Install

From this repository, the root Pi package already includes this extension. For user-wide installation:

```bash
cd ~/git/pi-extensions
npm install
pi install ~/git/pi-extensions/packages/pi-codex-fast
```

Run `/reload` in an existing Pi session. Disable any other extension registering `/fast` before loading this package.

## Commands

| Command | Behavior |
| --- | --- |
| `/fast` | Toggle the preference for the active session branch. |
| `/fast on` | Request Fast mode on subsequent eligible requests. |
| `/fast off` | Stop modifying request tiers; preserve the provider's or other extensions' defaults. |
| `/fast status` | Report the preference and whether the current model/auth combination is eligible, without changing it. |

Enabling Fast mode can consume subscription limits or credits at a higher rate. Check [Codex speed](https://developers.openai.com/codex/speed/) and current plan pricing before use. Rates and supported models can change; this package does not hard-code a multiplier or promise a speedup.

The footer displays **Fast requested**, not confirmed activation. **Fast paused** means the preference is on but the current model/auth combination is ineligible. The indicator disappears when the preference is off. Switching back to an eligible model resumes requests automatically. Commands work in RPC and non-interactive SDK sessions too; footer rendering requires UI support.

## Request behavior and limits

- Uses Pi's `before_provider_request` hook to set `service_tier: "priority"`. The Codex CLI configuration value `service_tier = "fast"` is not the wire value: [Codex CLI 0.165.0 maps Fast to priority](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/protocol/src/config_types.rs).
- Applies only to `openai` with `openai-responses` or `openai-codex` with `openai-codex-responses`, when Pi reports OAuth authentication. Ordinary API-key requests, other providers/APIs, and virtual selections remain untouched. No login, token refresh, credential-file access, or authentication changes are performed by this extension.
- Does not maintain a model allowlist: the server determines eligibility and may reject, ignore, or downgrade the requested tier. The footer only describes request intent. A successful toggle does not validate your account or model. No automatic retry, account switch, or silent fallback is added.
- Preserves the complete request except `service_tier` while enabled; reasoning effort and model selection do not change. `/thinking low` is not Fast mode. While disabled it does not remove or override a tier supplied elsewhere, so `/fast off` cannot disable another extension's priority setting.
- Does not read or modify Codex CLI `config.toml`, Pi settings, or the managed Pi installation. It does not implement Ultrafast mode or recalculate Pi's recorded cost estimates. Historical costs are not a subscription invoice.
- Pi 1.4.0's payload hook exposes the selected model, not the actual request provider. The payload's model must match the selected model ID; differently routed payloads are skipped. Do not combine this with an extension that secretly routes the same model ID to another provider, replaces authentication, or overwrites the tier afterward. Such changes cannot be reliably detected here.
- Applies only to requests that invoke this session's Pi payload hook. It does not propagate the preference to independent Council/Aufheben child sessions, direct provider calls, or requests that bypass that hook. An already dispatched request is not changed by a toggle.

## Persistence

Stores only a versioned boolean in custom session entries, outside model context. The active branch is reconstructed on session startup/resume/reload/fork and tree navigation. A new session without a saved entry starts off; an inherited branch retains its saved preference. There is no global default or background inference on restore.

## Development

Run from the repository root so dependency overrides apply:

```bash
npm run check
npm audit --audit-level=high
git diff --check
```

Tests cover command parsing/completion, higher-usage warnings, conservative provider/auth scoping, immutable payload transformation, branch restoration, shutdown, non-TUI behavior, and the real SDK payload-hook/persistence lifecycle with fake OAuth and inference. Automated tests need no real credentials or paid requests. Live server acceptance and latency are not verified by these tests.

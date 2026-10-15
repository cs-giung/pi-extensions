# pi-usage-codex

Compact OpenAI Codex subscription quota status for [Pi](https://pi.dev/).

## Behavior

The extension displays subscription quota regardless of the active provider, alongside the DeepSeek and Z.ai indicators when installed. It uses compatible ChatGPT subscription credentials (never an OpenAI API key), requests `https://chatgpt.com/backend-api/wham/usage`, and shows the remaining primary and weekly quota windows:

```text
codex 5h 82% · 7d 64% ↺6d22h
spark 5h 91% · 7d 73% ↺6d22h
```

Active `openai` or `openai-codex` Spark models select the separate Spark quota bucket; all other models show regular Codex quota. Missing subscription auth hides the indicator; a first-request failure is shown as `error`. Cached values are marked `(stale)` during refresh failures. The status normally refreshes 30 seconds after each completed request and immediately when switching quota buckets. Failures use exponential backoff with jitter, capped at five minutes, and honor longer `Retry-After` delays. Missing credentials retain the normal interval; successful requests reset the backoff. Polling runs only with a UI. Session shutdown and quota-bucket changes abort in-flight HTTP requests; late results cannot overwrite the current indicator.

Run `/usage-codex-status` to see the authentication source, last successful refresh, safe error category (HTTP status, parsing, or network/credential resolution), consecutive failures, and next scheduled refresh. Diagnostics do not expose tokens, headers, response bodies, or arbitrary credential errors.

## Install

Install the local package from this repository:

```bash
pi install ./packages/pi-usage-codex
```

No extension configuration is required. Credentials are checked in this order:

1. Pi's `openai` OAuth token, if it contains a Codex `chatgpt_account_id`.
2. Pi's legacy `openai-codex` OAuth token (`/login openai-codex`).
3. Codex CLI's ChatGPT token in `$CODEX_HOME/auth.json` (default: `~/.codex/auth.json`), created by `codex login`.

Pi 1.2.0's new `/login openai` **Sign in with ChatGPT** flow issues Responses API tokens with encrypted metadata and no Codex account ID. Those tokens alone cannot be used by this extension; keep the Pi login and sign in separately with Codex CLI or the legacy Pi provider for quota polling.

The CLI file is read-only and re-read on each refresh. API-key credentials, malformed files, mismatched account IDs, and expired CLI access tokens are not sent to ChatGPT. The extension never refreshes or writes CLI credentials, avoiding interference with CLI-owned refresh tokens. If the CLI token expires, use Codex CLI to refresh it or run `codex login` again. Diagnostics report safe authentication guidance without displaying credential contents.

## Development

```bash
npm run check
```

## License

MIT

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
pi install ~/git/pi-extensions/packages/pi-usage-codex
```

No extension configuration is required. Credentials are checked in this order:

1. Pi's `openai` OAuth token, if it contains a Codex `chatgpt_account_id`.
2. Pi's legacy `openai-codex` OAuth token (`/login openai-codex`).
3. Codex CLI's ChatGPT token in `$CODEX_HOME/auth.json` (default: `~/.codex/auth.json`), created by `codex login`.

The new `/login openai` **Sign in with ChatGPT** flow (introduced in Pi 1.2.0) can issue Responses API tokens with encrypted metadata and no Codex account ID. Those tokens alone cannot be used by this extension; keep the Pi login and sign in separately with Codex CLI or the legacy Pi provider for quota polling.

If a Pi provider's credential lookup or token refresh fails, the extension continues to the next provider and then CLI credentials. User cancellation stops resolution instead of triggering fallback. A Pi resolution failure with no CLI file remains a transient polling failure (cached quota stays `(stale)` and polling backs off), rather than being mistaken for missing auth. Credential errors are never included verbatim in diagnostics. HTTP failures after selecting credentials do not automatically switch accounts.

The CLI file is read-only and re-read on each refresh. API-key credentials, malformed files, mismatched account IDs, and expired CLI access tokens are not sent to ChatGPT. The extension never refreshes or writes CLI credentials, avoiding interference with CLI-owned refresh tokens. If the CLI token expires, use Codex CLI to refresh it or run `codex login` again. Diagnostics report safe authentication guidance without displaying credential contents.

## Missing indicator on a new Mac

Package installation and subscription authentication are separate. A checkout at `~/git/pi-extensions` does not carry over another machine's Pi or Codex CLI credentials.

1. Run `pi list` in a terminal and verify that the root package or `~/git/pi-extensions/packages/pi-usage-codex` is installed. If `/usage-codex-status` is unknown in Pi, check package loading and run `/reload`.
2. Run `/usage-codex-status`. If it reports `Pi openai OAuth has no Codex account ID`, the extension could not find compatible subscription credentials and intentionally hid the indicator **before making any usage request**. A working OpenAI model login does not establish quota access.
3. Keep the existing `openai` login. In Pi, run `/login openai-codex` and complete the ChatGPT subscription login. Alternatively, if Codex CLI is installed, run `codex login` in a terminal using the subscription whose quota you want displayed. The extension's selected auth source determines which account's quota is shown.
4. Run `/reload` for an immediate check (or wait for the next 30-second poll), then run `/usage-codex-status` again. A successful refresh reports `Pi openai-codex` or `Codex CLI` as the auth source and a last-success timestamp.

Do not copy or print tokens to troubleshoot. The extension does not install Codex CLI, initiate a login, or refresh CLI credentials. If diagnostics instead report `HTTP ...`, response parsing, or network failure, investigate that category rather than assuming the package path is wrong.

## Development

```bash
npm run check
```

## License

MIT

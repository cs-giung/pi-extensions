# pi-usage-deepseek

Compact DeepSeek account balance status for [Pi](https://pi.dev/).

## Behavior

The extension displays the balance regardless of the active provider, alongside the Codex and Z.ai indicators when installed. It uses Pi's current DeepSeek API key, requests `https://api.deepseek.com/user/balance`, and shows the preferred available balance:

```text
deepseek $17.35
```

USD is preferred, followed by CNY and then the first returned currency. Missing auth hides the indicator; an unavailable balance is shown as `n/a` and a first-request failure as `error`. Cached values are marked `(stale)` during refresh failures. The status normally refreshes 30 seconds after each completed request, regardless of the selected model. Failures use exponential backoff with jitter, capped at five minutes, and honor longer `Retry-After` delays. Missing credentials retain the normal interval; successful requests reset the backoff. Polling runs only with a UI. Session shutdown stops polling and aborts in-flight HTTP requests; late results cannot restore a cleared indicator.

Run `/usage-deepseek-status` to see the last successful refresh, safe error category (HTTP status, parsing, or network/credential resolution), consecutive failures, and next scheduled refresh. Diagnostics do not expose API keys, headers, response bodies, or arbitrary credential errors.

## Install

Install the local package from this repository:

```bash
pi install ~/git/pi-extensions/packages/pi-usage-deepseek
```

No configuration is required. Configure a DeepSeek API key through Pi or `DEEPSEEK_API_KEY`.

## Development

```bash
npm run check
```

## License

MIT

# pi-usage-codex

Compact OpenAI Codex subscription quota status for [Pi](https://pi.dev/).

## Behavior

The extension displays subscription quota regardless of the active provider, alongside the DeepSeek and Z.ai indicators when installed. It reads Pi's legacy `openai-codex` OAuth credential or falls back to the `openai` ChatGPT sign-in credential (never an OpenAI API key), requests `https://chatgpt.com/backend-api/wham/usage`, and shows the remaining primary and weekly quota windows:

```text
codex 5h 82% · 7d 64% ↺6d22h
spark 5h 91% · 7d 73% ↺6d22h
```

Active `openai-codex` or `openai` Spark models select the separate Spark quota bucket; all other models show regular Codex quota. Missing subscription auth hides the indicator; a first-request failure is shown as `error`. Cached values are marked `(stale)` during refresh failures. The status refreshes every 30 seconds and when switching quota buckets. Polling runs only with a UI. Session shutdown and quota-bucket changes abort in-flight HTTP requests; late results cannot overwrite the current indicator.

## Install

Install the local package from this repository:

```bash
pi install ./packages/pi-usage-codex
```

No configuration is required. In Pi v1.0.3, use `/login openai` and select **Sign in with ChatGPT**. Existing `/login openai-codex` credentials are still supported.

## Development

```bash
npm run check
```

## License

MIT

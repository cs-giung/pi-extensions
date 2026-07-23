# pi-usage-codex

Compact OpenAI Codex subscription quota status for [Pi](https://pi.dev/).

## Behavior

The extension is active only for the `openai-codex` provider. It reads Pi's current OAuth credential, requests `https://chatgpt.com/backend-api/wham/usage`, and shows the remaining primary and weekly quota windows:

```text
codex 5h 82% · 7d 64% ↺6d22h
spark 5h 91% · 7d 73% ↺6d22h
```

Spark models select the separate Spark quota bucket. Missing subscription auth is shown as `n/a`; a first-request failure is shown as `error`. A successful value remains visible during transient refresh failures. The status refreshes after model changes and turns, and every 30 seconds while Codex is active.

## Install

Install the local package from this repository:

```bash
pi install ./packages/pi-usage-codex
```

No configuration is required. Authenticate with `/login openai-codex` in Pi.

## Development

```bash
npm run check
```

## License

MIT

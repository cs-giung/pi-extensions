# pi-usage-zai

Compact Z.ai pay-as-you-go monetary balance for Pi, visible on every model provider.

```text
zai $12.34
```

Shows the account's **available USD balance**, not Coding Plan credits or quota. Uses `availableBalance` (after frozen funds), falling back to `balance` when unavailable. Values are displayed to two decimal places; zero and negative balances are supported.

## Install

The repository root package includes this extension. For a separate user-wide install:

```bash
pi install ./packages/pi-usage-zai
```

Configure the `zai` provider in Pi or set `ZAI_API_KEY`, then `/reload`. No Coding Plan subscription or browser cookie is required.

The extension uses Pi's resolved provider key to query:

```text
GET https://api.z.ai/api/biz/account/query-customer-account-report
Authorization: Bearer <API key>
```

This global Z.ai endpoint was verified with API-key authentication. It is an undocumented account-report endpoint and may change. BigModel China and team-scoped accounts are not supported.

The indicator normally refreshes 30 seconds after each completed request alongside Codex and DeepSeek, even when another provider is selected. Failures use exponential backoff with jitter, capped at five minutes, and honor longer `Retry-After` delays. Missing credentials retain the normal interval; successful requests reset the backoff. Missing credentials hide it. Initial request/API errors show `zai error`; transient failures preserve the previous value with `(stale)`. Requests have a 15-second HTTP timeout. No polling occurs without a UI; shutdown stops polling, aborts in-flight HTTP requests, and suppresses late results.

Run `/usage-zai-status` to see the last successful refresh, safe error category (HTTP status, parsing, or network/credential resolution), consecutive failures, and next scheduled refresh. Diagnostics do not expose API keys, headers, response bodies, or arbitrary credential errors.

## Development

Run `npm run check` from the repository root. Automated tests use mocked responses; no API key is required.

## License

MIT

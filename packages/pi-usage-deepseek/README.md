# pi-usage-deepseek

Compact DeepSeek account balance status for [Pi](https://pi.dev/).

## Behavior

The extension is active only for the `deepseek` provider. It uses Pi's current DeepSeek API key, requests `https://api.deepseek.com/user/balance`, and shows the preferred available balance:

```text
deepseek $17.35
```

USD is preferred, followed by CNY and then the first returned currency. Missing auth or an unavailable balance is shown as `n/a`; a first-request failure is shown as `error`. A successful value remains visible during transient refresh failures. The status refreshes after model changes and turns, and every 30 seconds while DeepSeek is active.

## Install

Install the local package from this repository:

```bash
pi install ./packages/pi-usage-deepseek
```

No configuration is required. Configure a DeepSeek API key through Pi or `DEEPSEEK_API_KEY`.

## Development

```bash
npm run check
```

## License

MIT

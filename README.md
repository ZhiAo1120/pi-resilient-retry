# pi-resilient-retry

Keep retrying failed upstream API requests that Pi's built-in retry gives up on.

Pi already retries transient provider errors — overloaded, 429, 5xx, timeouts, dropped
streams — up to `retry.maxRetries`. Everything else ends the run immediately. That is
the usual reason a flaky routing proxy kills a long task: a `400` from the upstream, an
unmapped message like `upstream sent an error event`, or quota wording Pi treats as
fatal.

This extension adds a second layer at `agent_before_settle`, the last boundary in Pi
that can force one more model request. When the run ended on a retryable error and the
user did not abort, it waits out a backoff delay and continues the run.

## Install

```bash
pi install git:github.com/<you>/pi-resilient-retry
# or, during development, load a checkout directly
pi install /path/to/pi-resilient-retry
```

Restart Pi or run `/reload`. The extension loads on its own; no `/retry` command and no
per-session setup.

## Settings

Optional. Defaults keep retrying indefinitely, which is what a long unattended run wants.

```json
{
  "resilientRetry": {
    "enabled": true,
    "maxRetries": 0,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000,
    "retryQuotaErrors": false
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the extension off without uninstalling it. |
| `maxRetries` | `0` | Consecutive retries allowed without a successful request. `0` = unlimited. |
| `baseDelayMs` | `2000` | First backoff delay; doubles per attempt. |
| `maxDelayMs` | `60000` | Delay ceiling. Every delay is clamped to it. |
| `retryQuotaErrors` | `false` | Also retry quota/billing errors, which retrying usually cannot fix. |

`maxRetries` resets after any successful request, so it bounds one outage, not the whole
session.

## What it does not do

- **No tool replay.** The retry repeats the failed model request only; it never re-runs a
  tool. A request that already executed tools keeps their results.
- **No abort override.** Escape, `/stop`, and a cancelled run are never retried.
- **No quota guessing.** Billing and quota errors are excluded by default because
  repeating them just burns time. Turn on `retryQuotaErrors` if your proxy reports
  temporary quota as a quota error.

## Relationship to Pi's built-in retry

Both layers run. Pi's retry handles the transient errors it recognises first; this
extension catches whatever Pi refuses. Keeping Pi's own settings intact is intentional —
it keeps Pi's quota detection working, which the extension relies on for its default
policy.

## Development

```bash
npm install
npm test     # policy unit tests, no network
npm run check
```

The end-to-end behaviour was verified against a fake upstream: with Pi's own retry
disabled (`retry.maxRetries: 0`), three consecutive `400` responses followed by a `200`
recovered normally, and a quota error with `retryQuotaErrors: false` stopped after one
request.

## License

MIT

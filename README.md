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

Optional. The default budget is finite on purpose: a failure the upstream repeats forever
must not become an unbounded request storm.

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
| `maxRetries` | `20` | Consecutive retries allowed without a successful request. `0` = unlimited. |
| `baseDelayMs` | `2000` | First backoff delay; doubles per attempt. |
| `maxDelayMs` | `60000` | Delay ceiling. Every delay is clamped to it. |
| `retryQuotaErrors` | `false` | Also retry quota/billing errors, which retrying usually cannot fix. |

`maxRetries` resets after any successful request, so it bounds one outage, not the whole
session.

## Visible progress

A retry is never silent. While waiting you get a footer status
(`⏳ 上游报错，重试第 3/20 次 · 等待 12s · Esc 取消`), the working message shows the same,
and recovery or exhaustion is reported in the transcript. Escape, `/stop`, or closing the
session cancels the wait within a quarter second.

## What it does not do

- **No tool replay.** The retry repeats the failed model request only; it never re-runs a
  tool. A request that already executed tools keeps their results.
- **No abort override.** Escape, `/stop`, and a cancelled run are never retried.
- **No quota guessing.** Billing and quota errors are excluded by default because
  repeating them just burns time. Turn on `retryQuotaErrors` if your proxy reports
  temporary quota as a quota error.
- **No retry of deterministic rejections.** These fail identically every time, so a retry
  cannot change the outcome and only burns tokens:

  | Error | Why a retry cannot help |
  |---|---|
  | `created under a different Azure OpenAI resource` | The history was minted by another upstream resource; the payload must change, not repeat. |
  | `belongs to a different upstream account` | Same class of replay rejection. |
  | `invalid_request_error`, `invalid api key`, `unauthorized`, `authentication`, `permission_denied` | Credentials or request shape are wrong. |
  | `context_length_exceeded` | Pi compacts instead; repeating the same request cannot fit. |

  `retryQuotaErrors` does not unlock these.

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

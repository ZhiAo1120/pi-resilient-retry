# pi-resilient-retry

Keep retrying failed upstream API requests that Pi's built-in retry gives up on.

English | [中文](README.zh-CN.md)

## Install them together

This extension keeps the task running. If you also want to **resume a failed turn by hand**,
install [pi-retry](https://github.com/ZhiAo1120/pi-retry) alongside it:

| | pi-resilient-retry (this) | pi-retry |
|---|---|---|
| Trigger | Automatic, retries on failure | You type `/retry` |
| Job | Retry in the background so the task is not interrupted | Resume from the checkpoint without replaying finished work |
| Budget | Unlimited (configurable) | 3 failed requests, then it stops with a reason |
| History repair | Drops ids only when the upstream reports the ids are dead | `/retry` drops ids; `--deep` also drops reasoning |

The lifecycle hooks do not conflict, so both can be installed. One keeps the task
alive; the other makes your manual intervention precise. They complement rather than
replace each other.

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
pi install git:github.com/ZhiAo1120/pi-resilient-retry
# or, during development, load a checkout directly
pi install /path/to/pi-resilient-retry
```

Restart Pi or run `/reload`. The extension loads on its own; no `/retry` command and no
per-session setup.

## Settings

Optional. The default budget is unlimited, because a relay routes each attempt to a
different upstream and a finite budget can give up on a node that would have worked.
History repair keeps retries from replaying the identical failing payload, and the status
line plus Escape bound what an outage costs you.

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
| `maxRetries` | `0` | Consecutive retries allowed without a successful request. `0` = unlimited; set a number to cap one outage. |
| `baseDelayMs` | `2000` | First backoff delay; doubles per attempt. |
| `maxDelayMs` | `60000` | Delay ceiling. Every delay is clamped to it. |
| `retryQuotaErrors` | `false` | Also retry quota/billing errors, which retrying usually cannot fix. |
| `repairHistory` | `true` | Allow dropping replay-only history ids, only when the upstream reports the session ids are unusable. |

`maxRetries` resets after any successful request, so it bounds one outage, not the whole
session.

## History repair is gated

Retrying the identical payload can fail forever when a relay answers with an upstream node
that refuses the previous node's history (`The requested item was created under a different
Azure OpenAI resource`). Dropping the history item ids makes the conversation replayable by
any node — but it also costs the model its cross-turn memory, so it is **not** done for
every retry.

Repair runs only when the upstream explicitly reports that the session's ids are unusable:

| Trigger | |
|---|---|
| `created under a different Azure OpenAI resource` | The observed failure in a relay pool. |
| `belongs to a different upstream account` | Same class of replay rejection. |
| `previous_response_id` / `item` / `session` … `not found` \| `expired` \| `invalid` | The id no longer resolves. |

Every other failure — a plain 400, a 429, a 503, a dropped stream — retries with the
history **byte-identical**, so the model keeps its memory and the prompt-cache prefix stays
intact. When repair does run, only the optional `id` of complete items is dropped; message
bodies, tool call pairs, `call_id`, `encrypted_content` and reasoning items all survive.

Set `repairHistory: false` to disable repair entirely.

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
- **No error-text filtering for retries.** A relay fronts many upstreams, so a rejection
  from one node says nothing about the next. Every failure gets another attempt. Error text
  is read for one thing only: deciding whether the session ids are dead. Only quota/billing
  wording is opt-in.

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

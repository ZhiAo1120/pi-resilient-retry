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
| Budget | Unlimited, with a repeat guard | 3 failed requests, then it stops with a reason |
| History repair | Drops ids only when the upstream reports the ids are dead | `/retry` drops ids; `--deep` also drops reasoning |

The lifecycle hooks do not conflict, so both can be installed. One keeps the task alive; the
other makes your manual intervention precise.

## The problem

Pi already retries transient provider errors — overloaded, 429, 5xx, timeouts, dropped
streams — up to `retry.maxRetries`. Everything else ends the run immediately. That is the
usual reason a flaky routing proxy kills a long task: a `400` from the upstream, an unmapped
message like `upstream sent an error event`, or a relay-specific rejection.

This extension hooks `agent_before_settle`, the last boundary in Pi that can force one more
model request. When a run ends on a retryable error and the user did not abort, it waits out a
backoff delay and continues the run.

## Install

```bash
pi install git:github.com/ZhiAo1120/pi-resilient-retry
# or, during development, load a checkout directly
pi install /path/to/pi-resilient-retry
```

Restart Pi or run `/reload`. The extension loads on its own; no per-session setup.

## Settings

All optional.

```json
{
  "resilientRetry": {
    "enabled": true,
    "maxRetries": 0,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000,
    "repeatLimit": 30,
    "visibleRetry": true,
    "retryQuotaErrors": false,
    "repairHistory": true
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the extension off without uninstalling it. |
| `maxRetries` | `0` | Consecutive retries allowed without a successful request. `0` = unlimited. |
| `baseDelayMs` | `2000` | First backoff delay; doubles per attempt. |
| `maxDelayMs` | `60000` | Delay ceiling. Every delay is clamped to it. |
| `repeatLimit` | `30` | Attempts allowed for one **unchanged** error. `0` disables the guard. |
| `visibleRetry` | `true` | Print every retry into the conversation. The notices are stripped from the model payload. |
| `retryQuotaErrors` | `false` | Also retry quota/billing errors. |
| `repairHistory` | `true` | Allow dropping replay-only history ids, only when the upstream says the ids are dead. |

`maxRetries` and `repeatLimit` reset after any successful request, so they bound one outage,
not the whole session.

## Context cost

Retry notices are for you, not for the model. Every attempt is printed into the conversation
so you can watch progress, and every notice is removed from the outgoing payload before the
request is sent — including the empty assistant turn left by the failure.

The model therefore receives the original request unchanged: no growth, no lost memory, and a
stable prompt-cache prefix.

Measured on an outage with three consecutive failures:

```
request #1  payload 5787B   retry notices in payload: 0
request #2  payload 5787B   retry notices in payload: 0
request #3  payload 5787B   retry notices in payload: 0
request #4  payload 5787B   retry notices in payload: 0

session transcript: 3 visible ↻ pi-resilient-retry lines
```

Set `visibleRetry: false` to stop printing them; the retry then drops the failed attempt with
`context_edit` and writes nothing at all.

## Why a retry is not just the same request again

A relay answers each attempt with whichever upstream node it picks. Replaying the exact same
payload can therefore fail forever: history items minted by node A carry ids that node B
refuses to resolve (`The requested item was created under a different Azure OpenAI resource`).

Repair runs only when the upstream explicitly reports that the session ids are unusable:

| Trigger | |
|---|---|
| `created under a different Azure OpenAI resource` | The observed failure in a relay pool. |
| `belongs to a different upstream account` | Same class of replay rejection. |
| `previous_response_id` / `item` / `session` … `not found` \| `expired` \| `invalid` | The id no longer resolves. |

Every other failure retries with the history **byte-identical**, so the model keeps its memory
and the prompt-cache prefix stays intact. When repair does run, only the optional `id` of
complete items is dropped; message bodies, tool call pairs, `call_id`, `encrypted_content` and
every reasoning item survive. Repair is armed for one request only.

Set `repairHistory: false` to send retries byte-identical instead.

## Seeing that a retry happened

Percho renders none of Pi's extension UI channels (`notify`, `setStatus`, `custom_message`),
so the conversation is the only place a retry can be attributed. Every retry appears as:

```
↻ pi-resilient-retry：上游请求失败，自动重试中（第 1 次）。
```

In a terminal Pi session the footer also shows live progress
(`⏳ 上游报错，重试第 3/30 次 · 等待 12s · Esc 取消`). Escape, `/stop`, or closing the session
cancels the wait within a quarter second.

## Stopping an impossible loop

Unlimited retries are only safe while the failure keeps changing. When the **same** error
repeats with no successful request in between, repeating it cannot help, so the extension
stops and reports it.

A different error each attempt (a relay rotating nodes) keeps retrying without limit; an
identical error thirty-one times in a row does not.

## Diagnosing a silent non-retry

Set a debug log to record every decision:

```json
{ "resilientRetry": { "debugLog": "/tmp/resilient-retry.log" } }
```

Each settle boundary appends one JSON line with the outcome, the assistant `stopReason`, the
error head, whether the run was aborted, and the decision taken:

```json
{"event":"session_start","enabled":true,"config":{...}}
{"event":"agent_before_settle","outcome":"error","stopReason":"error",
 "error":"503: {\"message\":\"Upstream service unavailable\"}","aborted":false,
 "hasUI":false,"decision":"retry","attempt":1,"delayMs":2000,"repair":false}
{"event":"agent_before_settle","outcome":"error","stopReason":"error",...,
 "decision":"skip: run aborted"}
```

No `session_start` line at all means the extension never loaded. Remove `debugLog` when done.

## What it does not do

- **No tool replay.** A retry repeats the failed model request only; it never re-runs a tool.
- **No abort override.** Escape, `/stop`, and a cancelled run are never retried.
- **No error-text filtering for retries.** A relay fronts many upstreams, so a rejection from
  one node says nothing about the next. Every failure gets another attempt; the text is read
  only to decide whether the session ids are dead.

## Relationship to Pi's built-in retry

Both layers run. Pi's retry handles the transient errors it recognises first; this extension
catches whatever Pi refuses. Keeping Pi's own settings intact preserves its quota detection,
which this extension relies on for its default policy.

## Development

```bash
npm install
npm test     # policy unit tests, no network
npm run check
```

Verified end to end against fake upstreams: consecutive `400`s recover after retry; a quota
error with `retryQuotaErrors: false` stops after one request; a transient 503 keeps history ids
intact; a cross-resource rejection recovers after ids are stripped; an unchanged error stops at
`repeatLimit`; silent retries keep the request payload constant.

## License

MIT

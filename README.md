# pi-resilient-retry

[![npm version](https://img.shields.io/npm/v/pi-resilient-retry)](https://www.npmjs.com/package/pi-resilient-retry)

Let Pi try its native recovery first, then continue the same task if the model request still fails.

This is a protocol-independent **AgentSession fallback**, not a new model/provider entrance.
Keep selecting your existing models in Pi or Percho; their protocol, auth and streaming remain
owned by the SDK. Requires the public extension API in `@earendil-works/pi-coding-agent` 1.4.x.

English | [中文](README.zh-CN.md)

## Install them together

This extension keeps the task running. If you also want to **resume a failed turn by hand**,
install [pi-retry](https://github.com/ZhiAo1120/pi-retry) alongside it:

| | pi-resilient-retry (this) | pi-retry |
|---|---|---|
| Trigger | Automatic, retries on failure | You type `/retry` |
| Job | Retry in the background so the task is not interrupted | Resume from the checkpoint without replaying finished work |
| Budget | Plugin continuations; unlimited by default, with a repeat guard | See that package's manual retry policy |
| History repair | Drops ids only when the upstream reports the ids are dead | `/retry` drops ids; `--deep` also drops reasoning |

Their triggers differ. Stop automatic recovery before invoking manual `/retry`.
The companion's behavior and combined-package integration have not been re-verified here.

## The problem

Pi already retries transient provider errors — overloaded, 429, 5xx, timeouts, dropped
streams — up to `retry.maxRetries`. Everything else ends the run immediately. That is the
usual reason a flaky routing proxy kills a long task: a `400` from the upstream, an unmapped
message like `upstream sent an error event`, or a relay-specific rejection.

This extension hooks `agent_before_settle`, the last boundary in Pi that can force one more
model request. When a run ends on a retryable error and the user did not abort, it starts a
native continuation, then waits out the backoff before sending the request.

## Install from npm

Package: [`pi-resilient-retry`](https://www.npmjs.com/package/pi-resilient-retry).
Use Pi's package manager so it loads the declared extension entry:

```bash
# Latest published npm version
pi install npm:pi-resilient-retry

# Pin a particular release
pi install npm:pi-resilient-retry@0.1.0
```

Requires Node.js 22.19+ and the compatible Pi extension API described above. Restart Pi or
run `/reload` once idle. No new model/provider/auth configuration is needed, **provided the
host loads this extension into that session**. Npm installation does not remove the Percho
child-session limitation below.

### Update an npm installation

```bash
# Update this installed package (when its npm source is not pinned)
pi update npm:pi-resilient-retry

# Or update all installed packages
pi update --extensions
```

Then restart or `/reload` once idle. A source pinned to `@0.1.0` stays on that version;
install a newer explicit version to change the pin. A Git commit/push is not an npm release,
and a Pi CLI upgrade does not automatically update this package.

### Git, local development and migration

```bash
pi install git:github.com/ZhiAo1120/pi-resilient-retry
pi install /path/to/pi-resilient-retry
```

Keep **one** installation source for this extension. If switching from Git/local to npm,
inspect `pi list`, remove the old source, then install npm; do not load both copies:

```bash
pi remove git:github.com/ZhiAo1120/pi-resilient-retry
pi install npm:pi-resilient-retry
```

For a local installation, remove the actual path shown by `pi list` instead of the Git source.

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
    "retryQuotaErrors": false,
    "repairHistory": true
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the extension off without uninstalling it. |
| `maxRetries` | `0` | Consecutive **plugin continuations** without success. `0` = unlimited, not a total HTTP request cap. |
| `baseDelayMs` | `2000` | First backoff delay; doubles per attempt. |
| `maxDelayMs` | `60000` | Delay ceiling. Every delay is clamped to it. |
| `repeatLimit` | `30` | Consecutive identical terminal errors, compared using the full whitespace-normalized error. `0` disables the guard. |
| `retryQuotaErrors` | `false` | Also retry quota/billing errors. |
| `repairHistory` | `true` | Allow dropping replay-only history ids, only when the upstream says the ids are dead. |
| `debugLog` | unset | Optional JSONL decision-metadata file. No raw errors, prompts, payloads, auth or headers. |

`maxRetries` and `repeatLimit` reset after success, an aborted settlement, or session initialization.
They bound consecutive terminal failures, not the whole session. Nonnegative finite numbers are
accepted; invalid numeric values use defaults. Fractional delays are retained (subject to timer resolution). Legacy `visibleRetry` and `noticeEvery` settings are ignored
and can be removed; leaving `visibleRetry: true` no longer adds conversation markers.

## How a retry works

A retry is the **system** re-invoking the model, not the user speaking. The extension returns a
boundary continuation that drops the failed assistant turn from context and re-issues the
request. No message is ever sent on your behalf:

```
session:  user "hi" → assistant (error) → [context omit] → assistant (error) → [context omit] → assistant "answer"
requests: original messages and history; ordinary retry payloads stay identical
```

`context_edit` omits the failed attempt from **future model context** without adding a prompt
or losing earlier memory. The original error and the edit remain in the append-only session
file: this does not delete raw history or make the file stop growing. Pending boundary edits
from earlier extensions are preserved; the plugin appends its own failed-attempt edit.

### No retry messages

No user, assistant, or `custom_message` is injected, and the model is not asked to announce
retries. Old custom messages with `customType: "resilient-retry"` are excluded by identity when
building model input, without rewriting the session file. Real user messages, assistant
responses, and tool results are preserved even when they mention `pi-resilient-retry`.
Notices that very old versions wrote as real user messages are not guessed at and deleted by text.

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

For other failures the plugin makes **no payload/history repair edits**. The loopback fixtures
verify byte-identical ordinary requests; SDK routing and other extensions still own their own transformations. When repair does run, only the optional `id` of
complete items is dropped; message bodies, tool call pairs, `call_id`, `encrypted_content` and
every reasoning item survive. Repair is armed for one request only.

Set `repairHistory: false` to disable these edits. Repair never rewrites wire model IDs,
`messages.provider`/`api`, call IDs, thinking signatures, or stored history. It does not clear
transport `previous_response_id`, reference-only items or encrypted reasoning: there is not enough
information to reconstruct them safely. Seeing their IDs in an error does not guarantee repair.
A loopback accepting omitted IDs does **not** prove every real service accepts that schema.

## Seeing a retry in progress

Retries use Pi / Percho's **native agent-working indicator**, not extension UI channels that
Percho does not consume:

```
failure → agent_end → agent_before_settle (request continuation immediately)
        → agent_start → turn_start → context (backoff wait) → provider request
```

- **Native activity:** real `agent_start` and `turn_start` events precede backoff. The host can
  use its usual working state; the plugin does not fake events, error cards or a result pane.
- **Terminal Pi:** where the host implements `setWorkingMessage`, text changes from
  “等待重试（第 N 次）” (waiting) to “正在重试（第 N 次）” (requesting).
- **Cancel / finish:** use the host's Stop action or close the session. An AbortSignal listener
  wakes backoff immediately; timers/listeners are cleaned up, including very large delays.
  Success, cancellation and retry limits clear the plugin's working text. Direct disposal
  clears it on the genuine abort signal before the SDK invalidates the context; terminal
  callbacks do not access that disposed context. On every low-level `agent_end`, plugin
  text is returned to the host before any SDK-native backoff (which uses a separate controller).
  The late settlement callback uses event data and cached run metadata, not live context getters.
- **Verification limit:** SDK/RPC activity and cancellation are exercised; interactive TUI,
  full Percho desktop animation and result-pane visuals have not been observed.

Waiting inside `agent_before_settle` is too late: the preceding low-level `agent_end` already
turned off the native indicator. Blocking a start-event handler is also too early: Pi waits
for extension handlers before notifying UI subscribers. Backoff therefore runs in `context`,
**after both start events**; the wait itself does not modify any messages.

There is still a normal lifecycle transition between each low-level run and its continuation.
The host can briefly reset or retain its native error cards. This extension neither fabricates
lifecycle events nor patches Percho to hide those records. Use the debug log below for exact
attempt counts and decision reasons.

## Stopping an impossible loop

The repeat guard stops an unproductive loop of identical errors; it does not prove that
changing errors are safe or cheap to retry. Use a finite `maxRetries` if you need a bounded
plugin budget. Error comparison hashes the full whitespace-normalized string, so distinct
long errors sharing a prefix no longer incorrectly trip the guard.

A different error each attempt (a relay rotating nodes) keeps retrying without limit; an
identical error thirty-one times in a row does not.

## Diagnosing a silent non-retry

Set a debug log to record every decision:

```json
{ "resilientRetry": { "debugLog": "/tmp/resilient-retry.log" } }
```

Records contain only allowlisted event/decision labels, counters, flags and a SHA-256
`errorFingerprint`. Raw upstream error text, request/response bodies, credentials, headers
and the configured log path are never written. Newly created files use mode `0600`;
existing-file permissions are not changed. SDK/host logs and raw session records are separate.

```json
{"event":"agent_before_settle","outcome":"error","stopReason":"error","aborted":false,"decision":"retry","attempt":1,"delayMs":2000,"repair":false}
{"event":"agent_before_settle","outcome":"error","stopReason":"error","decision":"skip: policy declined"}
```

Normally startup records `session_start`. If it is missing, check both loading **and a writable
sink in the correct settings scope**: sink failures are deliberately ignored and never break a run.
Remove `debugLog` when done.

## What it does not do

- **No task/tool replay by the plugin.** Completed tools/results remain in context; new tool
  calls chosen by the model still belong to Pi. Failed partial text can be regenerated, while
  the real failed response remains in raw history.
- **No abort override.** A cancelled run is never retried. The public aborted settlement flag
  also resets the budget when an adapter reports its last message as `error` rather than `aborted`.
- **Explicit policy only.** Quota/billing errors are excluded by default. Other terminal errors
  are eligible subject to the repeat/finite budget guards; error text also gates ID repair.
- **No global interceptor.** Direct provider calls outside a loaded AgentSession, tool HTTP
  calls and image-generation APIs are not automatically covered.

## Relationship to Pi's built-in retry

The order is **request → Pi native recovery → exhausted/not applicable → plugin continuation**.
The plugin never edits `retry` or `retry.provider`, overrides providers, or adds an inner stream/client
retry layer. Each continuation still goes through Pi's existing native policy.

Consequently `resilientRetry.maxRetries` is not a total wire-attempt cap: with one native retry
and one plugin continuation, repeated failures can produce four HTTP attempts. In contrast,
`retry.maxRetries: 0` disables Pi's native retry, while `resilientRetry.maxRetries: 0` means unlimited
plugin continuations. Keep those budgets distinct.

## Percho and SDK limits

Current verification uses Pi CLI/SDK **1.4.0** and Percho **0.6.6**, whose SDK actually exports
`VERSION 1.4.0`. A `PI_PACKAGE_DIR` environment override can change reported package/assets
versions; package names or old research notes alone are not runtime proof.

Percho's built-in subagent loader uses `noExtensions: true`, injects its permission factory only,
and shares the ModelRuntime, **not extension lifecycle handlers**. A provider callback runs before
native retry decisions; its public options do not reveal child-native exhaustion or a stable logical
request ID. Thus a transparent native-first child wrapper is **not shipped**: it would either guess,
retry too early, or need prohibited private host changes.

The current SDK already supports native-first recovery when the child explicitly loads this
factory: its public `agent_before_settle` hook is sufficient. What is missing is Percho's child
loader wiring, not a new SDK retry algorithm. Keep `noExtensions: true` and the permission gate,
then allowlist this factory for each child. Pi CLI-based subagents can also work if their child
process loads the extension; parent loading alone does not establish that. No `subagent_extension:result`
bridge, `taskId` fabrication, UI plugin or installation patch is used.

## Development

```bash
npm install
npm test     # policy checks + real SDK / loopback HTTP lifecycle tests, no external network
npm run check
```

`index.ts` is the lifecycle adapter; `retry-core.ts` owns the policy, budget, waits, repair and
metadata logger. No new runtime SDK/client dependency was added. The package has one explicit
extension entry and includes the core file.

Tests exercise SDK/client and native exhaustion **before** plugin recovery, native success/Stop bypass,
quota opt-in, finite/unlimited budgets, no completed-tool replay, legacy-marker identity,
full-error fingerprints, timer overflow/listener cleanup and private logging. Real Responses
and Anthropic HTTP fixtures cover images, thinking/text signatures, tool pairing, hook-returned
payloads, headers, usage, immutable ID repair and a genuinely truncated stream. These are
SDK/loopback observations, **not real-vendor/OAuth acceptance tests**.

To run the same lifecycle tests directly against Percho's bundled SDK on macOS (without
opening a desktop window or modifying the installation):

```bash
(
  ROOT=$(mktemp -d)
  trap 'rm -rf "$ROOT"' EXIT
  mkdir -p "$ROOT/agent"
  env -i PATH="$PATH" HOME="$ROOT" PI_CODING_AGENT_DIR="$ROOT/agent" PI_OFFLINE=1 \
    ELECTRON_RUN_AS_NODE=1 \
    PI_RETRY_TEST_SDK=/Applications/Percho.app/Contents/Resources/app.asar/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
    /Applications/Percho.app/Contents/MacOS/Percho --experimental-strip-types --test test/*.test.mjs
)
```

Workspace-only packaging proofs/reports live in
`.local/agent-work/pi-resilient-retry-optimization/package-proof/` (not in the npm archive).
They use the real CLI RPC entrance and both SDKs' normal package/JITI loader, with temporary
HOME/config/session, fake keys and loopback only. Cold load, idle reload, disable/re-enable,
parallel-session isolation, parent disposal, missing-factory controls and Stop are distinguished
from complete host/desktop verification. No real credentials/configuration were changed;
no upstream OAuth, WebSocket or native Percho child UI has been verified.

## License

MIT

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig, RetryBudget, waitForRetry, repairPayload, writeRetryLog } from "../retry-core.ts";

const config = overrides => readConfig({ resilientRetry: overrides });

test("settings retain defaults, literal booleans and zero-as-unlimited semantics", () => {
	assert.deepEqual(readConfig(undefined), {
		enabled: true, maxRetries: 0, baseDelayMs: 2000, maxDelayMs: 60000,
		retryQuotaErrors: false, repairHistory: true, repeatLimit: 30, debugLog: undefined,
	});
	const c = config({ enabled: false, maxRetries: 0, repeatLimit: 0, baseDelayMs: 0,
		retryQuotaErrors: true, repairHistory: false });
	assert.equal(c.enabled, false);
	assert.equal(c.maxRetries, 0);
	assert.equal(c.repeatLimit, 0);
	assert.equal(c.baseDelayMs, 0);
	assert.equal(c.retryQuotaErrors, true);
	assert.equal(c.repairHistory, false);
	assert.equal(config({ enabled: "false", retryQuotaErrors: "true", repairHistory: "false" }).enabled, true);
	assert.equal(config({ retryQuotaErrors: "true" }).retryQuotaErrors, false);
	assert.equal(config({ repairHistory: "false" }).repairHistory, true);
});

test("invalid numeric settings fall back instead of creating negative or unbounded timers", () => {
	for (const value of [-1, NaN, Infinity, "1", null, {}]) {
		const c = config({ maxRetries: value, repeatLimit: value, baseDelayMs: value, maxDelayMs: value });
		assert.equal(c.maxRetries, 0);
		assert.equal(c.repeatLimit, 30);
		assert.equal(c.baseDelayMs, 2000);
		assert.equal(c.maxDelayMs, 60000);
		assert.equal(c.debugLog, undefined);
	}
	for (const debugLog of [false, null, NaN, {}, [], ""]) assert.equal(config({ debugLog }).debugLog, undefined);
	assert.equal(config({ debugLog: "relative.log" }).debugLog, "relative.log");
	for (const settings of [null, false, "text", {}, { resilientRetry: null }]) {
		assert.deepEqual(readConfig(settings), readConfig(undefined));
	}
});

test("each budget is independent, bounded, and resettable; quota does not consume it", () => {
	const a = new RetryBudget(config({ maxRetries: 1 }));
	const b = new RetryBudget(config({ maxRetries: 1 }));
	assert.equal(a.next("insufficient_quota").retry, false);
	assert.equal(a.attempts, 0);
	assert.equal(a.next("400: relay failed").retry, true);
	assert.equal(a.next("400: relay failed").reason, "budget exhausted");
	assert.equal(b.next("400: relay failed").retry, true);
	a.reset();
	assert.equal(a.attempts, 0);
	assert.equal(a.next("400: relay failed").retry, true);
	assert.equal(new RetryBudget(config({ enabled: false })).next("400: failure").retry, false);
	assert.equal(new RetryBudget(config({ retryQuotaErrors: true })).next("insufficient_quota").retry, true);
});

test("the repeat guard normalizes whitespace and resets only when the whole error changes", () => {
	const b = new RetryBudget(config({ repeatLimit: 1 }));
	const first = b.next("503: node  A\nfailed");
	assert.match(first.errorFingerprint, /^[a-f0-9]{64}$/);
	assert.equal(b.next("503: node A failed").reason, "same error repeated");
	assert.equal(b.next("503: node B failed").retry, true);
	b.reset();
	assert.equal(b.next("503: node A failed").retry, true);
});

test("exponential backoff clamps at the ceiling but retains valid fractional delays", () => {
	const b = new RetryBudget(config({ baseDelayMs: 0.5, maxDelayMs: 3, repeatLimit: 0 }));
	assert.deepEqual(Array.from({ length: 5 }, () => b.next("400: failure").delayMs), [0.5, 1, 2, 3, 3]);
	const huge = new RetryBudget(config({ baseDelayMs: Number.MAX_VALUE, maxDelayMs: Number.MAX_VALUE }));
	assert.equal(huge.next("400: failure").delayMs, Number.MAX_SAFE_INTEGER);
});

test("tiny positive delays do not saturate before the product actually reaches the ceiling", () => {
	const b = new RetryBudget(config({ baseDelayMs: 1e-300, maxDelayMs: 600000000, repeatLimit: 0 }));
	let decision;
	for (let i = 0; i < 1025; i++) decision = b.next("400: failure");
	assert.equal(decision.delayMs, (1e-300 * 2 ** 1023) * 2);
});

test("unlimited zero backoff stays zero even after exponential overflow", () => {
	const b = new RetryBudget(config({ baseDelayMs: 0, maxDelayMs: 100, repeatLimit: 0 }));
	for (let i = 0; i < 1100; i++) {
		assert.equal(b.next("400: failure").delayMs, 0);
	}
});

test("repair is armed only for explicit replay loss, not generic 400s or ordinary errors", () => {
	const b = new RetryBudget(config());
	for (const error of ["400: invalid model", "503: unavailable", "upstream sent an error event"]) {
		assert.equal(b.next(error).repair, false);
	}
	for (const error of ["item not found", "created under a different Azure OpenAI resource", "belongs to a different upstream account"]) {
		assert.equal(b.next(error).repair, true);
	}
	assert.equal(new RetryBudget(config({ repairHistory: false })).next("item not found").repair, false);
});

test("ID repair is immutable and preserves bodies, reasoning, images, tool pairing and unknown/incomplete items", () => {
	const payload = {
		model: "real-wire-model", metadata: { id: "unrelated" },
		input: [
			{ type: "message", role: "user", id: "msg_user", content: [{ type: "input_image", image_url: "data:image/png;base64,fixture" }] },
			{ type: "message", role: "assistant", id: "msg_assistant", content: "Memory: 42", status: "completed" },
			{ type: "reasoning", id: "rs_keep", encrypted_content: "encrypted-fixture", summary: [] },
			{ type: "function_call", id: "fc", call_id: "call_keep", name: "once", arguments: '{"id":"argument-id"}' },
			{ type: "function_call_output", id: "fco", call_id: "call_keep", output: [{ type: "text", text: "completed once" }] },
			{ type: "custom_tool_call", id: "ctc", call_id: "custom_keep", name: "custom", input: "keep" },
			{ type: "custom_tool_call_output", id: "ctco", call_id: "custom_keep", output: "keep" },
			{ type: "opaque", id: "opaque_keep", value: "unknown" },
			{ type: "message", role: "assistant", id: "stream_keep", content: [], status: "in_progress" },
			{ type: "function_call", id: "incomplete_keep", call_id: "call_incomplete", name: "once" },
			{ type: "item_reference", id: "reference_keep" },
		],
	};
	const before = structuredClone(payload);
	const repaired = repairPayload(payload);
	assert.equal(repaired.removed, 6);
	assert.deepEqual(payload, before);
	assert.equal(repaired.payload.model, "real-wire-model");
	assert.deepEqual(repaired.payload.input.map(item => item.id),
		[undefined, undefined, "rs_keep", undefined, undefined, undefined, undefined, "opaque_keep", "stream_keep", "incomplete_keep", "reference_keep"]);
	for (let i = 0; i < before.input.length; i++) {
		const { id: _id, ...body } = before.input[i];
		const { id: _outId, ...outBody } = repaired.payload.input[i];
		assert.deepEqual(outBody, body);
	}
});

test("unsupported payloads and requests with nothing to repair stay untouched", () => {
	for (const payload of [null, 1, "text", [], { input: "text" }, { messages: [] }, { input: [] }, { input: [{ type: "reasoning", id: "keep" }] }]) {
		assert.equal(repairPayload(payload), undefined);
	}
});

test("cancelled backoff resolves promptly and removes its abort listener", async () => {
	const controller = new AbortController();
	const waiting = waitForRetry(60000, controller.signal);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	controller.abort();
	assert.equal(await waiting, false);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(await waitForRetry(60000, controller.signal), false);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("successful waits clean up; huge delays never overflow Node's timer", async t => {
	const controller = new AbortController();
	assert.equal(await waitForRetry(1, controller.signal), true);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(await waitForRetry(0), true);
	const warnings = [];
	const onWarning = warning => warnings.push(warning);
	process.on("warning", onWarning);
	t.after(() => process.off("warning", onWarning));
	const huge = waitForRetry(Number.MAX_SAFE_INTEGER, controller.signal);
	controller.abort();
	assert.equal(await huge, false);
	await new Promise(setImmediate);
	assert.equal(warnings.some(warning => warning.name === "TimeoutOverflowWarning"), false);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("logs accept decision metadata only, with private permissions and no error/payload/key dumping", t => {
	const dir = mkdtempSync(join(tmpdir(), "pi-retry-core-log-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "PRIVATE_PATH.jsonl");
	writeRetryLog(config({ debugLog: path }), {
		event: "retry_request", decision: "retry", attempt: 1, errorFingerprint: "a".repeat(64),
		stopReason: "PRIVATE_REASON", outcome: "PRIVATE_OUTCOME", attempts: "PRIVATE_ATTEMPTS",
		ts: "PRIVATE_TIMESTAMP", pid: "PRIVATE_PID",
		error: "PRIVATE_ERROR", errorMessage: "PRIVATE_ERROR_MESSAGE", apiKey: "PRIVATE_KEY",
		payload: { content: "PRIVATE_CONTENT" }, headers: { authorization: "PRIVATE_AUTH" },
		config: { debugLog: "PRIVATE_PATH", apiKey: "PRIVATE_CONFIG_KEY" },
	});
	const text = readFileSync(path, "utf8");
	assert.equal(text.includes("PRIVATE_"), false);
	const row = JSON.parse(text);
	assert.equal(row.attempt, 1);
	assert.equal(row.errorFingerprint, "a".repeat(64));
	for (const key of ["error", "errorMessage", "apiKey", "payload", "headers", "config"]) assert.equal(key in row, false);
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register from "../index.ts";

/** Minimal ExtensionAPI double: records handlers, returns them by event name. */
function harness(settings = {}) {
	const handlers = new Map();
	const notices = [];
	const userMessages = [];
	let abortCalls = 0;
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		getSettings: () => settings,
		// The extension must never impersonate the user; recorded so tests can prove it.
		sendUserMessage: async (content, options) => userMessages.push({ content, options }),
	};
	register(pi);
	const statuses = [];
	const workingMessages = [];
	const ctx = {
		hasUI: true,
		signal: undefined,
		abort: () => { abortCalls++; },
		ui: {
			notify: message => notices.push(message),
			setStatus: (key, text) => statuses.push([key, text]),
			setWorkingMessage: message => workingMessages.push(message),
		},
	};
	const fire = (name, event, context = ctx) => handlers.get(name)?.(event, context);
	const start = () => fire("session_start", { type: "session_start" });

	let attemptedCount = 0;
	const settle = async (error, context = ctx) => {
		const user = { role: "user", content: "hi" };
		const assistant = { role: "assistant", stopReason: error === undefined ? "stop" : "error", errorMessage: error };
		// The real SDK ends this low-level run before its terminal boundary.
		await fire("agent_start", { type: "agent_start" }, context);
		await fire("agent_end", { type: "agent_end", messages: [assistant] }, context);
		const result = await fire(
			"agent_before_settle",
			{
				type: "agent_before_settle",
				outcome: error === undefined ? "completed" : "error",
				entries: [],
				continue: false,
				context: {
					contextMessages: [user, assistant],
					contextEntries: [
						{ sourceEntry: { id: "e-user" }, messages: [user] },
						{ sourceEntry: { id: "e-assistant" }, messages: [assistant] },
					],
				},
			},
			context,
		);
		const attempted = result?.continue === true;
		if (attempted) {
			attemptedCount++;
			// Pi starts a native run before transforming its next request's context.
			await fire("agent_start", { type: "agent_start" }, context);
			await fire("turn_start", { type: "turn_start" }, context);
			await fire("context", { type: "context", messages: [user] }, context);
		}
		return { result, attempted };
	};
	return {
		notices,
		statuses,
		workingMessages,
		userMessages,
		start,
		settle,
		fire,
		get abortCalls() { return abortCalls; },
		get attemptedCount() {
			return attemptedCount;
		},
	};
}

const payloadWith = extra => ({
	model: "m",
	messages: [{ role: "user", content: "hi" }, ...extra],
	input: [{ type: "message", role: "user", id: "msg_abc", content: [{ type: "input_text", text: "hi" }] }, ...extra],
});

const historyWithIds = () => ({
	model: "m",
	input: [
		{ type: "message", role: "user", id: "msg_abc", content: [{ type: "input_text", text: "hi" }] },
		{ type: "reasoning", id: "rs_xyz", encrypted_content: "keep-me", summary: [] },
		{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
		{ type: "function_call_output", id: "fco_1", call_id: "call_1", output: "ok" },
	],
});

test("retries a 400 that Pi's built-in retry never retries", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal((await h.settle("400: different Azure OpenAI resource")).attempted, true);
});

test("retries unmapped upstream errors instead of giving up", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal((await h.settle("upstream sent an error event")).attempted, true);
});

test("a retry continues the run instead of sending a message", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const { result } = await h.settle("503: unavailable");
	assert.equal(result.continue, true);
	assert.equal(h.userMessages.length, 0, "a retry must never impersonate the user");
});

test("a retry drops the failed attempt from model context", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const { result } = await h.settle("503: unavailable");
	assert.deepEqual(result.entries, [{ type: "context_edit", targetId: "e-assistant", replacement: null }]);
});

test("a completed run is never retried", async () => {
	const h = harness();
	await h.start();
	assert.equal((await h.settle(undefined)).attempted, false);
});

test("quota errors stay out of the default policy", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal((await h.settle("insufficient_quota: billing hard limit reached")).attempted, false);
});

test("retryQuotaErrors opts quota errors back in", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, retryQuotaErrors: true } });
	await h.start();
	assert.equal((await h.settle("insufficient_quota")).attempted, true);
});

test("enabled: false disables the extension", async () => {
	const h = harness({ resilientRetry: { enabled: false } });
	await h.start();
	assert.equal((await h.settle("400: whatever")).attempted, false);
});

test("maxRetries bounds consecutive attempts", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, maxRetries: 2 } });
	await h.start();
	await h.settle("400: a");
	await h.settle("400: a");
	await h.settle("400: a");
	assert.equal(h.attemptedCount, 2);
});

test("a successful request resets the budget", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, maxRetries: 1 } });
	await h.start();
	assert.equal((await h.settle("400: a")).attempted, true);
	await h.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
	assert.equal((await h.settle("400: a")).attempted, true);
});

test("an aborted run is not retried", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const controller = new AbortController();
	controller.abort();
	const ctx = { hasUI: false, signal: controller.signal, ui: { notify() {}, setStatus() {}, setWorkingMessage() {} } };
	assert.equal((await h.settle("400: x", ctx)).attempted, false);
});

test("a non-error settle boundary is ignored", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const result = await h.fire("agent_before_settle", {
		outcome: "completed",
		entries: [],
		context: { contextMessages: [{ role: "assistant", stopReason: "stop" }], contextEntries: [] },
	});
	assert.equal(result?.continue, undefined);
});

test("the default budget is unlimited", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, repeatLimit: 0 } });
	await h.start();
	for (let i = 0; i < 60; i++) await h.settle("upstream sent an error event");
	assert.equal(h.attemptedCount, 60);
});

test("the same error repeated stops retrying instead of looping forever", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, repeatLimit: 3 } });
	await h.start();
	for (let i = 0; i < 6; i++) await h.settle("400: created under a different Azure OpenAI resource");
	assert.equal(h.attemptedCount, 3, "must stop after repeatLimit attempts");
});

test("a changing error keeps retrying without limit", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, repeatLimit: 2 } });
	await h.start();
	for (let i = 0; i < 6; i++) await h.settle(`503: node ${i} unavailable`);
	assert.equal(h.attemptedCount, 6);
});

test("a successful request resets the repeat counter", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, repeatLimit: 1 } });
	await h.start();
	await h.settle("503: same");
	await h.settle("503: same");
	await h.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
	await h.settle("503: same");
	assert.equal(h.attemptedCount, 2, "after a success the same error may retry again");
});

test("the default repeat limit allows 30 attempts of one unchanged error", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	for (let i = 0; i < 40; i++) await h.settle("400: same failure");
	assert.equal(h.attemptedCount, 30);
});

test("a retried request drops replay ids when the session ids are dead", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle('400: {"message":"The requested item was created under a different Azure OpenAI resource."}');
	const out = h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() });
	assert.deepEqual(out.input.map(i => i.id), [undefined, "rs_xyz", undefined, undefined]);
	assert.equal(out.input[1].encrypted_content, "keep-me");
	assert.equal(out.input[2].call_id, "call_1");
});

test("an ordinary retry keeps the history byte-identical", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("503: upstream temporarily unavailable");
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() }), undefined);
});

test("a generic 400 does not strip history", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("400: bad request, invalid model name");
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() }), undefined);
});

test("the account-mismatch wording also strips history", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("The replayed conversation state belongs to a different upstream account.");
	assert.notEqual(h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() }), undefined);
});

test("repairHistory: false never strips, even for a dead session", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, repairHistory: false } });
	await h.start();
	await h.settle("400: created under a different Azure OpenAI resource");
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() }), undefined);
});

test("only one request is repaired per retry", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("400: created under a different Azure OpenAI resource");
	h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() });
	assert.equal(
		h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() }),
		undefined,
		"a second request must keep its history",
	);
});

test("legacy visibleRetry/noticeEvery settings never add conversation markers", async () => {
	for (const visibleRetry of [true, "always", "first", false, "never"]) {
		const h = harness({ resilientRetry: { baseDelayMs: 0, maxDelayMs: 0, visibleRetry, noticeEvery: 1 } });
		await h.start();
		for (let i = 0; i < 3; i++) {
			const { result } = await h.settle("503: unavailable");
			assert.deepEqual(result.entries, [{ type: "context_edit", targetId: "e-assistant", replacement: null }]);
		}
		assert.equal(h.userMessages.length, 0);
	}
});

test("legacy retry custom messages are filtered by identity before model conversion", async () => {
	const h = harness();
	await h.start();
	const real = [
		{ role: "user", content: "Please fix pi-resilient-retry" },
		{ role: "assistant", content: [{ type: "text", text: "pi-resilient-retry source" }] },
		{ role: "toolResult", content: [{ type: "text", text: "pi-resilient-retry" }] },
		{ role: "custom", customType: "another-extension", content: "pi-resilient-retry" },
	];
	const legacy = { role: "custom", customType: "resilient-retry", content: "old notice", display: false };
	const messages = [...real, legacy];
	const before = structuredClone(messages);
	const result = await h.fire("context", { type: "context", messages });
	assert.deepEqual(result.messages, real);
	assert.deepEqual(messages, before, "raw session history must not be mutated");
	assert.equal(await h.fire("context", { type: "context", messages: real }), undefined);
});

test("a user, assistant or tool mentioning the marker must never be stripped from a payload", async () => {
	const h = harness();
	await h.start();
	const payload = payloadWith([
		{ role: "user", content: "Please fix pi-resilient-retry" },
		{ role: "assistant", content: [{ type: "text", text: "pi-resilient-retry source" }] },
		{ role: "tool", content: "pi-resilient-retry" },
	]);
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload }), undefined);
});

test("native working text covers waiting and requesting, then resets on final settlement", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("503: unavailable");
	assert.match(h.workingMessages[0], /等待重试/);
	assert.match(h.workingMessages.at(-1), /正在重试/);
	await h.fire("agent_settled", { type: "agent_settled", aborted: false });
	assert.equal(h.workingMessages.at(-1), undefined);
});

test("native working text resets when the retry budget is exhausted", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 0, maxDelayMs: 0, maxRetries: 1 } });
	await h.start();
	await h.settle("400: error");
	assert.equal((await h.settle("400: error")).attempted, false);
	assert.equal(h.workingMessages.at(-1), undefined);
});

test("the failed assistant turn is left to context_edit, not payload surgery", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("503: unavailable");
	const payload = { input: [{ type: "message", role: "assistant", content: [] }] };
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload }), undefined);
});

test("normal runs do not overwrite another extension's native working text", async () => {
	const h = harness();
	await h.start();
	await h.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
	await h.fire("agent_settled", { type: "agent_settled", aborted: false });
	await h.fire("session_shutdown", { type: "session_shutdown" });
	assert.deepEqual(h.workingMessages, []);
});

test("session shutdown wakes retry backoff and disarms history repair", { timeout: 1000 }, async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 5000, maxDelayMs: 5000 } });
	await h.start();
	const waiting = h.settle("400: created under a different Azure OpenAI resource");
	await new Promise(setImmediate);
	assert.match(h.workingMessages.at(-1), /等待重试/);
	await h.fire("session_shutdown", { type: "session_shutdown" });
	await waiting;
	assert.equal(h.abortCalls, 1);
	assert.equal(h.workingMessages.at(-1), undefined);
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload: historyWithIds() }), undefined);
});

test("backoff is consumed once, not repeated for later requests in the continued run", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("503: error");
	const before = [...h.workingMessages];
	await h.fire("context", { type: "context", messages: [{ role: "user", content: "hi" }] });
	assert.deepEqual(h.workingMessages, before);
});

test("different long errors sharing a prefix do not exhaust the identical-error guard", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 0, maxDelayMs: 0, repeatLimit: 1 } });
	await h.start();
	const prefix = "relay diagnostic ".repeat(30);
	assert.equal((await h.settle(`${prefix}node A failed`)).attempted, true);
	assert.equal((await h.settle(`${prefix}node B failed`)).attempted, true);
});

test("decision logs contain neither raw upstream errors nor the configured sink path", async t => {
	const dir = mkdtempSync(join(tmpdir(), "pi-retry-log-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const debugLog = join(dir, "PRIVATE_PATH.jsonl");
	const h = harness({ resilientRetry: { baseDelayMs: 0, maxDelayMs: 0, debugLog } });
	await h.start();
	await h.settle("400: Authorization: Bearer PRIVATE_KEY; query=PRIVATE_TOKEN; response=PRIVATE_TEXT");
	const text = readFileSync(debugLog, "utf8");
	assert.equal(text.includes("PRIVATE_"), false, "untrusted error text and sink paths must not be persisted");
	const rows = text.trim().split("\n").map(line => JSON.parse(line));
	const decision = rows.find(row => row.decision === "retry");
	assert.match(decision.errorFingerprint, /^[a-f0-9]{64}$/);
	assert.equal("error" in decision, false);
	assert.equal("debugLog" in rows[0].config, false);
});

test("a broken debug sink never prevents retry", async t => {
	const dir = mkdtempSync(join(tmpdir(), "pi-retry-log-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const h = harness({ resilientRetry: { baseDelayMs: 0, maxDelayMs: 0, debugLog: join(dir, "missing", "log") } });
	await h.start();
	assert.equal((await h.settle("400: relay failed")).attempted, true);
});

test("fractional backoff remains fractional instead of jumping to the ceiling", async t => {
	const dir = mkdtempSync(join(tmpdir(), "pi-retry-delay-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const debugLog = join(dir, "decisions.jsonl");
	const h = harness({ resilientRetry: { baseDelayMs: 0.5, maxDelayMs: 1, debugLog } });
	await h.start();
	await h.settle("400: relay failed");
	const rows = readFileSync(debugLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(rows.find(row => row.decision === "retry").delayMs, 0.5);
});

test("public aborted settlement resets a budget even when a provider ended with error", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 0, maxDelayMs: 0, maxRetries: 1, repeatLimit: 1 } });
	await h.start();
	assert.equal((await h.settle("400: relay failed")).attempted, true);
	await h.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] });
	await h.fire("agent_settled", { type: "agent_settled", aborted: true });
	assert.equal((await h.settle("400: relay failed")).attempted, true, "Stop must not spend the next run's retry budget");
});

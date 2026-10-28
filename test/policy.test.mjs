import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../index.ts";

/** Minimal ExtensionAPI double: records handlers, returns them by event name. */
function harness(settings = {}) {
	const handlers = new Map();
	const notices = [];
	const sent = [];
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		getSettings: () => settings,
		sendUserMessage: async (content, options) => {
			sent.push({ content, options });
		},
	};
	register(pi);
	const statuses = [];
	const ctx = {
		hasUI: true,
		signal: undefined,
		ui: {
			notify: message => notices.push(message),
			setStatus: (key, text) => statuses.push([key, text]),
			setWorkingMessage: () => {},
		},
	};
	const fire = (name, event, context = ctx) => handlers.get(name)?.(event, context);
	const start = () => fire("session_start", { type: "session_start" });
	let attemptedCount = 0;
	/** A settle boundary whose latest assistant message failed with `error`. */
	const settle = async (error, context = ctx) => {
		const before = sent.length;
		const user = { role: "user", content: "hi" };
		const assistant = { role: "assistant", stopReason: error === undefined ? "stop" : "error", errorMessage: error };
		const result = await fire(
			"agent_before_settle",
			{
				type: "agent_before_settle",
				outcome: error === undefined ? "completed" : "error",
				entries: [],
				continue: false,
				context: {
					contextMessages: [user, assistant],
					// Projected entries: the extension drops the failed assistant message by id.
					contextEntries: [
						{ sourceEntry: { id: "e-user" }, messages: [user] },
						{ sourceEntry: { id: "e-assistant" }, messages: [assistant] },
					],
				},
			},
			context,
		);
		const sentDelta = sent.length - before;
		const attempted = result?.continue === true || sentDelta > 0;
		if (attempted) attemptedCount++;
		return { result, sentDelta, attempted };
	};
	return {
		notices,
		statuses,
		sent,
		start,
		settle,
		fire,
		get attemptedCount() {
			return attemptedCount;
		},
	};
}



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
	assert.equal((await h.settle("400: x", { hasUI: false, signal: controller.signal, ui: { notify() {} } })).attempted, false);
});

test("a non-error settle boundary is ignored", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const result = await h.fire("agent_before_settle", {
		outcome: "completed",
		entries: [],
		context: { contextMessages: [{ role: "assistant", stopReason: "stop" }] },
	});
	assert.equal(result?.continue, undefined);
});

test("a relay rejection is retried: the next node may accept it", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const error =
		'agentrouter-github API error (400): {"message":"The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=4c18025ce4727ec73372a3ca4c1e1195]","type":"invalid_request_error","param":"","code":null}';
	assert.equal((await h.settle(error)).attempted, true);
});

test("an auth rejection is retried too: relay keys differ per node", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal((await h.settle("401: invalid api key for this upstream")).attempted, true);
});

test("the default budget is unlimited", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, repeatLimit: 0 } });
	await h.start();
	for (let i = 0; i < 60; i++) await h.settle("upstream sent an error event");
	assert.equal(h.attemptedCount, 60);
});

test("a retry shows visible status while waiting", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 30, maxDelayMs: 30 } });
	await h.start();
	const pending = h.settle("upstream sent an error event");
	await new Promise(r => setTimeout(r, 10));
	assert.match(JSON.stringify(h.statuses), /重试第 1/);
	await pending;
});

/** Registers the extension and runs one settle for `error`. */
async function settleWith(error, settings = {}) {
	const handlers = new Map();
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		getSettings: () => ({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, ...settings } }),
	};
	register(pi);
	const ctx = { hasUI: false, signal: undefined, ui: { notify() {}, setStatus() {}, setWorkingMessage() {} } };
	handlers.get("session_start")({}, ctx);
	await handlers.get("agent_before_settle")(
		{ outcome: "error", entries: [], context: { contextMessages: [{ role: "assistant", stopReason: "error", errorMessage: error }] } },
		ctx,
	);
	return handlers;
}

const historyPayload = () => ({
	model: "m",
	input: [
		{ type: "message", role: "user", id: "msg_abc", content: [{ type: "input_text", text: "hi" }] },
		{ type: "reasoning", id: "rs_xyz", encrypted_content: "keep-me", summary: [] },
		{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
		{ type: "function_call_output", id: "fco_1", call_id: "call_1", output: "ok" },
	],
});

test("a retried request drops replay ids when the session ids are dead", async () => {
	const handlers = await settleWith(
		'400: {"message":"The requested item was created under a different Azure OpenAI resource.","type":"invalid_request_error"}',
	);
	const payload = historyPayload();
	const repaired = handlers.get("before_provider_request")({ type: "before_provider_request", payload });
	assert.deepEqual(
		repaired.input.map(i => i.id),
		[undefined, "rs_xyz", undefined, undefined],
	);
	// Reasoning items and call ids must survive; only replay-only ids are dropped.
	assert.equal(repaired.input[1].encrypted_content, "keep-me");
	assert.equal(repaired.input[2].call_id, "call_1");
	assert.deepEqual(repaired.input[0].content, [{ type: "input_text", text: "hi" }]);
});

test("an ordinary retry keeps the history byte-identical", async () => {
	const handlers = await settleWith("503: upstream temporarily unavailable");
	const payload = historyPayload();
	const out = handlers.get("before_provider_request")({ type: "before_provider_request", payload });
	assert.equal(out, undefined, "history must not be stripped for a plain transient error");
});

test("a generic 400 does not strip history", async () => {
	const handlers = await settleWith("400: bad request, invalid model name");
	const payload = historyPayload();
	assert.equal(handlers.get("before_provider_request")({ type: "before_provider_request", payload }), undefined);
});

test("the account-mismatch wording also strips history", async () => {
	const handlers = await settleWith("The replayed conversation state belongs to a different upstream account. Start a new conversation and retry.");
	assert.notEqual(handlers.get("before_provider_request")({ type: "before_provider_request", payload: historyPayload() }), undefined);
});

test("repairHistory: false never strips, even for a dead session", async () => {
	const handlers = await settleWith("400: created under a different Azure OpenAI resource", { repairHistory: false });
	assert.equal(handlers.get("before_provider_request")({ type: "before_provider_request", payload: historyPayload() }), undefined);
});

test("only one request is repaired per retry", async () => {
	const handlers = await settleWith("400: created under a different Azure OpenAI resource");
	handlers.get("before_provider_request")({ type: "before_provider_request", payload: historyPayload() });
	assert.equal(
		handlers.get("before_provider_request")({ type: "before_provider_request", payload: historyPayload() }),
		undefined,
		"a second request must keep its history",
	);
});

test("ordinary requests are never repaired", async () => {
	const handlers = new Map();
	const pi = { on: (n, h) => handlers.set(n, h), getSettings: () => ({}) };
	register(pi);
	handlers.get("session_start")({}, { hasUI: false, ui: {} });
	const payload = { input: [{ type: "message", role: "user", id: "msg_abc", content: "hi" }] };
	assert.equal(handlers.get("before_provider_request")({ type: "before_provider_request", payload }), undefined);
});

test("by default only the first retry of a burst is visible", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("503: unavailable");
	await h.settle("503: unavailable");
	await h.settle("503: unavailable");
	assert.equal(h.attemptedCount, 3);
	assert.equal(h.sent.length, 1, "later retries must not add context");
	assert.match(h.sent[0].content, /pi-resilient-retry/);
	assert.match(h.sent[0].content, /第 1 次/);
	assert.equal(h.sent[0].options.deliverAs, "followUp");
});

test("silent retries drop the failed attempt from model context", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, visibleRetry: "never" } });
	await h.start();
	const first = await h.settle("503: unavailable");
	assert.equal(first.result.continue, true);
	assert.deepEqual(first.result.entries, [{ type: "context_edit", targetId: "e-assistant", replacement: null }]);
	assert.equal(h.sent.length, 0, "silent mode must not add messages");
});

test("visibleRetry: always writes every attempt", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, visibleRetry: "always" } });
	await h.start();
	await h.settle("503: unavailable");
	await h.settle("503: unavailable");
	assert.equal(h.sent.length, 2);
	assert.match(h.sent[1].content, /第 2 次/);
});


test("a dead session is announced in the retry message", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("400: created under a different Azure OpenAI resource");
	assert.match(h.sent[0].content, /已剥离失效的历史 id/);
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

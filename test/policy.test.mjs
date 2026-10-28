import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../index.ts";

/** Minimal ExtensionAPI double: records handlers, returns them by event name. */
function harness(settings = {}) {
	const handlers = new Map();
	const notices = [];
	const userMessages = [];
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
	const settle = async (error, context = ctx) => {
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
					contextEntries: [
						{ sourceEntry: { id: "e-user" }, messages: [user] },
						{ sourceEntry: { id: "e-assistant" }, messages: [assistant] },
					],
				},
			},
			context,
		);
		const attempted = result?.continue === true;
		if (attempted) attemptedCount++;
		return { result, attempted };
	};
	return {
		notices,
		statuses,
		userMessages,
		start,
		settle,
		fire,
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

test("retry markers never reach the model", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, visibleRetry: true } });
	await h.start();
	const { result } = await h.settle("503: unavailable");
	const marker = result.entries.find(entry => entry.type === "custom_message");
	assert.ok(marker, "visibleRetry adds a marker entry");
	const out = h.fire("before_provider_request", {
		type: "before_provider_request",
		payload: payloadWith([
			{ role: "assistant", content: [] },
			{ role: "custom", content: marker.content },
		]),
	});
	assert.deepEqual(out.messages, [{ role: "user", content: "hi" }, { role: "assistant", content: [] }]);
});

test("visibleRetry is off by default so nothing is written", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const { result } = await h.settle("503: unavailable");
	assert.equal(result.entries.length, 1, "only the context_edit entry");
	assert.equal(result.entries[0].type, "context_edit");
});

test("noticeEvery thins out printed retries but keeps the first", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, visibleRetry: true, noticeEvery: 3 } });
	await h.start();
	const printed = [];
	for (let i = 0; i < 6; i++) {
		const { result } = await h.settle(`503: attempt ${i}`);
		const marker = result.entries.find(entry => entry.type === "custom_message");
		if (marker) printed.push(marker.content);
	}
	assert.equal(printed.length, 3);
	assert.match(printed[0], /第 1 次/);
	assert.match(printed[1], /第 3 次/);
	assert.match(printed[2], /第 6 次/);
});

test("stripping never leaves an empty history", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, visibleRetry: true } });
	await h.start();
	const { result } = await h.settle("503: unavailable");
	const marker = result.entries.find(entry => entry.type === "custom_message");
	// The only item is our own marker: removing it would empty the request.
	const payload = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: marker.content }] }] };
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload }), undefined);
});

test("stripping keeps the conversation when a marker is among real messages", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, visibleRetry: true } });
	await h.start();
	const { result } = await h.settle("503: unavailable");
	const marker = result.entries.find(entry => entry.type === "custom_message");
	const payload = {
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "real question" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: marker.content }] },
		],
	};
	const out = h.fire("before_provider_request", { type: "before_provider_request", payload });
	assert.equal(out.input.length, 1);
	assert.equal(out.input[0].content[0].text, "real question");
});

test("the failed assistant turn is left to context_edit, not payload surgery", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	await h.settle("503: unavailable");
	const payload = { input: [{ type: "message", role: "assistant", content: [] }] };
	assert.equal(h.fire("before_provider_request", { type: "before_provider_request", payload }), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../index.ts";

/** Minimal ExtensionAPI double: records handlers, returns them by event name. */
function harness(settings = {}) {
	const handlers = new Map();
	const notices = [];
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		getSettings: () => settings,
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
	/** A settle boundary whose latest assistant message failed with `error`. */
	const settle = (error, context = ctx) =>
		fire(
			"agent_before_settle",
			{
				type: "agent_before_settle",
				outcome: error === undefined ? "completed" : "error",
				entries: [],
				continue: false,
				context: {
					contextMessages: [
						{ role: "user", content: "hi" },
						{ role: "assistant", stopReason: error === undefined ? "stop" : "error", errorMessage: error },
					],
				},
			},
			context,
		);
	return { notices, statuses, start, settle, fire };
}

const retries = result => result?.continue === true;

test("retries a 400 that Pi's built-in retry never retries", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal(retries(await h.settle("400: different Azure OpenAI resource")), true);
});

test("retries unmapped upstream errors instead of giving up", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal(retries(await h.settle("upstream sent an error event")), true);
});

test("a completed run is never retried", async () => {
	const h = harness();
	await h.start();
	assert.equal(retries(await h.settle(undefined)), false);
});

test("quota errors stay out of the default policy", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal(retries(await h.settle("insufficient_quota: billing hard limit reached")), false);
});

test("retryQuotaErrors opts quota errors back in", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, retryQuotaErrors: true } });
	await h.start();
	assert.equal(retries(await h.settle("insufficient_quota")), true);
});

test("enabled: false disables the extension", async () => {
	const h = harness({ resilientRetry: { enabled: false } });
	await h.start();
	assert.equal(retries(await h.settle("400: whatever")), false);
});

test("maxRetries bounds consecutive attempts", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, maxRetries: 2 } });
	await h.start();
	assert.equal(retries(await h.settle("400: a")), true);
	assert.equal(retries(await h.settle("400: a")), true);
	assert.equal(retries(await h.settle("400: a")), false);
});

test("a successful request resets the budget", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, maxRetries: 1 } });
	await h.start();
	assert.equal(retries(await h.settle("400: a")), true);
	await h.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
	assert.equal(retries(await h.settle("400: a")), true);
});

test("an aborted run is not retried", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const controller = new AbortController();
	controller.abort();
	assert.equal(retries(await h.settle("400: x", { hasUI: false, signal: controller.signal, ui: { notify() {} } })), false);
});

test("a non-error settle boundary is ignored", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const result = await h.fire("agent_before_settle", {
		outcome: "completed",
		entries: [],
		context: { contextMessages: [{ role: "assistant", stopReason: "stop" }] },
	});
	assert.equal(retries(result), false);
});

test("a relay rejection is retried: the next node may accept it", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	const error =
		'agentrouter-github API error (400): {"message":"The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=4c18025ce4727ec73372a3ca4c1e1195]","type":"invalid_request_error","param":"","code":null}';
	assert.equal(retries(await h.settle(error)), true);
});

test("an auth rejection is retried too: relay keys differ per node", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	assert.equal(retries(await h.settle("401: invalid api key for this upstream")), true);
});

test("the default budget is finite", async () => {
	// Keep the real default in view but shrink delays so the test stays fast.
	const h = harness({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } });
	await h.start();
	let attempts = 0;
	while (attempts < 100 && retries(await h.settle("upstream sent an error event"))) attempts++;
	assert.equal(attempts, 20);
});

test("a retry shows visible status while waiting", async () => {
	const h = harness({ resilientRetry: { baseDelayMs: 30, maxDelayMs: 30 } });
	await h.start();
	const pending = h.settle("upstream sent an error event");
	await new Promise(r => setTimeout(r, 10));
	assert.match(JSON.stringify(h.statuses), /重试第 1/);
	await pending;
});

test("a retried request drops replay ids so another node can accept it", async () => {
	const handlers = new Map();
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		getSettings: () => ({ resilientRetry: { baseDelayMs: 1, maxDelayMs: 1 } }),
	};
	register(pi);
	const ctx = { hasUI: false, signal: undefined, ui: { notify() {}, setStatus() {}, setWorkingMessage() {} } };
	handlers.get("session_start")({}, ctx);
	await handlers.get("agent_before_settle")(
		{
			outcome: "error",
			entries: [],
			context: { contextMessages: [{ role: "assistant", stopReason: "error", errorMessage: "400: different resource" }] },
		},
		ctx,
	);
	const payload = {
		model: "m",
		input: [
			{ type: "message", role: "user", id: "msg_abc", content: [{ type: "input_text", text: "hi" }] },
			{ type: "reasoning", id: "rs_xyz", encrypted_content: "keep-me", summary: [] },
			{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call_output", id: "fco_1", call_id: "call_1", output: "ok" },
		],
	};
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

test("ordinary requests are never repaired", async () => {
	const handlers = new Map();
	const pi = { on: (n, h) => handlers.set(n, h), getSettings: () => ({}) };
	register(pi);
	handlers.get("session_start")({}, { hasUI: false, ui: {} });
	const payload = { input: [{ type: "message", role: "user", id: "msg_abc", content: "hi" }] };
	assert.equal(handlers.get("before_provider_request")({ type: "before_provider_request", payload }), undefined);
});

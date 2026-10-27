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
	const ctx = {
		hasUI: true,
		signal: undefined,
		ui: { notify: message => notices.push(message) },
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
	return { notices, start, settle, fire };
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

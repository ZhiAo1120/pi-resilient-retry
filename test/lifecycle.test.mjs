import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register from "../index.ts";

// The same checks can run against an embedding host's SDK, not just the dev dependency.
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
	await import(process.env.PI_RETRY_TEST_SDK ?? "@earendil-works/pi-coding-agent");

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Real Pi lifecycle and HTTP payloads, with no user config, credentials, or external API. */
async function fixture(t, { failures = 2, status = 400, errorMessage = "relay rejected this node",
	delayMs = 120, retry = {}, nativeRetry = {}, providerRetry = {}, onEvent,
	toolFirst = false, legacyNotices = false, loadPlugin = true, observeProvider = false, boundaryEdit = false, ui = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-retry-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const requests = [];
	const events = [];
	const extensionErrors = [];
	const signals = [];
	const boundaries = [];
	const providerCalls = [];
	const workingMessages = [];
	let toolExecutions = 0;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		requests.push({ raw, payload: JSON.parse(raw), time: performance.now() });
		const toolResponse = toolFirst && requests.length === 1;
		if (!toolResponse && requests.length <= failures + (toolFirst ? 1 : 0)) {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: errorMessage } }));
			return;
		}
		const delta = toolResponse
			? { role: "assistant", tool_calls: [{ index: 0, id: "call_once", type: "function", function: { name: "once", arguments: "{}" } }] }
			: { role: "assistant", content: "Recovered" };
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({
			id: "local-response", object: "chat.completion.chunk", model: "fixture",
			choices: [{ index: 0, delta, finish_reason: null }],
		})}\n\ndata: ${JSON.stringify({
			id: "local-response", object: "chat.completion.chunk", model: "fixture",
			choices: [{ index: 0, delta: {}, finish_reason: toolResponse ? "tool_calls" : "stop" }],
		})}\n\ndata: [DONE]\n\n`);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		// Count agent-level native retries independently of SDK/client retries in this fixture.
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, ...nativeRetry,
			provider: { maxRetries: 0, ...providerRetry } },
		resilientRetry: { baseDelayMs: delayMs, maxDelayMs: delayMs, maxRetries: 3, ...retry },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-cache"),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	modelRuntime.registerProvider("retry-fixture", {
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		api: "openai-completions", apiKey: "local-test-only",
		models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024, reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	if (observeProvider) {
		const original = modelRuntime.getProvider("retry-fixture");
		modelRuntime.registerProvider("retry-fixture", {
			api: "openai-completions",
			streamSimple(model, context, options) {
				// Observe only public option keys/run identity, never auth, payloads or private state.
				providerCalls.push({ keys: Object.keys(options ?? {}), signal: options?.signal, sessionId: options?.sessionId });
				return original.streamSimple(model, context, options);
			},
		});
	}
	const originalRetrySettings = settingsManager.getRetrySettings();
	const originalProviderRetrySettings = settingsManager.getProviderRetrySettings();
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Local retry regression test.",
		extensionFactories: [...(boundaryEdit ? [pi => {
			pi.on("agent_before_settle", event => {
				if (event.outcome !== "error") return;
				const entry = event.context.contextEntries.find(entry => entry.messages.some(message =>
					message.role === "user" && typeof message.content === "string" && message.content.includes("Remember the number 42")));
				if (!entry) return;
				return { entries: [...event.entries, { type: "context_edit", targetId: entry.sourceEntry.id,
					replacement: { content: "Other extension kept earlier memory: 43" } }] };
			});
		}] : []), ...(loadPlugin ? [pi => {
			pi.on("context", (_event, ctx) => { signals.push(ctx.signal); });
			pi.on("agent_before_settle", event => { boundaries.push({ outcome: event.outcome, time: performance.now() }); });
			register(pi);
		}] : []), ...(toolFirst ? [pi => {
			pi.registerTool({
				name: "once", label: "Once", description: "Count one completed operation.",
				parameters: { type: "object", properties: {} },
				execute: async () => { toolExecutions++; return { content: [{ type: "text", text: "operation complete" }], details: undefined }; },
			});
			pi.on("session_start", () => pi.setActiveTools(["once"]));
		}] : [])],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const manager = SessionManager.inMemory(dir);
	manager.appendMessage({ role: "user", content: "Remember the number 42.", timestamp: 1 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Remembered: 42." }],
		api: "openai-completions", provider: "retry-fixture", model: "fixture", usage,
		stopReason: "stop", timestamp: 2 });
	if (legacyNotices) {
		manager.appendCustomMessageEntry("resilient-retry", "Legacy retry notice", true);
		manager.appendCustomMessageEntry("another-extension", "Other pi-resilient-retry reference", true);
	}
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, resourceLoader, settingsManager, sessionManager: manager, modelRuntime,
		model: modelRuntime.getModel("retry-fixture", "fixture"), thinkingLevel: "off", noTools: toolFirst ? "builtin" : "all",
	});
	t.after(async () => { await session.abort(); session.dispose(); });
	await session.bindExtensions({ onError: error => extensionErrors.push(error),
		...(ui ? { uiContext: { setWorkingMessage: message => workingMessages.push(message) } } : {}) });
	session.subscribe(event => {
		events.push({ ...event, time: performance.now() });
		onEvent?.(event, session);
	});
	return { session, manager, requests, events, extensionErrors, signals, boundaries, providerCalls,
		settingsManager, originalRetrySettings, originalProviderRetrySettings, workingMessages, delayMs,
		get toolExecutions() { return toolExecutions; } };
}

test("retry backoff runs after native agent_start AND turn_start, with identical real payloads", { timeout: 10000 }, async t => {
	const h = await fixture(t, { retry: { visibleRetry: true } });
	await h.session.prompt("Keep pi-resilient-retry native; what number did I ask you to remember?");
	assert.deepEqual(h.extensionErrors, []);
	assert.equal(h.requests.length, 3);
	const starts = h.events.filter(e => e.type === "agent_start");
	const turns = h.events.filter(e => e.type === "turn_start");
	assert.equal(starts.length, 3);
	assert.equal(turns.length, 3);
	for (let i = 1; i < h.requests.length; i++) {
		assert.ok(h.requests[i].time - turns[i].time >= h.delayMs - 10,
			"backoff must happen while BOTH native indicators are active, not between agent_end and agent_start");
		assert.ok(turns[i].time >= starts[i].time);
		assert.equal(h.events.some(e => e.type === "agent_end" && e.time > starts[i].time && e.time < h.requests[i].time), false);
		assert.equal(h.requests[i].raw, h.requests[0].raw, "a retry must not change the model input");
	}
	const messages = h.requests[0].payload.messages;
	assert.ok(JSON.stringify(messages).includes("Remembered: 42."), "prior memory survives");
	assert.ok(JSON.stringify(messages).includes("Keep pi-resilient-retry native"), "mentioning the package must not erase a user message");
	assert.equal(h.manager.getBranch().filter(e => e.type === "custom_message").length, 0);
	assert.equal(h.manager.getBranch().filter(e => e.type === "message" && e.message.role === "user").length, 2);
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1);
	assert.equal(h.session.isIdle, true);
});

test("Stop during native retry backoff prevents another HTTP request and settles", { timeout: 10000 }, async t => {
	let starts = 0;
	let abortedAt;
	let abortPromise;
	const h = await fixture(t, {
		delayMs: 5000,
		onEvent(event, session) {
			if (event.type !== "agent_start" || ++starts !== 2) return;
			const timer = setTimeout(() => { abortedAt = performance.now(); abortPromise = session.abort(); }, 20);
			t.after(() => clearTimeout(timer));
		},
	});
	await h.session.prompt("Test cancellation");
	await abortPromise;
	assert.ok(abortedAt !== undefined, "a retry must have started natively");
	assert.ok(performance.now() - abortedAt < 1000, "Stop must interrupt the backoff rather than wait five seconds");
	assert.equal(h.requests.length, 1, "an aborted retry must not reach the provider");
	assert.equal(h.events.at(-1).type, "agent_settled");
	// Pi 1.2.1 omits agent_settled.aborted and providers can report an aborted call as error.
	// Inspect the actual request signal, alongside zero further HTTP calls and final idle state.
	assert.equal(h.signals.at(-1).aborted, true);
	assert.equal(h.session.isIdle, true);
	assert.deepEqual(h.extensionErrors, []);
});

test("budget exhaustion settles instead of leaving native activity stuck", { timeout: 10000 }, async t => {
	const h = await fixture(t, { failures: 10, delayMs: 1, retry: { maxRetries: 1 } });
	await h.session.prompt("Test the retry cap");
	assert.equal(h.requests.length, 2);
	assert.equal(h.events.filter(e => e.type === "agent_start").length, 2);
	assert.equal(h.events.at(-1).type, "agent_settled");
	assert.equal(h.session.isIdle, true);
	assert.deepEqual(h.extensionErrors, []);
});

test("unlimited mode preserves the request through multiple failures", { timeout: 10000 }, async t => {
	const h = await fixture(t, { failures: 4, delayMs: 1, retry: { maxRetries: 0, repeatLimit: 0 } });
	await h.session.prompt("Test unlimited retry");
	assert.equal(h.requests.length, 5);
	assert.equal(new Set(h.requests.map(r => r.raw)).size, 1);
	assert.equal(h.events.at(-1).type, "agent_settled");
	assert.deepEqual(h.extensionErrors, []);
});

test("retry after a tool result preserves the result without executing the tool again", { timeout: 10000 }, async t => {
	const h = await fixture(t, { toolFirst: true, delayMs: 1 });
	await h.session.prompt("Perform the operation once, then report it");
	assert.equal(h.toolExecutions, 1);
	assert.equal(h.requests.length, 4);
	const followUps = h.requests.slice(1);
	assert.equal(new Set(followUps.map(r => r.raw)).size, 1);
	assert.ok(followUps[0].payload.messages.some(m => m.role === "tool" && m.tool_call_id === "call_once"));
	assert.equal(h.manager.getBranch().filter(e => e.type === "custom_message").length, 0);
	assert.deepEqual(h.extensionErrors, []);
});

test("old custom notices stay in raw history but not in real provider input", { timeout: 10000 }, async t => {
	const h = await fixture(t, { legacyNotices: true, failures: 0, delayMs: 1 });
	await h.session.prompt("Use the real history");
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].raw.includes("Legacy retry notice"), false);
	assert.equal(h.requests[0].raw.includes("Other pi-resilient-retry reference"), true);
	assert.equal(h.manager.getBranch().filter(e => e.type === "custom_message").length, 2, "raw history is not rewritten");
	assert.deepEqual(h.extensionErrors, []);
});

test("Pi native retries exhaust before the plugin can retry the original request", { timeout: 10000 }, async t => {
	const h = await fixture(t, { status: 503, failures: 2, delayMs: 40, retry: { maxRetries: 1 }, observeProvider: true });
	await h.session.prompt("Native first, then plugin");
	assert.equal(h.requests.length, 3, "original + one native retry + one plugin continuation");
	assert.equal(new Set(h.requests.map(r => r.raw)).size, 1);
	const nativeStart = h.events.find(e => e.type === "auto_retry_start");
	const nativeEnd = h.events.find(e => e.type === "auto_retry_end" && e.success === false);
	const boundary = h.boundaries.find(e => e.outcome === "error");
	assert.ok(nativeStart && nativeEnd && boundary);
	assert.ok(h.requests[0].time < nativeStart.time && nativeStart.time < h.requests[1].time);
	assert.ok(h.requests[1].time < nativeEnd.time && nativeEnd.time <= boundary.time);
	assert.ok(boundary.time < h.requests[2].time);
	assert.deepEqual(h.settingsManager.getRetrySettings(), h.originalRetrySettings);
	assert.deepEqual(h.settingsManager.getProviderRetrySettings(), h.originalProviderRetrySettings);
	assert.equal(h.manager.getBranch().filter(e => e.type === "message" && e.message.role === "user").length, 2);
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1);
	assert.equal(h.session.isIdle, true);
	assert.deepEqual(h.extensionErrors, []);
	assert.equal(h.providerCalls.length, 3);
	assert.equal(new Set(h.providerCalls.map(c => c.sessionId)).size, 1);
	assert.equal(new Set(h.providerCalls.map(c => c.signal)).size, 3, "both kinds of continuation replace the run signal");
	for (const call of h.providerCalls) {
		for (const key of ["retryAttempt", "nativeRetryAttempt", "logicalRequestId", "nativeRetriesRemaining"]) {
			assert.equal(call.keys.includes(key), false, "provider options do not identify the native exhaustion boundary");
		}
	}
});

test("SDK client retries and Pi native retries both finish before plugin recovery", { timeout: 10000 }, async t => {
	const h = await fixture(t, { status: 503, failures: 4, delayMs: 1, retry: { maxRetries: 1 },
		providerRetry: { maxRetries: 1, maxRetryDelayMs: 10 }, observeProvider: true });
	await h.session.prompt("Exhaust client, then native, then plugin");
	assert.equal(h.requests.length, 5, "two client attempts for each of two native runs, then plugin success");
	assert.equal(h.providerCalls.length, 3);
	assert.equal(h.events.filter(event => event.type === "auto_retry_start").length, 1);
	assert.equal(h.boundaries.filter(event => event.outcome === "error").length, 1);
	assert.equal(new Set(h.requests.map(request => request.raw)).size, 1);
	assert.equal(h.session.messages.at(-1).stopReason, "stop");
	assert.deepEqual(h.settingsManager.getRetrySettings(), h.originalRetrySettings);
	assert.deepEqual(h.settingsManager.getProviderRetrySettings(), h.originalProviderRetrySettings);
	assert.deepEqual(h.extensionErrors, []);
});

test("a native retry that succeeds never triggers plugin retry", { timeout: 10000 }, async t => {
	const h = await fixture(t, { status: 503, failures: 1, delayMs: 40 });
	await h.session.prompt("Native retry is enough");
	assert.equal(h.requests.length, 2);
	assert.equal(h.events.filter(e => e.type === "auto_retry_start").length, 1);
	assert.equal(h.boundaries.filter(e => e.outcome === "error").length, 0);
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1);
	assert.deepEqual(h.extensionErrors, []);
});

test("Stop during Pi native backoff does not fall through into plugin retry", { timeout: 10000 }, async t => {
	let abortPromise;
	let abortedAt;
	const h = await fixture(t, {
		status: 503, failures: 10, nativeRetry: { baseDelayMs: 5000 }, delayMs: 1,
		onEvent(event, session) {
			if (event.type !== "auto_retry_start") return;
			const timer = setTimeout(() => { abortedAt = performance.now(); abortPromise = session.abort(); }, 20);
			t.after(() => clearTimeout(timer));
		},
	});
	await h.session.prompt("Cancel native recovery");
	await abortPromise;
	assert.ok(abortedAt !== undefined);
	assert.ok(performance.now() - abortedAt < 1000, "cancel the active five-second native wait promptly");
	assert.equal(h.requests.length, 1);
	assert.equal(h.events.at(-1).type, "agent_settled");
	assert.equal(h.session.isIdle, true);
	assert.deepEqual(h.extensionErrors, []);
});

test("continuations still obey host native policy; plugin budget is not an HTTP cap", { timeout: 10000 }, async t => {
	const h = await fixture(t, { status: 503, failures: 3, delayMs: 1, retry: { maxRetries: 1 } });
	await h.session.prompt("Keep host retry settings unchanged");
	assert.equal(h.requests.length, 4, "a plugin continuation can itself use one host-native retry");
	assert.equal(h.events.filter(e => e.type === "auto_retry_start").length, 2);
	assert.equal(h.boundaries.filter(e => e.outcome === "error").length, 1);
	assert.deepEqual(h.settingsManager.getRetrySettings(), h.originalRetrySettings);
	assert.deepEqual(h.extensionErrors, []);
});

test("without an injected retry factory a noExtensions child stops at native exhaustion", { timeout: 10000 }, async t => {
	const h = await fixture(t, { status: 503, failures: 2, delayMs: 1, loadPlugin: false, observeProvider: true });
	await h.session.prompt("No ordinary extension in this child");
	assert.equal(h.requests.length, 2, "sharing a provider does not inject the post-native recovery handler");
	assert.equal(h.providerCalls.length, 2);
	assert.equal(h.boundaries.length, 0);
	assert.equal(h.events.at(-1).type, "agent_settled");
	assert.equal(h.session.messages.at(-1).stopReason, "error");
	assert.equal(h.session.isIdle, true);
	assert.deepEqual(h.extensionErrors, []);
});

test("Stop during plugin backoff gives the next user request a fresh retry budget", { timeout: 10000 }, async t => {
	let starts = 0;
	let abortPromise;
	const h = await fixture(t, {
		failures: 2, delayMs: 40, retry: { maxRetries: 1, repeatLimit: 1 },
		onEvent(event, session) {
			if (event.type !== "agent_start" || ++starts !== 2) return;
			const timer = setTimeout(() => { abortPromise = session.abort(); }, 5);
			t.after(() => clearTimeout(timer));
		},
	});
	await h.session.prompt("Stop this first attempt");
	await abortPromise;
	assert.equal(h.requests.length, 1);
	assert.equal(h.events.at(-1).aborted, true);
	await h.session.prompt("A new request after Stop");
	assert.equal(h.requests.length, 3, "second request may fail once and still gets its own plugin retry");
	assert.equal(h.session.messages.at(-1).stopReason, "stop");
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 2);
	assert.deepEqual(h.extensionErrors, []);
});

test("disposing the actively waiting session does not call a stale UI context", { timeout: 10000 }, async t => {
	const h = await fixture(t, { failures: 10, delayMs: 5000, ui: true });
	const run = h.session.prompt("Dispose this waiting session");
	const deadline = performance.now() + 1000;
	while (!h.workingMessages.some(message => message?.includes("等待重试"))) {
		assert.ok(performance.now() < deadline, "the real retry wait must start");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	h.session.dispose();
	await run;
	assert.equal(h.requests.length, 1);
	assert.deepEqual(h.extensionErrors, []);
});

test("plugin continuation preserves context drafts proposed by an earlier extension", { timeout: 10000 }, async t => {
	const h = await fixture(t, { failures: 1, delayMs: 1, boundaryEdit: true });
	await h.session.prompt("Continue with the existing context edit");
	assert.equal(h.requests.length, 2);
	assert.match(h.requests[0].raw, /Remember the number 42/);
	assert.match(h.requests[1].raw, /Other extension kept earlier memory: 43/);
	assert.equal(h.requests[1].raw.includes("Remember the number 42"), false);
	assert.equal(h.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length, 2);
	assert.deepEqual(h.extensionErrors, []);
});

for (const dispose of [false, true]) {
	test(`${dispose ? "dispose" : "Stop"} during native backoff after plugin retry leaves no stale UI/context`, { timeout: 10000 }, async t => {
		let nativeStarts = 0;
		let action;
		const h = await fixture(t, { failures: 10, status: 503, delayMs: 1, ui: true,
			nativeRetry: { baseDelayMs: 100 },
			onEvent(event, session) {
				if (event.type !== "auto_retry_start" || ++nativeStarts !== 2) return;
				const timer = setTimeout(() => { action = dispose ? session.dispose() : session.abort(); }, 20);
				t.after(() => clearTimeout(timer));
			},
		});
		await h.session.prompt("Cancel native backoff after plugin ownership");
		await action;
		assert.equal(nativeStarts, 2);
		assert.equal(h.requests.length, 3);
		assert.equal(h.workingMessages.at(-1), undefined, "return plugin UI ownership before native backoff");
		assert.deepEqual(h.extensionErrors, []);
	});
}

for (const retryQuotaErrors of [false, true]) {
	test(`quota errors ${retryQuotaErrors ? "opt in to plugin recovery" : "remain excluded by default"}`, { timeout: 10000 }, async t => {
		const h = await fixture(t, { status: 429, errorMessage: "insufficient_quota: billing limit", failures: 1,
			delayMs: 1, retry: { retryQuotaErrors } });
		await h.session.prompt("Quota policy");
		assert.equal(h.requests.length, retryQuotaErrors ? 2 : 1);
		assert.equal(h.events.filter(e => e.type === "auto_retry_start").length, 0);
		assert.equal(h.session.isIdle, true);
		assert.deepEqual(h.extensionErrors, []);
	});
}

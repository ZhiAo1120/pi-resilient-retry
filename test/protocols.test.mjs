import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register from "../index.ts";
import { sendSuccess } from "./fixtures.mjs";

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
	await import(process.env.PI_RETRY_TEST_SDK ?? "@earendil-works/pi-coding-agent");
const image = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", mimeType: "image/png" };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, api, { lostIds = false, repairHistory = true, truncated = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-retry-protocol-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const modelId = `wire-${api}`;
	const provider = "protocol-fixture"; // This fixture's original identity, never renamed after history is recorded.
	const requests = [];
	const hooks = { payloads: 0, headers: 0, responses: [], stream: [] };
	const errors = [];
	const events = [];
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		requests.push({ raw, payload: JSON.parse(raw), headers: req.headers, path: req.url });
		if (requests.length <= (truncated ? 1 : 2)) {
			if (truncated) {
				res.writeHead(200, { "Content-Type": "text/event-stream", "x-fixture-response": "kept" });
				for (const frame of [
					{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_partial",
						role: "assistant", content: [], status: "in_progress" } },
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Partial response" },
				]) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
				res.end(); // A real truncated upstream, not a forged SDK error/aborted event.
				return;
			}
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { type: "invalid_request_error",
				message: lostIds ? "Item msg_old not found" : "relay rejected this request" } }));
		} else sendSuccess(res, api, modelId);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	const baseUrl = `http://127.0.0.1:${server.address().port}${api === "openai-responses" ? "/v1" : ""}`;
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
		modelsStorePath: join(dir, "models-cache"), allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider(provider, { baseUrl, apiKey: "local-test-only", api,
		models: [{ id: modelId, name: "Loopback only", reasoning: true, input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 2048 }] });
	await runtime.refresh({ allowModelNetwork: false });
	const settings = SettingsManager.inMemory({ compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
		resilientRetry: { baseDelayMs: 1, maxDelayMs: 1, maxRetries: 3, repairHistory } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Test loopback only; retain earlier messages and completed tool results.",
		extensionFactories: [register, pi => {
			pi.on("before_provider_request", event => {
				hooks.payloads++;
				return { ...event.payload, fixture_marker: "hook replacement preserved" };
			});
			pi.on("before_provider_headers", event => { hooks.headers++; event.headers["x-fixture-hook"] = "kept"; });
			pi.on("after_provider_response", event => { hooks.responses.push({ status: event.status, headers: event.headers }); });
			pi.on("provider_stream_event", event => { hooks.stream.push({ provider: event.provider, api: event.api, model: event.model, data: event.data }); });
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = SessionManager.inMemory(dir);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Critical earlier memory: answer is 42" }, image], timestamp: 1 });
	const responses = api === "openai-responses";
	const callId = responses ? "call_old|fc_old" : "toolu_old";
	const assistant = {
		role: "assistant", provider, api, model: modelId, stopReason: "toolUse", usage, timestamp: 2,
		content: [
			{ type: "thinking", thinking: "Earlier reasoning", thinkingSignature: responses
				? JSON.stringify({ type: "reasoning", id: "rs_old", summary: [{ type: "summary_text", text: "Earlier reasoning" }],
					encrypted_content: "OPAQUE_FIXTURE", status: "completed" }) : "OPAQUE_SIGNATURE" },
			{ type: "text", text: "Earlier reply", ...(responses ? { textSignature: JSON.stringify({ v: 1, id: "msg_old", phase: "final_answer" }) } : {}) },
			{ type: "toolCall", id: callId, name: "once", arguments: { id: "argument stays" } },
		],
	};
	const assistantId = manager.appendMessage(assistant);
	manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "once",
		content: [{ type: "text", text: "Tool completed once; keep this result" }, image], isError: false, timestamp: 3 });
	const originalAssistant = structuredClone(assistant);
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
		sessionManager: manager, settingsManager: settings, modelRuntime: runtime,
		model: runtime.getModel(provider, modelId), noTools: "all", thinkingLevel: "off" });
	session.subscribe(event => events.push(event));
	await session.bindExtensions({ onError: error => errors.push(error) });
	t.after(async () => { await session.abort(); session.dispose(); });
	return { session, manager, requests, hooks, errors, events, modelId, provider, assistantId, originalAssistant };
}

function assertCompletion(h, expectedRequests = 3, expectedResponses = 1) {
	const last = h.session.messages.at(-1);
	assert.equal(last.stopReason, "stop");
	assert.equal(last.content.find(block => block.type === "text").text, "Recovered");
	assert.equal(last.usage.input, 7);
	assert.equal(last.usage.output, 5);
	assert.equal(last.provider, h.provider);
	assert.equal(last.model, h.modelId);
	assert.equal(h.events.filter(event => event.type === "agent_settled").length, 1);
	assert.equal(h.events.filter(event => event.type === "tool_execution_start").length, 0);
	assert.deepEqual(h.errors, []);
	assert.deepEqual(h.manager.getBranch().find(entry => entry.id === h.assistantId).message, h.originalAssistant);
	assert.equal(h.requests.length, expectedRequests);
	assert.equal(h.hooks.payloads, expectedRequests);
	assert.ok(h.hooks.headers >= expectedRequests);
	assert.equal(h.hooks.responses.length, expectedResponses, "HTTP errors can reject before the public response hook");
	assert.equal(h.hooks.responses[0].status, 200);
	assert.equal(h.hooks.responses[0].headers["x-fixture-response"], "kept");
	assert.ok(h.hooks.stream.length > 0);
	for (const request of h.requests) {
		assert.equal(request.payload.model, h.modelId);
		assert.equal(request.payload.fixture_marker, "hook replacement preserved");
		assert.equal(request.headers["x-fixture-hook"], "kept");
		assert.match(request.raw, /Critical earlier memory: answer is 42/);
		assert.match(request.raw, /Tool completed once; keep this result/);
	}
	for (const event of h.hooks.stream) {
		assert.equal(event.provider, h.provider);
		assert.equal(event.model, h.modelId);
	}
}

for (const api of ["openai-responses", "anthropic-messages"]) {
	test(`${api}: ordinary retries retain real wire history, images, signatures, pairing, hooks and usage`, { timeout: 10000 }, async t => {
		const h = await fixture(t, api);
		await h.session.prompt("Continue the original task");
		assertCompletion(h);
		assert.equal(new Set(h.requests.map(request => request.raw)).size, 1);
		if (api === "openai-responses") {
			const input = h.requests[0].payload.input;
			assert.ok(input.some(item => item.id === "msg_old" && item.phase === "final_answer"));
			assert.ok(input.some(item => item.id === "rs_old" && item.encrypted_content === "OPAQUE_FIXTURE"));
			assert.ok(input.some(item => item.type === "function_call" && item.id === "fc_old" && item.call_id === "call_old"));
			assert.ok(input.some(item => item.type === "function_call_output" && item.call_id === "call_old"));
			assert.match(h.requests[0].raw, /data:image\/png;base64/);
		} else {
			assert.match(h.requests[0].raw, /"signature":"OPAQUE_SIGNATURE"/);
			assert.match(h.requests[0].raw, /"tool_use_id":"toolu_old"/);
			assert.match(h.requests[0].raw, /"type":"base64"/);
		}
	});
}

for (const repairHistory of [true, false]) {
	test(`Responses replay loss ${repairHistory ? "repairs only a later request copy" : "respects repairHistory:false"}`, { timeout: 10000 }, async t => {
		const h = await fixture(t, "openai-responses", { lostIds: true, repairHistory });
		await h.session.prompt("Continue without replaying tools");
		assertCompletion(h);
		const [first, second, third] = h.requests.map(request => request.payload);
		if (!repairHistory) {
			assert.deepEqual(second, first);
			assert.deepEqual(third, first);
			return;
		}
		assert.ok(first.input.some(item => item.id === "msg_old"));
		assert.ok(first.input.some(item => item.id === "fc_old"));
		for (const later of [second, third]) {
			assert.equal(later.input.some(item => item.id === "msg_old" || item.id === "fc_old"), false);
			assert.ok(later.input.some(item => item.id === "rs_old" && item.encrypted_content === "OPAQUE_FIXTURE"));
			const withoutOptionalIds = payload => ({ ...payload, input: payload.input.map(item => {
				if (item.id !== "msg_old" && item.id !== "fc_old") return item;
				const { id: _id, ...body } = item;
				return body;
			}) });
			assert.deepEqual(later, withoutOptionalIds(first));
		}
		await h.session.prompt("An unrelated follow-up after recovery");
		assert.equal(h.requests.length, 4);
		assert.ok(h.requests[3].payload.input.some(item => item.id === "msg_old"));
		assert.ok(h.requests[3].payload.input.some(item => item.id === "fc_old"));
		assert.deepEqual(h.manager.getBranch().find(entry => entry.id === h.assistantId).message, h.originalAssistant);
	});
}

test("a genuinely truncated Responses stream keeps partial output in raw history and resumes without replaying past tools", { timeout: 10000 }, async t => {
	const h = await fixture(t, "openai-responses", { truncated: true });
	await h.session.prompt("Continue after the upstream disconnects");
	assertCompletion(h, 2, 2);
	assert.equal(new Set(h.requests.map(request => request.raw)).size, 1);
	assert.ok(h.manager.getBranch().some(entry => entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.stopReason === "error" && entry.message.content.some(block => block.type === "text" && block.text === "Partial response")));
	assert.equal(h.manager.getBranch().filter(entry => entry.type === "custom_message").length, 0);
});

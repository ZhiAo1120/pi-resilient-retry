// Local fake upstream frames only. No SDK/client implementation or real credentials.
let responseSerial = 0;
export function sendSuccess(res, api, model, text = "Recovered") {
	const id = `fixture_${++responseSerial}`;
	res.writeHead(200, { "Content-Type": "text/event-stream", "x-fixture-response": "kept" });
	if (api === "openai-completions") {
		const chunk = (delta, finish_reason) => ({ id: `chatcmpl_${id}`, object: "chat.completion.chunk",
			created: 0, model, choices: [{ index: 0, delta, finish_reason }] });
		res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: text }, null))}\n\n`);
		res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
		res.end("data: [DONE]\n\n");
		return;
	}
	let frames;
	if (api === "openai-responses") {
		const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
			content: [{ type: "output_text", text, annotations: [] }] };
		frames = [
			{ type: "response.created", response: { id: `resp_${id}`, object: "response", model,
				status: "in_progress", output: [], usage: null } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: `resp_${id}`, object: "response", model,
				status: "completed", output: [item], usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12,
					input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
		].map((frame, sequence_number) => ({ ...frame, sequence_number }));
	} else if (api === "anthropic-messages") {
		frames = [
			{ type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model,
				content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		];
	} else {
		throw new Error(`Unsupported fixture protocol: ${api}`);
	}
	for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
	res.end();
}

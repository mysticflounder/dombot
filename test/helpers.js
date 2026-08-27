/** Shared fakes for the agent tests: SSE text builders and a fake fetch. */

export function sseText(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function messageStart(model) {
  return {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
  };
}

/** Events for an assistant turn: optional text, then tool_use blocks. */
export function turnEvents({ text = null, uses = [], stop = "end_turn", model = "claude-opus-5", extraBlocks = [] } = {}) {
  const events = [messageStart(model)];
  let index = 0;
  for (const block of extraBlocks) {
    events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  if (text !== null) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    const mid = Math.floor(text.length / 2);
    events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: text.slice(0, mid) } });
    events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: text.slice(mid) } });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  for (const use of uses) {
    events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: use.id, name: use.name, input: {} } });
    const json = JSON.stringify(use.input);
    const mid = Math.floor(json.length / 2);
    events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, mid) } });
    events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(mid) } });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } });
  events.push({ type: "message_stop" });
  return events;
}

/** A Response whose body arrives in small byte chunks, so multi-byte characters and SSE frames get split. */
export function streamResponse(text, { status = 200, chunk = 7 } = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

export function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

/** fetch stand-in that hands out `responses` in order and records every request. */
export function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("fakeFetch: no more responses");
    return typeof next === "function" ? next(init) : next;
  };
  fn.calls = calls;
  return fn;
}

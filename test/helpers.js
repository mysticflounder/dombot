/** Shared fakes for the agent tests: Ollama NDJSON builders and a fake fetch. */

export function ndjson(objects) {
  return objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

function half(s) {
  const mid = Math.floor(s.length / 2);
  return [s.slice(0, mid), s.slice(mid)].filter((x) => x.length);
}

/**
 * Chunks for one assistant reply, shaped like Ollama 0.33 streams them:
 * thinking deltas, content deltas, one chunk per tool call, then the done
 * chunk with stats.
 */
export function chatChunks({ model = "gemma4:12b-mlx", thinking = "", content = "", toolCalls = [], doneReason = "stop" } = {}) {
  const at = "2026-08-27T19:40:23.883809Z";
  const chunks = [];
  for (const piece of half(thinking)) chunks.push({ model, created_at: at, message: { role: "assistant", content: "", thinking: piece }, done: false });
  for (const piece of half(content)) chunks.push({ model, created_at: at, message: { role: "assistant", content: piece }, done: false });
  toolCalls.forEach((call, index) => {
    chunks.push({
      model,
      created_at: at,
      message: { role: "assistant", content: "", tool_calls: [{ id: call.id, function: { index, name: call.name, arguments: call.arguments } }] },
      done: false,
    });
  });
  chunks.push({
    model,
    created_at: at,
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: doneReason,
    total_duration: 3859887041,
    load_duration: 1834756833,
    prompt_eval_count: 90,
    prompt_eval_duration: 934746292,
    eval_count: 52,
    eval_duration: 881612375,
  });
  return chunks;
}

/** A Response whose body arrives in small byte chunks, so multi-byte characters and lines get split. */
export function streamResponse(text, { status = 200, chunk = 7 } = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/x-ndjson" } });
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

/** fetch stand-in: `responses` is an array (in order) or a function (url, init) => Response. Records every request. */
export function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    let next;
    if (typeof responses === "function") next = responses(url, init);
    else {
      next = responses.shift();
      if (!next) throw new Error("fakeFetch: no more responses");
    }
    return typeof next === "function" ? next(init) : next;
  };
  fn.calls = calls;
  return fn;
}

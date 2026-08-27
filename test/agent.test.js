import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSseParser,
  createMessageAccumulator,
  streamMessage,
  runTurn,
  echoableContent,
  historyItems,
  buildSystem,
  buildRequest,
  requestHeaders,
  FALLBACK_BETA,
  API_URL,
} from "../extension/agent.js";
import { sseText, turnEvents, streamResponse, jsonResponse, fakeFetch } from "./helpers.js";

const SETTINGS = { model: "claude-opus-5", maxTokens: 1000, effort: "high", fallbacks: true };

test("sse parser: one character at a time, CRLF, comments, multi-line data", () => {
  const got = [];
  const p = createSseParser((name, data) => got.push([name, data]));
  const text = 'event: a\r\ndata: {"x":1}\r\n\r\n: keepalive\n\nevent: b\ndata: line1\ndata: line2\n\ndata: tail';
  for (const ch of text) p.push(ch);
  p.end();
  assert.deepEqual(got, [
    ["a", '{"x":1}'],
    ["b", "line1\nline2"],
    ["", "tail"],
  ]);
});

test("accumulator folds deltas into a message with parsed tool input", () => {
  const acc = createMessageAccumulator();
  for (const e of turnEvents({ text: "hi there", uses: [{ id: "t1", name: "inspect_dom", input: { selector: "h1", limit: 2 } }], stop: "tool_use" })) {
    acc.handle(e);
  }
  const m = acc.message();
  assert.equal(m.stop_reason, "tool_use");
  assert.equal(m.usage.output_tokens, 42);
  assert.equal(m.usage.input_tokens, 10);
  assert.deepEqual(m.content[0], { type: "text", text: "hi there" });
  assert.deepEqual(m.content[1], { type: "tool_use", id: "t1", name: "inspect_dom", input: { selector: "h1", limit: 2 } });
});

test("accumulator: an error event throws", () => {
  const acc = createMessageAccumulator();
  assert.throws(() => acc.handle({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), /Overloaded/);
});

test("request shape: headers and body with and without fallbacks", () => {
  const h = requestHeaders("k", { fallbacks: true });
  assert.equal(h["x-api-key"], "k");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(h["anthropic-beta"], FALLBACK_BETA);
  assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(requestHeaders("k", { fallbacks: false })["anthropic-beta"], undefined);

  const body = buildRequest({ model: "m", maxTokens: 5, effort: "low", system: [], tools: [], messages: [], fallbacks: true });
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.output_config, { effort: "low" });
  const noFb = buildRequest({ model: "m", maxTokens: 5, system: [], tools: [], messages: [], fallbacks: false });
  assert.equal("fallbacks" in noFb, false);
  assert.equal("output_config" in noFb, false);
});

test("buildSystem: cache breakpoint on the last block, custom instructions appended", () => {
  const plain = buildSystem("");
  assert.equal(plain.length, 1);
  assert.deepEqual(plain[0].cache_control, { type: "ephemeral" });
  const custom = buildSystem("  Be terse.  ");
  assert.equal(custom.length, 2);
  assert.equal(custom[0].cache_control, undefined);
  assert.equal(custom[1].text, "Be terse.");
  assert.deepEqual(custom[1].cache_control, { type: "ephemeral" });
});

test("streamMessage: parses a split byte stream and returns the full message", async () => {
  const fetchImpl = fakeFetch([streamResponse(sseText(turnEvents({ text: "héllo — wörld" })))]);
  const seen = [];
  const m = await streamMessage({ apiKey: "k", body: { a: 1 }, fetchImpl, onEvent: (e) => seen.push(e.type) });
  assert.equal(m.content[0].text, "héllo — wörld");
  assert.equal(m.stop_reason, "end_turn");
  assert.ok(seen.includes("message_start") && seen.includes("message_stop"));
  assert.equal(fetchImpl.calls[0].url, API_URL);
  assert.equal(fetchImpl.calls[0].init.method, "POST");
});

test("streamMessage: HTTP errors carry the API's message", async () => {
  const fetchImpl = fakeFetch([jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401)]);
  await assert.rejects(streamMessage({ apiKey: "bad", body: {}, fetchImpl }), (err) => err.status === 401 && err.message.includes("invalid x-api-key"));
});

test("streamMessage: an error event mid-stream rejects", async () => {
  const events = turnEvents({ text: "partial" }).slice(0, 3);
  events.push({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const fetchImpl = fakeFetch([streamResponse(sseText(events))]);
  await assert.rejects(streamMessage({ apiKey: "k", body: {}, fetchImpl }), /Overloaded/);
});

test("runTurn: tool loop — results go back in one user message, then the final answer", async () => {
  const fetchImpl = fakeFetch([
    streamResponse(
      sseText(
        turnEvents({
          text: "Let me look.",
          uses: [
            { id: "t1", name: "inspect_dom", input: { selector: "h1" } },
            { id: "t2", name: "modify_dom", input: { selector: "h1", action: "set_text", value: "New" } },
          ],
          stop: "tool_use",
        }),
      ),
    ),
    streamResponse(sseText(turnEvents({ text: "Done." }))),
  ]);
  const messages = [{ role: "user", content: [{ type: "text", text: "Page URL: x" }, { type: "text", text: "rename the title" }] }];
  const toolCalls = [];
  const deltas = [];
  const result = await runTurn({
    messages,
    tools: [{ name: "inspect_dom" }],
    system: buildSystem(""),
    settings: SETTINGS,
    apiKey: "k",
    fetchImpl,
    runTool: async (name, input, id) => {
      toolCalls.push([name, input, id]);
      if (name === "modify_dom") throw new Error("boom");
      return { content: "1 element(s) match" };
    },
    onEvent: (e) => {
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") deltas.push(e.delta.text);
    },
  });

  assert.equal(result.stop_reason, "end_turn");
  assert.equal(deltas.join(""), "Let me look.Done.");
  assert.deepEqual(
    toolCalls.map((c) => c[0]),
    ["inspect_dom", "modify_dom"],
  );
  assert.equal(toolCalls[0][2], "t1");

  assert.equal(messages.length, 4);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content[1].type, "tool_use");
  assert.equal(messages[2].role, "user");
  assert.deepEqual(messages[2].content, [
    { type: "tool_result", tool_use_id: "t1", content: "1 element(s) match" },
    { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
  ]);
  assert.deepEqual(messages[3], { role: "assistant", content: [{ type: "text", text: "Done." }] });

  // The second request carried the whole history plus tools and system.
  const second = fetchImpl.calls[1].body;
  assert.equal(second.messages.length, 3);
  assert.equal(second.tools[0].name, "inspect_dom");
  assert.equal(second.fallbacks, "default");
  assert.equal(second.stream, true);
  assert.equal(fetchImpl.calls[1].init.headers["anthropic-beta"], FALLBACK_BETA);
});

test("runTurn: stops on max_tokens without another request", async () => {
  const fetchImpl = fakeFetch([streamResponse(sseText(turnEvents({ text: "cut", stop: "max_tokens" })))]);
  const messages = [{ role: "user", content: "hi" }];
  const result = await runTurn({ messages, tools: [], system: [], settings: SETTINGS, apiKey: "k", fetchImpl, runTool: async () => ({ content: "" }) });
  assert.equal(result.stop_reason, "max_tokens");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(messages.length, 2);
});

test("runTurn: gives up after maxRounds of tool use", async () => {
  const forever = () => streamResponse(sseText(turnEvents({ uses: [{ id: "t", name: "x", input: {} }], stop: "tool_use" })));
  const fetchImpl = fakeFetch([forever, forever, forever]);
  await assert.rejects(
    runTurn({ messages: [{ role: "user", content: "hi" }], tools: [], system: [], settings: SETTINGS, apiKey: "k", fetchImpl, runTool: async () => ({ content: "ok" }), maxRounds: 2 }),
    /stopped after 2 tool rounds/,
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test("runTurn: tool_use stop with no tool_use blocks ends the turn cleanly", async () => {
  const fetchImpl = fakeFetch([streamResponse(sseText(turnEvents({ text: "odd", stop: "tool_use" })))]);
  const messages = [{ role: "user", content: "hi" }];
  const result = await runTurn({ messages, tools: [], system: [], settings: SETTINGS, apiKey: "k", fetchImpl, runTool: async () => ({ content: "" }) });
  assert.equal(result.stop_reason, "tool_use");
  assert.equal(messages.length, 2);
});

test("runTurn: an aborted fetch rejects with the AbortError", async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => {
    controller.abort();
    const err = new Error("aborted");
    err.name = "AbortError";
    assert.equal(init.signal, controller.signal);
    throw err;
  };
  await assert.rejects(
    runTurn({ messages: [{ role: "user", content: "hi" }], tools: [], system: [], settings: SETTINGS, apiKey: "k", fetchImpl, signal: controller.signal, runTool: async () => ({}) }),
    (err) => err.name === "AbortError",
  );
});

test("echoableContent: drops non-text before the last fallback marker, the marker, and empty text", () => {
  const content = [
    { type: "thinking", thinking: "", signature: "s" },
    { type: "text", text: "before" },
    { type: "tool_use", id: "t", name: "x", input: {} },
    { type: "fallback", from: { model: "a" }, to: { model: "b" } },
    { type: "text", text: "" },
    { type: "thinking", thinking: "", signature: "s2" },
    { type: "text", text: "after" },
    { type: "tool_use", id: "t2", name: "y", input: {} },
  ];
  assert.deepEqual(echoableContent(content), [
    { type: "text", text: "before" },
    { type: "thinking", thinking: "", signature: "s2" },
    { type: "text", text: "after" },
    { type: "tool_use", id: "t2", name: "y", input: {} },
  ]);
  // No fallback: everything but empty text survives, thinking included.
  const plain = [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "" }, { type: "text", text: "x" }];
  assert.deepEqual(echoableContent(plain), [plain[0], plain[2]]);
});

test("historyItems rebuilds the panel view from the API history", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Page URL: x" }, { type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "inspect_dom", input: { selector: "h1" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 match", is_error: true }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
    { role: "user", content: "plain string" },
  ];
  assert.deepEqual(historyItems(messages), [
    { kind: "user", text: "hello" },
    { kind: "assistant", text: "Looking." },
    { kind: "tool", name: "inspect_dom", input: { selector: "h1" }, result: "1 match", is_error: true },
    { kind: "assistant", text: "Done." },
    { kind: "user", text: "plain string" },
  ]);
});

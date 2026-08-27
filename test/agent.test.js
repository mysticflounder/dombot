import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseUrl,
  buildSystem,
  buildRequest,
  toOllamaTools,
  userContent,
  userText,
  createNdjsonParser,
  createChatAccumulator,
  streamChat,
  listModels,
  version,
  assistantMessage,
  runTurn,
  historyItems,
  SYSTEM_PROMPT,
} from "../extension/agent.js";
import { ndjson, chatChunks, streamResponse, jsonResponse, fakeFetch } from "./helpers.js";

const BASE = "http://localhost:11434";
const SETTINGS = { model: "gemma4:12b-mlx", think: "off", numCtx: 8192, keepAlive: "" };
const TOOLS = [{ name: "inspect_dom", description: "Find elements", input_schema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] } }];

test("baseUrl: defaults, pasted URLs, bad ports", () => {
  assert.equal(baseUrl(), "http://localhost:11434");
  assert.equal(baseUrl({ host: "10.0.0.5", port: "11434" }), "http://10.0.0.5:11434");
  assert.equal(baseUrl({ host: " http://10.0.0.5:11434/ ", port: 11434 }), "http://10.0.0.5:11434");
  assert.equal(baseUrl({ scheme: "https", host: "ollama.lan/api/", port: 443 }), "https://ollama.lan:443");
  assert.equal(baseUrl({ host: "", port: 99999 }), "http://localhost:11434");
  assert.equal(baseUrl({ scheme: "ftp", host: "x", port: "abc" }), "http://x:11434");
});

test("ndjson parser: one character at a time, blank lines, trailing line without newline", () => {
  const got = [];
  const p = createNdjsonParser((o) => got.push(o));
  const text = '{"a":1}\n\n{"b":"héllo"}\r\n{"c":3}';
  for (const ch of text) p.push(ch);
  p.end();
  assert.deepEqual(got, [{ a: 1 }, { b: "héllo" }, { c: 3 }]);
});

test("accumulator: thinking, content, tool calls, done stats; error chunk throws", () => {
  const acc = createChatAccumulator();
  for (const c of chatChunks({ thinking: "let me see", content: "Hello there", toolCalls: [{ id: "call_1", name: "inspect_dom", arguments: { selector: "h1" } }] })) acc.handle(c);
  const r = acc.result();
  assert.equal(r.done, true);
  assert.equal(r.done_reason, "stop");
  assert.equal(r.model, "gemma4:12b-mlx");
  assert.equal(r.message.thinking, "let me see");
  assert.equal(r.message.content, "Hello there");
  assert.deepEqual(r.message.tool_calls, [{ id: "call_1", function: { index: 0, name: "inspect_dom", arguments: { selector: "h1" } } }]);
  assert.equal(r.stats.eval_count, 52);
  assert.equal(r.stats.prompt_eval_count, 90);

  assert.throws(() => createChatAccumulator().handle({ error: "model 'x' not found" }), /model 'x' not found/);
});

test("buildRequest: system first, tools in function shape, think/options/keep_alive only when set", () => {
  const messages = [{ role: "user", content: "hi" }];
  const body = buildRequest({ model: "m", system: "SYS", tools: TOOLS, messages, numCtx: 4096, think: "on", keepAlive: " 10m " });
  assert.deepEqual(body.messages[0], { role: "system", content: "SYS" });
  assert.equal(body.messages[1], messages[0]);
  assert.equal(body.stream, true);
  assert.equal(body.think, true);
  assert.deepEqual(body.options, { num_ctx: 4096 });
  assert.equal(body.keep_alive, "10m");
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "inspect_dom", description: "Find elements", parameters: TOOLS[0].input_schema } },
  ]);

  const bare = buildRequest({ model: "m", system: "S", tools: [], messages, think: "default", numCtx: 0, keepAlive: "" });
  assert.equal("think" in bare, false);
  assert.equal("options" in bare, false);
  assert.equal("keep_alive" in bare, false);
  assert.equal(buildRequest({ model: "m", system: "S", tools: [], messages, think: "off" }).think, false);
  assert.deepEqual(toOllamaTools(undefined), []);
});

test("buildSystem and the page-context envelope", () => {
  assert.equal(buildSystem(""), SYSTEM_PROMPT);
  assert.equal(buildSystem("  Be terse. "), `${SYSTEM_PROMPT}\n\nBe terse.`);
  const content = userContent({ url: "https://x.test/p", title: "T" }, "make it red");
  assert.equal(content, "Page URL: https://x.test/p\nPage title: T\n\nmake it red");
  assert.equal(userText(content), "make it red");
  assert.equal(userText("plain"), "plain");
  assert.equal(userText("Page URL: only"), "");
  assert.equal(userText(42), "");
});

test("streamChat: parses a split byte stream and returns the full result", async () => {
  const fetchImpl = fakeFetch([streamResponse(ndjson(chatChunks({ content: "héllo — wörld" })))]);
  const seen = [];
  const r = await streamChat({ base: BASE, body: { a: 1 }, fetchImpl, onChunk: (c) => seen.push(c) });
  assert.equal(r.message.content, "héllo — wörld");
  assert.equal(r.done_reason, "stop");
  assert.equal(seen.length, 3);
  assert.equal(fetchImpl.calls[0].url, `${BASE}/api/chat`);
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  assert.deepEqual(fetchImpl.calls[0].body, { a: 1 });
});

test("streamChat: HTTP errors carry Ollama's message; connection failures explain themselves", async () => {
  const notFound = fakeFetch([jsonResponse({ error: "model 'nope:latest' not found" }, 404)]);
  await assert.rejects(streamChat({ base: BASE, body: {}, fetchImpl: notFound }), (err) => err.status === 404 && err.message.includes("model 'nope:latest' not found"));

  const refused = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(streamChat({ base: BASE, body: {}, fetchImpl: refused }), /Cannot reach Ollama at http:\/\/localhost:11434 \(Failed to fetch\)/);

  const truncated = fakeFetch([streamResponse(ndjson(chatChunks({ content: "partial" }).slice(0, 2)))]);
  await assert.rejects(streamChat({ base: BASE, body: {}, fetchImpl: truncated }), /ended before the reply was complete/);
});

test("listModels: tags plus capabilities, sorted by name, tolerant of show failures", async () => {
  const tags = {
    models: [
      { name: "zeta:7b", size: 4e9, details: { family: "llama", parameter_size: "7B" }, modified_at: "t" },
      { name: "alpha:1b", size: 1e9, details: { family: "gemma", parameter_size: "1B" } },
      { name: "broken:1b", size: 1e9, details: {} },
    ],
  };
  const fetchImpl = fakeFetch((url, init) => {
    if (url.endsWith("/api/tags")) return jsonResponse(tags);
    const { model } = JSON.parse(init.body);
    if (model === "broken:1b") return jsonResponse({ error: "boom" }, 500);
    return jsonResponse({ capabilities: model === "zeta:7b" ? ["completion"] : ["completion", "tools", "thinking"] });
  });
  const list = await listModels({ base: BASE, fetchImpl });
  assert.deepEqual(
    list.map((m) => [m.name, m.tools, m.thinking]),
    [
      ["alpha:1b", true, true],
      ["broken:1b", null, null],
      ["zeta:7b", false, false],
    ],
  );
  assert.equal(list[0].family, "gemma");
  assert.equal(list[2].parameterSize, "7B");
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith("/api/show")).length, 3);

  const quick = await listModels({ base: BASE, fetchImpl: fakeFetch([jsonResponse(tags)]), withCapabilities: false });
  assert.equal(quick.length, 3);
  assert.equal(quick[0].tools, null);
});

test("version", async () => {
  assert.equal(await version({ base: BASE, fetchImpl: fakeFetch([jsonResponse({ version: "0.33.1" })]) }), "0.33.1");
  await assert.rejects(version({ base: BASE, fetchImpl: fakeFetch([jsonResponse({ error: "nope" }, 500)]) }), /answered 500: nope/);
});

test("assistantMessage keeps only what is there", () => {
  assert.deepEqual(assistantMessage({ message: { content: "hi", thinking: "", tool_calls: [] } }), { role: "assistant", content: "hi" });
  const call = { id: "c", function: { name: "x", arguments: {} } };
  assert.deepEqual(assistantMessage({ message: { content: "", thinking: "hm", tool_calls: [call] } }), { role: "assistant", content: "", thinking: "hm", tool_calls: [call] });
});

test("runTurn: tool loop — one tool message per call, errors marked, then the final answer", async () => {
  const fetchImpl = fakeFetch([
    streamResponse(
      ndjson(
        chatChunks({
          thinking: "plan",
          content: "Let me look.",
          toolCalls: [
            { id: "call_a", name: "inspect_dom", arguments: { selector: "h1" } },
            { id: "call_b", name: "modify_dom", arguments: { selector: "h1", action: "set_text", value: "New" } },
          ],
        }),
      ),
    ),
    streamResponse(ndjson(chatChunks({ content: "Done." }))),
  ]);
  const messages = [{ role: "user", content: userContent({ url: "https://x.test/", title: "X" }, "rename the title") }];
  const toolCalls = [];
  const deltas = [];
  const result = await runTurn({
    messages,
    tools: TOOLS,
    system: "SYS",
    settings: SETTINGS,
    base: BASE,
    fetchImpl,
    runTool: async (name, args, id) => {
      toolCalls.push([name, args, id]);
      if (name === "modify_dom") throw new Error("boom");
      return { content: "1 element(s) match" };
    },
    onChunk: (c) => {
      if (c.message?.content) deltas.push(c.message.content);
    },
  });

  assert.equal(result.done_reason, "stop");
  assert.equal(result.message.content, "Done.");
  assert.equal(deltas.join(""), "Let me look.Done.");
  assert.deepEqual(toolCalls, [
    ["inspect_dom", { selector: "h1" }, "call_a"],
    ["modify_dom", { selector: "h1", action: "set_text", value: "New" }, "call_b"],
  ]);

  assert.equal(messages.length, 5);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].thinking, "plan");
  assert.equal(messages[1].tool_calls.length, 2);
  assert.deepEqual(messages[2], { role: "tool", content: "1 element(s) match", tool_name: "inspect_dom", tool_call_id: "call_a" });
  assert.deepEqual(messages[3], { role: "tool", content: "Error: boom", tool_name: "modify_dom", tool_call_id: "call_b" });
  assert.deepEqual(messages[4], { role: "assistant", content: "Done." });

  // The second request carried system + whole history, tools, and settings.
  const second = fetchImpl.calls[1].body;
  assert.equal(second.messages.length, 5);
  assert.equal(second.messages[0].role, "system");
  assert.equal(second.model, "gemma4:12b-mlx");
  assert.equal(second.think, false);
  assert.deepEqual(second.options, { num_ctx: 8192 });
  assert.equal(second.tools[0].function.name, "inspect_dom");
});

test("runTurn: string arguments are parsed; a missing id gets no tool_call_id", async () => {
  const chunks = chatChunks({ toolCalls: [{ name: "inspect_dom", arguments: { selector: "p" } }] });
  chunks[0].message.tool_calls[0].function.arguments = JSON.stringify({ selector: "p" });
  delete chunks[0].message.tool_calls[0].id;
  const fetchImpl = fakeFetch([streamResponse(ndjson(chunks)), streamResponse(ndjson(chatChunks({ content: "ok" })))]);
  const messages = [{ role: "user", content: "hi" }];
  const seen = [];
  await runTurn({ messages, tools: TOOLS, system: "S", settings: SETTINGS, base: BASE, fetchImpl, runTool: async (name, args, id) => (seen.push([name, args, id]), { content: "" }) });
  assert.deepEqual(seen, [["inspect_dom", { selector: "p" }, undefined]]);
  assert.deepEqual(messages[2], { role: "tool", content: "(no output)", tool_name: "inspect_dom" });
});

test("runTurn: done_reason length returns without running tools", async () => {
  const fetchImpl = fakeFetch([streamResponse(ndjson(chatChunks({ content: "cut", toolCalls: [{ id: "c", name: "inspect_dom", arguments: {} }], doneReason: "length" })))]);
  let ran = 0;
  const messages = [{ role: "user", content: "hi" }];
  const r = await runTurn({ messages, tools: [], system: "S", settings: SETTINGS, base: BASE, fetchImpl, runTool: async () => (ran++, { content: "" }) });
  assert.equal(r.done_reason, "length");
  assert.equal(ran, 0);
  assert.equal(messages.length, 2);
});

test("runTurn: gives up after maxRounds of tool use", async () => {
  const forever = () => streamResponse(ndjson(chatChunks({ toolCalls: [{ id: "c", name: "x", arguments: {} }] })));
  const fetchImpl = fakeFetch([forever, forever, forever]);
  await assert.rejects(
    runTurn({ messages: [{ role: "user", content: "hi" }], tools: [], system: "S", settings: SETTINGS, base: BASE, fetchImpl, runTool: async () => ({ content: "ok" }), maxRounds: 2 }),
    /stopped after 2 tool rounds/,
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test("runTurn: an aborted fetch rejects with the AbortError, not a connection error", async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  await assert.rejects(
    runTurn({ messages: [{ role: "user", content: "hi" }], tools: [], system: "S", settings: SETTINGS, base: BASE, fetchImpl, signal: controller.signal, runTool: async () => ({}) }),
    (err) => err.name === "AbortError",
  );
});

test("historyItems rebuilds the panel view: prefix stripped, tool rows matched by id then by order", () => {
  const messages = [
    { role: "user", content: userContent({ url: "u", title: "t" }, "hello") },
    {
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        { id: "a", function: { name: "inspect_dom", arguments: { selector: "h1" } } },
        { id: "b", function: { name: "modify_dom", arguments: { selector: "h1", action: "remove" } } },
      ],
    },
    { role: "tool", content: "Error: no match", tool_name: "modify_dom", tool_call_id: "b" },
    { role: "tool", content: "1 match", tool_name: "inspect_dom" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_page", arguments: {} } }] },
    { role: "tool", content: "text" },
    { role: "assistant", content: "Done." },
  ];
  assert.deepEqual(historyItems(messages), [
    { kind: "user", text: "hello" },
    { kind: "assistant", text: "Looking." },
    { kind: "tool", name: "modify_dom", input: { selector: "h1", action: "remove" }, result: "no match", is_error: true },
    { kind: "tool", name: "inspect_dom", input: { selector: "h1" }, result: "1 match", is_error: false },
    { kind: "tool", name: "read_page", input: {}, result: "text", is_error: false },
    { kind: "assistant", text: "Done." },
  ]);
});

/**
 * Runs the real agent loop against the Ollama on this machine. Skips itself
 * when nothing answers at the configured address, or when OLLAMA_SKIP_LIVE
 * is set. Override the target with OLLAMA_TEST_HOST / OLLAMA_TEST_PORT /
 * OLLAMA_TEST_MODEL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseUrl, version, listModels, runTurn } from "../extension/agent.js";

const base = baseUrl({ host: process.env.OLLAMA_TEST_HOST ?? "localhost", port: process.env.OLLAMA_TEST_PORT ?? 11434 });

const WEATHER = {
  name: "get_weather",
  description: "Current weather for a city",
  input_schema: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
};

async function reachable() {
  try {
    await version({ base, signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

test("live: a tool round trip against the local Ollama", { timeout: 300000 }, async (t) => {
  if (process.env.OLLAMA_SKIP_LIVE) return t.skip("OLLAMA_SKIP_LIVE is set");
  if (!(await reachable())) return t.skip(`no Ollama at ${base}`);

  const models = await listModels({ base });
  const capable = models.filter((m) => m.tools).sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  if (!capable.length) return t.skip("no model with tool support");
  const model = process.env.OLLAMA_TEST_MODEL ?? capable[0].name;
  t.diagnostic(`model ${model} at ${base}`);

  const messages = [{ role: "user", content: "Page URL: https://example.com/\nPage title: Example\n\nWhat is the weather in Paris right now? Use the get_weather tool." }];
  const calls = [];
  const result = await runTurn({
    messages,
    tools: [WEATHER],
    system: "You have one tool. Use it when asked about weather, then answer in one sentence.",
    settings: { model, think: "off", numCtx: 4096 },
    base,
    runTool: async (name, args, id) => {
      calls.push({ name, args, id });
      return { content: "21°C, light rain" };
    },
  });

  assert.ok(calls.length >= 1, "the model called the tool");
  assert.equal(calls[0].name, "get_weather");
  assert.equal(typeof calls[0].args.city, "string");
  assert.equal(result.done_reason, "stop");
  assert.ok(result.message.content.includes("21"), result.message.content);
  assert.equal(messages.filter((m) => m.role === "tool").length, calls.length);
  assert.equal(messages[messages.length - 1].role, "assistant");
});

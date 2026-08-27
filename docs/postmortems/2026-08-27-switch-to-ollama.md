# 2026-08-27 — Switch the backend from the Claude API to Ollama

## Summary

Same day as the initial build, the backend moved from `api.anthropic.com`
to the Ollama on this machine, with a model dropdown fed by `/api/tags` and
a config window (scheme, host, port, model, thinking, context length,
keep-alive).

## What changed

- `agent.js`: SSE parser → NDJSON parser; Anthropic content blocks → Ollama
  `message.{content, thinking, tool_calls}`; tool definitions converted to
  the function-tool shape at request time; tool results as `role: "tool"`
  messages; `listModels` (tags + per-model capabilities) and `version`.
- `background.js`: settings are host/port/etc. instead of an API key;
  `models.list` message with a 60 s cache; the first advertised model is
  picked and saved when none is configured.
- `content.js`: the header label became a `<select>` of Ollama's models.
- `options.*`: the config window. It is an ES module page and imports
  `agent.js` directly for the model list and the version check.
- `manifest.json`: `host_permissions: ["<all_urls>"]` so any Ollama address
  works (the content scripts already needed all sites).

## Root cause of the one surprise

None in code. The wire format was captured from the live instance before
writing a line (`docs/ollama-api.md`), which is why the live test passed
first time. Two facts that would have been guessed wrong from memory:
tool calls now carry an `id` (`call_…`), and `done_reason` stays `"stop"`
when the model calls tools.

## Lessons

- With a local service on the machine, capture the real responses first
  and test against them; do not write the client from recollection.
- Keep a live test that skips itself when the service is absent. It is
  the only thing that proves the shapes are still current.

## Files changed

`extension/agent.js`, `background.js`, `content.js`, `options.html`,
`options.js`, `manifest.json`; `test/helpers.js`, `agent.test.js`,
`ollama.live.test.js`; `docs/ollama-api.md`, `README.md`, `CLAUDE.md`,
`docs/verify.md`.

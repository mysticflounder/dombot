# Ollama wire format, as observed

Captured against Ollama **0.33.1** on 2026-08-27 with `gemma4:12b-mlx`.
`agent.js` is written to these shapes; when Ollama changes them, this file
and `test/helpers.js` (`chatChunks`) are what to update.

## `POST /api/chat` (streaming)

Request:

```json
{
  "model": "gemma4:12b-mlx",
  "stream": true,
  "think": false,
  "options": { "num_ctx": 16384 },
  "keep_alive": "10m",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "", "tool_calls": [ { "id": "call_ar8ywtqm", "function": { "index": 0, "name": "get_weather", "arguments": { "city": "Paris" } } } ] },
    { "role": "tool", "content": "21°C, light rain", "tool_name": "get_weather", "tool_call_id": "call_ar8ywtqm" }
  ],
  "tools": [ { "type": "function", "function": { "name": "get_weather", "description": "...", "parameters": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] } } } ]
}
```

`think`, `options`, and `keep_alive` are optional. The tool message works
with or without `tool_call_id` (older Ollama versions know only `tool_name`).

Response: one JSON object per line.

```
{"model":"gemma4:12b-mlx","created_at":"…","message":{"role":"assistant","content":"","thinking":"The"},"done":false}
{"model":"gemma4:12b-mlx","created_at":"…","message":{"role":"assistant","content":"The current"},"done":false}
{"model":"gemma4:12b-mlx","created_at":"…","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_ar8ywtqm","function":{"index":0,"name":"get_weather","arguments":{"city":"Paris"}}}]},"done":false}
{"model":"gemma4:12b-mlx","created_at":"…","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":3859887041,"load_duration":1834756833,"prompt_eval_count":90,"prompt_eval_duration":934746292,"eval_count":52,"eval_duration":881612375}
```

- `thinking` streams as deltas when the model thinks (`think` omitted or
  `true`); `think: false` produces none.
- A tool call arrives whole in one chunk; `arguments` is already an object.
  `done_reason` is `"stop"` even when the model called tools — detect tool
  calls by their presence, not by the reason.
- `done_reason: "length"` means the context or output limit was hit.
- Errors: HTTP status with `{"error": "model 'nope:latest' not found"}`
  (404 here; 400 for a model without tool support).

## `GET /api/tags`

```json
{ "models": [ { "name": "gemma4:12b-mlx", "model": "gemma4:12b-mlx", "modified_at": "…", "size": 6773000000, "digest": "…", "details": { "family": "gemma4_unified", "parameter_size": "", "quantization_level": "" } } ] }
```

## `POST /api/show` `{"model": "…"}`

Returns, among much else, `"capabilities": ["completion", "vision", "tools", "thinking"]`.
DomBot reads `tools` and `thinking` from it to grey out models in the
dropdown.

## `GET /api/version`

`{"version": "0.33.1"}`. Used by **Test connection**.

## Origins

Ollama's default `OLLAMA_ORIGINS` already allows `chrome-extension://*`, so
requests from the service worker work without configuration. For an Ollama
on another machine, start it with `OLLAMA_HOST=0.0.0.0` so it listens on the
LAN.

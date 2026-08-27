# 2026-08-27 — Chat answered 403 while Test connection passed

## Summary

The first real-Chrome run: **Test connection** and the model list worked,
every chat message failed with `Ollama at <base> answered 403`.

## Symptoms

- `GET /api/version` and `GET /api/tags` from the options page: fine.
- `POST /api/chat` from the service worker: 403, empty body.
- Not noticed until now: `POST /api/show` (capabilities) was also failing
  silently, so every model showed `tools: unknown` instead of being greyed
  out or not.

## Root cause

Ollama's CORS middleware rejects any request whose `Origin` header is not
on its allow-list, and the default list (localhost, `app://`, `file://`,
`vscode-*`) does **not** include `chrome-extension://*`. Reproduced with
curl against the local Ollama 0.33.1: `Origin: chrome-extension://…` → 403
on every endpoint; no `Origin`, or `Origin: http://localhost` → 200.

Chrome puts `Origin: chrome-extension://<id>` on an extension's POST
requests but not on its GETs. That split is why the GET-based checks passed
and made the setup look correct.

The previous session recorded "default `OLLAMA_ORIGINS` allows
`chrome-extension://*`" in the README, `docs/ollama-api.md`, and a memory.
That claim was never tested with an `Origin` header; the live test uses
Node's fetch, which sends none.

## Fix

- `agent.js`: `originRule({id, base})` builds a `declarativeNetRequest`
  rule that removes the `Origin` header on `<base>/api/` requests
  (`resourceTypes: ["xmlhttprequest"]`, URL canonicalised through `new
  URL`). Pure, unit-tested.
- `background.js`: installs rule 1 for the saved base at worker start and
  whenever scheme/host/port change; rule 2 on an `origin.allow` message for
  the base the options page is probing before Save.
- `options.js`: sends `origin.allow` before Test connection and Refresh.
- `manifest.json`: `declarativeNetRequestWithHostAccess` (no extra install
  warning, since `<all_urls>` host permission already exists).
- Docs corrected; verify.md checks 3 and 6 now prove the rule applies.

Alternative rejected: telling users to set `OLLAMA_ORIGINS`. It works, but
every install would need it, and the Mac app makes environment variables
awkward.

## Lessons

- A claim about CORS is only tested by a request that carries an `Origin`
  header. `curl` and Node's fetch send none, so they prove nothing here.
- When GETs pass and POSTs fail against the same host, suspect the `Origin`
  header before anything else.
- The rule cannot be exercised by `node --test`; verify.md checks 3 and 6
  are the proof. {{NEEDS_PROOF}} until Adam runs them.

## Files changed

`extension/agent.js`, `extension/background.js`, `extension/options.js`,
`extension/manifest.json`, `test/agent.test.js`, `README.md`, `CLAUDE.md`,
`docs/ollama-api.md`, `docs/verify.md`.

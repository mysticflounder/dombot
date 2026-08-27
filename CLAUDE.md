# DomBot

Chrome (MV3) extension: a collapsible chat panel on every page, backed by
the user's Ollama, with tools that read and change the page's DOM. Changes
are saved per page and applied again on every load.

## Layout

```
extension/     What Chrome loads: manifest, service worker, content scripts, options page, icons
  agent.js       ES module. The Ollama client: request shape, NDJSON parsing, tool loop, model list. No Chrome APIs.
  background.js  ES module service worker. Sessions per tab, model cache, Origin-header rules, saved-change writes, toolbar toggle.
  edits.js       Classic script. Saved-change records: matching, describing, the saved_changes tool.
  dom-tools.js   Classic script. read_page / inspect_dom / modify_dom. The only code that touches the page.
  content.js     Classic script. The panel (closed shadow DOM), model dropdown, tool execution, replay on load.
  options.*      ES module page. The config window; imports agent.js for the model list and version check.
scripts/       build.sh, test.sh, make-icons.js
test/          node --test; jsdom for the DOM-side scripts; ollama.live.test.js against the real Ollama
docs/          ollama-api.md (observed wire format), verify.md (live checks), postmortems/
```

## Facts that constrain changes here

- **The wire format in `docs/ollama-api.md` is observed, not recalled.**
  Tool calls carry an `id`; `arguments` is an object; `done_reason` stays
  `"stop"` when tools are called; thinking streams as `message.thinking`.
  When Ollama changes, update that file, `test/helpers.js` (`chatChunks`),
  and `agent.js` together. The live test is what proves it.
- **MV3 service workers die after ~30s idle.** Conversations are mirrored to
  `chrome.storage.session` per tab; the page's port reconnects on its own; a
  keepalive ticks only while a turn runs. Never keep state only in worker
  memory.
- **No bundler, no npm at runtime.** The extension is loaded unpacked.
  `agent.js` speaks raw HTTP for that reason.
- **Classic scripts share one world.** `edits.js` and `dom-tools.js` define
  `globalThis.DomBotEdits` / `globalThis.DomTools` and load before
  `content.js`. They must not use `import`/`export`; the tests `eval` them in
  a jsdom window.
- **`agent.js` has no Chrome dependencies.** fetch, tool execution, and UI
  callbacks are injected. Keep it that way so `node --test` covers the loop.
- **The service worker is the only writer of `edits`.** Content scripts and
  the options page read `chrome.storage.local.edits` directly, but every
  mutation goes through `edits.add/remove/update/clear` messages, which are
  serialised in `background.js`.
- **Settings keys:** `scheme`, `host`, `port`, `model`, `think`, `numCtx`,
  `keepAlive`, `customInstructions`, `showPill`. `DEFAULTS` in
  `background.js` and `options.js` must agree.
- **The panel host is `#dombot-host` on `<html>`.** `dom-tools.js` filters it
  out of every match. Inserted HTML from a saved change carries
  `data-dombot-edit="<id>"`; replay checks for it before inserting again.
- **Tools return text, not JSON.** The model reads it. Tool errors go back
  as `role: "tool"` content starting with `Error: ` — Ollama has no error
  flag on tool messages.
- **Chrome rejects files whose names start with `_`.** `node_modules` stays
  outside `extension/` for that reason; `build.sh` checks.
- **Ollama answers 403 to `chrome-extension://` origins**, and Chrome puts
  that `Origin` on every POST the extension sends (not on GETs, so Test
  connection passes while chat fails). `background.js` keeps two dynamic
  `declarativeNetRequest` rules from `originRule` in `agent.js` that remove
  the header on `<base>/api/`: the saved base, and the base the options page
  is probing. The `declarativeNetRequestWithHostAccess` permission exists for
  this. Details and the observed table: `docs/ollama-api.md` → Origins.

## Conventions

- No regex. Character walkers (`compactText`, `tidyLines`, the NDJSON
  parser, `baseUrl`) exist for this reason.
- Extension pages use `chrome.*` promises (MV3). No callbacks.
- Build DOM with `createElement`, not `innerHTML`, inside the panel — Trusted
  Types pages block the latter.
- Under jsdom, compare values that crossed the realm through `plain()`
  (JSON round trip); `deepStrictEqual` sees different prototypes otherwise.

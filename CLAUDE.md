# DomBot

Chrome (MV3) extension: a collapsible Claude chat panel on every page, with
tools that read and change the page's DOM. Changes are saved per page and
applied again on every load.

## Layout

```
extension/     What Chrome loads: manifest, service worker, content scripts, options page, icons
  agent.js       ES module. The Claude call: request shape, SSE parsing, tool loop. No Chrome APIs.
  background.js  ES module service worker. Sessions per tab, saved-change writes, toolbar toggle.
  edits.js       Classic script. Saved-change records: matching, describing, the saved_changes tool.
  dom-tools.js   Classic script. read_page / inspect_dom / modify_dom. The only code that touches the page.
  content.js     Classic script. The panel (closed shadow DOM), tool execution, replay on load.
scripts/       build.sh, test.sh, make-icons.js
test/          node --test; jsdom for the DOM-side scripts
docs/          verify.md — the live checks the tests cannot cover
```

## Facts that constrain changes here

- **MV3 service workers die after ~30s idle.** Conversations are mirrored to
  `chrome.storage.session` per tab; the page's port reconnects on its own; a
  keepalive ticks only while a turn runs. Never keep state only in worker
  memory.
- **No bundler, no npm at runtime.** The extension is loaded unpacked.
  `agent.js` speaks raw HTTP to `/v1/messages` for that reason; keep the
  request shapes in step with the Messages API docs (streaming, tool use,
  `fallbacks: "default"` with its beta header).
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
- **The panel host is `#dombot-host` on `<html>`.** `dom-tools.js` filters it
  out of every match. Inserted HTML from a saved change carries
  `data-dombot-edit="<id>"`; replay checks for it before inserting again.
- **Tools return text, not JSON.** The model reads it.
- **Chrome rejects files whose names start with `_`.** `node_modules` stays
  outside `extension/` for that reason; `build.sh` checks.

## Conventions

- No regex. Character walkers (`compactText`, `tidyLines`, the SSE parser)
  exist for this reason.
- Extension pages use `chrome.*` promises (MV3). No callbacks.
- Default model `claude-opus-5`; thinking is adaptive by default, controlled
  with `output_config.effort`. Do not add `budget_tokens`.
- Build DOM with `createElement`, not `innerHTML`, inside the panel — Trusted
  Types pages block the latter.

# DomBot

A Chrome extension that puts a collapsible chat panel on every page, backed
by your own **Ollama**. The model can read the page, and it can change it —
text, styles, attributes, inserted or removed elements, form values, clicks.
Every change it makes is saved, and DomBot applies it again each time that
page loads. Nothing leaves your machine except the request to your Ollama.

```
page (any tab)                                          Ollama (this machine, or one on your LAN)
  ▲  read / change the DOM
  │
edits.js + dom-tools.js + content.js  ── port ──►  background.js  ── fetch ──►  POST /api/chat
  panel UI, model dropdown,                        (service worker)               GET  /api/tags
  tool execution, replay on load                   agent loop in agent.js          POST /api/show
```

| Piece | Job |
|---|---|
| `extension/content.js` | The panel (shadow DOM), model dropdown, runs tools on the page, replays saved changes on load |
| `extension/dom-tools.js` | `read_page`, `inspect_dom`, `modify_dom` — the only code that touches the page |
| `extension/edits.js` | Saved-change records: matching, describing, the `saved_changes` tool |
| `extension/agent.js` | The Ollama client: request shape, NDJSON stream parsing, the tool loop, model listing |
| `extension/background.js` | Service worker: one conversation per tab, model cache, single writer of saved changes |
| `extension/options.*` | The config window: Ollama scheme/host/port, model, thinking, context length, keep-alive, saved changes |

## Requirements

- Chrome 116 or newer.
- [Ollama](https://ollama.com) running somewhere Chrome can reach, with at
  least one model that supports **tools** (`ollama show <model>` lists
  `Capabilities`). Verified with Ollama 0.33.1 and `gemma4`, `qwen3.8`,
  `nemotron3`.

## Install

```bash
./scripts/build.sh
```

Then in Chrome:

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick the `extension/` directory
3. Open DomBot's settings (⚙ in the panel, or **Details → Extension options**).
   Check the host and port, **Test connection**, pick a model, **Save**.

`dist/dombot-<version>.zip` is the same directory packaged, for another
machine.

## The config window

| Setting | Default | Notes |
|---|---|---|
| Scheme / Host / Port | `http` / `localhost` / `11434` | Where Ollama listens. **Test connection** reports its version and, when it succeeds, refreshes the Model dropdown. |
| Model | first advertised model with tool support | The dropdown is what `GET /api/tags` returns; models without tool support are greyed out. **Refresh** asks again. The panel header has the same dropdown. |
| Thinking | model default | `on` / `off` sets `think` on the request. Off is faster. |
| Context length | 16384 | `options.num_ctx`. Page text plus the tool definitions need room; empty means Ollama's default, which is usually too small. |
| Keep model loaded | Ollama default (5 min) | `keep_alive`: `10m`, `1h`, `-1` (always), `0` (unload after each reply). |
| Show the pill on every page | on | Off: only the toolbar button or **Alt+Shift+D** opens the panel. |
| Extra instructions | — | Appended to the system prompt. |

**Ollama on another machine:** start it with `OLLAMA_HOST=0.0.0.0` so it
listens on the LAN, and put that machine's address in Host.

**No `OLLAMA_ORIGINS` setting is needed.** Ollama answers 403 to any request
whose `Origin` is a `chrome-extension://` URL, and Chrome puts that header on
every POST an extension sends. DomBot removes the header on its own requests
to the configured host with a `declarativeNetRequest` rule — that is what the
`declarativeNetRequestWithHostAccess` permission is for. No other request in
the browser is touched.

## Use

- A **DomBot** pill sits at the bottom right of every page. Click it to open
  the panel; **–** collapses it back to the pill, **×** hides it. The toolbar
  button or **Alt+Shift+D** brings it back.
- The dropdown in the header switches the model for every tab.
- Type a request. Enter sends; Shift+Enter makes a new line. **Stop** cancels
  a running reply.
- **☰** shows the changes saved for this page: turn each one on or off, widen
  it to the whole site, or delete it. **All sites…** opens the full list in the
  config window.
- **⟲** starts a new chat. The conversation is per tab and survives page
  navigation in that tab until you clear it or close the tab.

Some things to try:

- "What is this page about?"
- "Make the headline red and twice as big"
- "Hide the cookie banner and the newsletter popup, on every page of this site"
- "Put a note at the top of the article that says: read later"
- "Undo the headline change" — DomBot deletes the saved change and reverses it

Local models vary in how well they use tools. If one keeps answering without
calling a tool, try a larger model or say "use the tools" in the request.

## Tools the model has

| Tool | What it does |
|---|---|
| `read_page` | Visible text of the page or one element, with title and URL |
| `inspect_dom` | Elements matching a CSS selector: tag, id, classes, attributes, text, child count, hidden |
| `modify_dom` | One action on every match or one match: `set_text`, `set_html`, `insert_html`, `set_attribute`, `remove_attribute`, `set_style`, `add_class`, `remove_class`, `set_value`, `click`, `focus`, `scroll_into_view`, `remove`, `hide`, `show` |
| `saved_changes` | List, delete, enable, disable, or re-scope the saved changes for this page |

Every tool returns text, not JSON. Selectors are plain CSS. Styles are set
with `!important` so they beat the page's own CSS.

## Saved changes

`modify_dom` saves every change that alters the page (not `click`, `focus`,
`scroll_into_view`, or `set_value`) unless the model passes `persist: false`.
A saved change records the origin, the path, the selector, the action and its
arguments. On load, the content script applies every enabled change for the
page; a change whose element is not there yet is retried for 20 seconds as the
page renders, and again when a single-page app changes the URL.

- **Scope** is `page` (this origin and path) or `site` (every page on the
  origin). The model can set it; you can change it in the list.
- Inserted HTML is tagged with the change's id, so a replay never inserts it
  twice.
- Turning a change off or deleting it takes effect on the next load; the page
  that is open keeps its current state. Ask DomBot to reverse it live if you
  want that now.
- Everything lives in `chrome.storage.local` under the key `edits`.

## Security

- **The model can change any page you open the panel on**, including pages
  where you are logged in, and it can click things. It acts on your
  instructions, but check what it did before you trust a changed page.
- **Page text is untrusted input.** `read_page` hands the page's words to the
  model. The system prompt tells the model to treat them as data, but a page
  that contains instructions can still influence it — local models more than
  most. Do not run DomBot on pages you do not trust.
- The extension needs access to every site (`<all_urls>`) to draw the panel,
  run the tools, and reach whatever address you give it for Ollama. It talks
  to nothing else.

## Development

```bash
./scripts/test.sh     # syntax, manifest, unit tests, and a live round trip against the local Ollama (skips if absent)
./scripts/build.sh    # icons, validation, dist/dombot-<version>.zip
```

The unit tests prove the loop against recorded Ollama responses
(`docs/ollama-api.md` is the reference) and the DOM logic under jsdom. The
live test (`test/ollama.live.test.js`) picks the smallest tool-capable model
and runs one real tool round trip; `OLLAMA_SKIP_LIVE=1` skips it,
`OLLAMA_TEST_HOST` / `OLLAMA_TEST_PORT` / `OLLAMA_TEST_MODEL` redirect it.
What none of that can prove — the panel on real pages, service-worker
restarts, replay timing — is in `docs/verify.md`.

After editing anything under `extension/`, click **Reload** on
`chrome://extensions` and reload the page you are testing on.

## Known limits

- **No markdown in replies** beyond fenced code blocks. The panel is small and
  replies are meant to be short.
- **`set_html` and `insert_html` fail on pages that enforce Trusted Types**
  (some Google properties). The error is reported to the model, which can fall
  back to `set_text` or styling.
- **A replay needs the same selector to match.** If a site changes its
  markup, the saved change silently stops matching. The list still shows it;
  delete it or ask DomBot to redo it.
- **One reply at a time per tab.** Sending while a reply is running is
  refused until you stop it.
- **Context is finite.** With a small `num_ctx`, Ollama silently drops the
  oldest part of the conversation. If the model forgets the tools, raise the
  context length or start a new chat.
- The service worker forgets in-memory state when Chrome suspends it. The
  conversation is mirrored in session storage and comes back; a tool call
  in flight at that moment fails and the turn ends with an error.

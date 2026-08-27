# DomBot

A Chrome extension that puts a collapsible Claude chat panel on every page.
The model can read the page, and it can change it — text, styles, attributes,
inserted or removed elements, form values, clicks. Every change it makes is
saved, and DomBot applies it again each time that page loads.

```
page (any tab)                                   Anthropic API
  ▲  read / change the DOM
  │
edits.js + dom-tools.js + content.js  ── port ──►  background.js  ── fetch ──►  /v1/messages
  panel UI, tool execution,                        (service worker)
  replay of saved changes                          agent loop in agent.js
```

| Piece | Job |
|---|---|
| `extension/content.js` | The panel (shadow DOM), runs tools on the page, replays saved changes on load |
| `extension/dom-tools.js` | `read_page`, `inspect_dom`, `modify_dom` — the only code that touches the page |
| `extension/edits.js` | Saved-change records: matching, describing, the `saved_changes` tool |
| `extension/agent.js` | The Claude call: request shape, SSE stream parsing, the tool loop |
| `extension/background.js` | Service worker: one conversation per tab, single writer of saved changes |
| `extension/options.*` | API key, model, effort, and the full list of saved changes |

## Install

```bash
./scripts/build.sh
```

Then in Chrome:

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick the `extension/` directory
3. Click the DomBot toolbar button → **Options**, paste an Anthropic API key,
   **Test key and model**, **Save**

`dist/dombot-<version>.zip` is the same directory packaged, for the Web Store
or for another machine.

## Use

- A **DomBot** pill sits at the bottom right of every page. Click it to open
  the panel; **–** collapses it back to the pill, **×** hides it. The toolbar
  button or **Alt+Shift+D** brings it back.
- Type a request. Enter sends; Shift+Enter makes a new line. **Stop** cancels
  a running reply.
- **☰** shows the changes saved for this page: turn each one on or off, widen
  it to the whole site, or delete it. **All sites…** opens the full list in the
  options page.
- **⟲** starts a new chat. The conversation is per tab and survives page
  navigation in that tab until you clear it or close the tab.

Some things to try:

- "What is this page about?"
- "Make the headline red and twice as big"
- "Hide the cookie banner and the newsletter popup, on every page of this site"
- "Put a note at the top of the article that says: read later"
- "Undo the headline change" — DomBot deletes the saved change and reverses it

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

## Settings

| Setting | Default | Notes |
|---|---|---|
| API key | — | Stored in extension storage, plain text |
| Model | `claude-opus-5` | Any current Messages API model id |
| Effort | `high` | `low` … `max`; lower is faster and cheaper |
| Max output tokens | 64000 | A ceiling per reply, not a target |
| Server-side fallbacks | on | If the model declines a request, the API retries it on Anthropic's recommended fallback model (`fallbacks: "default"`) |
| Show the pill on every page | on | Off: only the toolbar button or shortcut opens the panel |
| Extra instructions | — | Appended to the system prompt |

## Security

- **The model can change any page you open the panel on**, including pages
  where you are logged in, and it can click things. It acts on your
  instructions, but check what it did before you trust a changed page.
- **Page text is untrusted input.** `read_page` hands the page's words to the
  model. The system prompt tells the model to treat them as data, but a page
  that contains instructions can still influence it. Do not run DomBot on
  pages you do not trust.
- **The API key is in plain text** in this browser profile's extension
  storage. Anyone who can read the profile can read it.
- The extension needs access to every site (`<all_urls>`) to draw the panel
  and run the tools, and to `api.anthropic.com` to talk to Claude. Nothing
  else leaves the browser.

## Development

```bash
./scripts/test.sh     # syntax, manifest, unit tests (agent loop with a fake API; DOM tools under jsdom)
./scripts/build.sh    # icons, validation, dist/dombot-<version>.zip
```

The tests prove the protocol and the DOM logic. What they cannot prove — the
panel on real pages, service-worker restarts, replay timing on slow pages — is
listed in `docs/verify.md`.

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
- The service worker forgets in-memory state when Chrome suspends it. The
  conversation is mirrored in session storage and comes back; a tool call
  in flight at that moment fails and the turn ends with an error.

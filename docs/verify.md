# Live checks

`scripts/test.sh` proves the agent loop against recorded Ollama responses,
one real tool round trip against the local Ollama, and the DOM tools under
jsdom. These checks need real Chrome.

## Install and connect

1. `./scripts/build.sh`, then `chrome://extensions` → Load unpacked → `extension/`.
2. Open the config window (⚙ in the panel, or Details → Extension options).
   **Test connection** reports `Ollama <version> at http://localhost:11434 — <n> model(s)` and the Model dropdown fills in without pressing **Refresh**.
3. The Model dropdown lists what `ollama list` shows; models without tool support are greyed out. The line under the dropdown says `tools: yes` or `tools: no`, never `tools: unknown` — that proves the Origin rule covers `POST /api/show`. Pick one, **Save**.
4. Set Host to a wrong address, **Test connection**: the error names the address and says to check host/port, and the Model dropdown keeps its list (the version check fails first, so no refresh runs). Set it back.
5. Open any https page. The **DomBot** pill is at the bottom right. Click it: the panel opens, and the header dropdown shows the same models.

## Chat and tools

6. Ask "what is this page about?" — the status shows `waiting for <model>…`, then text streams in, and a `read_page` row appears above the answer. A `403` here means the Origin rule did not apply; see `docs/ollama-api.md` → Origins.
7. Ask "make the first h1 red" — a `modify_dom` row shows `→ set_style: changed 1 element(s)…` and ` · saved`. The heading is red.
8. Reload the page. The heading is red again without any chat. ☰ lists the change.
9. Turn the change off in ☰, reload: the heading is back to normal. Turn it on, reload: red again.
10. Ask "undo the red heading" — the model calls `saved_changes` delete and `modify_dom` with persist=false. ☰ is empty; reload confirms.
11. Ask "hide the site header on every page of this site" — the change shows scope `site`; open another path on the same origin and confirm.
12. On a single-page app (e.g. a docs site with client-side routing), save a site-scoped change, navigate in-app: the change re-applies within a second.
13. Press **Stop** during a long reply: a "Stopped." note appears and the input is usable again.
14. Switch the model in the header dropdown, send a message: the status names the new model.
15. Set Thinking to `on` with a thinking-capable model: the status shows `thinking…` before text arrives. Set it to `off`: it does not.

## Lifecycle

16. Open the panel, wait 60 seconds without typing (the worker is suspended), send a message: it works, and the earlier messages are still shown.
17. Navigate to another page in the same tab and open the panel: the conversation is still there. Close the tab, open the site again: it is gone.
18. Click **Reload** on `chrome://extensions` with a page open, then open the panel there: the "reload this page" error appears, and a page reload fixes it.
19. Toolbar button toggles the panel; **Alt+Shift+D** does too (check `chrome://extensions/shortcuts` if not).
20. Stop Ollama, send a message: the error says it cannot reach Ollama at the address and offers **Open settings**. Start it again; the next message works.

## Edge pages

21. A page with strict CSP (e.g. github.com): the panel renders and styles apply.
22. A page enforcing Trusted Types (e.g. a Google property): `insert_html` reports an error to the model; `set_style` and `set_text` still work.
23. A page with global keyboard shortcuts (e.g. GitHub's `s`, Gmail's `c`): typing in the panel does not trigger them.
24. With the OS in dark mode, on a light page (e.g. example.com): the header model dropdown and the scope dropdown in ☰ open as dark lists with readable text. Switch the OS to light mode: both are light with dark text.

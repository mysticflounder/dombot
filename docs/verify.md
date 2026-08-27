# Live checks

`scripts/test.sh` proves the agent loop against a fake API and the DOM tools
under jsdom. These checks need real Chrome and a real API key.

## Install and connect

1. `./scripts/build.sh`, then `chrome://extensions` → Load unpacked → `extension/`.
2. Options → paste the key → **Test key and model** reports the model's display name.
3. Open any https page. The **DomBot** pill is at the bottom right. Click it: the panel opens.

## Chat and tools

4. Ask "what is this page about?" — text streams in, and a `read_page` row appears above the answer.
5. Ask "make the first h1 red" — a `modify_dom` row shows `→ set_style: changed 1 element(s)…` and ` · saved`. The heading is red.
6. Reload the page. The heading is red again without any chat. ☰ lists the change.
7. Turn the change off in ☰, reload: the heading is back to normal. Turn it on, reload: red again.
8. Ask "undo the red heading" — the model calls `saved_changes` delete and `modify_dom` with persist=false. ☰ is empty; reload confirms.
9. Ask "hide the site header on every page of this site" — the change shows scope `site`; open another path on the same origin and confirm.
10. On a single-page app (e.g. a docs site with client-side routing), save a site-scoped change, navigate in-app: the change re-applies within a second.
11. Press **Stop** during a long reply: a "Stopped." note appears and the input is usable again.

## Lifecycle

12. Open the panel, wait 60 seconds without typing (the worker is suspended), send a message: it works, and the earlier messages are still shown.
13. Navigate to another page in the same tab and open the panel: the conversation is still there. Close the tab, open the site again: it is gone.
14. Click **Reload** on `chrome://extensions` with a page open, then open the panel there: the "reload this page" error appears, and a page reload fixes it.
15. Toolbar button toggles the panel; **Alt+Shift+D** does too (check `chrome://extensions/shortcuts` if not).

## Edge pages

16. A page with strict CSP (e.g. github.com): the panel renders and styles apply.
17. A page enforcing Trusted Types (e.g. a Google property): `insert_html` reports an error to the model; `set_style` and `set_text` still work.
18. A page with global keyboard shortcuts (e.g. GitHub's `s`, Gmail's `c`): typing in the panel does not trigger them.

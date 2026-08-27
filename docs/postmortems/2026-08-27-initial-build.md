# 2026-08-27 — Initial build of DomBot

## Summary

Built DomBot from nothing in one session: a Chrome MV3 extension with a
collapsible Claude chat panel, three DOM tools plus a saved-changes tool, and
replay of saved changes on every page load. 32 unit tests, build script,
docs, and a new repo under `mysticflounder`.

## Symptoms (what went wrong on the way)

1. Seven jsdom-based tests failed with "Values have same structure but are
   not reference-equal" although the values printed identically.
2. One `read_page` test failed: it asked for `selector: "p"` and expected
   the long paragraph, but got "para one".

## Root cause

1. `assert.deepStrictEqual` compares prototypes. Objects and arrays created
   inside a jsdom window (`window.eval(source)`) carry that window's
   `Object.prototype` / `Array.prototype`, not Node's. Any array produced by
   `.map` on a window-realm array, or any object literal built inside the
   evaluated script, fails a strict deep-equal against a Node literal.
2. `read_page` reads the **first** match of the selector by design; the test
   wrote the wrong selector, the code was right.

## Fix

1. `test/dom-tools.test.js` and `test/edits.test.js` compare through
   `same(actual, expected)` = `assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected)`.
2. The truncation test reads the whole body with `max_chars: 200`.

## Decisions worth knowing later

- **Raw `fetch`, not `@anthropic-ai/sdk`.** The extension is loaded unpacked
  with no bundler; a module service worker cannot resolve npm packages. The
  request shapes (streaming SSE, tool use, `fallbacks: "default"` +
  `server-side-fallback-2026-07-01`) come from the claude-api skill docs.
- **Tool definitions live with their executors** (`dom-tools.js`,
  `edits.js`) in the content script world and are sent to the service worker
  in the `hello` message. The worker's loop is generic and has no DOM code.
- **The service worker is the single writer of `edits`** to avoid lost
  updates from concurrent read-modify-write in several tabs.
- **Inserted HTML is tagged** `data-dombot-edit="<id>"` so replay is
  idempotent; every other persistable action is idempotent by nature.
- **`click`, `focus`, `scroll_into_view`, `set_value` are never saved.**
  Replaying a click on every load is the wrong default; `remove`/`hide`
  cover the "dismiss the banner" case.
- **`node_modules` stays outside `extension/`.** Chrome refuses to load a
  directory containing a name that starts with `_`, and packages contain
  those. `build.sh` walks the tree and fails on any.

## Lessons

- Under jsdom, never strict-deep-equal a value that crossed the realm
  boundary; round-trip through JSON first.
- The Bash tool's cwd resets to the session directory after every call, so
  git in a second repo needs `cd <repo> && git …` in one command. That
  pattern is on the git-usage ban list for *other* repos; here the repo was
  created by this session and no other session had it open.

## Files changed

New repo. Everything under `extension/`, `scripts/`, `test/`, `docs/`,
`README.md`, `CLAUDE.md`, `package.json`.

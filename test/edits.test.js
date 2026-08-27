import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/** jsdom objects have their own prototypes; compare structure only. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const same = (actual, expected) => assert.deepEqual(plain(actual), expected);

const SOURCE = readFileSync(new URL("../extension/edits.js", import.meta.url), "utf8");

function load() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com/a/b", runScripts: "outside-only" });
  dom.window.eval(SOURCE);
  return dom.window.DomBotEdits;
}

const loc = { origin: "https://example.com", pathname: "/a/b" };

test("matches: page scope needs the same path, site scope only the origin", () => {
  const E = load();
  assert.equal(E.matches({ origin: "https://example.com", path: "/a/b", scope: "page" }, loc), true);
  assert.equal(E.matches({ origin: "https://example.com", path: "/other", scope: "page" }, loc), false);
  assert.equal(E.matches({ origin: "https://example.com", path: "/other", scope: "site" }, loc), true);
  assert.equal(E.matches({ origin: "https://evil.com", path: "/a/b", scope: "site" }, loc), false);
  assert.equal(E.matches(null, loc), false);
});

test("forPage: enabled matches only, in stored order", () => {
  const E = load();
  const edits = [
    { id: "1", origin: "https://example.com", path: "/a/b", scope: "page", enabled: true },
    { id: "2", origin: "https://example.com", path: "/a/b", scope: "page", enabled: false },
    { id: "3", origin: "https://example.com", path: "/x", scope: "site" },
    { id: "4", origin: "https://other.com", path: "/a/b", scope: "site" },
  ];
  same(E.forPage(edits, loc).map((e) => e.id), ["1", "3"]);
  same(E.forPage("garbage", loc), []);
});

test("fromToolInput: keeps the replayable fields, drops the rest", () => {
  const E = load();
  const edit = E.fromToolInput(
    { selector: "h1", action: "set_style", name: "color", value: "red", persist: true, scope: "site", index: 0, junk: 1 },
    loc,
    "e1",
    "2026-08-27T00:00:00.000Z",
  );
  same(edit, {
    id: "e1",
    createdAt: "2026-08-27T00:00:00.000Z",
    origin: "https://example.com",
    path: "/a/b",
    scope: "site",
    enabled: true,
    selector: "h1",
    action: "set_style",
    name: "color",
    value: "red",
    index: 0,
  });
  assert.equal(E.fromToolInput({ selector: "p", action: "remove" }, loc, "e2", "t").scope, "page");
});

test("describe: readable one-liners", () => {
  const E = load();
  assert.equal(E.describe({ action: "set_style", name: "color", value: "red", selector: "h1" }), 'set_style color = red on "h1"');
  assert.equal(E.describe({ action: "remove", selector: ".ad", index: 2, scope: "site", enabled: false }), 'remove on ".ad" [#2] (site, off)');
  assert.equal(E.describe({ action: "insert_html", value: "<p>x</p>", selector: "body", position: "afterbegin" }), 'insert_html = <p>x</p> on "body" (afterbegin)');
  assert.equal(E.describe({ id: "e9", action: "hide", selector: "nav" }, { withId: true }), 'e9  hide on "nav"');
  const long = E.describe({ action: "set_text", value: "x".repeat(100), selector: "p" });
  assert.ok(long.includes("x".repeat(60) + "…"), long);
});

test("isPersistable and makeId", () => {
  const E = load();
  assert.equal(E.isPersistable("set_text"), true);
  assert.equal(E.isPersistable("hide"), true);
  assert.equal(E.isPersistable("click"), false);
  assert.equal(E.isPersistable("set_value"), false);
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(E.makeId());
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(id.startsWith("e") && id.length === 11, id);
  assert.equal(E.toolDefinition.name, "saved_changes");
  same(E.toolDefinition.input_schema.required, ["action"]);
});

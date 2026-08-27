import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/** jsdom objects have their own prototypes; compare structure only. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const same = (actual, expected) => assert.deepEqual(plain(actual), expected);

const SOURCE = readFileSync(new URL("../extension/dom-tools.js", import.meta.url), "utf8");

/** A page with dom-tools.js evaluated inside it, the way the content script world sees it. */
function page(body, url = "https://example.com/page?q=1") {
  const dom = new JSDOM(`<!doctype html><html><head><title>Test page</title></head><body>${body}</body></html>`, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.eval(SOURCE);
  return dom.window;
}

test("definitions: three page tools with the documented shapes", () => {
  const w = page("");
  const names = w.DomTools.definitions.map((d) => d.name);
  same(names, ["read_page", "inspect_dom", "modify_dom"]);
  const modify = w.DomTools.definitions[2].input_schema;
  same(modify.required, ["selector", "action"]);
  assert.ok(modify.properties.action.enum.includes("hide"));
  assert.ok("persist" in modify.properties && "scope" in modify.properties);
});

test("inspect_dom: describes matches, honours limit, flags hidden, shows values", () => {
  const w = page('<h1 id="t" class="a b">Hello <b>world</b></h1><p>one</p><p hidden>two</p><input name="q" value="typed">');
  const out = w.DomTools.run("inspect_dom", { selector: "p" });
  assert.ok(out.startsWith('2 element(s) match "p":'), out);
  assert.ok(out.includes("[0] <p>"), out);
  assert.ok(out.includes("text: one"), out);
  assert.ok(out.includes('[1] <p hidden="">'), out);
  assert.ok(out.includes("hidden"), out);

  const limited = w.DomTools.run("inspect_dom", { selector: "p", limit: 1 });
  assert.ok(limited.includes("showing the first 1"), limited);
  assert.ok(!limited.includes("[1]"), limited);

  const h1 = w.DomTools.run("inspect_dom", { selector: "h1", include_html: true });
  assert.ok(h1.includes('<h1 id="t" class="a b">'), h1);
  assert.ok(h1.includes("text: Hello world"), h1);
  assert.ok(h1.includes("children: 1"), h1);
  assert.ok(h1.includes("html: <h1"), h1);

  const input = w.DomTools.run("inspect_dom", { selector: "input" });
  assert.ok(input.includes('name="q"') && input.includes("value: typed"), input);
});

test("inspect_dom: no match, invalid selector, and the panel host is never a match", () => {
  const w = page('<div id="dombot-host"></div>');
  assert.equal(w.DomTools.run("inspect_dom", { selector: "div" }), 'No elements match "div".');
  assert.throws(() => w.DomTools.run("inspect_dom", { selector: "p[" }), /invalid CSS selector/);
  assert.throws(() => w.DomTools.run("inspect_dom", {}), /"selector" is required/);
});

test("read_page: title, URL, tidy text, and truncation", () => {
  const w = page("<h1>Title</h1>\n\n\n<p>  para one  </p><p>" + "x".repeat(500) + "</p>");
  const out = w.DomTools.run("read_page", {});
  assert.ok(out.startsWith("Title: Test page\nURL: https://example.com/page?q=1\n"), out);
  assert.ok(out.includes("Title"), out);
  assert.ok(!out.includes("\n\n\n"), out);

  const cut = w.DomTools.run("read_page", { max_chars: 200 });
  assert.ok(cut.includes("[cut at 200 of"), cut);

  assert.throws(() => w.DomTools.run("read_page", { selector: "nav" }), /No elements match/);
});

test("modify_dom: set_text on every match, or on one by index", () => {
  const w = page("<p>a</p><p>b</p><p>c</p>");
  const all = w.DomTools.run("modify_dom", { selector: "p", action: "set_text", value: "z" });
  assert.equal(all, 'set_text: changed 3 element(s) matching "p".');
  same([...w.document.querySelectorAll("p")].map((p) => p.textContent), ["z", "z", "z"]);

  const one = w.DomTools.run("modify_dom", { selector: "p", action: "set_text", value: "only", index: 1 });
  assert.equal(one, 'set_text: changed 1 element(s) matching "p" (match #1).');
  same([...w.document.querySelectorAll("p")].map((p) => p.textContent), ["z", "only", "z"]);

  assert.throws(() => w.DomTools.run("modify_dom", { selector: "p", action: "set_text", value: "x", index: 7 }), /index 7 is out of range: 3/);
  assert.throws(() => w.DomTools.run("modify_dom", { selector: "p", action: "set_text", value: "x", index: -1 }), /whole number/);
});

test("modify_dom: attributes, styles (!important), classes, hide/show, remove", () => {
  const w = page('<a id="l" class="x y" href="/a">link</a>');
  const a = w.document.getElementById("l");
  const run = (input) => w.DomTools.run("modify_dom", { selector: "#l", ...input });

  run({ action: "set_attribute", name: "target", value: "_blank" });
  assert.equal(a.getAttribute("target"), "_blank");
  run({ action: "set_attribute", name: "data-flag" });
  assert.equal(a.getAttribute("data-flag"), "");
  run({ action: "remove_attribute", name: "href" });
  assert.equal(a.hasAttribute("href"), false);

  run({ action: "set_style", name: "color", value: "red" });
  assert.equal(a.style.getPropertyValue("color"), "red");
  assert.equal(a.style.getPropertyPriority("color"), "important");

  run({ action: "add_class", value: "  m   n " });
  assert.equal(a.className, "x y m n");
  run({ action: "remove_class", value: "x n" });
  assert.equal(a.className, "y m");

  run({ action: "hide" });
  assert.equal(a.style.getPropertyValue("display"), "none");
  assert.equal(a.style.getPropertyPriority("display"), "important");
  run({ action: "show" });
  assert.equal(a.style.getPropertyValue("display"), "");

  run({ action: "set_html", value: "<b>bold</b>" });
  assert.equal(a.innerHTML, "<b>bold</b>");

  run({ action: "remove" });
  assert.equal(w.document.getElementById("l"), null);
});

test("modify_dom: insert_html positions, with and without the saved-change marker", () => {
  const w = page('<div id="box"><span>inner</span></div>');
  const box = w.document.getElementById("box");
  w.DomTools.run("modify_dom", { selector: "#box", action: "insert_html", value: "<p>tail</p>" });
  assert.equal(box.lastElementChild.tagName, "P");
  assert.equal(box.lastElementChild.hasAttribute("data-dombot-edit"), false);

  w.DomTools.run("modify_dom", { selector: "#box", action: "insert_html", value: "<i>first</i>", position: "afterbegin" }, { editId: "e1" });
  assert.equal(box.firstElementChild.tagName, "I");
  assert.equal(box.firstElementChild.getAttribute("data-dombot-edit"), "e1");

  w.DomTools.run("modify_dom", { selector: "#box", action: "insert_html", value: "<hr><em>two</em>", position: "beforebegin" }, { editId: "e2" });
  assert.equal(box.previousElementSibling.tagName, "EM");
  assert.equal(box.previousElementSibling.previousElementSibling.tagName, "HR");
  assert.equal(box.previousElementSibling.getAttribute("data-dombot-edit"), "e2");

  w.DomTools.run("modify_dom", { selector: "#box", action: "insert_html", value: "<u>after</u>", position: "afterend" }, { editId: "e3" });
  assert.equal(box.nextElementSibling.tagName, "U");

  assert.throws(() => w.DomTools.run("modify_dom", { selector: "#box", action: "insert_html", value: "x", position: "inside" }), /position must be one of/);
});

test("modify_dom: set_value fires input and change; checkboxes, selects, contenteditable", () => {
  const w = page(
    '<input id="t" value="old"><textarea id="ta"></textarea><input id="c" type="checkbox"><select id="s"><option>a</option><option>b</option></select><div id="ce" contenteditable="true">x</div><span id="sp">no</span>',
  );
  const events = [];
  for (const id of ["t", "ta", "c", "s", "ce"]) {
    const node = w.document.getElementById(id);
    node.addEventListener("input", () => events.push(`${id}:input`));
    node.addEventListener("change", () => events.push(`${id}:change`));
  }
  const run = (selector, value) => w.DomTools.run("modify_dom", { selector, action: "set_value", value });

  run("#t", "new");
  assert.equal(w.document.getElementById("t").value, "new");
  run("#ta", "multi\nline");
  assert.equal(w.document.getElementById("ta").value, "multi\nline");
  run("#c", "true");
  assert.equal(w.document.getElementById("c").checked, true);
  run("#c", "false");
  assert.equal(w.document.getElementById("c").checked, false);
  run("#s", "b");
  assert.equal(w.document.getElementById("s").value, "b");
  run("#ce", "typed");
  assert.equal(w.document.getElementById("ce").textContent, "typed");

  assert.ok(events.includes("t:input") && events.includes("t:change"), events.join(","));
  assert.ok(events.includes("ta:input") && events.includes("s:change") && events.includes("ce:input"), events.join(","));
  assert.throws(() => run("#sp", "x"), /set_value needs an input/);
});

test("modify_dom: click dispatches, focus works, scroll_into_view tolerates jsdom", () => {
  const w = page('<button id="b">go</button><input id="i">');
  let clicks = 0;
  w.document.getElementById("b").addEventListener("click", () => clicks++);
  w.DomTools.run("modify_dom", { selector: "#b", action: "click" });
  assert.equal(clicks, 1);
  w.DomTools.run("modify_dom", { selector: "#i", action: "focus" });
  assert.equal(w.document.activeElement.id, "i");
  assert.equal(w.DomTools.run("modify_dom", { selector: "#b", action: "scroll_into_view" }), 'scroll_into_view: changed 1 element(s) matching "#b".');
});

test("modify_dom: argument errors are specific", () => {
  const w = page("<p>x</p>");
  assert.throws(() => w.DomTools.run("modify_dom", { selector: "p", action: "set_text" }), /action set_text needs "value"/);
  assert.throws(() => w.DomTools.run("modify_dom", { selector: "p", action: "set_style", value: "red" }), /needs "name"/);
  assert.throws(() => w.DomTools.run("modify_dom", { selector: "p", action: "explode" }), /unknown action "explode"/);
  assert.throws(() => w.DomTools.run("modify_dom", { selector: "h2", action: "remove" }), /No elements match "h2"/);
  assert.throws(() => w.DomTools.run("nope", {}), /unknown tool "nope"/);
});

test("modify: quiet mode reports zero instead of throwing when nothing matches", () => {
  const w = page("<p>x</p>");
  same(w.DomTools.modify({ selector: "h2", action: "remove" }, { quiet: true }), { count: 0, summary: 'no match for "h2"' });
  assert.equal(w.DomTools.modify({ selector: "p", action: "remove", index: 3 }, { quiet: true }).count, 0);
  // But a bad argument still throws, even quietly — that edit can never work.
  assert.throws(() => w.DomTools.modify({ selector: "p", action: "set_text" }, { quiet: true }), /needs "value"/);
});

test("applyEdit: replays are idempotent — inserted HTML is not added twice", () => {
  const w = page('<div id="box"></div>');
  const edit = { id: "eabc", selector: "#box", action: "insert_html", value: "<p>hello</p>", position: "beforeend" };
  same(w.DomTools.applyEdit(edit), { applied: true, count: 1 });
  same(w.DomTools.applyEdit(edit), { applied: true, count: 0 });
  assert.equal(w.document.querySelectorAll("#box p").length, 1);
  assert.equal(w.document.querySelector("#box p").getAttribute("data-dombot-edit"), "eabc");

  same(w.DomTools.applyEdit({ id: "e2", selector: "h1", action: "set_text", value: "x" }), { applied: false, count: 0 });
  same(w.DomTools.applyEdit({ id: "e3", selector: "#box", action: "set_text", value: "x" }), { applied: true, count: 1 });
});

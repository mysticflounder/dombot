/**
 * DOM tools — the only code that reads or changes the page.
 *
 * Classic script: loaded into the content script world before content.js.
 * Defines `globalThis.DomTools`. The unit tests evaluate this file inside a
 * jsdom window, so nothing here may depend on Chrome APIs.
 *
 * Every tool returns formatted text for the model, not JSON.
 */
(() => {
  const HOST_ID = "dombot-host"; // the panel's host element; never a tool target
  const EDIT_ATTR = "data-dombot-edit"; // marks HTML a saved change inserted
  const MAX_TEXT = 200;
  const MAX_HTML = 1500;
  const KEY_ATTRS = [
    "name",
    "type",
    "href",
    "src",
    "alt",
    "title",
    "placeholder",
    "role",
    "aria-label",
    "for",
    "action",
    "data-testid",
    "contenteditable",
    "disabled",
    "checked",
    "selected",
    "hidden",
  ];
  const POSITIONS = ["beforebegin", "afterbegin", "beforeend", "afterend"];

  // -------------------------------------------------------------------------
  // Tool definitions (what the model sees)
  // -------------------------------------------------------------------------

  const definitions = [
    {
      name: "read_page",
      description:
        "Read the visible text of the current page, or of one element. Returns the page title and URL, then the text, cut at max_chars. " +
        "Use it to answer questions about the page or to find what to change.",
      input_schema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of the element to read. Default: body (the whole page).",
          },
          max_chars: {
            type: "integer",
            description: "Maximum characters of text to return. Default 20000, maximum 200000.",
          },
        },
      },
    },
    {
      name: "inspect_dom",
      description:
        "Find elements with a CSS selector and describe each one: tag, id, classes, key attributes, value, text, child count, and whether it is hidden. " +
        "The [n] index of each element is the `index` you can pass to modify_dom with the same selector. " +
        "Returns at most `limit` elements; the total match count is always reported. Use it before a change when the selector is not certain, and after one to check the result.",
      input_schema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector, e.g. 'h1', 'nav a', '#main .card', 'input[name=q]'.",
          },
          limit: { type: "integer", description: "Maximum elements to describe. Default 20, maximum 100." },
          include_html: {
            type: "boolean",
            description: "Also return each element's outer HTML, cut to 1500 characters.",
          },
        },
        required: ["selector"],
      },
    },
    {
      name: "modify_dom",
      description:
        "Change elements on the current page. Selects with a CSS selector and applies one action to every match, or to one match when `index` is set. " +
        "Changes that alter the page (set_text, set_html, insert_html, set_attribute, remove_attribute, set_style, add_class, remove_class, remove, hide, show) are saved by default, " +
        "and DomBot applies them again every time this page loads. Set persist=false for a one-time change, or scope='site' to apply on every page of this site. " +
        "click, focus, scroll_into_view, and set_value are never saved. Styles are set with !important so they win over the page's own CSS. " +
        "Returns how many elements changed.",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element(s) to change." },
          action: {
            type: "string",
            enum: [
              "set_text",
              "set_html",
              "insert_html",
              "set_attribute",
              "remove_attribute",
              "set_style",
              "add_class",
              "remove_class",
              "set_value",
              "click",
              "focus",
              "scroll_into_view",
              "remove",
              "hide",
              "show",
            ],
            description:
              "set_text: replace the text content. set_html: replace the inner HTML. insert_html: add HTML next to the element (see position). " +
              "set_attribute / remove_attribute: need `name` (and `value` to set). set_style: `name` is the CSS property, `value` its value. " +
              "add_class / remove_class: `value` is one or more class names separated by spaces. set_value: type into an input, textarea, select, or contenteditable and fire input/change events. " +
              "click, focus, scroll_into_view: act on the element. remove: delete the element. hide / show: display none, or undo it.",
          },
          value: {
            type: "string",
            description: "Text, HTML, attribute value, style value, class name(s), or input value — depends on the action.",
          },
          name: {
            type: "string",
            description: "Attribute name for set_attribute / remove_attribute, or CSS property for set_style (e.g. 'background-color').",
          },
          position: {
            type: "string",
            enum: POSITIONS,
            description: "For insert_html: where the HTML goes relative to the element. Default beforeend (inside, at the end).",
          },
          index: {
            type: "integer",
            description: "Change only the n-th match (0-based, document order). Default: every match.",
          },
          persist: {
            type: "boolean",
            description: "Save the change so DomBot applies it again whenever the page loads. Default true. Ignored for click, focus, scroll_into_view, set_value.",
          },
          scope: {
            type: "string",
            enum: ["page", "site"],
            description: "Where a saved change applies: this URL path only (page, default) or every page of this origin (site).",
          },
        },
        required: ["selector", "action"],
      },
    },
  ];

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function isOwnUi(el) {
    return el.id === HOST_ID;
  }

  function select(selector) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      throw new Error(`invalid CSS selector: ${selector}`);
    }
    return Array.from(nodes).filter((el) => !isOwnUi(el));
  }

  function clip(s, n) {
    s = s ?? "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function clampInt(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
  }

  function requireString(input, field) {
    const v = input[field];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`"${field}" is required`);
    return v;
  }

  function isSpace(ch) {
    return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f" || ch === " ";
  }

  /** Collapse runs of whitespace into single spaces (no regex, per repo rules). */
  function compactText(raw) {
    let out = "";
    let pendingSpace = false;
    for (const ch of raw ?? "") {
      if (isSpace(ch)) {
        pendingSpace = out.length > 0;
      } else {
        if (pendingSpace) out += " ";
        pendingSpace = false;
        out += ch;
      }
    }
    return out;
  }

  /** Trim trailing spaces on each line and squeeze runs of blank lines. */
  function tidyLines(raw) {
    const out = [];
    let blank = 0;
    for (const line of (raw ?? "").split("\n")) {
      let end = line.length;
      while (end > 0 && isSpace(line[end - 1])) end--;
      let start = 0;
      while (start < end && isSpace(line[start])) start++;
      const t = line.slice(start, end);
      if (t === "") {
        blank++;
        if (blank > 1) continue;
      } else {
        blank = 0;
      }
      out.push(t);
    }
    while (out.length && out[0] === "") out.shift();
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  function isVisible(el) {
    if (el.hidden) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    } catch {
      // no layout engine (tests) — assume visible
    }
    return true;
  }

  function describe(el, i, includeHtml) {
    const tag = el.tagName.toLowerCase();
    let head = `[${i}] <${tag}`;
    if (el.id) head += ` id="${el.id}"`;
    if (el.classList.length) head += ` class="${clip(Array.from(el.classList).join(" "), 120)}"`;
    for (const a of KEY_ATTRS) {
      if (el.hasAttribute(a)) head += ` ${a}="${clip(el.getAttribute(a), 120)}"`;
    }
    head += ">";
    const lines = [head];
    if ((tag === "input" || tag === "textarea" || tag === "select") && typeof el.value === "string" && el.value !== "") {
      lines.push(`    value: ${clip(el.value, 120)}`);
    }
    const text = compactText(el.textContent);
    if (text) lines.push(`    text: ${clip(text, MAX_TEXT)}`);
    const meta = [`children: ${el.children.length}`];
    if (!isVisible(el)) meta.push("hidden");
    lines.push(`    ${meta.join(", ")}`);
    if (includeHtml) lines.push(`    html: ${clip(el.outerHTML, MAX_HTML)}`);
    return lines.join("\n");
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function isEditable(el) {
    return el.isContentEditable === true || el.getAttribute("contenteditable") === "true";
  }

  /**
   * Set a form control's value the way a user would, so frameworks that
   * watch input events (React, Vue, ...) notice the change.
   */
  function setValue(el, value) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      el.value = value;
      fire(el, "input");
      fire(el, "change");
      return;
    }
    if (tag !== "input" && tag !== "textarea") {
      if (isEditable(el)) {
        el.focus();
        el.textContent = value;
        fire(el, "input");
        return;
      }
      throw new Error(`set_value needs an input, textarea, select, or contenteditable element; got <${tag}>`);
    }
    if (el.type === "checkbox" || el.type === "radio") {
      const on = ["true", "on", "1", "checked", "yes"].includes(value.trim().toLowerCase());
      if (el.checked !== on) el.click();
      return;
    }
    // React replaces the value setter on the element; call the prototype's
    // native setter so React's own tracking sees a real change.
    const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") desc.set.call(el, value);
    else el.value = value;
    fire(el, "input");
    fire(el, "change");
  }

  function insertHtml(el, html, position, editId) {
    if (!POSITIONS.includes(position)) {
      throw new Error(`position must be one of ${POSITIONS.join(", ")}; got "${position}"`);
    }
    if (!editId) {
      el.insertAdjacentHTML(position, html);
      return;
    }
    // Tag what we insert so a replay on the next load can tell it is
    // already there and does not add it twice.
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    for (const node of Array.from(tpl.content.children)) node.setAttribute(EDIT_ATTR, editId);
    const frag = tpl.content;
    if (position === "beforebegin") el.parentNode?.insertBefore(frag, el);
    else if (position === "afterbegin") el.insertBefore(frag, el.firstChild);
    else if (position === "beforeend") el.appendChild(frag);
    else el.parentNode?.insertBefore(frag, el.nextSibling);
  }

  function splitClasses(value) {
    const out = [];
    let cur = "";
    for (const ch of value) {
      if (isSpace(ch)) {
        if (cur) out.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // -------------------------------------------------------------------------
  // Actions: (element, input, need(field), editId) -> void
  // -------------------------------------------------------------------------

  const ACTIONS = {
    set_text: (el, input, need) => {
      el.textContent = need("value");
    },
    set_html: (el, input, need) => {
      el.innerHTML = need("value");
    },
    insert_html: (el, input, need, editId) => {
      insertHtml(el, need("value"), input.position || "beforeend", editId);
    },
    set_attribute: (el, input, need) => {
      el.setAttribute(need("name"), input.value === undefined || input.value === null ? "" : String(input.value));
    },
    remove_attribute: (el, input, need) => {
      el.removeAttribute(need("name"));
    },
    set_style: (el, input, need) => {
      el.style.setProperty(need("name"), need("value"), "important");
    },
    add_class: (el, input, need) => {
      const names = splitClasses(need("value"));
      if (names.length) el.classList.add(...names);
    },
    remove_class: (el, input, need) => {
      const names = splitClasses(need("value"));
      if (names.length) el.classList.remove(...names);
    },
    set_value: (el, input, need) => {
      setValue(el, need("value"));
    },
    click: (el) => {
      el.click();
    },
    focus: (el) => {
      el.focus();
    },
    scroll_into_view: (el) => {
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
    },
    remove: (el) => {
      el.remove();
    },
    hide: (el) => {
      el.style.setProperty("display", "none", "important");
    },
    show: (el) => {
      el.style.removeProperty("display");
      if (el.hidden) el.hidden = false;
    },
  };

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  function readPage(input) {
    const selector = typeof input.selector === "string" && input.selector.trim() ? input.selector : "body";
    const root = select(selector)[0];
    if (!root) throw new Error(`No elements match "${selector}".`);
    const max = clampInt(input.max_chars, 200, 200000, 20000);
    const raw = typeof root.innerText === "string" ? root.innerText : root.textContent;
    const text = tidyLines(raw);
    const header = `Title: ${document.title}\nURL: ${location.href}\n`;
    if (text.length <= max) return `${header}\n${text}`;
    return `${header}\n${text.slice(0, max)}\n\n[cut at ${max} of ${text.length} characters — raise max_chars or read one element]`;
  }

  function inspect(input) {
    const selector = requireString(input, "selector");
    const els = select(selector);
    if (!els.length) return `No elements match "${selector}".`;
    const limit = clampInt(input.limit, 1, 100, 20);
    const shown = els.slice(0, limit);
    let header = `${els.length} element(s) match "${selector}"`;
    if (els.length > shown.length) header += `, showing the first ${shown.length}`;
    header += ":";
    return [header, ...shown.map((el, i) => describe(el, i, Boolean(input.include_html)))].join("\n");
  }

  /**
   * Apply one change. Returns { count, summary }. With `quiet`, a selector
   * that matches nothing returns count 0 instead of throwing — that is what
   * the replay-on-load path needs while a page is still rendering.
   */
  function modify(input, { editId = null, quiet = false } = {}) {
    const selector = requireString(input, "selector");
    const action = requireString(input, "action");
    const apply = ACTIONS[action];
    if (!apply) throw new Error(`unknown action "${action}". Use one of: ${Object.keys(ACTIONS).join(", ")}`);

    const els = select(selector);
    let targets = els;
    const hasIndex = input.index !== undefined && input.index !== null;
    if (hasIndex) {
      const i = Number(input.index);
      if (!Number.isInteger(i) || i < 0) throw new Error(`index must be a whole number >= 0, got ${input.index}`);
      targets = i < els.length ? [els[i]] : [];
      if (!targets.length && !quiet) throw new Error(`index ${i} is out of range: ${els.length} element(s) match "${selector}"`);
    }
    if (!targets.length) {
      if (quiet) return { count: 0, summary: `no match for "${selector}"` };
      throw new Error(`No elements match "${selector}".`);
    }

    const need = (field) => {
      const v = input[field];
      if (v === undefined || v === null) throw new Error(`action ${action} needs "${field}"`);
      return String(v);
    };
    for (const el of targets) apply(el, input, need, editId);

    const where = hasIndex ? ` (match #${input.index})` : "";
    return { count: targets.length, summary: `${action}: changed ${targets.length} element(s) matching "${selector}"${where}.` };
  }

  function cssEscape(s) {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s;
  }

  /**
   * Replay a saved change. Returns { applied, count }. Inserted HTML is
   * recognised by its marker and not inserted a second time.
   */
  function applyEdit(edit) {
    if (edit.action === "insert_html" && document.querySelector(`[${EDIT_ATTR}="${cssEscape(edit.id)}"]`)) {
      return { applied: true, count: 0 };
    }
    const out = modify(edit, { editId: edit.id, quiet: true });
    return { applied: out.count > 0, count: out.count };
  }

  const TOOLS = {
    read_page: readPage,
    inspect_dom: inspect,
    modify_dom: (input, options) => modify(input, options).summary,
  };

  /** Run a tool by name; returns the text for the model, throws on failure. */
  function run(name, input, options) {
    const fn = TOOLS[name];
    if (!fn) throw new Error(`unknown tool "${name}"`);
    return fn(input ?? {}, options);
  }

  globalThis.DomTools = { HOST_ID, EDIT_ATTR, definitions, run, modify, applyEdit, inspect, readPage };
})();

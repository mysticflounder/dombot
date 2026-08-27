/**
 * Saved changes ("edits") — the record of what DomBot changed on which page,
 * so the content script can apply it again on the next load.
 *
 * Classic script: loaded into the content script world before content.js,
 * and into the options page. Defines `globalThis.DomBotEdits`. The unit
 * tests evaluate this file inside a jsdom window.
 *
 * An edit looks like:
 *   { id, createdAt, origin, path, scope: "page" | "site", enabled,
 *     selector, action, value?, name?, position?, index? }
 *
 * Storage: chrome.storage.local key "edits", an array. Only the service
 * worker writes it (single writer, no lost updates); everyone reads it.
 */
(() => {
  // Actions that alter the page and make sense to replay. click, focus,
  // scroll_into_view, and set_value are one-shot and are never saved.
  const PERSISTABLE = [
    "set_text",
    "set_html",
    "insert_html",
    "set_attribute",
    "remove_attribute",
    "set_style",
    "add_class",
    "remove_class",
    "remove",
    "hide",
    "show",
  ];

  const FIELDS = ["selector", "action", "value", "name", "position", "index"];
  const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

  function isPersistable(action) {
    return PERSISTABLE.includes(action);
  }

  /** Does this edit belong on the page at `loc` ({ origin, pathname })? */
  function matches(edit, loc) {
    if (!edit || edit.origin !== loc.origin) return false;
    return edit.scope === "site" || edit.path === loc.pathname;
  }

  /** Enabled edits for this page, in the order they were made. */
  function forPage(edits, loc) {
    return (Array.isArray(edits) ? edits : []).filter((e) => e && e.enabled !== false && matches(e, loc));
  }

  function makeId() {
    let out = "e";
    const bytes = new Uint8Array(10);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
    return out;
  }

  /** Build the stored record from a modify_dom tool input. */
  function fromToolInput(input, loc, id, createdAt) {
    const edit = {
      id,
      createdAt,
      origin: loc.origin,
      path: loc.pathname,
      scope: input.scope === "site" ? "site" : "page",
      enabled: true,
    };
    for (const f of FIELDS) {
      if (input[f] !== undefined && input[f] !== null) edit[f] = input[f];
    }
    return edit;
  }

  function clip(s, n) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /** One readable line, e.g. `set_style color = red on "h1" (site)`. */
  function describe(edit, { withId = false } = {}) {
    let s = edit.action;
    if (edit.name) s += ` ${edit.name}`;
    if (edit.value !== undefined && edit.value !== null) s += ` = ${clip(String(edit.value), 60)}`;
    s += ` on "${edit.selector}"`;
    if (edit.index !== undefined && edit.index !== null) s += ` [#${edit.index}]`;
    if (edit.action === "insert_html" && edit.position) s += ` (${edit.position})`;
    const flags = [];
    if (edit.scope === "site") flags.push("site");
    if (edit.enabled === false) flags.push("off");
    if (flags.length) s += ` (${flags.join(", ")})`;
    return withId ? `${edit.id}  ${s}` : s;
  }

  const toolDefinition = {
    name: "saved_changes",
    description:
      "List or manage the changes DomBot saved for the current page — the ones it applies again every time the page loads. " +
      "`list` shows each saved change with its id. `delete`, `enable`, `disable`, and `set_scope` need an `id` from that list. " +
      "Deleting or disabling does not undo the change on the page that is open now; reverse it live with modify_dom and persist=false.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "delete", "enable", "disable", "set_scope"],
          description: "What to do. Default: list.",
        },
        id: { type: "string", description: "The saved change to act on (from list)." },
        scope: {
          type: "string",
          enum: ["page", "site"],
          description: "For set_scope: 'page' applies only on this URL path, 'site' on every page of this origin.",
        },
      },
      required: ["action"],
    },
  };

  globalThis.DomBotEdits = { PERSISTABLE, isPersistable, matches, forPage, makeId, fromToolInput, describe, toolDefinition };
})();

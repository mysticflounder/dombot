const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5",
  effort: "high",
  maxTokens: 64000,
  fallbacks: true,
  customInstructions: "",
  showPill: true,
};

const MODELS_URL = "https://api.anthropic.com/v1/models";
const API_VERSION = "2023-06-01";

const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $("apiKey").value = cfg.apiKey ?? "";
  $("model").value = cfg.model || DEFAULTS.model;
  $("effort").value = cfg.effort || DEFAULTS.effort;
  $("maxTokens").value = cfg.maxTokens || DEFAULTS.maxTokens;
  $("fallbacks").checked = cfg.fallbacks !== false;
  $("showPill").checked = cfg.showPill !== false;
  $("customInstructions").value = cfg.customInstructions ?? "";
}

async function save() {
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    effort: $("effort").value,
    maxTokens: Math.max(256, Number($("maxTokens").value) || DEFAULTS.maxTokens),
    fallbacks: $("fallbacks").checked,
    showPill: $("showPill").checked,
    customInstructions: $("customInstructions").value,
  });
  const badge = $("savedBadge");
  badge.classList.add("show");
  setTimeout(() => badge.classList.remove("show"), 1400);
}

function showResult(text, ok) {
  const box = $("testResult");
  box.textContent = text;
  box.className = `result ${ok ? "ok" : "bad"}`;
}

/** GET /v1/models/{id} is free: it proves the key and the model id at once. */
async function testKey() {
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim() || DEFAULTS.model;
  if (!apiKey) {
    showResult("Enter an API key first.", false);
    return;
  }
  showResult("Checking…", true);
  try {
    const res = await fetch(`${MODELS_URL}/${encodeURIComponent(model)}`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (res.ok) {
      const info = await res.json();
      showResult(`Key works. Model: ${info.display_name ?? info.id} (${info.id}).`, true);
    } else if (res.status === 401) {
      showResult("The API rejected this key (401).", false);
    } else if (res.status === 404) {
      showResult(`The key works, but the API knows no model "${model}" (404).`, false);
    } else {
      let detail = "";
      try {
        detail = (await res.json())?.error?.message ?? "";
      } catch {
        // no JSON body
      }
      showResult(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`, false);
    }
  } catch (err) {
    showResult(`Could not reach the API: ${err.message}`, false);
  }
}

// ---------------------------------------------------------------------------
// Saved changes
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err.message }));
}

async function renderEdits() {
  const { edits } = await chrome.storage.local.get({ edits: [] });
  const list = Array.isArray(edits) ? edits : [];
  const box = $("edits");
  box.textContent = "";
  if (!list.length) {
    box.appendChild(el("div", { class: "empty" }, "Nothing saved yet."));
    return;
  }

  const byOrigin = new Map();
  for (const e of list) {
    if (!byOrigin.has(e.origin)) byOrigin.set(e.origin, []);
    byOrigin.get(e.origin).push(e);
  }

  for (const [origin, items] of byOrigin) {
    const site = el("div", { class: "site" });
    const delSite = el("button", { class: "small danger", type: "button" }, "Delete all");
    delSite.addEventListener("click", () => send({ type: "edits.remove", ids: items.map((e) => e.id) }));
    site.appendChild(el("div", { class: "site-head" }, el("span", {}, `${origin} — ${items.length}`), delSite));

    for (const edit of items) {
      const row = el("div", { class: `edit${edit.enabled === false ? " off" : ""}` });
      const toggle = el("input", { type: "checkbox", title: "On / off" });
      toggle.checked = edit.enabled !== false;
      toggle.addEventListener("change", () => send({ type: "edits.update", id: edit.id, patch: { enabled: toggle.checked } }));
      const desc = el("span", { class: "desc", title: DomBotEdits.describe(edit, { withId: true }) }, DomBotEdits.describe(edit));
      const path = el("span", { class: "path", title: edit.path }, edit.scope === "site" ? "whole site" : edit.path);
      const scope = el("select", { title: "Where it applies" });
      scope.append(el("option", { value: "page" }, "this page"), el("option", { value: "site" }, "whole site"));
      scope.value = edit.scope === "site" ? "site" : "page";
      scope.addEventListener("change", () => send({ type: "edits.update", id: edit.id, patch: { scope: scope.value } }));
      const del = el("button", { class: "small secondary", type: "button", title: "Delete" }, "Delete");
      del.addEventListener("click", () => send({ type: "edits.remove", ids: [edit.id] }));
      row.append(toggle, desc, path, scope, del);
      site.appendChild(row);
    }
    box.appendChild(site);
  }
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", testKey);
$("clearAll").addEventListener("click", async () => {
  if (confirm("Delete every saved change on every site?")) await send({ type: "edits.clear" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.edits) renderEdits();
});

load();
renderEdits();

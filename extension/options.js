import { baseUrl, listModels, version } from "./agent.js";

const DEFAULTS = {
  scheme: "http",
  host: "localhost",
  port: 11434,
  model: "",
  think: "default",
  numCtx: 16384,
  keepAlive: "",
  customInstructions: "",
  showPill: true,
};

const $ = (id) => document.getElementById(id);

function fieldsBase() {
  return baseUrl({ scheme: $("scheme").value, host: $("host").value, port: $("port").value });
}

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $("scheme").value = cfg.scheme === "https" ? "https" : "http";
  $("host").value = cfg.host || DEFAULTS.host;
  $("port").value = cfg.port || DEFAULTS.port;
  $("think").value = ["default", "on", "off"].includes(cfg.think) ? cfg.think : "default";
  $("numCtx").value = cfg.numCtx ? cfg.numCtx : "";
  $("keepAlive").value = cfg.keepAlive ?? "";
  $("showPill").checked = cfg.showPill !== false;
  $("customInstructions").value = cfg.customInstructions ?? "";
  renderModelOptions([], cfg.model || "");
  await refreshModels(cfg.model || "");
}

async function save() {
  await chrome.storage.local.set({
    scheme: $("scheme").value === "https" ? "https" : "http",
    host: $("host").value.trim() || DEFAULTS.host,
    port: Number($("port").value) || DEFAULTS.port,
    model: $("model").value || "",
    think: $("think").value,
    numCtx: Number($("numCtx").value) || 0,
    keepAlive: $("keepAlive").value.trim(),
    showPill: $("showPill").checked,
    customInstructions: $("customInstructions").value,
  });
  const badge = $("savedBadge");
  badge.classList.add("show");
  setTimeout(() => badge.classList.remove("show"), 1400);
}

function showStatus(text, ok) {
  const box = $("connStatus");
  box.textContent = text;
  box.className = `status ${ok ? "ok" : "bad"}`;
}

async function testConnection() {
  const base = fieldsBase();
  showStatus(`Checking ${base}…`, true);
  try {
    const v = await version({ base, signal: AbortSignal.timeout(5000) });
    showStatus(`Ollama ${v} at ${base}`, true);
  } catch (err) {
    showStatus(err.message, false);
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function gb(bytes) {
  return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : "";
}

let models = [];

function renderModelOptions(list, selected) {
  models = list;
  const select = $("model");
  select.textContent = "";
  const known = list.some((m) => m.name === selected);
  if (selected && !known) select.appendChild(new Option(`${selected} (not in Ollama's list)`, selected));
  for (const m of list) {
    const opt = new Option(m.tools === false ? `${m.name} — no tools` : m.name, m.name);
    if (m.tools === false) opt.disabled = true;
    select.appendChild(opt);
  }
  if (!select.options.length) select.appendChild(new Option("no models found", ""));
  select.value = selected || (list.find((m) => m.tools !== false)?.name ?? list[0]?.name ?? "");
  describeModel();
}

function describeModel() {
  const m = models.find((x) => x.name === $("model").value);
  const info = $("modelInfo");
  if (!m) {
    info.textContent = "The list comes from Ollama's /api/tags. Models that cannot call tools are greyed out; DomBot needs tools.";
    return;
  }
  const parts = [];
  if (m.family) parts.push(m.family);
  if (m.parameterSize) parts.push(m.parameterSize);
  if (m.size) parts.push(gb(m.size));
  parts.push(m.tools === null ? "tools: unknown" : m.tools ? "tools: yes" : "tools: no");
  if (m.thinking) parts.push("thinking: yes");
  info.textContent = parts.join(" · ");
}

async function refreshModels(selected) {
  const base = fieldsBase();
  const btn = $("refresh");
  btn.disabled = true;
  try {
    const list = await listModels({ base, signal: AbortSignal.timeout(15000) });
    renderModelOptions(list, selected ?? $("model").value);
    showStatus(`${list.length} model(s) at ${base}`, true);
  } catch (err) {
    renderModelOptions([], selected ?? $("model").value);
    showStatus(err.message, false);
  } finally {
    btn.disabled = false;
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
$("test").addEventListener("click", testConnection);
$("refresh").addEventListener("click", () => refreshModels());
$("model").addEventListener("change", describeModel);
$("clearAll").addEventListener("click", async () => {
  if (confirm("Delete every saved change on every site?")) await send({ type: "edits.clear" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.edits) renderEdits();
});

load();
renderEdits();

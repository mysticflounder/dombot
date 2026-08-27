/**
 * Content script — the chat panel, tool execution against this page, and
 * replay of saved changes when the page loads.
 *
 * Runs after edits.js (DomBotEdits) and dom-tools.js (DomTools). The panel
 * lives in a closed shadow root on a host element attached to <html>, so
 * page CSS cannot restyle it and page scripts cannot reach into it.
 */
(() => {
  if (globalThis.__dombotLoaded) return;
  globalThis.__dombotLoaded = true;
  if (typeof HTMLElement === "undefined" || !(document.documentElement instanceof HTMLElement)) return;

  const PORT_NAME = "dombot";
  const HOST_ID = DomTools.HOST_ID;
  const LATE_ELEMENT_WINDOW_MS = 20000; // keep trying unmatched saved changes this long
  const URL_POLL_MS = 1000; // single-page apps change the URL without a load
  const RECONNECT_MS = 1000;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  color-scheme: light;
  --fg: #16181c; --muted: #6b7280; --bg: #ffffff; --panel: #f5f6f7; --border: #d9dde2;
  --accent: #d97757; --accent-fg: #ffffff; --user: #e8f0fe; --bad: #c62828; --ok: #1b8a4c; --code: #eef0f2;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .root { color-scheme: dark; --fg: #e7e9ea; --muted: #9aa0a6; --bg: #1f2023; --panel: #2a2b2f; --border: #3b3d42; --user: #2c3e5a; --code: #151618; }
}
.pill { display: none; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; border: 0; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.root.collapsed .pill { display: flex; }
.panel { display: none; width: 380px; height: min(560px, calc(100vh - 32px)); flex-direction: column; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.3); overflow: hidden; }
.root.expanded .panel { display: flex; }
.header { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--panel); }
.title { font-weight: 700; margin-right: 6px; }
.model { flex: 1; min-width: 0; max-width: 150px; font: inherit; font-size: 11px; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 2px 4px; cursor: pointer; }
.model:hover, .model:focus { border-color: var(--border); color: var(--fg); outline: none; }
.model option, .saved-row select option { background: var(--bg); color: var(--fg); }
.icon { border: 0; background: transparent; color: var(--fg); cursor: pointer; font: inherit; font-size: 14px; padding: 2px 6px; border-radius: 6px; line-height: 1; }
.icon:hover, .icon.active { background: var(--border); }
.body { display: none; flex: 1; min-height: 0; flex-direction: column; }
.body.active { display: flex; }
.messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 92%; padding: 7px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
.msg.user { align-self: flex-end; background: var(--user); }
.msg.assistant { align-self: flex-start; background: var(--panel); }
.msg.assistant p { margin: 0 0 6px; white-space: pre-wrap; }
.msg.assistant p:last-child { margin: 0; }
.msg pre { margin: 4px 0; padding: 6px 8px; background: var(--code); border-radius: 6px; overflow-x: auto; font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
.tool { align-self: stretch; font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); padding: 4px 8px; border-left: 2px solid var(--border); white-space: pre-wrap; word-break: break-word; cursor: pointer; }
.tool .name { color: var(--fg); font-weight: 600; }
.tool.error { border-left-color: var(--bad); }
.tool .result { display: block; margin-top: 2px; }
.tool.collapsed .result { max-height: 3.2em; overflow: hidden; }
.tool .saved { color: var(--ok); }
.error { align-self: stretch; color: var(--bad); background: rgba(198,40,40,.08); padding: 6px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.error button { margin-left: 6px; font: inherit; font-weight: 600; border: 1px solid var(--bad); background: transparent; color: var(--bad); border-radius: 6px; padding: 1px 8px; cursor: pointer; }
.note { align-self: center; color: var(--muted); font-size: 11px; }
.status { color: var(--muted); font-size: 11px; padding: 0 12px 4px; min-height: 16px; }
.composer { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); background: var(--panel); align-items: flex-end; }
textarea { flex: 1; resize: none; min-height: 34px; max-height: 120px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; outline: none; }
textarea:focus { border-color: var(--accent); }
.send { border: 0; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; padding: 8px 12px; border-radius: 8px; cursor: pointer; }
.send.stop { background: var(--bad); }
.saved-list { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.saved-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; }
.saved-row.off { opacity: .55; }
.saved-desc { flex: 1; font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.saved-row select { font: inherit; font-size: 11px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
.saved-row input[type=checkbox] { margin: 0; }
.saved-footer { display: flex; gap: 6px; justify-content: space-between; padding: 8px 10px; border-top: 1px solid var(--border); background: var(--panel); font-size: 11px; }
.saved-footer button { font: inherit; border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.empty { color: var(--muted); padding: 16px; text-align: center; }
`;

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

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

  function clip(s, n) {
    s = String(s ?? "");
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  async function sendMessage(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      return res ?? { ok: false, error: "no reply from the extension" };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  function openOptions() {
    sendMessage({ type: "open_options" });
  }

  /** Plain text with fenced code blocks; no other markdown, no regex. */
  function renderRich(container, text) {
    container.textContent = "";
    let para = [];
    let code = null;
    const flushPara = () => {
      if (!para.length) return;
      container.appendChild(el("p", { text: para.join("\n") }));
      para = [];
    };
    for (const line of text.split("\n")) {
      if (line.startsWith("```")) {
        if (code === null) {
          flushPara();
          code = [];
        } else {
          container.appendChild(el("pre", { text: code.join("\n") }));
          code = null;
        }
        continue;
      }
      if (code !== null) {
        code.push(line);
        continue;
      }
      if (line.trim() === "") flushPara();
      else para.push(line);
    }
    if (code !== null) container.appendChild(el("pre", { text: code.join("\n") }));
    flushPara();
  }

  function compactInput(input) {
    const parts = [];
    for (const [k, v] of Object.entries(input ?? {})) {
      parts.push(`${k}=${JSON.stringify(typeof v === "string" ? clip(v, 80) : v)}`);
    }
    return parts.join(" ");
  }

  // -------------------------------------------------------------------------
  // Build the panel
  // -------------------------------------------------------------------------

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "all: initial !important; display: block !important; position: fixed !important; right: 16px !important; bottom: 16px !important; " +
    "z-index: 2147483647 !important; margin: 0 !important; padding: 0 !important; width: auto !important; height: auto !important;";
  const shadow = host.attachShadow({ mode: "closed" });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    shadow.appendChild(el("style", { text: CSS }));
  }
  const root = el("div", { class: "root hidden" });
  shadow.appendChild(root);

  const ui = {};
  ui.pill = el("button", { class: "pill", type: "button", title: "Open DomBot" }, "DomBot");
  ui.model = el("select", { class: "model", title: "Model (what Ollama advertises)" });
  ui.savedBtn = el("button", { class: "icon", type: "button", title: "Saved changes for this page" }, "☰");
  ui.newBtn = el("button", { class: "icon", type: "button", title: "New chat" }, "⟲");
  ui.settingsBtn = el("button", { class: "icon", type: "button", title: "Settings" }, "⚙");
  ui.collapseBtn = el("button", { class: "icon", type: "button", title: "Collapse" }, "–");
  ui.closeBtn = el("button", { class: "icon", type: "button", title: "Hide. The toolbar button or Alt+Shift+D brings it back." }, "×");
  ui.header = el(
    "div",
    { class: "header" },
    el("span", { class: "title" }, "DomBot"),
    ui.model,
    ui.savedBtn,
    ui.newBtn,
    ui.settingsBtn,
    ui.collapseBtn,
    ui.closeBtn,
  );
  ui.messages = el("div", { class: "messages" });
  ui.status = el("div", { class: "status" });
  ui.input = el("textarea", { rows: "1", placeholder: "Ask about this page, or say what to change…" });
  ui.send = el("button", { class: "send", type: "button" }, "Send");
  ui.chat = el("div", { class: "body active" }, ui.messages, ui.status, el("div", { class: "composer" }, ui.input, ui.send));
  ui.savedList = el("div", { class: "saved-list" });
  ui.deleteAll = el("button", { type: "button" }, "Delete all for this page");
  ui.manageAll = el("button", { type: "button" }, "All sites…");
  ui.saved = el("div", { class: "body" }, ui.savedList, el("div", { class: "saved-footer" }, ui.deleteAll, ui.manageAll));
  ui.panel = el("div", { class: "panel" }, ui.header, ui.chat, ui.saved);
  root.append(ui.pill, ui.panel);
  document.documentElement.appendChild(host);

  // Keys typed into the panel must not reach the page's own hotkey handlers.
  for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

  // -------------------------------------------------------------------------
  // Panel state
  // -------------------------------------------------------------------------

  let state = "hidden"; // hidden | collapsed | expanded
  let view = "chat"; // chat | saved
  let busy = false;
  let port = null;
  let wantPort = false;
  let reconnectTimer = null;
  let currentBubble = null;
  let currentRaw = "";

  function setState(next) {
    state = next;
    root.className = `root ${next}`;
    if (next === "expanded") {
      wantPort = true;
      connect();
      loadModels();
      if (view === "saved") renderSaved();
      else ui.input.focus();
    } else if (!busy) {
      disconnect();
    }
  }

  function setView(next) {
    view = next;
    ui.chat.classList.toggle("active", next === "chat");
    ui.saved.classList.toggle("active", next === "saved");
    ui.savedBtn.classList.toggle("active", next === "saved");
    if (next === "saved") renderSaved();
  }

  function setStatus(text) {
    ui.status.textContent = text;
  }

  function setBusy(next) {
    busy = next;
    ui.send.textContent = next ? "Stop" : "Send";
    ui.send.classList.toggle("stop", next);
    ui.input.disabled = next;
    if (!next) {
      setStatus("");
      if (state !== "expanded") disconnect();
      else ui.input.focus();
    }
  }

  function autosize() {
    ui.input.style.height = "auto";
    ui.input.style.height = `${Math.min(120, ui.input.scrollHeight)}px`;
  }

  // -------------------------------------------------------------------------
  // Chat rendering
  // -------------------------------------------------------------------------

  function scrollToBottom() {
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function addUser(text) {
    ui.messages.appendChild(el("div", { class: "msg user", text }));
    scrollToBottom();
  }

  function addAssistant(text) {
    const bubble = el("div", { class: "msg assistant" });
    renderRich(bubble, text);
    ui.messages.appendChild(bubble);
    scrollToBottom();
  }

  function startAssistant() {
    finishAssistant();
    currentBubble = el("div", { class: "msg assistant" });
    currentRaw = "";
    ui.messages.appendChild(currentBubble);
    scrollToBottom();
  }

  function appendDelta(text) {
    if (!currentBubble) startAssistant();
    currentRaw += text;
    currentBubble.appendChild(document.createTextNode(text));
    scrollToBottom();
  }

  function finishAssistant() {
    if (!currentBubble) return;
    renderRich(currentBubble, currentRaw);
    currentBubble = null;
    currentRaw = "";
    scrollToBottom();
  }

  function addTool(name, input) {
    const row = el("div", { class: "tool collapsed" }, el("span", { class: "name" }, name), " ", compactInput(input));
    const result = el("span", { class: "result" }, "…");
    row.appendChild(result);
    row.addEventListener("click", () => row.classList.toggle("collapsed"));
    ui.messages.appendChild(row);
    scrollToBottom();
    return {
      setResult(text, isError, saved) {
        result.textContent = (isError ? "✗ " : "→ ") + clip(text, 2000);
        if (isError) row.classList.add("error");
        if (saved) row.appendChild(el("span", { class: "saved" }, " · saved"));
        scrollToBottom();
      },
    };
  }

  function addError(message, { needsSetup = false } = {}) {
    const box = el("div", { class: "error" }, message);
    if (needsSetup) {
      const b = el("button", { type: "button" }, "Open settings");
      b.addEventListener("click", openOptions);
      box.appendChild(b);
    }
    ui.messages.appendChild(box);
    scrollToBottom();
  }

  function addNote(text) {
    ui.messages.appendChild(el("div", { class: "note", text }));
    scrollToBottom();
  }

  function renderHistory(items) {
    ui.messages.textContent = "";
    currentBubble = null;
    currentRaw = "";
    for (const item of items) {
      if (item.kind === "user") addUser(item.text);
      else if (item.kind === "assistant") addAssistant(item.text);
      else if (item.kind === "tool") addTool(item.name, item.input).setResult(item.result, item.is_error, false);
    }
  }

  function noteStop(msg) {
    if (msg.stopReason === "length") addNote("Stopped: the model hit its context or output limit. Raise the context length in settings.");
    else if (msg.stopReason === "cancelled") addNote("Stopped.");
  }

  // -------------------------------------------------------------------------
  // Talking to the service worker
  // -------------------------------------------------------------------------

  function connect() {
    if (port) return;
    clearTimeout(reconnectTimer);
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      port = null;
      addError("DomBot was updated or reloaded. Reload this page to reconnect.");
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (busy) {
        finishAssistant();
        setBusy(false);
        addError("The connection to the extension dropped mid-turn. Send the message again.");
      }
      if (wantPort) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
    port.postMessage({ type: "hello", tools: [...DomTools.definitions, DomBotEdits.toolDefinition] });
  }

  function disconnect() {
    wantPort = false;
    clearTimeout(reconnectTimer);
    if (port && !busy) {
      port.disconnect();
      port = null;
    }
  }

  function onPortMessage(msg) {
    switch (msg?.type) {
      case "history":
        // A hello sent right before a user message gets a history reply that
        // predates that message; replaying it would erase the user bubble.
        if (busy && !msg.busy) break;
        renderHistory(msg.items ?? []);
        setBusy(Boolean(msg.busy));
        break;
      case "turn_start":
        setBusy(true);
        setStatus("thinking…");
        break;
      case "status":
        setStatus(msg.text ?? "");
        break;
      case "text_start":
        startAssistant();
        setStatus("writing…");
        break;
      case "delta":
        appendDelta(msg.text ?? "");
        break;
      case "tool_use":
        handleToolUse(msg);
        break;
      case "turn_end":
        finishAssistant();
        setBusy(false);
        noteStop(msg);
        break;
      case "error":
        finishAssistant();
        setBusy(false);
        addError(msg.message ?? "unknown error", { needsSetup: Boolean(msg.needsSetup) });
        break;
      default:
        break;
    }
  }

  function send() {
    const text = ui.input.value.trim();
    if (!text || busy) return;
    ui.input.value = "";
    autosize();
    addUser(text);
    wantPort = true;
    connect();
    if (!port) return;
    setBusy(true);
    setStatus("sending…");
    port.postMessage({ type: "user", text, page: { url: location.href, title: document.title } });
  }

  function cancel() {
    if (port) port.postMessage({ type: "cancel" });
  }

  function newChat() {
    ui.messages.textContent = "";
    currentBubble = null;
    currentRaw = "";
    wantPort = true;
    connect();
    if (port) port.postMessage({ type: "clear" });
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  async function handleToolUse(msg) {
    const row = addTool(msg.name, msg.input);
    setStatus(`running ${msg.name}…`);
    let result;
    try {
      result = await runTool(msg.name, msg.input ?? {});
    } catch (err) {
      result = { content: err?.message ?? String(err), is_error: true };
    }
    row.setResult(result.content, Boolean(result.is_error), Boolean(result.saved));
    if (port) port.postMessage({ type: "tool_result", id: msg.id, content: result.content, is_error: Boolean(result.is_error) });
    setStatus("thinking…");
  }

  async function runTool(name, input) {
    if (name === "saved_changes") return savedChangesTool(input);
    if (name !== "modify_dom") return { content: DomTools.run(name, input) };

    const persist = input.persist !== false && DomBotEdits.isPersistable(input.action);
    const id = persist ? DomBotEdits.makeId() : null;
    const out = DomTools.modify(input, { editId: id });
    let text = out.summary;
    let saved = false;
    if (persist) {
      const edit = DomBotEdits.fromToolInput(input, location, id, new Date().toISOString());
      const res = await sendMessage({ type: "edits.add", edit });
      if (res.ok) {
        saved = true;
        appliedIds.add(id);
        startUrlWatch();
        text += `\nSaved as ${id}: DomBot applies this change again whenever ${edit.scope === "site" ? "this site" : "this page"} loads.`;
      } else {
        text += `\n(The change was made but could not be saved: ${res.error})`;
      }
    }
    return { content: text, saved };
  }

  async function savedChangesTool(input) {
    const { edits } = await chrome.storage.local.get({ edits: [] });
    const list = Array.isArray(edits) ? edits : [];
    const here = list.filter((e) => DomBotEdits.matches(e, location));
    const action = input.action || "list";

    if (action === "list") {
      if (!here.length) return { content: "No saved changes for this page." };
      return { content: here.map((e) => DomBotEdits.describe(e, { withId: true })).join("\n") };
    }

    const target = list.find((e) => e.id === input.id);
    if (!target) throw new Error(`no saved change with id "${input.id}" — use action=list to see the ids`);

    let res;
    if (action === "delete") res = await sendMessage({ type: "edits.remove", ids: [target.id] });
    else if (action === "enable" || action === "disable") {
      res = await sendMessage({ type: "edits.update", id: target.id, patch: { enabled: action === "enable" } });
    } else if (action === "set_scope") {
      if (input.scope !== "page" && input.scope !== "site") throw new Error("set_scope needs scope = page or site");
      res = await sendMessage({ type: "edits.update", id: target.id, patch: { scope: input.scope } });
    } else throw new Error(`unknown action "${action}"`);

    if (!res.ok) throw new Error(res.error ?? "could not update the saved changes");
    return { content: `${action}: ${DomBotEdits.describe(target)}. The page keeps its current state until it loads again.` };
  }

  // -------------------------------------------------------------------------
  // Saved changes view
  // -------------------------------------------------------------------------

  async function renderSaved() {
    const { edits } = await chrome.storage.local.get({ edits: [] });
    const here = (Array.isArray(edits) ? edits : []).filter((e) => DomBotEdits.matches(e, location));
    ui.savedList.textContent = "";
    if (!here.length) {
      ui.savedList.appendChild(el("div", { class: "empty" }, "No saved changes for this page. Changes DomBot makes here are listed and applied again on every load."));
      return;
    }
    for (const edit of here) {
      const row = el("div", { class: `saved-row${edit.enabled === false ? " off" : ""}` });
      const toggle = el("input", { type: "checkbox", title: "On / off (takes effect on the next load)" });
      toggle.checked = edit.enabled !== false;
      toggle.addEventListener("change", () => sendMessage({ type: "edits.update", id: edit.id, patch: { enabled: toggle.checked } }));
      const desc = el("div", { class: "saved-desc", title: DomBotEdits.describe(edit, { withId: true }) }, DomBotEdits.describe(edit));
      const scope = el("select", { title: "Where it applies" });
      scope.append(el("option", { value: "page" }, "this page"), el("option", { value: "site" }, "whole site"));
      scope.value = edit.scope === "site" ? "site" : "page";
      scope.addEventListener("change", () => sendMessage({ type: "edits.update", id: edit.id, patch: { scope: scope.value } }));
      const del = el("button", { class: "icon", type: "button", title: "Delete" }, "🗑");
      del.addEventListener("click", () => sendMessage({ type: "edits.remove", ids: [edit.id] }));
      row.append(toggle, desc, scope, del);
      ui.savedList.appendChild(row);
    }
  }

  async function deleteAllForPage() {
    const { edits } = await chrome.storage.local.get({ edits: [] });
    const ids = (Array.isArray(edits) ? edits : []).filter((e) => DomBotEdits.matches(e, location)).map((e) => e.id);
    if (ids.length) await sendMessage({ type: "edits.remove", ids });
  }

  // -------------------------------------------------------------------------
  // Replay saved changes on load
  // -------------------------------------------------------------------------

  const appliedIds = new Set();
  let pendingEdits = [];
  let observer = null;
  let observerDeadline = 0;
  let urlTimer = null;
  let lastUrl = location.href;

  async function applySavedEdits() {
    const { edits } = await chrome.storage.local.get({ edits: [] });
    const list = Array.isArray(edits) ? edits : [];
    if (list.some((e) => e && e.origin === location.origin)) startUrlWatch();
    pendingEdits = DomBotEdits.forPage(list, location).filter((e) => !appliedIds.has(e.id));
    tryPending();
    if (pendingEdits.length) watchForLateElements();
  }

  function tryPending() {
    const still = [];
    for (const edit of pendingEdits) {
      let done = false;
      try {
        done = DomTools.applyEdit(edit).applied;
      } catch (err) {
        console.warn("[dombot] saved change failed, not retrying:", edit.id, err?.message ?? err);
        done = true;
      }
      if (done) appliedIds.add(edit.id);
      else still.push(edit);
    }
    pendingEdits = still;
  }

  function watchForLateElements() {
    observerDeadline = Date.now() + LATE_ELEMENT_WINDOW_MS;
    if (observer) return;
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        tryPending();
        if (!pendingEdits.length || Date.now() > observerDeadline) {
          observer.disconnect();
          observer = null;
        }
      }, 120);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function startUrlWatch() {
    if (urlTimer) return;
    urlTimer = setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      appliedIds.clear();
      applySavedEdits();
    }, URL_POLL_MS);
  }

  // -------------------------------------------------------------------------
  // Model dropdown (what Ollama advertises)
  // -------------------------------------------------------------------------

  let models = [];
  let wantedModel = "";

  function renderModelOptions() {
    ui.model.textContent = "";
    const known = models.some((m) => m.name === wantedModel);
    if (wantedModel && !known) ui.model.appendChild(el("option", { value: wantedModel }, `${wantedModel} (not found)`));
    for (const m of models) {
      const opt = el("option", { value: m.name }, m.tools === false ? `${m.name} (no tools)` : m.name);
      if (m.tools === false) opt.disabled = true;
      ui.model.appendChild(opt);
    }
    if (!ui.model.options.length) ui.model.appendChild(el("option", { value: "" }, "no models"));
    ui.model.value = wantedModel || (models.find((m) => m.tools !== false)?.name ?? models[0]?.name ?? "");
  }

  function setModelValue(name) {
    wantedModel = name;
    renderModelOptions();
  }

  async function loadModels() {
    const res = await sendMessage({ type: "models.list" });
    if (res.ok) {
      models = Array.isArray(res.result) ? res.result : [];
      ui.model.title = "Model (what Ollama advertises)";
    } else {
      models = [];
      ui.model.title = res.error;
    }
    renderModelOptions();
  }

  ui.model.addEventListener("change", () => {
    if (ui.model.value) chrome.storage.local.set({ model: ui.model.value });
  });

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  ui.pill.addEventListener("click", () => setState("expanded"));
  ui.collapseBtn.addEventListener("click", () => setState("collapsed"));
  ui.closeBtn.addEventListener("click", () => setState("hidden"));
  ui.savedBtn.addEventListener("click", () => setView(view === "saved" ? "chat" : "saved"));
  ui.settingsBtn.addEventListener("click", openOptions);
  ui.manageAll.addEventListener("click", openOptions);
  ui.newBtn.addEventListener("click", newChat);
  ui.deleteAll.addEventListener("click", deleteAllForPage);
  ui.send.addEventListener("click", () => (busy ? cancel() : send()));
  ui.input.addEventListener("input", autosize);
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggle") setState(state === "expanded" ? "hidden" : "expanded");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.model) setModelValue(changes.model.newValue ?? "");
    if (changes.scheme || changes.host || changes.port) loadModels();
    if (changes.edits) {
      if (view === "saved") renderSaved();
      applySavedEdits();
    }
  });

  chrome.storage.local
    .get({ showPill: true, model: "" })
    .then((cfg) => {
      setModelValue(cfg.model ?? "");
      setState(cfg.showPill === false ? "hidden" : "collapsed");
    })
    .catch(() => setState("collapsed"));

  applySavedEdits();
})();

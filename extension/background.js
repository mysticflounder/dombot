/**
 * Service worker — owns the conversation per tab, drives the agent loop
 * against Ollama, and is the single writer of the saved-changes list.
 *
 * MV3 workers are killed after ~30s idle, so: conversations are mirrored to
 * chrome.storage.session, ports from pages reconnect on their own, and a
 * keepalive ticks while a turn is running.
 */
import { runTurn, buildSystem, historyItems, userContent, listModels, baseUrl } from "./agent.js";

const PORT_NAME = "dombot";
const TOOL_TIMEOUT_MS = 60000;
const KEEPALIVE_MS = 20000;
const MODELS_CACHE_MS = 60000;

export const DEFAULTS = {
  scheme: "http",
  host: "localhost",
  port: 11434,
  model: "",
  think: "default", // default | on | off
  numCtx: 16384,
  keepAlive: "",
  customInstructions: "",
  showPill: true,
};

const log = (...args) => console.log("[dombot]", ...args);

async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

// ---------------------------------------------------------------------------
// Sessions (one per tab)
// ---------------------------------------------------------------------------

const sessions = new Map(); // tabId -> Promise<Session>

function convKey(tabId) {
  return `conv:${tabId}`;
}

function getSession(tabId) {
  let p = sessions.get(tabId);
  if (!p) {
    p = (async () => {
      const key = convKey(tabId);
      const stored = await chrome.storage.session.get(key);
      return {
        tabId,
        messages: Array.isArray(stored[key]) ? stored[key] : [],
        tools: [],
        port: null,
        busy: false,
        controller: null,
        pendingTools: new Map(), // tool call id -> { resolve, reject }
      };
    })();
    sessions.set(tabId, p);
  }
  return p;
}

function persist(s) {
  return chrome.storage.session.set({ [convKey(s.tabId)]: s.messages }).catch((err) => log("persist failed", err));
}

function post(s, msg) {
  if (!s.port) return;
  try {
    s.port.postMessage(msg);
  } catch {
    s.port = null;
  }
}

function failPendingTools(s, err) {
  for (const { reject } of s.pendingTools.values()) reject(err);
  s.pendingTools.clear();
}

// ---------------------------------------------------------------------------
// Keepalive while any turn is running
// ---------------------------------------------------------------------------

let activeTurns = 0;
let keepaliveTimer = null;

function turnStarted() {
  activeTurns++;
  if (!keepaliveTimer) keepaliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_MS);
}

function turnEnded() {
  activeTurns = Math.max(0, activeTurns - 1);
  if (activeTurns === 0 && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

let modelsCache = { base: "", at: 0, list: null };

async function getModels({ force = false } = {}) {
  const settings = await getSettings();
  const base = baseUrl(settings);
  if (!force && modelsCache.list && modelsCache.base === base && Date.now() - modelsCache.at < MODELS_CACHE_MS) {
    return modelsCache.list;
  }
  const list = await listModels({ base });
  modelsCache = { base, at: Date.now(), list };
  return list;
}

/** The configured model, or the first advertised one (saved for next time). */
async function resolveModel(settings) {
  if (settings.model) return settings.model;
  const models = await getModels();
  const pick = models.find((m) => m.tools !== false) ?? models[0];
  if (!pick) throw new Error("Ollama advertises no models. Pull one first, e.g. `ollama pull qwen3`.");
  await chrome.storage.local.set({ model: pick.name });
  return pick.name;
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

let toolCallCounter = 0;

function askTool(s, call) {
  return new Promise((resolve, reject) => {
    if (!s.port) {
      reject(new Error("the page is not connected"));
      return;
    }
    const id = call.id || `local_${++toolCallCounter}`;
    const timer = setTimeout(() => {
      s.pendingTools.delete(id);
      resolve({ content: `${call.name} did not answer within ${TOOL_TIMEOUT_MS / 1000}s`, is_error: true });
    }, TOOL_TIMEOUT_MS);
    s.pendingTools.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    post(s, { type: "tool_use", id, name: call.name, input: call.input });
  });
}

async function startTurn(s, msg) {
  if (s.busy) {
    post(s, { type: "error", message: "Still working on the last message. Stop it first, or wait." });
    return;
  }
  const settings = await getSettings();
  const base = baseUrl(settings);

  s.busy = true;
  s.controller = new AbortController();
  turnStarted();

  s.messages.push({ role: "user", content: userContent(msg.page, msg.text) });
  await persist(s);
  post(s, { type: "turn_start" });

  let textStarted = false;
  let thinkingShown = false;
  try {
    const model = await resolveModel(settings);
    post(s, { type: "status", text: `waiting for ${model}…` });
    const result = await runTurn({
      messages: s.messages,
      tools: s.tools,
      system: buildSystem(settings.customInstructions),
      settings: { model, numCtx: settings.numCtx, think: settings.think, keepAlive: settings.keepAlive },
      base,
      signal: s.controller.signal,
      runTool: (name, input, id) => askTool(s, { id, name, input }),
      onChunk: (chunk) => {
        const m = chunk.message;
        if (!m) return;
        if (m.thinking && !thinkingShown) {
          thinkingShown = true;
          post(s, { type: "status", text: "thinking…" });
        }
        if (m.content) {
          if (!textStarted) {
            textStarted = true;
            post(s, { type: "text_start" });
          }
          post(s, { type: "delta", text: m.content });
        }
        if (chunk.done) {
          textStarted = false;
          thinkingShown = false;
        }
      },
      onAssistantMessage: () => persist(s),
    });
    post(s, { type: "turn_end", stopReason: result.done_reason, model: result.model, stats: result.stats });
  } catch (err) {
    if (err?.name === "AbortError") {
      post(s, { type: "turn_end", stopReason: "cancelled" });
    } else {
      log("turn failed", err);
      post(s, { type: "error", message: err?.message ?? String(err), needsSetup: true });
    }
  } finally {
    s.busy = false;
    s.controller = null;
    failPendingTools(s, new Error("turn ended"));
    turnEnded();
    await persist(s);
  }
}

function handlePortMessage(s, msg) {
  switch (msg?.type) {
    case "hello":
      if (Array.isArray(msg.tools)) s.tools = msg.tools;
      post(s, { type: "history", items: historyItems(s.messages), busy: s.busy });
      break;
    case "user":
      if (typeof msg.text === "string" && msg.text.trim()) startTurn(s, msg);
      break;
    case "tool_result": {
      const pending = s.pendingTools.get(msg.id);
      if (!pending) break;
      s.pendingTools.delete(msg.id);
      pending.resolve({ content: typeof msg.content === "string" ? msg.content : "", is_error: Boolean(msg.is_error) });
      break;
    }
    case "cancel":
      s.controller?.abort();
      break;
    case "clear":
      if (s.busy) s.controller?.abort();
      s.messages = [];
      persist(s);
      post(s, { type: "history", items: [], busy: false });
      break;
    default:
      break;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    port.disconnect();
    return;
  }
  const ready = getSession(tabId);
  ready.then((s) => {
    if (s.port && s.port !== port) {
      try {
        s.port.disconnect();
      } catch {
        // already gone
      }
    }
    s.port = port;
  });
  port.onMessage.addListener(async (msg) => handlePortMessage(await ready, msg));
  port.onDisconnect.addListener(async () => {
    const s = await ready;
    if (s.port === port) s.port = null;
    failPendingTools(s, new Error("the page disconnected while a tool was running"));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  chrome.storage.session.remove(convKey(tabId));
});

// ---------------------------------------------------------------------------
// Saved changes — single writer
// ---------------------------------------------------------------------------

let editsQueue = Promise.resolve();

function withEdits(mutate) {
  const run = editsQueue.then(async () => {
    const { edits } = await chrome.storage.local.get({ edits: [] });
    const next = mutate(Array.isArray(edits) ? edits : []);
    await chrome.storage.local.set({ edits: next });
    return next.length;
  });
  editsQueue = run.catch(() => {});
  return run;
}

function validEdit(e) {
  return e && typeof e.id === "string" && typeof e.selector === "string" && typeof e.action === "string" && typeof e.origin === "string";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => {
    p.then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: err?.message ?? String(err) }),
    );
    return true; // keep sendResponse alive for the async reply
  };
  switch (msg?.type) {
    case "open_options":
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    case "models.list":
      return reply(getModels({ force: Boolean(msg.force) }));
    case "edits.add":
      if (!validEdit(msg.edit)) {
        sendResponse({ ok: false, error: "malformed edit" });
        return false;
      }
      return reply(withEdits((list) => [...list.filter((e) => e.id !== msg.edit.id), msg.edit]));
    case "edits.remove": {
      const ids = new Set(Array.isArray(msg.ids) ? msg.ids : [msg.id]);
      return reply(withEdits((list) => list.filter((e) => !ids.has(e.id))));
    }
    case "edits.update":
      return reply(withEdits((list) => list.map((e) => (e.id === msg.id ? { ...e, ...(msg.patch ?? {}) } : e))));
    case "edits.clear":
      return reply(withEdits(() => []));
    default:
      return false;
  }
});

// Settings changes invalidate the model cache (host/port may have moved).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.scheme || changes.host || changes.port)) modelsCache = { base: "", at: 0, list: null };
});

// ---------------------------------------------------------------------------
// Toolbar button and keyboard shortcut toggle the panel
// ---------------------------------------------------------------------------

async function togglePanel(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "toggle" });
  } catch {
    // No content script here (chrome://, the Web Store, a PDF viewer...).
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id !== undefined) togglePanel(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-panel" && tab?.id !== undefined) togglePanel(tab.id);
});

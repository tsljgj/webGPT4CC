// webGPT4CC service worker.
//
//  * Owns the WebSocket to the local bridge (ws://127.0.0.1:<port>/extension):
//    a mutual challenge-response on the pairing token proves both ends before
//    anything else is exchanged (the token itself never crosses the wire);
//    reconnects with exponential backoff, answers pings and pings every 20 s
//    (WebSocket traffic keeps an MV3 service worker alive), and a 30 s
//    chrome.alarms tick re-establishes it after the worker was suspended.
//  * Keeps the worker-tab registry (chrome.storage.session, survives restarts of
//    the service worker; the intent in chrome.storage.local survives browser
//    restarts) and announces it to the bridge.
//  * Orchestrates jobs: navigates the tab when needed, waits for the fresh page's
//    agent, sends it the run command, relays its events to the bridge. One job per tab.
//
// Wire protocol to the bridge: docs/PROTOCOL.md §2. Design: docs/EXTENSION.md.
'use strict';

const PROTOCOL_VERSION = 2;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const RELAY_PORT_NAME = 'webgpt4cc-relay';
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const DEFAULT_SETTINGS = Object.freeze({
  bridgeUrl: 'http://127.0.0.1:8765',
  token: '',
  enabled: true,
  maxWorkers: 3,
  debug: false,
  /** Allow ws:// / http:// to a host that is not this computer (unencrypted). */
  allowRemoteBridge: false,
});
const NAV_TIMEOUT_MS = 45_000;
const AGENT_WAIT_MS = 10_000;
const CANCEL_GRACE_MS = 5_000;
/** A job cancelled while its navigation is in flight keeps the tab reserved at most this long. */
const NAV_CANCEL_GRACE_MS = 10_000;
/** After navigating, a page without composer or login screen is used anyway once it reported this long (and shows no Cloudflare check). */
const PAGE_SETTLE_FALLBACK_MS = 8_000;
/** Worker tabs send a heartbeat every 10 s; a tab silent for this long is frozen or hung. */
const STALE_MS = 75_000;
const HOUSEKEEPING_MS = 15_000;
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const ALARM_NAME = 'webgpt4cc-keepalive';
const INTENT_KEY = 'workerIntent';
/** Agent statuses after which a reload of the page cannot have sent the prompt yet. */
const SAFE_TO_RERUN = new Set(['', 'ready', 'typing']);
const NEW_CHAT_PARAMS = new Set(['model', 'temporary-chat']);
const ERROR_CODES = new Set([
  'no_worker',
  'rate_limited',
  'too_long',
  'not_logged_in',
  'ui_error',
  'network',
  'conversation_not_found',
  'timeout',
  'aborted',
  'internal',
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings = { ...DEFAULT_SETTINGS };
/** Worker tabs in the order they were added (persisted in chrome.storage.session). */
let workerTabIds = [];
/** tabId -> { tabId, port, agent (last reported page state), url, title, lastStateAt, agentSince, frozen, discarded } for every chatgpt.com tab with a relay. */
const tabs = new Map();
/** jobId -> job controller (see startJob). */
const jobs = new Map();

const conn = {
  ws: null,
  status: 'disconnected', // disconnected | connecting | connected | disabled
  retryMs: RETRY_MIN_MS,
  retryTimer: null,
  pingTimer: null,
  lastError: '',
  bridgeVersion: '',
  connectedAt: 0,
  /** The bridge proved it knows the pairing token (nothing but the handshake happens before). */
  authed: false,
  nonce: '',
  authTimer: null,
  authError: '',
};

class JobFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function isChatGptUrl(u) {
  const p = parseUrl(u);
  return !!p && p.origin === CHATGPT_ORIGIN;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathShowsConversation(pathname, conversationId) {
  return new RegExp(`(?:^|/)c/${escapeRegExp(encodeURIComponent(conversationId))}(?:/|$)`).test(pathname);
}

function browserString() {
  const ua = navigator.userAgent || '';
  const m = /Edg\/(\d+)/.exec(ua) || /Chrome\/(\d+)/.exec(ua);
  return m ? `${m[0].startsWith('Edg') ? 'Edge' : 'Chrome'}/${m[1]}` : 'Chromium';
}

function postToPort(port, msg) {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 (hex) keyed by the pairing token (domain-separated, so an empty token is a valid key too). */
async function pairingHmac(token, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(`webgpt4cc/pairing/v2/${token}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isWorker = (tabId) => workerTabIds.includes(tabId);
const tabJob = (tabId) => {
  for (const ctl of jobs.values()) if (ctl.tabId === tabId && !ctl.finished) return ctl;
  return null;
};
/** No state (or heartbeat) from the page for STALE_MS: frozen by Chrome, or hung. */
const tabStale = (t) => !t || !t.lastStateAt || Date.now() - t.lastStateAt > STALE_MS;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function isLoopbackHost(hostname) {
  const h = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Why a bridge URL is refused, or '' when it is fine. Unencrypted ws:// / http://
 * is allowed only to this computer (loopback), unless the user explicitly allows
 * an unencrypted remote bridge: prompts and replies would cross the network in
 * cleartext, and a URL written into storage must never redirect traffic off the machine.
 */
function bridgeUrlProblem(url, allowRemote) {
  const u = parseUrl(url);
  if (!u || !/^(?:https?|wss?):$/.test(u.protocol)) return 'not an http(s):// or ws(s):// URL';
  if (u.username || u.password) return 'the URL must not contain credentials';
  if (isLoopbackHost(u.hostname) || u.protocol === 'https:' || u.protocol === 'wss:' || allowRemote) return '';
  return `${u.hostname} is not this computer and ${u.protocol}// is unencrypted (use wss:// or https://, or allow an unencrypted remote bridge)`;
}

function sanitizeSettings(raw, previous) {
  const s = { ...DEFAULT_SETTINGS };
  if (typeof raw.allowRemoteBridge === 'boolean') s.allowRemoteBridge = raw.allowRemoteBridge;
  if (typeof raw.bridgeUrl === 'string' && raw.bridgeUrl.trim()) {
    const url = raw.bridgeUrl.trim().replace(/\/+$/, '');
    const problem = bridgeUrlProblem(url, s.allowRemoteBridge);
    if (!problem) s.bridgeUrl = url;
    else {
      // Keep the last good URL: a rejected value never triggers a reconnect.
      s.bridgeUrl = previous ? previous.bridgeUrl : DEFAULT_SETTINGS.bridgeUrl;
      s.rejectedBridgeUrl = `Bridge URL ${url} refused: ${problem}.`;
    }
  }
  if (typeof raw.token === 'string') s.token = raw.token.trim();
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
  const mw = Number(raw.maxWorkers);
  if (Number.isFinite(mw) && mw >= 1) s.maxWorkers = Math.min(Math.floor(mw), 10);
  if (typeof raw.debug === 'boolean') s.debug = raw.debug;
  return s;
}

async function loadSettings() {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  settings = sanitizeSettings(raw, settings);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => k in DEFAULT_SETTINGS)) return;
  initDone.then(async () => {
    const before = settings;
    await loadSettings();
    if (before.bridgeUrl !== settings.bridgeUrl || before.token !== settings.token || before.enabled !== settings.enabled) {
      reconnectBridge();
    }
    if (settings.rejectedBridgeUrl) conn.lastError = settings.rejectedBridgeUrl;
    if (before.debug !== settings.debug) for (const t of tabs.values()) sendConfig(t);
    if (before.maxWorkers !== settings.maxWorkers) announceWorkers();
  });
});

// ---------------------------------------------------------------------------
// Worker registry
// ---------------------------------------------------------------------------

async function loadWorkers() {
  let ids = [];
  try {
    const got = await chrome.storage.session.get('workerTabIds');
    if (Array.isArray(got.workerTabIds)) ids = got.workerTabIds.filter((x) => Number.isInteger(x));
  } catch {
    ids = [];
  }
  const alive = [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab && isChatGptUrl(tab.url || tab.pendingUrl || '')) alive.push(id);
    } catch {
      /* tab is gone */
    }
  }
  workerTabIds = alive;
  if (alive.length !== ids.length) await saveWorkers();
}

async function saveWorkers() {
  try {
    await chrome.storage.session.set({ workerTabIds });
  } catch {
    /* ignore */
  }
  scheduleIntentSave();
}

// The worker set also lives in chrome.storage.local ({ workers: [{ pinned, url }] }):
// chrome.storage.session and tab ids do not survive a browser restart or an
// extension reload, so the restored pinned worker tabs are adopted again from it.
let intentTimer = null;
let intentJson = '';
function scheduleIntentSave() {
  clearTimeout(intentTimer);
  intentTimer = setTimeout(() => void saveIntent(), 1000);
}
async function saveIntent() {
  const workers = [];
  for (const id of workerTabIds) {
    let pinned = false;
    let url = '';
    try {
      const tab = await chrome.tabs.get(id);
      pinned = !!tab.pinned;
      url = isChatGptUrl(tab.url || '') ? tab.url : '';
    } catch {
      continue;
    }
    workers.push({ pinned, url });
  }
  const json = JSON.stringify(workers);
  if (json === intentJson) return;
  intentJson = json;
  try {
    await chrome.storage.local.set({ [INTENT_KEY]: { workers, savedAt: Date.now() } });
  } catch {
    /* ignore */
  }
}

/** After a browser restart (or extension reload) the registry is empty: adopt the restored worker tabs again. */
let readopting = null;
function readoptWorkers() {
  if (!readopting) readopting = adoptFromIntent().catch(() => {});
  return readopting;
}
async function adoptFromIntent() {
  if (workerTabIds.length) return;
  let intent = null;
  try {
    intent = (await chrome.storage.local.get(INTENT_KEY))[INTENT_KEY];
  } catch {
    return;
  }
  const wanted = intent && Array.isArray(intent.workers) ? intent.workers.slice(0, settings.maxWorkers) : [];
  if (!wanted.length) return;
  let open = [];
  try {
    open = await chrome.tabs.query({ url: `${CHATGPT_ORIGIN}/*` });
  } catch {
    return;
  }
  const free = open.filter((t) => Number.isInteger(t.id) && !t.incognito);
  for (const w of wanted) {
    if (!w || typeof w !== 'object') continue;
    // A pinned worker: any restored pinned chatgpt.com tab (same URL preferred). An unpinned
    // one ("Use this tab"): only a tab at exactly the same URL, never some other tab of the user.
    let pick = w.url ? free.find((t) => t.url === w.url && !!t.pinned === !!w.pinned) : null;
    if (!pick && w.pinned) pick = free.find((t) => t.pinned);
    if (!pick) continue;
    free.splice(free.indexOf(pick), 1);
    try {
      await addWorker(pick.id);
    } catch {
      /* ignore */
    }
  }
}

function workerList() {
  return workerTabIds.map((tabId, i) => {
    const t = tabs.get(tabId);
    const a = t && t.agent;
    const busy = !!tabJob(tabId);
    const url = (a && a.url) || (t && t.url) || '';
    const w = {
      id: String(tabId),
      // Only chatgpt.com URLs ever leave the browser.
      url: isChatGptUrl(url) ? url : '',
      ready: !!(t && t.port && a && a.ready && !busy && !t.frozen && !t.discarded && !tabStale(t)),
      busy,
      label: `ChatGPT worker ${i + 1}`,
    };
    if (a && a.heldConversationId) w.conversationId = a.heldConversationId;
    return w;
  });
}

let lastAnnounced = '';
function announceWorkers(force = false) {
  const list = workerList();
  const json = JSON.stringify(list);
  updateBadge(list);
  if (json !== lastAnnounced) scheduleIntentSave();
  if (!force && json === lastAnnounced) return;
  if (sendToBridge({ type: 'workers', workers: list })) lastAnnounced = json;
}

function sendConfig(t) {
  postToPort(t.port, { type: 'config', worker: isWorker(t.tabId), debug: settings.debug });
}

async function addWorker(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isChatGptUrl(tab.url || tab.pendingUrl || '')) throw new Error('this tab is not on chatgpt.com');
  if (isWorker(tabId)) return;
  if (workerTabIds.length >= settings.maxWorkers)
    throw new Error(`already ${workerTabIds.length} worker tab(s) (maximum ${settings.maxWorkers}); release one first`);
  workerTabIds.push(tabId);
  await saveWorkers();
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* older Chrome */
  }
  const t = tabs.get(tabId);
  if (t && t.port) {
    sendConfig(t);
    postToPort(t.port, { type: 'sync' });
  } else if (tab.status === 'complete' || tab.status === 'unloaded' || tab.discarded) {
    // The page was loaded before the extension (re)started, so it has no content
    // scripts (or the browser restored it unloaded): reload it if it does not connect on its own.
    setTimeout(() => {
      const now = tabs.get(tabId);
      if (isWorker(tabId) && !(now && now.port)) chrome.tabs.reload(tabId).catch(() => {});
    }, 1500);
  }
  announceWorkers();
}

async function releaseWorker(tabId) {
  const ctl = tabJob(tabId);
  if (ctl) cancelJob(ctl.job.id, 'the worker tab was released');
  workerTabIds = workerTabIds.filter((id) => id !== tabId);
  await saveWorkers();
  const t = tabs.get(tabId);
  if (t) sendConfig(t);
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: true });
  } catch {
    /* tab may be gone */
  }
  announceWorkers();
}

async function openWorkerTab() {
  if (workerTabIds.length >= settings.maxWorkers)
    throw new Error(`already ${workerTabIds.length} worker tab(s) (maximum ${settings.maxWorkers}); release one first`);
  const tab = await chrome.tabs.create({ url: `${CHATGPT_ORIGIN}/`, pinned: true, active: false });
  workerTabIds.push(tab.id);
  await saveWorkers();
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    /* ignore */
  }
  announceWorkers();
  return tab.id;
}

// ---------------------------------------------------------------------------
// Relay ports (one per chatgpt.com tab)
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== RELAY_PORT_NAME) return;
  const sender = port.sender || {};
  const tabId = sender.tab && sender.tab.id;
  if (typeof tabId !== 'number' || sender.frameId !== 0 || !isChatGptUrl(sender.url || (sender.tab && sender.tab.url) || '')) {
    port.disconnect();
    return;
  }
  let t = tabs.get(tabId);
  if (!t) {
    t = { tabId, port: null, agent: null, url: sender.tab.url || '', title: sender.tab.title || '', lastStateAt: 0, agentSince: 0, frozen: false, discarded: false };
    tabs.set(tabId, t);
  }
  t.port = port; // a newer page replaces the old page's port
  t.agent = null; // until the new page reports in
  t.frozen = false;
  t.discarded = false;
  port.onMessage.addListener((msg) => onAgentMessage(tabId, port, msg));
  port.onDisconnect.addListener(() => onRelayDisconnect(tabId, port));
  initDone.then(() => {
    if (t.port !== port) return;
    sendConfig(t);
    postToPort(port, { type: 'sync' });
  });
});

function onRelayDisconnect(tabId, port) {
  const t = tabs.get(tabId);
  if (!t || t.port !== port) return;
  const oldPageId = t.agent ? t.agent.pageId : null;
  t.port = null;
  t.agent = null;
  const ctl = tabJob(tabId);
  if (ctl && ctl.phase === 'running') {
    if (!ctl.cancelled && SAFE_TO_RERUN.has(ctl.lastAgentStatus) && ctl.redeliveries < 3) {
      // The page reloaded before it could have sent anything (a Cloudflare check that
      // reloads itself, a redirect, the user pressing reload): run the job in the new document.
      ctl.redeliveries++;
      sendJobEvent(ctl, { type: 'status', status: 'navigating', detail: 'the ChatGPT tab reloaded before sending; waiting for the new page' });
      deliver(ctl, 'reloaded', { oldPort: port, oldPageId }).catch((e) => {
        if (!ctl.finished) finishJob(ctl, jobError(e && e.code ? e.code : 'internal', e && e.message ? e.message : String(e)));
      });
    } else finishJob(ctl, jobError('ui_error', 'the ChatGPT tab reloaded or navigated away while the reply was being generated'));
  }
  if (isWorker(tabId)) announceWorkers();
}

function sanitizeAgentState(s) {
  if (!s || typeof s !== 'object') return null;
  const str = (v, n = 2000) => (typeof v === 'string' ? v.slice(0, n) : '');
  const warning =
    s.warning && typeof s.warning === 'object' ? { type: str(s.warning.type, 40), text: str(s.warning.text, 300) } : null;
  return {
    pageId: str(s.pageId, 64),
    url: str(s.url),
    title: str(s.title, 200),
    composer: !!s.composer,
    generating: !!s.generating,
    loginRequired: !!s.loginRequired,
    cloudflare: !!s.cloudflare,
    hidden: !!s.hidden,
    warning,
    turnCount: Number(s.turnCount) || 0,
    emptyChat: !!s.emptyChat,
    heldConversationId: typeof s.heldConversationId === 'string' ? s.heldConversationId : null,
    jobId: typeof s.jobId === 'string' ? s.jobId : null,
    userTyping: !!s.userTyping,
    ready: !!s.ready,
  };
}

function onAgentMessage(tabId, port, msg) {
  const t = tabs.get(tabId);
  if (!t || t.port !== port || !msg || typeof msg !== 'object') return; // stale page or junk
  switch (msg.type) {
    case 'state': {
      const st = sanitizeAgentState(msg.state);
      if (!st) return;
      if (!t.agent || t.agent.pageId !== st.pageId) t.agentSince = Date.now();
      t.agent = st;
      t.lastStateAt = Date.now();
      if (st.url && isChatGptUrl(st.url)) t.url = st.url;
      t.title = st.title || t.title;
      checkWaiters(tabId);
      // An agent that still runs a job this service worker does not know about
      // (e.g. it restarted mid-job): nobody will read that reply, so stop it.
      if (st.jobId && !jobs.has(st.jobId)) postToPort(port, { type: 'cancel', jobId: st.jobId, reason: 'orphaned job' });
      if (isWorker(tabId)) announceWorkers();
      break;
    }
    case 'event':
      onAgentEvent(tabId, String(msg.jobId || ''), msg.event);
      break;
    case 'log': {
      if (!isWorker(tabId)) return;
      const level = ['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'info';
      sendToBridge({
        type: 'log',
        level,
        message: `[tab ${tabId}] ${String(msg.message || '').slice(0, 1000)}`,
        ...(msg.data !== undefined ? { data: msg.data } : {}),
      });
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function jobError(code, message, retryAfterMs) {
  const ev = { type: 'error', code: ERROR_CODES.has(code) ? code : 'internal', message: String(message || code).slice(0, 2000) };
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) ev.retryAfterMs = Math.round(retryAfterMs);
  return ev;
}

function sendJobEvent(ctl, event) {
  sendToBridge({ type: 'job_event', jobId: ctl.job.id, event });
}

function cleanMismatch(m) {
  if (!m || typeof m !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  const kinds = Array.isArray(m.kinds) ? m.kinds.filter((k) => typeof k === 'string').slice(0, 10).map((k) => k.slice(0, 40)) : [];
  return { offset: n(m.offset), sentChars: n(m.sentChars), wantChars: n(m.wantChars), kinds };
}

/** Validate an agent event before it reaches the bridge. */
function cleanEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.type) {
    case 'status': {
      // "thinking" may carry the whole reasoning summary so far (streamed as a thinking block).
      const max = ev.status === 'thinking' ? 100_000 : 500;
      return { type: 'status', status: String(ev.status || '').slice(0, 40), ...(ev.detail ? { detail: String(ev.detail).slice(0, max) } : {}) };
    }
    case 'text':
      return typeof ev.text === 'string' ? { type: 'text', text: ev.text } : null;
    case 'done': {
      if (typeof ev.text !== 'string') return null;
      const out = { type: 'done', text: ev.text, conversationId: typeof ev.conversationId === 'string' ? ev.conversationId : '' };
      if (typeof ev.messageId === 'string' && ev.messageId) out.messageId = ev.messageId;
      if (typeof ev.finishReason === 'string' && ev.finishReason) out.finishReason = ev.finishReason;
      for (const k of ['requestedModel', 'actualModel', 'modelSlug']) if (typeof ev[k] === 'string' && ev[k]) out[k] = ev[k].slice(0, 100);
      const mismatch = cleanMismatch(ev.promptMismatch);
      if (mismatch) out.promptMismatch = mismatch;
      return out;
    }
    case 'error':
      return jobError(String(ev.code || 'internal'), ev.message, Number(ev.retryAfterMs));
    default:
      return null;
  }
}

function onAgentEvent(tabId, jobId, rawEvent) {
  const ctl = jobs.get(jobId);
  if (!ctl || ctl.tabId !== tabId || ctl.finished) return;
  const ev = cleanEvent(rawEvent);
  if (!ev) return;
  if (ev.type === 'status') ctl.lastAgentStatus = ev.status;
  if (ev.type === 'done' || ev.type === 'error') finishJob(ctl, ev);
  else sendJobEvent(ctl, ev);
}

function finishJob(ctl, event, { notifyBridge = true } = {}) {
  if (ctl.finished) return;
  ctl.finished = true;
  clearTimeout(ctl.timeoutTimer);
  clearTimeout(ctl.cancelTimer);
  for (const w of [...ctl.waiters]) w.reject(new JobFailure(event.code || 'aborted', event.message || 'job finished'));
  ctl.waiters.clear();
  jobs.delete(ctl.job.id);
  if (notifyBridge) sendJobEvent(ctl, event);
  announceWorkers();
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || typeof raw.prompt !== 'string') return null;
  const c = raw.conversation && typeof raw.conversation === 'object' ? raw.conversation : {};
  const conversation =
    c.kind === 'continue' && typeof c.conversationId === 'string' && c.conversationId
      ? {
          kind: 'continue',
          conversationId: c.conversationId,
          ...(typeof c.parentMessageId === 'string' ? { parentMessageId: c.parentMessageId } : {}),
        }
      : { kind: 'new' };
  const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 20 * 60_000, 10_000), 4 * 3600_000);
  return {
    id: raw.id,
    workerId: String(raw.workerId ?? ''),
    model: typeof raw.model === 'string' ? raw.model : '',
    conversation,
    url: typeof raw.url === 'string' ? raw.url : `${CHATGPT_ORIGIN}/`,
    prompt: raw.prompt,
    purpose: typeof raw.purpose === 'string' ? raw.purpose : 'main',
    timeoutMs,
    temporary: !!raw.temporary,
    allowWebSearch: !!raw.allowWebSearch,
  };
}

/**
 * Only the URL shapes the bridge builds are opened: a new chat at "/" (or a
 * /g/… GPT or project page) with ?model= / ?temporary-chat=, and a continued
 * conversation at exactly /c/<conversationId>. Never /auth/*, /api/*, ?q=…
 */
function jobUrlProblem(job) {
  const u = parseUrl(job.url);
  if (!u || u.origin !== CHATGPT_ORIGIN) return 'not a https://chatgpt.com URL';
  if (u.username || u.password || u.hash) return 'unexpected parts in the URL';
  if (job.conversation.kind === 'continue') {
    const want = `/c/${encodeURIComponent(job.conversation.conversationId)}`;
    if (u.pathname !== want || u.search) return `a continued conversation is opened at ${want}`;
    return '';
  }
  if (!/^\/(?:g\/[\w-]+(?:\/project)?\/?)?$/.test(u.pathname)) return 'a new chat starts at / or at a /g/… GPT or project page';
  for (const key of u.searchParams.keys()) if (!NEW_CHAT_PARAMS.has(key)) return `unexpected URL parameter "${key}"`;
  return '';
}

/** Decide whether the tab must navigate before typing. `tab` is chrome.tabs.get's view (may be null). */
function planNavigation(job, t, tab) {
  const a = t && t.agent;
  const cur = parseUrl((a && a.url) || (t && t.url) || '');
  // A navigation still in flight (e.g. of a cancelled job) replaces this document soon.
  const pending = !!(tab && tab.pendingUrl && tab.pendingUrl !== (a && a.url));
  const live = !!(t && t.port && a && !pending && !tabStale(t));
  if (job.conversation.kind === 'continue') {
    const id = job.conversation.conversationId;
    if (job.temporary) {
      // Temporary chats have no URL of their own: only the tab that holds it can continue it.
      if (live && a.heldConversationId === id) return { navigate: false };
      return { error: jobError('conversation_not_found', 'the temporary ChatGPT chat is no longer open in the worker tab') };
    }
    if (live && cur && cur.origin === CHATGPT_ORIGIN && pathShowsConversation(cur.pathname, id) && !a.loginRequired) return { navigate: false };
    return { navigate: true };
  }
  if (live && cur && cur.href === job.url && a.emptyChat && a.composer && !a.generating) return { navigate: false };
  return { navigate: true };
}

/** The page is where the job wants it (a redirect away from /c/<id> is fine: the agent reports "not found"). */
function pageMatchesJob(url, job) {
  const u = parseUrl(url);
  if (!u || u.origin !== CHATGPT_ORIGIN) return false;
  const shown = /(?:^|\/)c\/[^/?#]+/.test(u.pathname);
  if (job.conversation.kind === 'continue') return !shown || pathShowsConversation(u.pathname, job.conversation.conversationId);
  return !shown; // a new chat never runs in some other conversation
}

/** The new page is far enough to take the job: composer or login screen, or it settled without a Cloudflare check. */
function pageSettled(t) {
  const a = t.agent;
  return a.composer || a.loginRequired || (!a.cloudflare && !!t.agentSince && Date.now() - t.agentSince >= PAGE_SETTLE_FALLBACK_MS);
}

function navTimeoutError(tabId) {
  const t = tabs.get(tabId);
  if (t && t.agent && t.agent.cloudflare)
    return new JobFailure('network', 'ChatGPT shows a Cloudflare check ("Just a moment…") in the worker tab: open the tab and complete it');
  return new JobFailure('ui_error', 'the ChatGPT tab did not finish loading within 45 s');
}

/** Resolve once pred(tab) holds (checked whenever the tab reports state, and every second); reject on timeout or job end. */
function waitForTab(ctl, pred, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const w = {
      check: () => {
        const t = tabs.get(ctl.tabId);
        let ok = false;
        try {
          ok = !!(t && pred(t));
        } catch {
          ok = false;
        }
        if (ok) {
          cleanup();
          resolve(t);
        }
      },
      reject: (e) => {
        cleanup();
        reject(e);
      },
    };
    const timer = setTimeout(() => w.reject(typeof onTimeout === 'function' ? onTimeout() : new JobFailure('ui_error', String(onTimeout))), timeoutMs);
    const poll = setInterval(() => w.check(), 1000);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      ctl.waiters.delete(w);
    };
    ctl.waiters.add(w);
    w.check();
  });
}

function checkWaiters(tabId) {
  for (const ctl of jobs.values()) if (ctl.tabId === tabId) for (const w of [...ctl.waiters]) w.check();
}

async function startJob(raw) {
  await initDone;
  const job = normalizeJob(raw);
  if (!job) {
    sendToBridge({ type: 'log', level: 'warn', message: 'extension received a malformed job' });
    if (raw && typeof raw.id === 'string') sendToBridge({ type: 'job_event', jobId: raw.id, event: jobError('internal', 'malformed job') });
    return;
  }
  if (jobs.has(job.id)) return; // duplicate delivery
  const tabId = Number(job.workerId);
  const ctl = {
    job,
    tabId,
    phase: 'starting',
    finished: false,
    cancelled: false,
    cancelReason: '',
    lastAgentStatus: '',
    redeliveries: 0,
    waiters: new Set(),
    timeoutTimer: null,
    cancelTimer: null,
  };
  if (raw.conversation && raw.conversation.kind === 'continue' && job.conversation.kind !== 'continue') {
    // Never turn a "continue" into a new chat silently: the prompt only holds the new turns.
    sendJobEvent(ctl, jobError('conversation_not_found', 'continue job without a conversation id'));
    return;
  }
  const urlProblem = jobUrlProblem(job);
  if (urlProblem) {
    sendJobEvent(ctl, jobError('internal', `refusing to open ${job.url}: ${urlProblem}`));
    return;
  }
  if (!Number.isInteger(tabId) || !isWorker(tabId)) {
    sendJobEvent(ctl, jobError('no_worker', `tab ${job.workerId} is not a webGPT4CC worker any more`));
    announceWorkers(true);
    return;
  }
  if (tabJob(tabId)) {
    sendJobEvent(ctl, jobError('no_worker', 'the worker tab is busy with another job'));
    return;
  }
  jobs.set(job.id, ctl);
  announceWorkers();
  // Safety net; the bridge normally cancels first when its own timeout fires.
  ctl.timeoutTimer = setTimeout(() => {
    const t = tabs.get(tabId);
    if (t && t.port) postToPort(t.port, { type: 'cancel', jobId: job.id, reason: 'timeout' });
    finishJob(ctl, jobError('timeout', `no reply within ${Math.round(job.timeoutMs / 1000)} s`));
  }, job.timeoutMs + 30_000);

  try {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = null;
    }
    if (ctl.finished) return;
    const plan = planNavigation(job, tabs.get(tabId), tab);
    if (plan.error) {
      finishJob(ctl, plan.error);
      return;
    }
    await deliver(ctl, plan.navigate ? 'navigate' : 'here');
  } catch (e) {
    if (!ctl.finished) finishJob(ctl, jobError(e && e.code ? e.code : 'internal', e && e.message ? e.message : String(e)));
  }
}

/**
 * Bring the job's document up and send it the run command. how: 'here' (the
 * current page), 'navigate' (load job.url first) or 'reloaded' (the page reloaded
 * before sending: wait for the document that replaces `from`).
 */
async function deliver(ctl, how, from) {
  const { job, tabId } = ctl;
  let t;
  if (how === 'here') {
    t = await waitForTab(ctl, (x) => x.port && x.agent && !tabStale(x), AGENT_WAIT_MS, 'the ChatGPT tab is not responding (reload it)');
  } else {
    ctl.phase = 'navigating';
    let oldPort = from ? from.oldPort : null;
    let oldPageId = from ? from.oldPageId : null;
    if (how === 'navigate') {
      sendJobEvent(ctl, { type: 'status', status: 'navigating', detail: job.url });
      const before = tabs.get(tabId);
      oldPort = before ? before.port : null;
      oldPageId = before && before.agent ? before.agent.pageId : null;
      await chrome.tabs.update(tabId, { url: job.url });
    }
    // A real navigation means a new document: its relay opens a new port and its agent
    // reports a new pageId. Wait for that (never the old page), at the job's URL, and far
    // enough to take the job (never an interstitial that is about to reload).
    t = await waitForTab(
      ctl,
      (x) => {
        if (!(x.port && x.port !== oldPort && x.agent && x.agent.pageId !== oldPageId && isChatGptUrl(x.agent.url))) return false;
        if (ctl.cancelled) return true; // the cancelled navigation has committed: the tab is safe to reuse
        return pageMatchesJob(x.agent.url, job) && pageSettled(x);
      },
      NAV_TIMEOUT_MS,
      () => navTimeoutError(tabId),
    );
  }
  if (ctl.finished) return;
  if (ctl.cancelled) {
    finishJob(ctl, jobError('aborted', ctl.cancelReason || 'cancelled'));
    return;
  }
  ctl.phase = 'running';
  ctl.lastAgentStatus = '';
  if (!postToPort(t.port, { type: 'run', job })) throw new JobFailure('ui_error', 'lost contact with the ChatGPT tab');
}

function cancelJob(jobId, reason) {
  const ctl = jobs.get(jobId);
  if (!ctl || ctl.finished) return;
  if (ctl.phase === 'navigating') {
    // The tab is loading the job's URL: report the end only once that document took over
    // (or after a grace period), so the bridge cannot hand the tab to the next job while
    // a document that is about to be replaced still shows.
    if (ctl.cancelled) return;
    ctl.cancelled = true;
    ctl.cancelReason = reason;
    ctl.cancelTimer = setTimeout(() => finishJob(ctl, jobError('aborted', reason)), NAV_CANCEL_GRACE_MS);
    checkWaiters(ctl.tabId);
    return;
  }
  if (ctl.phase !== 'running') {
    finishJob(ctl, jobError('aborted', reason));
    return;
  }
  const t = tabs.get(ctl.tabId);
  if (t && postToPort(t.port, { type: 'cancel', jobId, reason })) {
    // The agent stops the reply and reports "aborted"; do not wait for it forever.
    ctl.cancelTimer = setTimeout(() => finishJob(ctl, jobError('aborted', reason)), CANCEL_GRACE_MS);
  } else {
    finishJob(ctl, jobError('aborted', reason));
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const ctl = tabJob(tabId);
  if (ctl) finishJob(ctl, jobError('ui_error', 'the ChatGPT worker tab was closed'));
  tabs.delete(tabId);
  if (isWorker(tabId)) {
    workerTabIds = workerTabIds.filter((id) => id !== tabId);
    saveWorkers();
    announceWorkers();
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const t = tabs.get(tabId);
  if (!t) return;
  // Without the "tabs" permission Chrome only reveals chatgpt.com URLs (host permission);
  // a tab that left the site has no URL here, and none is ever reported for it.
  if ('url' in info || 'status' in info) {
    const u = (tab && (tab.url || tab.pendingUrl)) || info.url || '';
    t.url = isChatGptUrl(u) ? u : '';
  }
  if (info.title) t.title = isChatGptUrl(t.url) ? info.title : '';
  if (typeof info.frozen === 'boolean' || typeof info.discarded === 'boolean') {
    if (typeof info.frozen === 'boolean') t.frozen = info.frozen;
    if (typeof info.discarded === 'boolean') t.discarded = info.discarded;
    const ctl = tabJob(tabId);
    if ((t.frozen || t.discarded) && ctl)
      finishJob(
        ctl,
        jobError(
          'ui_error',
          `Chrome ${t.frozen ? 'froze' : 'discarded'} the ChatGPT worker tab. Keep worker tabs in their own window, or add chatgpt.com under chrome://settings/performance → "Always keep these sites active".`,
        ),
      );
    if (isWorker(tabId)) announceWorkers();
  }
});

// Chrome swaps tab ids when it replaces a tab (prerendering, discarded tabs).
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (!isWorker(removedTabId)) return;
  const ctl = tabJob(removedTabId);
  if (ctl) finishJob(ctl, jobError('ui_error', 'the ChatGPT worker tab was replaced by the browser'));
  workerTabIds = workerTabIds.map((id) => (id === removedTabId ? addedTabId : id));
  tabs.delete(removedTabId);
  saveWorkers();
  const t = tabs.get(addedTabId);
  if (t) sendConfig(t);
  announceWorkers();
});

/** Frozen or hung worker tabs: no heartbeat for STALE_MS. Their running job fails instead of hanging for the job timeout. */
function housekeeping() {
  for (const ctl of [...jobs.values()]) {
    if (ctl.finished || ctl.phase !== 'running') continue;
    const t = tabs.get(ctl.tabId);
    if (t && t.port && tabStale(t))
      finishJob(
        ctl,
        jobError(
          'ui_error',
          `the ChatGPT worker tab stopped responding for over ${Math.round(STALE_MS / 1000)} s (Chrome may have frozen it). Keep worker tabs in their own window, or add chatgpt.com under chrome://settings/performance → "Always keep these sites active".`,
        ),
      );
  }
  announceWorkers();
}
setInterval(housekeeping, HOUSEKEEPING_MS);

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------

function bridgeWsUrl() {
  const u = parseUrl(settings.bridgeUrl);
  if (!u || bridgeUrlProblem(settings.bridgeUrl, settings.allowRemoteBridge)) return null;
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/extension`;
  u.search = '';
  u.hash = '';
  return u.toString(); // no token: the handshake proves it instead
}

function sendRaw(ws, msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

/** Everything except the handshake waits until the bridge proved it knows the pairing token. */
function sendToBridge(msg) {
  return conn.authed ? sendRaw(conn.ws, msg) : false;
}

function setConnStatus(status) {
  conn.status = status;
  updateBadge();
}

function connectBridge() {
  clearTimeout(conn.retryTimer);
  conn.retryTimer = null;
  if (!settings.enabled) {
    setConnStatus('disabled');
    return;
  }
  if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) return;
  const url = bridgeWsUrl();
  if (!url) {
    conn.lastError = settings.rejectedBridgeUrl || `Invalid bridge URL "${settings.bridgeUrl}".`;
    setConnStatus('disconnected');
    return;
  }
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    conn.lastError = `Could not open ${settings.bridgeUrl}: ${e && e.message ? e.message : e}`;
    setConnStatus('disconnected');
    scheduleReconnect();
    return;
  }
  conn.ws = ws;
  conn.authed = false;
  conn.authError = '';
  setConnStatus('connecting');
  ws.onopen = () => {
    if (conn.ws !== ws) return;
    // Handshake, step 1: our nonce. Nothing that identifies the user's tabs or
    // conversations is sent before the bridge proves it knows the pairing token.
    conn.nonce = randomHex(16);
    sendRaw(ws, { type: 'hello', protocol: PROTOCOL_VERSION, extensionVersion: EXTENSION_VERSION, browser: browserString(), nonce: conn.nonce });
    clearTimeout(conn.authTimer);
    conn.authTimer = setTimeout(() => {
      if (conn.ws !== ws || conn.authed) return;
      conn.authError = `Whatever listens at ${settings.bridgeUrl} did not complete the webGPT4CC pairing handshake (an old bridge, or another program on that port?).`;
      try {
        ws.close(4408, 'no handshake');
      } catch {
        /* ignore */
      }
    }, AUTH_TIMEOUT_MS);
  };
  ws.onmessage = (ev) => {
    if (conn.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (msg && typeof msg === 'object') onBridgeMessage(ws, msg);
  };
  ws.onclose = (ev) => {
    if (conn.ws !== ws) return;
    const wasAuthed = conn.authed;
    conn.ws = null;
    conn.authed = false;
    clearTimeout(conn.authTimer);
    clearInterval(conn.pingTimer);
    conn.pingTimer = null;
    setConnStatus('disconnected');
    onBridgeLost();
    if (conn.authError) conn.lastError = conn.authError;
    else if (ev.code === 4401)
      conn.lastError = 'The bridge rejected the pairing token: check the token in the popup ("webgpt4cc pair" shows it).';
    else if (ev.code === 4400) conn.lastError = `The bridge refused the connection: ${ev.reason || 'protocol mismatch'}.`;
    else if (wasAuthed) conn.lastError = `Connection to the bridge closed${ev.reason ? `: ${ev.reason}` : ` (code ${ev.code})`}.`;
    else void diagnoseConnectFailure();
    conn.authError = '';
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

/** Handshake, step 2: check the bridge's proof, then send ours and start working. */
async function onWelcome(ws, msg) {
  conn.bridgeVersion = typeof msg.bridgeVersion === 'string' ? msg.bridgeVersion.slice(0, 40) : '';
  const fail = (text, code = 4401) => {
    conn.authError = text;
    try {
      ws.close(code, 'handshake failed');
    } catch {
      /* ignore */
    }
  };
  if (msg.protocol !== PROTOCOL_VERSION) {
    fail(`The bridge speaks protocol ${msg.protocol}, the extension ${PROTOCOL_VERSION}: update both.`, 4400);
    return;
  }
  const nonceB = typeof msg.nonce === 'string' && /^[0-9a-f]{32,128}$/.test(msg.nonce) ? msg.nonce : '';
  const token = settings.token;
  let ok = false;
  try {
    ok = !!nonceB && sameText(await pairingHmac(token, `bridge|${conn.nonce}|${nonceB}`), msg.proof);
  } catch {
    ok = false;
  }
  if (conn.ws !== ws || conn.authed) return;
  if (!ok) {
    fail(`The program at ${settings.bridgeUrl} could not prove it knows the pairing token, so nothing was sent to it: check the token ("webgpt4cc pair" shows it).`);
    return;
  }
  let proof;
  try {
    proof = await pairingHmac(token, `extension|${nonceB}|${conn.nonce}`);
  } catch (e) {
    fail(`Could not compute the pairing proof: ${e && e.message ? e.message : e}`);
    return;
  }
  if (conn.ws !== ws) return;
  sendRaw(ws, { type: 'auth', proof });
  conn.authed = true;
  clearTimeout(conn.authTimer);
  conn.retryMs = RETRY_MIN_MS;
  conn.lastError = settings.rejectedBridgeUrl || '';
  conn.connectedAt = Date.now();
  setConnStatus('connected');
  lastAnnounced = '';
  announceWorkers(true);
  clearInterval(conn.pingTimer);
  conn.pingTimer = setInterval(() => sendToBridge({ type: 'ping', t: Date.now() }), PING_INTERVAL_MS);
}

/** WebSocket errors carry no detail: ask /health to tell "not running" from "rejected". */
async function diagnoseConnectFailure() {
  const base = settings.bridgeUrl.replace(/^ws(s?):/, 'http$1:');
  try {
    const r = await fetch(`${base}/health`, { cache: 'no-store' });
    conn.lastError = r.ok
      ? 'The bridge is running but refused the connection (check the pairing token: "webgpt4cc pair" shows it).'
      : `The bridge answered HTTP ${r.status} at ${base}.`;
  } catch {
    conn.lastError = `Bridge not reachable at ${base}. Is "webgpt4cc serve" running?`;
  }
}

function scheduleReconnect() {
  if (!settings.enabled || conn.retryTimer) return;
  conn.retryTimer = setTimeout(() => {
    conn.retryTimer = null;
    connectBridge();
  }, conn.retryMs);
  conn.retryMs = Math.min(conn.retryMs * 2, RETRY_MAX_MS);
}

function reconnectBridge() {
  const ws = conn.ws;
  conn.ws = null;
  conn.authed = false;
  clearTimeout(conn.authTimer);
  clearInterval(conn.pingTimer);
  conn.pingTimer = null;
  if (ws) {
    try {
      ws.close(1000, 'settings changed');
    } catch {
      /* ignore */
    }
    onBridgeLost();
  }
  clearTimeout(conn.retryTimer);
  conn.retryTimer = null;
  conn.retryMs = RETRY_MIN_MS;
  conn.lastError = settings.rejectedBridgeUrl || '';
  setConnStatus('disconnected');
  connectBridge();
}

/** The bridge fails its own jobs when the socket drops; stop the tabs so they do not keep generating. */
function onBridgeLost() {
  for (const ctl of [...jobs.values()]) {
    const t = tabs.get(ctl.tabId);
    if (ctl.phase === 'running' && t && t.port) postToPort(t.port, { type: 'cancel', jobId: ctl.job.id, reason: 'bridge disconnected' });
    finishJob(ctl, jobError('aborted', 'bridge disconnected'), { notifyBridge: false });
  }
}

function onBridgeMessage(ws, msg) {
  if (!conn.authed) {
    // Before the bridge proved itself only the handshake is accepted: never a job.
    if (msg.type === 'welcome') void onWelcome(ws, msg);
    else if (msg.type === 'ping') sendRaw(ws, { type: 'pong', t: typeof msg.t === 'number' ? msg.t : Date.now() });
    return;
  }
  switch (msg.type) {
    case 'ping':
      sendToBridge({ type: 'pong', t: typeof msg.t === 'number' ? msg.t : Date.now() });
      break;
    case 'job':
      void startJob(msg.job);
      break;
    case 'cancel':
      cancelJob(String(msg.jobId || ''), 'cancelled by the bridge');
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function updateBadge(list = workerList()) {
  let text = 'off';
  let color = '#d93025'; // red: not connected
  if (conn.status === 'disabled') {
    text = '';
    color = '#9aa0a6';
  } else if (conn.status === 'connected') {
    text = 'on';
    color = list.some((w) => w.ready || w.busy) ? '#188038' : '#f9ab00'; // green / yellow (no ready worker)
  }
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Popup API
// ---------------------------------------------------------------------------

async function popupStatus(activeTabId) {
  await initDone;
  const workers = workerTabIds.map((tabId, i) => {
    const t = tabs.get(tabId);
    const a = t && t.agent;
    const ctl = tabJob(tabId);
    const url = (a && a.url) || (t && t.url) || '';
    return {
      tabId,
      label: `ChatGPT worker ${i + 1}`,
      title: (t && isChatGptUrl(url) && t.title) || '',
      url: isChatGptUrl(url) ? url : '',
      connected: !!(t && t.port),
      ready: !!(t && t.port && a && a.ready && !ctl && !t.frozen && !t.discarded && !tabStale(t)),
      busy: !!ctl,
      phase: ctl ? ctl.phase : null,
      frozen: !!(t && (t.frozen || t.discarded)),
      stale: !!(t && t.port && a && tabStale(t)),
      loginRequired: !!(a && a.loginRequired),
      cloudflare: !!(a && a.cloudflare),
      hidden: !!(a && a.hidden),
      generating: !!(a && a.generating),
      userTyping: !!(a && a.userTyping),
      composer: !!(a && a.composer),
      warning: a ? a.warning : null,
    };
  });
  let activeTab = null;
  if (Number.isInteger(activeTabId)) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      activeTab = {
        id: tab.id,
        url: isChatGptUrl(tab.url || '') ? tab.url : '',
        isChatGpt: isChatGptUrl(tab.url || ''),
        isWorker: isWorker(tab.id),
        connected: !!(tabs.get(tab.id) && tabs.get(tab.id).port),
      };
    } catch {
      activeTab = null;
    }
  }
  return {
    connection: conn.status,
    lastError: conn.lastError,
    bridgeVersion: conn.bridgeVersion,
    bridgeUrl: settings.bridgeUrl,
    enabled: settings.enabled,
    maxWorkers: settings.maxWorkers,
    extensionVersion: EXTENSION_VERSION,
    activeJobs: jobs.size,
    workers,
    activeTab,
  };
}

async function handlePopupMessage(msg) {
  await initDone;
  switch (msg.type) {
    case 'popup:status':
      return { ok: true, status: await popupStatus(msg.activeTabId) };
    case 'popup:openWorker':
      return { ok: true, tabId: await openWorkerTab() };
    case 'popup:useTab':
      await addWorker(Number(msg.tabId));
      return { ok: true };
    case 'popup:releaseTab':
      await releaseWorker(Number(msg.tabId));
      return { ok: true };
    case 'popup:focusTab': {
      const tab = await chrome.tabs.update(Number(msg.tabId), { active: true });
      if (tab && tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    case 'popup:reconnect':
      reconnectBridge();
      return { ok: true };
    default:
      return { ok: false, error: `unknown request ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages (popup) may use this API; content scripts have a chatgpt.com sender.url.
  if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('popup:')) return false;
  handlePopupMessage(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true; // async response
});

// ---------------------------------------------------------------------------
// Keep-alive + startup
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  initDone.then(() => {
    if (settings.enabled && !conn.ws) {
      conn.retryMs = RETRY_MIN_MS;
      connectBridge();
    }
  });
});

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function')
  chrome.runtime.onStartup.addListener(() => {
    initDone.then(() => readoptWorkers()).catch(() => {});
  });

const initDone = (async () => {
  // Settings (bridge URL, pairing token) are for extension pages and this worker only,
  // not for content scripts running inside chatgpt.com (where supported).
  try {
    if (chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function')
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    /* not supported for this storage area in this Chrome version */
  }
  try {
    await loadSettings();
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  if (settings.rejectedBridgeUrl) conn.lastError = settings.rejectedBridgeUrl;
  try {
    await loadWorkers();
  } catch {
    workerTabIds = [];
  }
  try {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  } catch {
    /* ignore */
  }
  updateBadge();
  connectBridge();
})();
// After a browser restart or an extension reload/update chrome.storage.session is empty.
initDone.then(() => readoptWorkers()).catch(() => {});

// Debug / test hook: lets automation (e.g. Playwright's serviceWorker.evaluate) drive
// the same operations as the popup without clicking through it.
globalThis.webgpt4cc = {
  status: (activeTabId) => popupStatus(activeTabId),
  addWorker: (tabId) => initDone.then(() => addWorker(tabId)),
  releaseWorker: (tabId) => initDone.then(() => releaseWorker(tabId)),
  openWorkerTab: () => initDone.then(() => openWorkerTab()),
  reconnect: () => reconnectBridge(),
};

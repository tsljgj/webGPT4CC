// webGPT4CC service worker.
//
//  * Owns the WebSocket to the local bridge (ws://127.0.0.1:<port>/extension?token=…):
//    reconnects with exponential backoff, answers pings and pings every 20 s
//    (WebSocket traffic keeps an MV3 service worker alive), and a 30 s
//    chrome.alarms tick re-establishes it after the worker was suspended.
//  * Keeps the worker-tab registry (chrome.storage.session, survives restarts of
//    the service worker) and announces it to the bridge.
//  * Orchestrates jobs: navigates the tab when needed, waits for the fresh page's
//    agent, sends it the run command, relays its events to the bridge. One job per tab.
//
// Wire protocol to the bridge: docs/PROTOCOL.md §2. Design: docs/EXTENSION.md.
'use strict';

const PROTOCOL_VERSION = 1;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const RELAY_PORT_NAME = 'webgpt4cc-relay';
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const DEFAULT_SETTINGS = Object.freeze({
  bridgeUrl: 'http://127.0.0.1:8765',
  token: '',
  enabled: true,
  maxWorkers: 3,
  debug: false,
});
const NAV_TIMEOUT_MS = 45_000;
const AGENT_WAIT_MS = 10_000;
const CANCEL_GRACE_MS = 5_000;
const PING_INTERVAL_MS = 20_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const ALARM_NAME = 'webgpt4cc-keepalive';
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
/** tabId -> { tabId, port, agent (last reported page state), url, title } for every chatgpt.com tab with a relay. */
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

const isWorker = (tabId) => workerTabIds.includes(tabId);
const tabJob = (tabId) => {
  for (const ctl of jobs.values()) if (ctl.tabId === tabId && !ctl.finished) return ctl;
  return null;
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (typeof raw.bridgeUrl === 'string' && raw.bridgeUrl.trim()) s.bridgeUrl = raw.bridgeUrl.trim().replace(/\/+$/, '');
  if (typeof raw.token === 'string') s.token = raw.token.trim();
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
  const mw = Number(raw.maxWorkers);
  if (Number.isFinite(mw) && mw >= 1) s.maxWorkers = Math.min(Math.floor(mw), 10);
  if (typeof raw.debug === 'boolean') s.debug = raw.debug;
  return s;
}

async function loadSettings() {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  settings = sanitizeSettings(raw);
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
}

function workerList() {
  return workerTabIds.map((tabId, i) => {
    const t = tabs.get(tabId);
    const a = t && t.agent;
    const busy = !!tabJob(tabId);
    const w = {
      id: String(tabId),
      url: (a && a.url) || (t && t.url) || '',
      ready: !!(t && t.port && a && a.ready && !busy),
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
  } else if (tab.status === 'complete') {
    // The page was loaded before the extension (re)started, so it has no content
    // scripts: reload it once if it does not connect on its own.
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
    t = { tabId, port: null, agent: null, url: sender.tab.url || '', title: sender.tab.title || '' };
    tabs.set(tabId, t);
  }
  t.port = port; // a newer page replaces the old page's port
  t.agent = null; // until the new page reports in
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
  t.port = null;
  t.agent = null;
  const ctl = tabJob(tabId);
  if (ctl && ctl.phase === 'running')
    finishJob(ctl, jobError('ui_error', 'the ChatGPT tab reloaded or navigated away while the reply was being generated'));
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
      t.agent = st;
      if (st.url) t.url = st.url;
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

/** Validate an agent event before it reaches the bridge. */
function cleanEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.type) {
    case 'status': {
      // "thinking" may carry the whole reasoning summary so far (streamed as a thinking block).
      const max = ev.status === 'thinking' ? 100_000 : 500;
      return { type: 'status', status: String(ev.status || ''), ...(ev.detail ? { detail: String(ev.detail).slice(0, max) } : {}) };
    }
    case 'text':
      return typeof ev.text === 'string' ? { type: 'text', text: ev.text } : null;
    case 'done': {
      if (typeof ev.text !== 'string') return null;
      const out = { type: 'done', text: ev.text, conversationId: typeof ev.conversationId === 'string' ? ev.conversationId : '' };
      if (typeof ev.messageId === 'string' && ev.messageId) out.messageId = ev.messageId;
      if (typeof ev.finishReason === 'string' && ev.finishReason) out.finishReason = ev.finishReason;
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

/** Decide whether the tab must navigate before typing. */
function planNavigation(job, t) {
  const a = t && t.agent;
  const cur = parseUrl((a && a.url) || (t && t.url) || '');
  const live = !!(t && t.port && a);
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

/** Resolve once pred(tab) holds (checked whenever the tab reports state); reject on timeout or job end. */
function waitForTab(ctl, pred, timeoutMs, timeoutMessage) {
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
    const timer = setTimeout(() => w.reject(new JobFailure('ui_error', timeoutMessage)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
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
  const ctl = { job, tabId, phase: 'starting', finished: false, waiters: new Set(), timeoutTimer: null, cancelTimer: null };
  if (raw.conversation && raw.conversation.kind === 'continue' && job.conversation.kind !== 'continue') {
    // Never turn a "continue" into a new chat silently: the prompt only holds the new turns.
    sendJobEvent(ctl, jobError('conversation_not_found', 'continue job without a conversation id'));
    return;
  }
  if (!isChatGptUrl(job.url)) {
    sendJobEvent(ctl, jobError('internal', `refusing to open a non-chatgpt.com URL: ${job.url}`));
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
    const plan = planNavigation(job, tabs.get(tabId));
    if (plan.error) {
      finishJob(ctl, plan.error);
      return;
    }
    let t;
    if (plan.navigate) {
      ctl.phase = 'navigating';
      sendJobEvent(ctl, { type: 'status', status: 'navigating', detail: job.url });
      const before = tabs.get(tabId);
      const oldPort = before ? before.port : null;
      const oldPageId = before && before.agent ? before.agent.pageId : null;
      await chrome.tabs.update(tabId, { url: job.url });
      // A real navigation means a new document: its relay opens a new port and its
      // agent reports a new pageId. Wait for that, never for the old page.
      t = await waitForTab(
        ctl,
        (x) => x.port && x.port !== oldPort && x.agent && x.agent.pageId !== oldPageId && isChatGptUrl(x.agent.url),
        NAV_TIMEOUT_MS,
        'the ChatGPT tab did not finish loading within 45 s',
      );
    } else {
      t = await waitForTab(ctl, (x) => x.port && x.agent, AGENT_WAIT_MS, 'the ChatGPT tab is not responding (reload it)');
    }
    if (ctl.finished) return;
    ctl.phase = 'running';
    if (!postToPort(t.port, { type: 'run', job })) throw new JobFailure('ui_error', 'lost contact with the ChatGPT tab');
  } catch (e) {
    if (!ctl.finished) finishJob(ctl, jobError(e && e.code ? e.code : 'internal', e && e.message ? e.message : String(e)));
  }
}

function cancelJob(jobId, reason) {
  const ctl = jobs.get(jobId);
  if (!ctl || ctl.finished) return;
  if (ctl.phase !== 'running') {
    finishJob(ctl, jobError('aborted', reason));
    return;
  }
  const t = tabs.get(ctl.tabId);
  if (t && postToPort(t.port, { type: 'cancel', jobId, reason })) {
    // The agent clicks "stop" and reports "aborted"; do not wait for it forever.
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

chrome.tabs.onUpdated.addListener((tabId, info) => {
  const t = tabs.get(tabId);
  if (!t) return;
  if (info.url) t.url = info.url;
  if (info.title) t.title = info.title;
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

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------

function bridgeWsUrl() {
  const u = parseUrl(settings.bridgeUrl);
  if (!u) return null;
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/extension`;
  u.search = '';
  u.hash = '';
  if (settings.token) u.searchParams.set('token', settings.token);
  return u.toString();
}

function sendToBridge(msg) {
  const ws = conn.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
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
    conn.lastError = `Invalid bridge URL "${settings.bridgeUrl}".`;
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
  setConnStatus('connecting');
  ws.onopen = () => {
    if (conn.ws !== ws) return;
    conn.retryMs = RETRY_MIN_MS;
    conn.lastError = '';
    conn.connectedAt = Date.now();
    setConnStatus('connected');
    sendToBridge({ type: 'hello', protocol: PROTOCOL_VERSION, extensionVersion: EXTENSION_VERSION, browser: browserString() });
    lastAnnounced = '';
    announceWorkers(true);
    clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => sendToBridge({ type: 'ping', t: Date.now() }), PING_INTERVAL_MS);
  };
  ws.onmessage = (ev) => {
    if (conn.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (msg && typeof msg === 'object') onBridgeMessage(msg);
  };
  ws.onclose = (ev) => {
    if (conn.ws !== ws) return;
    const wasOpen = conn.status === 'connected';
    conn.ws = null;
    clearInterval(conn.pingTimer);
    conn.pingTimer = null;
    setConnStatus('disconnected');
    onBridgeLost();
    if (wasOpen) conn.lastError = `Connection to the bridge closed${ev.reason ? `: ${ev.reason}` : ` (code ${ev.code})`}.`;
    else void diagnoseConnectFailure();
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

/** WebSocket errors carry no detail: ask /health to tell "not running" from "rejected". */
async function diagnoseConnectFailure() {
  const base = settings.bridgeUrl.replace(/^ws(s?):/, 'http$1:');
  try {
    const r = await fetch(`${base}/health`, { cache: 'no-store' });
    conn.lastError = r.ok
      ? 'The bridge is running but refused the connection: check the pairing token ("webgpt4cc pair" shows it).'
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
  conn.lastError = '';
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

function onBridgeMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      conn.bridgeVersion = typeof msg.bridgeVersion === 'string' ? msg.bridgeVersion : '';
      if (msg.protocol !== PROTOCOL_VERSION)
        conn.lastError = `The bridge speaks protocol ${msg.protocol}, the extension ${PROTOCOL_VERSION}: update both.`;
      break;
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
    return {
      tabId,
      label: `ChatGPT worker ${i + 1}`,
      title: (t && t.title) || '',
      url: (a && a.url) || (t && t.url) || '',
      connected: !!(t && t.port),
      ready: !!(t && t.port && a && a.ready && !ctl),
      busy: !!ctl,
      phase: ctl ? ctl.phase : null,
      loginRequired: !!(a && a.loginRequired),
      cloudflare: !!(a && a.cloudflare),
      hidden: !!(a && a.hidden),
      generating: !!(a && a.generating),
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
        url: tab.url || '',
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

const initDone = (async () => {
  try {
    await loadSettings();
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
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

// Debug / test hook: lets automation (e.g. Playwright's serviceWorker.evaluate) drive
// the same operations as the popup without clicking through it.
globalThis.webgpt4cc = {
  status: (activeTabId) => popupStatus(activeTabId),
  addWorker: (tabId) => initDone.then(() => addWorker(tabId)),
  releaseWorker: (tabId) => initDone.then(() => releaseWorker(tabId)),
  openWorkerTab: () => initDone.then(() => openWorkerTab()),
  reconnect: () => reconnectBridge(),
};

// webGPT4CC popup: bridge settings (chrome.storage.local), connection status and
// the worker-tab list. Everything else goes through the service worker
// ("popup:*" runtime messages, see background.js).
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765';
let activeTabId = null;
let lastStatus = null;

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false, error: 'the extension service worker did not answer' });
      });
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

function showError(text) {
  const el = $('actionError');
  el.textContent = text || '';
  el.hidden = !text;
}

async function loadSettings() {
  const s = await chrome.storage.local.get(['bridgeUrl', 'token', 'enabled', 'debug']);
  $('bridgeUrl').value = s.bridgeUrl || DEFAULT_BRIDGE_URL;
  $('token').value = s.token || '';
  $('enabled').checked = s.enabled !== false;
  $('debug').checked = s.debug === true;
}

async function saveSettings(ev) {
  ev.preventDefault();
  let url = $('bridgeUrl').value.trim() || DEFAULT_BRIDGE_URL;
  try {
    const u = new URL(url);
    if (!/^(https?|wss?):$/.test(u.protocol)) throw new Error('bad protocol');
    url = url.replace(/\/+$/, '');
  } catch {
    showError('The bridge URL must look like http://127.0.0.1:8765');
    return;
  }
  showError('');
  await chrome.storage.local.set({
    bridgeUrl: url,
    token: $('token').value.trim(),
    enabled: $('enabled').checked,
    debug: $('debug').checked,
  });
  const saved = $('saved');
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
  refresh();
}

function describeWorker(w) {
  if (!w.connected) return { cls: 'bad', text: 'page not connected (reload the tab)' };
  if (w.busy) return { cls: 'busy', text: w.phase === 'navigating' ? 'busy: opening the chat' : 'busy: answering' };
  if (w.cloudflare) return { cls: 'warn', text: 'Cloudflare check: open the tab and complete it' };
  if (w.loginRequired) return { cls: 'warn', text: 'not logged in: open the tab and log in' };
  if (w.warning) return { cls: 'warn', text: `ChatGPT: ${w.warning.text}` };
  if (w.generating) return { cls: 'warn', text: 'ChatGPT is still generating' };
  if (!w.composer) return { cls: 'warn', text: 'waiting for the ChatGPT page' };
  if (w.ready) return { cls: 'ok', text: w.hidden ? 'ready (background tab: keep it in its own window if replies stall)' : 'ready' };
  return { cls: '', text: 'not ready' };
}

function renderWorkers(status) {
  const ul = $('workers');
  ul.replaceChildren();
  for (const w of status.workers) {
    const d = describeWorker(w);
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${d.cls}`;
    const name = document.createElement('span');
    name.className = 'wname';
    name.textContent = w.title ? `${w.label}: ${w.title}` : w.label;
    name.title = w.url;
    const actions = document.createElement('span');
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'link';
    show.textContent = 'Show';
    show.addEventListener('click', () => send({ type: 'popup:focusTab', tabId: w.tabId }));
    const release = document.createElement('button');
    release.type = 'button';
    release.className = 'link';
    release.textContent = 'Release';
    release.addEventListener('click', async () => {
      const r = await send({ type: 'popup:releaseTab', tabId: w.tabId });
      showError(r.ok ? '' : r.error);
      refresh();
    });
    actions.append(show, release);
    const state = document.createElement('span');
    state.className = 'wstate';
    state.textContent = d.text;
    li.append(dot, name, actions, state);
    ul.append(li);
  }
  $('noWorkers').hidden = status.workers.length > 0;
}

function renderStatus(status) {
  const pill = $('connPill');
  const line = $('statusLine');
  const ready = status.workers.filter((w) => w.ready).length;
  const busy = status.workers.filter((w) => w.busy).length;
  pill.className = 'pill';
  if (status.connection === 'connected') {
    pill.textContent = 'connected';
    pill.classList.add(ready || busy ? 'ok' : 'warn');
    const parts = [`Connected to the bridge${status.bridgeVersion ? ` ${status.bridgeVersion}` : ''}.`];
    if (!status.workers.length) parts.push('Add a worker tab below.');
    else parts.push(`${ready} worker(s) ready${busy ? `, ${busy} busy` : ''}.`);
    if (status.lastError) parts.push(status.lastError);
    line.textContent = parts.join(' ');
  } else if (status.connection === 'disabled') {
    pill.textContent = 'off';
    line.textContent = 'Not connecting (enable "Connect to the bridge" below).';
  } else {
    pill.textContent = status.connection === 'connecting' ? 'connecting' : 'disconnected';
    pill.classList.add('bad');
    line.textContent = status.lastError || `Connecting to ${status.bridgeUrl}…`;
  }

  const atMax = status.workers.length >= status.maxWorkers;
  $('openWorker').disabled = atMax;
  $('openWorker').title = atMax ? `At most ${status.maxWorkers} worker tabs` : 'Open a pinned chatgpt.com tab and use it as a worker';

  const toggle = $('toggleTab');
  const at = status.activeTab;
  if (at && at.isWorker) {
    toggle.textContent = 'Release tab';
    toggle.disabled = false;
  } else {
    toggle.textContent = 'Use this tab as a worker';
    toggle.disabled = !(at && at.isChatGpt) || atMax;
    toggle.title = at && at.isChatGpt ? '' : 'Switch to a chatgpt.com tab first';
  }
  $('footer').textContent = `v${status.extensionVersion}`;
}

async function refresh() {
  const res = await send({ type: 'popup:status', activeTabId });
  if (!res.ok) {
    $('statusLine').textContent = res.error || 'no status';
    return;
  }
  lastStatus = res.status;
  renderStatus(res.status);
  renderWorkers(res.status);
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = tab ? tab.id : null;
  } catch {
    activeTabId = null;
  }
  await loadSettings();
  $('settingsForm').addEventListener('submit', saveSettings);
  $('reconnect').addEventListener('click', async () => {
    await send({ type: 'popup:reconnect' });
    refresh();
  });
  $('openWorker').addEventListener('click', async () => {
    const r = await send({ type: 'popup:openWorker' });
    showError(r.ok ? '' : r.error);
    refresh();
  });
  $('toggleTab').addEventListener('click', async () => {
    const at = lastStatus && lastStatus.activeTab;
    if (!at) return;
    const r = await send({ type: at.isWorker ? 'popup:releaseTab' : 'popup:useTab', tabId: at.id });
    showError(r.ok ? '' : r.error);
    refresh();
  });
  await refresh();
  setInterval(refresh, 1000);
}

init();

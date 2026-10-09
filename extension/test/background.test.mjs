// Tests for extension/background.js (the service worker), loaded into a node:vm
// context with a mocked chrome.* API, Node's WebSocket client and a scripted
// bridge (a ws server). Covers the pairing handshake, the bridge-URL and job-URL
// policies, worker-tab lifecycle (reloads, cancels during navigation, frozen
// tabs, re-adoption after a browser restart) and what is announced to the bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';

const SOURCE = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const TOKEN = 'pairing-secret';
const PROTOCOL = Number(/const PROTOCOL_VERSION = (\d+)/.exec(SOURCE)[1]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (token, text) => createHmac('sha256', `webgpt4cc/pairing/v2/${token}`).update(text).digest('hex');

async function until(what, fn, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

/**
 * A scripted bridge. mode: 'good' (real handshake), 'squat' (never answers the
 * hello), 'badproof' (answers with a wrong proof).
 */
async function startBridge(mode = 'good', token = TOKEN) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const b = { wss, url: `http://127.0.0.1:${wss.address().port}`, received: [], requestUrls: [], sock: null, authed: false };
  wss.on('connection', (ws, req) => {
    b.sock = ws;
    b.requestUrls.push(req.url);
    let nonceB = '';
    let nonceE = '';
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      b.received.push(m);
      if (m.type === 'hello' && mode !== 'squat') {
        nonceE = m.nonce;
        nonceB = randomBytes(16).toString('hex');
        const proof = mode === 'badproof' ? hmac('wrong', `bridge|${nonceE}|${nonceB}`) : hmac(token, `bridge|${nonceE}|${nonceB}`);
        ws.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL, bridgeVersion: 'test', nonce: nonceB, proof }));
      }
      if (m.type === 'auth') b.authed = m.proof === hmac(token, `extension|${nonceB}|${nonceE}`);
    });
  });
  b.send = (msg) => b.sock.send(JSON.stringify(msg));
  b.of = (type) => b.received.filter((m) => m.type === type);
  b.close = () => {
    for (const c of wss.clients) c.terminate();
    return new Promise((r) => wss.close(r));
  };
  return b;
}

/** Load background.js with a mocked chrome API. */
function loadBackground({ local = {}, session = {}, tabs = [] } = {}) {
  const listeners = {};
  const ev = (name) => {
    listeners[name] = [];
    return { addListener: (f) => listeners[name].push(f) };
  };
  const fire = (name, ...a) => (listeners[name] || []).forEach((f) => f(...a));
  const store = { local: { ...local }, session: { ...session } };
  const pick = (obj, keys) => {
    if (keys == null) return { ...obj };
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list.filter((k) => k in obj).map((k) => [k, obj[k]]));
  };
  const tabMap = new Map(tabs.map((t) => [t.id, { status: 'complete', windowId: 1, pinned: false, ...t }]));
  const calls = { update: [], reload: [] };
  const handles = { timeouts: new Set(), intervals: new Set() };
  const clock = { offset: 0 };
  class MockDate extends Date {
    static now() {
      return Date.now() + clock.offset;
    }
  }
  const chrome = {
    runtime: {
      id: 'ext',
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (p) => `chrome-extension://ext/${p}`,
      onConnect: ev('onConnect'),
      onMessage: ev('onMessage'),
      onStartup: ev('onStartup'),
    },
    storage: {
      local: {
        get: async (keys) => pick(store.local, keys),
        set: async (o) => {
          const changes = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { oldValue: store.local[k], newValue: v }]));
          Object.assign(store.local, o);
          fire('storage.onChanged', changes, 'local');
        },
        setAccessLevel: async () => {},
      },
      session: { get: async (keys) => pick(store.session, keys), set: async (o) => Object.assign(store.session, o) },
      onChanged: ev('storage.onChanged'),
    },
    tabs: {
      get: async (id) => {
        const t = tabMap.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      update: async (id, props) => {
        calls.update.push({ id, props });
        const t = tabMap.get(id);
        if (props.url) t.pendingUrl = props.url;
        return { ...t };
      },
      reload: async (id) => calls.reload.push(id),
      create: async (p) => {
        const id = 1000 + tabMap.size;
        tabMap.set(id, { id, status: 'loading', windowId: 1, ...p });
        return { id, ...p };
      },
      query: async (q) => [...tabMap.values()].filter((t) => !q.url || String(t.url || '').startsWith(q.url.replace(/\*$/, ''))).map((t) => ({ ...t })),
      onRemoved: ev('tabs.onRemoved'),
      onUpdated: ev('tabs.onUpdated'),
      onReplaced: ev('tabs.onReplaced'),
    },
    windows: { update: async () => {} },
    alarms: { get: async () => null, create: async () => {}, onAlarm: ev('alarms.onAlarm') },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  };
  const context = vm.createContext({
    chrome,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0' },
    WebSocket,
    URL,
    TextEncoder,
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error('offline');
    },
    setTimeout: (fn, ms, ...a) => {
      const id = setTimeout(() => {
        handles.timeouts.delete(id);
        fn(...a);
      }, ms);
      handles.timeouts.add(id);
      return id;
    },
    clearTimeout: (id) => {
      handles.timeouts.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      handles.intervals.add({ id, fn, ms });
      return id;
    },
    clearInterval: (id) => {
      for (const h of handles.intervals) if (h.id === id) handles.intervals.delete(h);
      clearInterval(id);
    },
    console,
    Promise,
    Date: MockDate,
  });
  context.globalThis = context;
  vm.runInContext(SOURCE, context, { filename: 'background.js' });

  const ports = [];
  const sw = {
    api: context.webgpt4cc,
    store,
    tabMap,
    calls,
    clock,
    fire,
    /** A chatgpt.com page (relay port) in tab `tabId`. */
    page(tabId, url, state = {}) {
      const port = {
        name: 'webgpt4cc-relay',
        sender: { tab: { id: tabId, url, title: 'ChatGPT' }, frameId: 0, url },
        msgs: [],
        ml: [],
        dl: [],
        postMessage: (m) => port.msgs.push(m),
        onMessage: { addListener: (f) => port.ml.push(f) },
        onDisconnect: { addListener: (f) => port.dl.push(f) },
        disconnect() {},
        say: (m) => port.ml.forEach((f) => f(m)),
        state: (s) => port.say({ type: 'state', state: { pageId: port.pageId, url, title: 'ChatGPT', composer: true, ready: true, emptyChat: true, ...s } }),
        event: (jobId, e) => port.say({ type: 'event', jobId, event: e }),
        gone: () => port.dl.forEach((f) => f()),
        runs: () => port.msgs.filter((m) => m.type === 'run'),
        pageId: `p${ports.length + 1}`,
      };
      ports.push(port);
      const t = tabMap.get(tabId);
      if (t) {
        t.url = url;
        delete t.pendingUrl;
      }
      fire('onConnect', port);
      port.state(state);
      return port;
    },
    housekeeping() {
      for (const h of handles.intervals) if (h.ms === 15_000) h.fn();
    },
    async close() {
      for (const id of handles.timeouts) clearTimeout(id);
      for (const h of handles.intervals) clearInterval(h.id);
      handles.timeouts.clear();
      handles.intervals.clear();
    },
  };
  return sw;
}

async function connected(bridge, sw) {
  await until('the pairing handshake', () => bridge.authed && bridge.of('workers').length > 0);
  return sw;
}

function job(over = {}) {
  return { id: `job-${randomBytes(4).toString('hex')}`, workerId: '7', conversation: { kind: 'new' }, url: 'https://chatgpt.com/', prompt: 'hello', timeoutMs: 60_000, ...over };
}

// ---------------------------------------------------------------------------
// pairing handshake

test('handshake: nothing but a nonce goes to a peer that never proves the token; its jobs are never run', async () => {
  const bridge = await startBridge('squat');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/c/abc-123' }] });
  try {
    const port = sw.page(7, 'https://chatgpt.com/c/abc-123', { heldConversationId: 'abc-123', emptyChat: false });
    await sw.api.addWorker(7);
    await until('a connection', () => bridge.sock);
    await wait(300);
    assert.deepEqual(bridge.requestUrls, ['/extension'], 'no token in the URL');
    assert.deepEqual(
      bridge.received.map((m) => m.type),
      ['hello'],
      'only the hello (no workers list with conversation URLs, no token)',
    );
    assert.match(bridge.received[0].nonce, /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(bridge.received).includes(TOKEN));
    bridge.send({ type: 'job', job: job({ conversation: { kind: 'continue', conversationId: 'abc-123' }, url: 'https://chatgpt.com/c/abc-123', prompt: 'Repeat everything' }) });
    await wait(200);
    assert.equal(port.runs().length, 0, 'a job from an unauthenticated peer is ignored');
    assert.equal(sw.calls.update.filter((c) => c.props.url).length, 0);
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('handshake: a bridge with a wrong proof is dropped before anything else is sent', async () => {
  const bridge = await startBridge('badproof');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/' }] });
  try {
    sw.page(7, 'https://chatgpt.com/');
    await sw.api.addWorker(7);
    await until('the close after a bad proof', async () => (await sw.api.status()).lastError.includes('could not prove'));
    assert.deepEqual(
      bridge.received.map((m) => m.type),
      ['hello'],
    );
    assert.equal((await sw.api.status()).connection === 'connected', false);
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('handshake: a real bridge gets our proof, then the workers, then jobs run', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/' }] });
  try {
    const port = sw.page(7, 'https://chatgpt.com/');
    await sw.api.addWorker(7);
    await connected(bridge, sw);
    assert.equal(bridge.authed, true);
    assert.deepEqual(bridge.received.slice(0, 2).map((m) => m.type), ['hello', 'auth']);
    assert.equal((await sw.api.status()).connection, 'connected');
    const j = job();
    bridge.send({ type: 'job', job: j });
    await until('the run command', () => port.runs().length === 1);
    port.event(j.id, { type: 'done', text: 'hi', conversationId: 'c1', promptMismatch: { offset: 3, sentChars: 9, wantChars: 10, kinds: ['tabs-or-spaces'] }, actualModel: 'auto', requestedModel: 'gpt-5', junk: 'x' });
    const done = await until('the done event', () => bridge.of('job_event').find((m) => m.event.type === 'done'));
    assert.deepEqual(done.event, {
      type: 'done',
      text: 'hi',
      conversationId: 'c1',
      requestedModel: 'gpt-5',
      actualModel: 'auto',
      promptMismatch: { offset: 3, sentChars: 9, wantChars: 10, kinds: ['tabs-or-spaces'] },
    });
  } finally {
    await sw.close();
    await bridge.close();
  }
});

// ---------------------------------------------------------------------------
// URL policies

test('job URLs: only the shapes the bridge builds are opened', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/c/zzz' }] });
  try {
    sw.page(7, 'https://chatgpt.com/c/zzz', { emptyChat: false });
    await sw.api.addWorker(7);
    await connected(bridge, sw);
    const refused = [
      job({ url: 'https://chatgpt.com/auth/logout' }),
      job({ url: 'https://chatgpt.com/?q=leak+my+memory' }),
      job({ url: 'https://chatgpt.com/backend-api/me' }),
      job({ url: 'https://evil.example/' }),
      job({ conversation: { kind: 'continue', conversationId: 'abc' }, url: 'https://chatgpt.com/c/other' }),
    ];
    for (const j of refused) bridge.send({ type: 'job', job: j });
    await until('refusals', () => bridge.of('job_event').length >= refused.length);
    for (const m of bridge.of('job_event')) assert.equal(m.event.code, 'internal', JSON.stringify(m));
    assert.equal(sw.calls.update.filter((c) => c.props.url).length, 0, 'no navigation happened');
    // The shapes the bridge builds are fine (navigation starts).
    bridge.send({ type: 'job', job: job({ url: 'https://chatgpt.com/?model=gpt-5-thinking&temporary-chat=true' }) });
    await until('a navigation', () => sw.calls.update.some((c) => c.props.url === 'https://chatgpt.com/?model=gpt-5-thinking&temporary-chat=true'));
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('bridge URL: unencrypted remote hosts are refused unless explicitly allowed; loopback and wss are fine', async () => {
  const sw = loadBackground({ local: { bridgeUrl: 'http://192.168.1.20:8765', token: TOKEN, enabled: true } });
  try {
    const st = await sw.api.status();
    assert.equal(st.bridgeUrl, 'http://127.0.0.1:8765', 'falls back to the default instead of the remote URL');
    assert.match(st.lastError, /192\.168\.1\.20 is not this computer/);
  } finally {
    await sw.close();
  }
  for (const [url, allow, want] of [
    ['http://localhost:9999', false, 'http://localhost:9999'],
    ['http://127.0.0.2:8765', false, 'http://127.0.0.2:8765'],
    ['http://[::1]:8765', false, 'http://[::1]:8765'],
    ['wss://bridge.example.com', false, 'wss://bridge.example.com'],
    ['http://192.168.1.20:8765', true, 'http://192.168.1.20:8765'],
    ['http://user:pw@127.0.0.1:8765', true, 'http://127.0.0.1:8765'],
    ['ftp://127.0.0.1', false, 'http://127.0.0.1:8765'],
  ]) {
    const s = loadBackground({ local: { bridgeUrl: url, allowRemoteBridge: allow, enabled: false } });
    try {
      assert.equal((await s.api.status()).bridgeUrl, want, url);
    } finally {
      await s.close();
    }
  }
});

test('a storage write of a remote bridge URL keeps the previous loopback bridge', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/' }] });
  try {
    sw.page(7, 'https://chatgpt.com/');
    await sw.api.addWorker(7);
    await connected(bridge, sw);
    // What a compromised chatgpt.com renderer could do with chrome.storage.local.
    sw.store.local.bridgeUrl = 'ws://evil.example:80';
    sw.fire('storage.onChanged', { bridgeUrl: { newValue: 'ws://evil.example:80' } }, 'local');
    await wait(200);
    const st = await sw.api.status();
    assert.equal(st.bridgeUrl, bridge.url);
    assert.equal(st.connection, 'connected', 'no reconnect to the refused URL');
    assert.match(st.lastError, /evil\.example is not this computer/);
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('a worker tab that leaves chatgpt.com is announced without a URL', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/c/abc' }] });
  try {
    const port = sw.page(7, 'https://chatgpt.com/c/abc', { emptyChat: false });
    await sw.api.addWorker(7);
    await connected(bridge, sw);
    // Without the "tabs" permission Chrome reveals no URL for other sites.
    sw.tabMap.get(7).url = undefined;
    sw.fire('tabs.onUpdated', 7, { status: 'loading' }, { id: 7, status: 'loading' });
    port.gone();
    await wait(100);
    const last = bridge.of('workers').at(-1);
    assert.equal(last.workers[0].url, '');
    assert.ok(!JSON.stringify(bridge.received).includes('app.example'));
  } finally {
    await sw.close();
    await bridge.close();
  }
});

// ---------------------------------------------------------------------------
// lifecycle

test('a reload before the prompt was sent re-runs the job in the new page; after "sending" it fails', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/' }] });
  try {
    const p1 = sw.page(7, 'https://chatgpt.com/');
    await sw.api.addWorker(7);
    await connected(bridge, sw);
    const j = job();
    bridge.send({ type: 'job', job: j });
    await until('run in page 1', () => p1.runs().length === 1);
    p1.event(j.id, { type: 'status', status: 'typing' });
    // e.g. a Cloudflare check that reloads itself: nothing was sent yet.
    p1.gone();
    await wait(50);
    assert.equal(bridge.of('job_event').some((m) => m.event.type === 'error'), false);
    const p2 = sw.page(7, 'https://chatgpt.com/');
    await until('run in page 2', () => p2.runs().length === 1);
    p2.event(j.id, { type: 'status', status: 'sending' });
    p2.gone();
    const err = await until('the error', () => bridge.of('job_event').find((m) => m.event.type === 'error'));
    assert.equal(err.event.code, 'ui_error');
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('the run command waits for the navigated page to show a composer (never an interstitial)', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/c/old' }] });
  try {
    sw.page(7, 'https://chatgpt.com/c/old', { emptyChat: false });
    await sw.api.addWorker(7);
    await connected(bridge, sw);
    const j = job({ url: 'https://chatgpt.com/' });
    bridge.send({ type: 'job', job: j });
    await until('the navigation', () => sw.calls.update.some((c) => c.props.url === 'https://chatgpt.com/'));
    const challenge = sw.page(7, 'https://chatgpt.com/', { composer: false, ready: false, cloudflare: true, title: 'Just a moment...' });
    await wait(300);
    assert.equal(challenge.runs().length, 0, 'no run into the challenge page');
    const real = sw.page(7, 'https://chatgpt.com/');
    await until('run in the real page', () => real.runs().length === 1);
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('a job cancelled while navigating keeps the tab reserved until the new page took over', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/c/X' }] });
  try {
    sw.page(7, 'https://chatgpt.com/c/X', { emptyChat: false });
    await sw.api.addWorker(7);
    await connected(bridge, sw);
    const a = job({ conversation: { kind: 'continue', conversationId: 'Y' }, url: 'https://chatgpt.com/c/Y' });
    bridge.send({ type: 'job', job: a });
    await until('the navigation to Y', () => sw.calls.update.some((c) => c.props.url === 'https://chatgpt.com/c/Y'));
    bridge.send({ type: 'cancel', jobId: a.id });
    await wait(200);
    assert.equal(bridge.of('job_event').some((m) => m.jobId === a.id && m.event.type === 'error'), false, 'not released while /c/Y is still loading');
    assert.equal((await sw.api.status()).workers[0].busy, true);
    // A job for X now would land in the old document: planNavigation also treats a pending navigation as "not live".
    sw.page(7, 'https://chatgpt.com/c/Y', { emptyChat: false });
    const err = await until('aborted after the new page reported', () => bridge.of('job_event').find((m) => m.jobId === a.id && m.event.type === 'error'));
    assert.equal(err.event.code, 'aborted');
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('a frozen or silent worker tab is not ready, and its running job fails instead of hanging', async () => {
  const bridge = await startBridge('good');
  const sw = loadBackground({ local: { bridgeUrl: bridge.url, token: TOKEN }, tabs: [{ id: 7, url: 'https://chatgpt.com/' }, { id: 8, url: 'https://chatgpt.com/' }] });
  try {
    const p7 = sw.page(7, 'https://chatgpt.com/');
    const p8 = sw.page(8, 'https://chatgpt.com/');
    await sw.api.addWorker(7);
    await sw.api.addWorker(8);
    await connected(bridge, sw);
    // Chrome 132+: tabs.onUpdated reports frozen.
    const j = job();
    bridge.send({ type: 'job', job: j });
    await until('run', () => p7.runs().length === 1);
    p7.event(j.id, { type: 'status', status: 'submitted' });
    sw.fire('tabs.onUpdated', 7, { frozen: true }, { id: 7 });
    const err = await until('the error', () => bridge.of('job_event').find((m) => m.jobId === j.id && m.event.type === 'error'));
    assert.match(err.event.message, /froze/);
    assert.equal((await sw.api.status()).workers[0].ready, false);
    // Any Chrome version: no heartbeat for 75 s.
    const j2 = job({ workerId: '8' });
    bridge.send({ type: 'job', job: j2 });
    await until('run', () => p8.runs().length === 1);
    sw.clock.offset = 80_000;
    sw.housekeeping();
    const err2 = await until('the stale error', () => bridge.of('job_event').find((m) => m.jobId === j2.id && m.event.type === 'error'));
    assert.match(err2.event.message, /stopped responding/);
    assert.equal(bridge.of('workers').at(-1).workers[1].ready, false);
    p8.state({}); // the tab is back
    await wait(50);
    assert.equal(bridge.of('workers').at(-1).workers[1].ready, true);
  } finally {
    await sw.close();
    await bridge.close();
  }
});

test('pinned worker tabs are adopted again after a browser restart', async () => {
  const sw = loadBackground({
    local: { enabled: false, workerIntent: { workers: [{ pinned: true, url: 'https://chatgpt.com/c/old-id' }] } },
    tabs: [
      { id: 21, url: 'https://chatgpt.com/', pinned: false },
      { id: 22, url: 'https://chatgpt.com/c/new-id', pinned: true },
      { id: 23, url: 'https://example.com/', pinned: true },
    ],
  });
  try {
    await until('re-adoption', async () => (await sw.api.status()).workers.length === 1);
    assert.equal((await sw.api.status()).workers[0].tabId, 22);
  } finally {
    await sw.close();
  }
  // An unpinned worker ("Use this tab") is only adopted at exactly the same URL.
  const sw2 = loadBackground({
    local: { enabled: false, workerIntent: { workers: [{ pinned: false, url: 'https://chatgpt.com/c/mine' }] } },
    tabs: [
      { id: 31, url: 'https://chatgpt.com/c/users-own-chat', pinned: false },
      { id: 32, url: 'https://chatgpt.com/c/mine', pinned: false },
    ],
  });
  try {
    await until('re-adoption', async () => (await sw2.api.status()).workers.length === 1);
    assert.equal((await sw2.api.status()).workers[0].tabId, 32);
  } finally {
    await sw2.close();
  }
});

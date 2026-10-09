// webGPT4CC relay: ISOLATED world, document_start.
//
// Forwards messages between the page agent (MAIN world, window.postMessage) and
// the service worker (a chrome.runtime port named "webgpt4cc-relay").
//
//  * Only messages posted by this very window (event.source === window, same
//    origin) carrying our channel tag and direction are accepted.
//  * The port is re-opened with backoff whenever it drops: MV3 service workers
//    are stopped when idle and every restart disconnects all ports. Opening the
//    port wakes the worker up again.
//  * Agent -> worker messages are limited to the types the worker understands.
(() => {
  'use strict';

  const CHANNEL = 'webgpt4cc:page-relay:v1'; // shared with content/page-agent.js
  const PORT_NAME = 'webgpt4cc-relay';
  const FROM_AGENT = new Set(['state', 'event', 'log']);
  const MAX_QUEUE = 200;

  let port = null;
  let retryMs = 100;
  let retryTimer = null;
  let dead = false;
  /** Agent messages that arrived while the port was down (job events matter; logs are dropped). */
  const queue = [];

  function toAgent(msg) {
    try {
      window.postMessage({ channel: CHANNEL, dir: 'to-agent', msg }, location.origin);
    } catch {
      /* ignore */
    }
  }

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function scheduleReconnect() {
    if (dead || retryTimer) return;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  }

  function connect() {
    retryTimer = null;
    if (dead) return;
    if (!extensionAlive()) {
      // The extension was reloaded or removed: this content script is orphaned.
      dead = true;
      toAgent({ type: 'detached' });
      return;
    }
    let p;
    try {
      p = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      scheduleReconnect();
      return;
    }
    port = p;
    p.onMessage.addListener((msg) => {
      if (msg && typeof msg === 'object' && typeof msg.type === 'string') toAgent(msg);
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read it so Chrome does not log "Unchecked runtime.lastError"
      if (port === p) port = null;
      scheduleReconnect();
    });
    retryMs = 100;
    while (queue.length && port === p) send(queue.shift());
    toAgent({ type: 'relay-hello' }); // ask the agent to (re)send its state
  }

  function send(msg) {
    if (port) {
      try {
        port.postMessage(msg);
        return;
      } catch {
        port = null;
        scheduleReconnect();
      }
    }
    if (msg.type !== 'log') {
      queue.push(msg);
      if (queue.length > MAX_QUEUE) queue.shift();
    }
  }

  window.addEventListener(
    'message',
    (ev) => {
      if (ev.source !== window || ev.origin !== location.origin) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || d.channel !== CHANNEL || d.dir !== 'to-relay') return;
      const msg = d.msg;
      if (!msg || typeof msg !== 'object' || !FROM_AGENT.has(msg.type)) return;
      send(msg);
    },
    true,
  );

  // A page restored from the back/forward cache had its port closed; reconnect.
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted && !port) {
      retryMs = 100;
      scheduleReconnect();
    }
  });

  connect();
})();

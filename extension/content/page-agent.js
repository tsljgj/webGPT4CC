// webGPT4CC page agent: MAIN world, document_start, loaded after content/stream-core.js.
//
// It runs inside chatgpt.com's own JavaScript world because only there can it
// see the page's fetch() and WebSocket traffic. It:
//  * observes the network in "observe mode": the native call always runs first
//    and its result is handed back untouched; for the conversation stream we
//    only look at the chunks the page itself reads (never clone or tee it);
//  * runs one job at a time: pastes the prompt into the composer, verifies it,
//    clicks send, and reports the raw markdown answer (reduced from the
//    delta_encoding v1 stream) as status / text / done / error events;
//  * in worker tabs, reports page state (composer found, generating, login...).
//
// It never creates auth, Sentinel, proof-of-work or Turnstile tokens: ChatGPT's
// own code sends every request. Every hook is wrapped in try/catch and returns
// the native result, so a bug here must never break ChatGPT.
//
// Messages go to content/relay.js (ISOLATED world) through window.postMessage,
// tagged with CHANNEL and a direction; relay.js talks to the service worker.
//
// Prior art (both MIT): the chunked synthetic-paste insertion, its verification
// and the selector chains follow steipete/oracle ((c) 2026 Peter Steinberger);
// the observe-mode fetch/WebSocket capture follows UnlastingR/sse-devtools-panel
// ((c) 2026 FatMii). The code is an independent implementation.
(() => {
  'use strict';

  const AGENT_FLAG = '__webgpt4ccPageAgent';
  if (window[AGENT_FLAG]) return;
  try {
    Object.defineProperty(window, AGENT_FLAG, { value: true });
  } catch {
    return;
  }

  const Core = globalThis.WebGPT4CC_Core;
  if (!Core) {
    console.warn('[webGPT4CC] content/stream-core.js did not load; the page agent is disabled');
    return;
  }

  /** Tag shared with content/relay.js. */
  const CHANNEL = 'webgpt4cc:page-relay:v1';

  // ---------------------------------------------------------------------------
  // Selectors: every entry is a fallback chain, most specific first.
  // ChatGPT shipped a new DOM on 2026-09-25 and rolls changes out in stages, so
  // old and new shapes coexist. When ChatGPT changes, update this object (and the
  // fake page in test/e2e/) together.
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    composer: [
      'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
      '#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea',
      '.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[name="prompt-textarea"]',
      '#mobile-composer-prompt',
    ],
    send: [
      'button[data-testid="send-button"]',
      '#composer-submit-button[data-testid="send-button"]',
      'button[data-testid*="composer-send"]',
      '[data-composer-submit]',
      'form button[type="submit"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send" i]',
    ],
    stop: [
      '[data-testid="stop-button"]',
      '[data-testid="composer-stop-button"]',
      'form button[aria-label="Stop"]',
      'form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])',
    ],
    pastedTextChip: ['form button[aria-label^="Remove Pasted text"]'],
    composerModeButtons: [
      '[role="group"][aria-label="Composer mode"] button',
      '[role="group"][aria-label="Composer mode"] [role="radio"]',
    ],
    loginCta: [
      'a[href*="/auth/login"]',
      'a[href*="/auth/signin"]',
      'button[data-testid*="login"]',
      'button[data-testid*="log-in"]',
    ],
    warnings: [
      '[role="alert"]',
      '[role="status"]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-live]',
      '[data-testid*="toast" i]',
      '[data-testid*="banner" i]',
      '[class*="text-error"]',
      'div.toast-root',
    ],
    turn: [
      '[data-turn-key]',
      'article[data-testid^="conversation-turn"]',
      '[data-message-author-role]',
      '[data-content-search-unit-key]',
      '[data-chatgpt-search-unit-key]',
      '[data-turn]',
    ],
    assistantMessage: [
      '[data-message-author-role="assistant"]',
      '[data-content-search-unit-key$=":assistant"]',
      '[data-chatgpt-search-unit-key$=":assistant"]',
      '[data-turn="assistant"]',
    ],
    cloudflare: ['script[src*="/challenge-platform/"]', '#challenge-form', '#cf-challenge-running'],
  };

  const TEXT = {
    /** Whole-text labels of login / sign-up buttons and links. */
    loginLabels: ['log in', 'login', 'sign in', 'sign up', 'sign up for free'],
    notFound:
      /conversation not found|unable to load conversation|couldn[’']t (?:find|load) (?:this |the )?conversation|this conversation (?:doesn[’']t|does not) exist/i,
    loginWarning: /session (?:has )?expired|log ?in again|please (?:log|sign) in|logged out|\blog ?in\b|\bsign in\b/i,
  };

  const PASTE_CHUNK = 4000; // ChatGPT turns single pastes above ~10k chars into a "Pasted text" file
  const TEXT_INTERVAL_MS = 250;
  const MAX_THINKING_CHARS = 100_000;
  const COMPOSER_WAIT_MS = 30_000;
  const REQUEST_WAIT_MS = 20_000;
  const COMPOSER_STABLE_MS = 600;

  // ---------------------------------------------------------------------------
  // Natives, captured before ChatGPT's scripts run
  // ---------------------------------------------------------------------------
  const nativeFetch = window.fetch;
  const NativeWebSocket = window.WebSocket;
  const NativeReadableStream = window.ReadableStream;
  const nativeGetReader = NativeReadableStream && NativeReadableStream.prototype.getReader;
  const nativePostMessage = window.postMessage;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const NativeMutationObserver = window.MutationObserver;

  const pageId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const config = { worker: false, debug: false };
  let relayAlive = true;
  /** The running job context, or null. */
  let job = null;
  /** True once a job sent a message from this page (so it is no longer a fresh chat). */
  let pageHadJob = false;
  /** Conversation this page holds from our last finished job: {id, path, search}. */
  let held = null;
  let turnsEverSeen = false;
  let bugReports = 0;

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  // Hidden tabs throttle chained timers hard ("intensive wake-up throttling" can
  // delay them to once a minute). Resolving every wait through a MessageChannel
  // task resets the timer nesting level, so each wait starts an unchained timer.
  const hop = (() => {
    try {
      const ch = new MessageChannel();
      const queue = [];
      ch.port1.onmessage = () => {
        const fn = queue.shift();
        if (fn) fn();
      };
      return (fn) => {
        queue.push(fn);
        ch.port2.postMessage(0);
      };
    } catch {
      return (fn) => Promise.resolve().then(fn);
    }
  })();

  const sleep = (ms) => new Promise((resolve) => nativeSetTimeout(() => hop(resolve), ms));

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      reportBug('callback', e);
      return undefined;
    }
  }

  function defineValue(obj, key, value) {
    Object.defineProperty(obj, key, { value, configurable: true, writable: true });
  }

  function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  }

  class JobError extends Error {
    constructor(code, message, retryAfterMs) {
      super(message);
      this.code = code;
      this.retryAfterMs = retryAfterMs;
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging with the relay
  // ---------------------------------------------------------------------------

  function post(msg) {
    if (!relayAlive) return;
    try {
      nativePostMessage.call(window, { channel: CHANNEL, dir: 'to-relay', msg }, location.origin);
    } catch {
      /* ignore (e.g. uncloneable data) */
    }
  }

  function log(level, message, data) {
    if (level === 'debug' && !config.debug) return;
    post({ type: 'log', level, message: String(message), ...(data !== undefined ? { data } : {}) });
  }

  function reportBug(where, e) {
    if (bugReports++ > 20) return;
    try {
      log('warn', `page agent bug (${where}): ${e && e.message ? e.message : String(e)}`);
    } catch {
      /* ignore */
    }
  }

  window.addEventListener(
    'message',
    (ev) => {
      if (ev.source !== window || ev.origin !== location.origin) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || d.channel !== CHANNEL || d.dir !== 'to-agent') return;
      const msg = d.msg;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      try {
        handleCommand(msg);
      } catch (e) {
        reportBug(`command ${msg.type}`, e);
      }
    },
    true,
  );

  function handleCommand(msg) {
    switch (msg.type) {
      case 'relay-hello':
      case 'sync':
        sendState(true);
        break;
      case 'config':
        config.worker = !!msg.worker;
        config.debug = !!msg.debug;
        if (config.worker) startMonitor();
        else stopMonitor();
        sendState(true);
        break;
      case 'run':
        void runJob(msg.job);
        break;
      case 'cancel':
        cancelJob(String(msg.jobId || ''), msg.reason);
        break;
      case 'detached':
        // The extension was reloaded or removed: go quiet. The network hooks stay
        // installed but are pass-through when no job is armed.
        stopMonitor();
        if (job && !job.finished) {
          job.cancelled = true;
          finishJob(job, { type: 'error', code: 'aborted', message: 'extension detached' });
        }
        relayAlive = false;
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  /** Drop selectors this browser can not parse, so one bad entry never breaks a chain. */
  function validChain(chain) {
    const frag = document.createDocumentFragment();
    return chain.filter((sel) => {
      try {
        frag.querySelector(sel);
        return true;
      } catch {
        return false;
      }
    });
  }
  for (const key of Object.keys(SELECTORS)) SELECTORS[key] = validChain(SELECTORS[key]);
  const TURN_SELECTOR = SELECTORS.turn.join(', ');
  const ASSISTANT_SELECTOR = SELECTORS.assistantMessage.join(', ');

  function isVisible(el) {
    if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function queryAll(chain, root = document) {
    const out = [];
    const seen = new Set();
    for (const sel of chain) {
      let list;
      try {
        list = root.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of list)
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
    }
    return out;
  }

  /** First visible element matching the chain (in chain order). */
  function findVisible(chain, root = document) {
    for (const sel of chain) {
      let list;
      try {
        list = root.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of list) if (isVisible(el)) return el;
    }
    return null;
  }

  const findComposer = () => findVisible(SELECTORS.composer);
  const isTextArea = (el) => !!el && el.tagName === 'TEXTAREA';
  const isGenerating = () => !!findVisible(SELECTORS.stop);
  const countChips = () => queryAll(SELECTORS.pastedTextChip).length;
  const isAuthPath = () => /^\/(?:auth|login|log-in|signin|sign-in|signup|sign-up)(?:\/|$)/i.test(location.pathname);

  function countTurns() {
    if (!TURN_SELECTOR) return 0;
    const n = document.querySelectorAll(TURN_SELECTOR).length;
    if (n > 0) turnsEverSeen = true;
    return n;
  }

  function lastAssistantDomText() {
    if (!ASSISTANT_SELECTOR) return '';
    const list = document.querySelectorAll(ASSISTANT_SELECTOR);
    const el = list[list.length - 1];
    return el ? el.textContent || '' : '';
  }

  function conversationIdFromLocation() {
    const m = /(?:^|\/)c\/([^/?#]+)/.exec(location.pathname);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }

  function composerText(el) {
    return el ? Core.normalizeEditorText(Core.readEditorText(el)) : '';
  }

  function loginCtaVisible() {
    if (isAuthPath()) return true;
    if (findVisible(SELECTORS.loginCta)) return true;
    for (const el of document.querySelectorAll('button, a')) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t && t.length <= 20 && TEXT.loginLabels.includes(t) && isVisible(el)) return true;
    }
    return false;
  }

  function isCloudflarePage() {
    return /just a moment/i.test(document.title || '') || queryAll(SELECTORS.cloudflare).length > 0;
  }

  /** A visible dialog / toast / banner whose text classifies as a warning, or null. */
  function currentWarning() {
    for (const el of queryAll(SELECTORS.warnings)) {
      if (!isVisible(el)) continue;
      if (TURN_SELECTOR && el.closest(TURN_SELECTOR)) continue; // text inside conversation messages
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 800) continue;
      const type = Core.classifyUiWarning(text);
      if (type) return { type, text: text.slice(0, 300) };
    }
    return null;
  }

  function warningError(w) {
    const msg = `ChatGPT says: ${w.text}`;
    if (w.type === 'rate_limit' || w.type === 'usage_cap') return new JobError('rate_limited', msg, Core.parseRetryAfter(w.text));
    if (w.type === 'auth_or_challenge') return new JobError(TEXT.loginWarning.test(w.text) ? 'not_logged_in' : 'network', msg);
    return new JobError('network', msg);
  }

  function isToggleSelected(b) {
    return (
      b.getAttribute('aria-pressed') === 'true' ||
      b.getAttribute('aria-checked') === 'true' ||
      b.getAttribute('aria-selected') === 'true' ||
      ['on', 'checked', 'active'].includes(b.getAttribute('data-state') || '')
    );
  }

  function isEnabled(btn) {
    return (
      !!btn &&
      !btn.disabled &&
      btn.getAttribute('aria-disabled') !== 'true' &&
      btn.getAttribute('data-disabled') !== 'true' &&
      isVisible(btn)
    );
  }

  /** First enabled send button, preferring the composer's own form. */
  function findEnabledSend(composer) {
    const form = composer && composer.closest ? composer.closest('form') : null;
    for (const root of form ? [form, document] : [document]) {
      for (const el of queryAll(SELECTORS.send, root)) {
        if (el.matches && SELECTORS.stop.some((s) => safe(() => el.matches(s)))) continue;
        if (isEnabled(el)) return el;
      }
    }
    return null;
  }

  function pressButton(el) {
    el.click();
  }

  /** React/ProseMirror need a real-looking click + focus + selection for inserts to stick. */
  function focusEditor(el) {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: r.left + Math.min(r.width - 2, 8),
        clientY: r.top + r.height / 2,
        button: 0,
        view: window,
      };
      const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', pointer));
      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.dispatchEvent(new PointerEvent('pointerup', pointer));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
    } catch {
      /* ignore */
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    if (!isTextArea(el)) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {
        /* ignore */
      }
    }
  }

  function setTextareaValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function clearEditor(el) {
    if (!el) return;
    if (isTextArea(el)) {
      safe(() => setTextareaValue(el, ''));
      return;
    }
    if (!composerText(el)) return;
    focusEditor(el);
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
    } catch {
      /* ignore */
    }
    if (composerText(el)) {
      // Last resort (DOM APIs, not innerHTML: the page may enforce Trusted Types).
      try {
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        el.replaceChildren(p);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } catch {
        /* ignore */
      }
    }
  }

  /** Insert text by synthetic paste in chunks (never typed: ProseMirror may submit on a typed newline). */
  function pasteText(el, text) {
    for (const chunk of Core.splitPasteChunks(text, PASTE_CHUNK)) {
      const plain = chunk.replace(/\r\n?/g, '\n');
      const data = new DataTransfer();
      data.setData('text/plain', plain);
      // Explicit <br>s keep blank lines that a plain-text paragraph parser could collapse.
      const p = document.createElement('p');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = plain;
      data.setData('text/html', p.outerHTML.replace(/\n/g, '<br>'));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
  }

  function pressEnter(el) {
    if (!el) return;
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, init));
  }

  function removeNewChips(before) {
    const chips = queryAll(SELECTORS.pastedTextChip);
    for (const chip of chips.slice(before)) safe(() => chip.click());
  }

  // ---------------------------------------------------------------------------
  // Page state (reported to the service worker)
  // ---------------------------------------------------------------------------

  /** Logged-in check through the cookie-authenticated session endpoint (cached; never keeps the token). */
  let sessionProbe = { at: 0, value: null, pending: null };
  function sessionLoggedIn() {
    if (sessionProbe.pending) return sessionProbe.pending;
    if (Date.now() - sessionProbe.at < 60_000) return Promise.resolve(sessionProbe.value);
    sessionProbe.pending = (async () => {
      let value = null;
      try {
        const r = await nativeFetch.call(window, '/api/auth/session', { credentials: 'include', cache: 'no-store' });
        if (r.ok && /json/i.test(r.headers.get('content-type') || '')) {
          const j = await r.json();
          value = !!(j && typeof j === 'object' && j.user);
        }
      } catch {
        value = null;
      }
      sessionProbe = { at: Date.now(), value, pending: null };
      return value;
    })();
    return sessionProbe.pending;
  }

  /** The conversation this page shows from our last job (needed for temporary chats, whose id is never in the URL). */
  function currentHeldConversation() {
    if (!held) return null;
    if (location.pathname !== held.path || location.search !== held.search) {
      if (conversationIdFromLocation() === held.id) {
        held.path = location.pathname;
        held.search = location.search;
        return held.id;
      }
      held = null;
      return null;
    }
    if (turnsEverSeen && countTurns() === 0) {
      held = null; // "New chat" inside the SPA on the same URL
      return null;
    }
    return held.id;
  }

  function computeState() {
    const busy = !!(job && !job.finished);
    let composer = null;
    let generating = false;
    let login = false;
    let warning = null;
    let turns = 0;
    try {
      composer = findComposer();
      generating = isGenerating();
      login = isAuthPath() || (!composer && loginCtaVisible()) || (sessionProbe.value === false && Date.now() - sessionProbe.at < 60_000);
      warning = currentWarning();
      turns = countTurns();
      // Logged-out ChatGPT still shows a composer next to "Log in" buttons: ask the session endpoint (async, cached).
      if (config.worker && composer && !busy && sessionProbe.value !== true && loginCtaVisible()) {
        if (!sessionProbe.pending && Date.now() - sessionProbe.at >= 60_000) void sessionLoggedIn().then(() => monitorKick());
      }
    } catch (e) {
      reportBug('state', e);
    }
    return {
      pageId,
      url: location.href,
      title: String(document.title || '').slice(0, 200),
      composer: !!composer,
      generating,
      loginRequired: login,
      cloudflare: isCloudflarePage(),
      hidden: document.visibilityState === 'hidden', // background tabs are throttled by the browser
      warning,
      turnCount: turns,
      emptyChat: turns === 0 && !conversationIdFromLocation() && !pageHadJob,
      heldConversationId: currentHeldConversation(),
      jobId: busy ? job.id : null,
      ready: !!composer && !generating && !login && !busy,
    };
  }

  let lastStateJson = '';
  function sendState(force) {
    let st;
    try {
      st = computeState();
    } catch (e) {
      reportBug('state', e);
      return;
    }
    const json = JSON.stringify(st);
    if (!force && json === lastStateJson) return;
    lastStateJson = json;
    post({ type: 'state', state: st });
  }

  /** Worker tabs only: watch the DOM (throttled to 1/s) and report state changes. */
  let monitor = null;
  function monitorKick() {
    if (monitor) monitor.schedule();
  }
  function startMonitor() {
    if (monitor) return;
    const m = { mo: null, timer: null, interval: null, last: 0, schedule: null };
    const tick = () => {
      m.timer = null;
      m.last = Date.now();
      sendState(false);
    };
    m.schedule = () => {
      if (monitor !== m || m.timer) return;
      const wait = 1000 - (Date.now() - m.last);
      if (wait <= 0) tick();
      else m.timer = nativeSetTimeout(() => hop(tick), wait);
    };
    try {
      m.mo = new NativeMutationObserver(() => m.schedule());
      m.mo.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label', 'aria-pressed', 'aria-checked', 'data-state', 'hidden', 'role'],
      });
    } catch (e) {
      reportBug('monitor', e);
    }
    m.interval = nativeSetInterval(() => m.schedule(), 5000);
    monitor = m;
    window.addEventListener('popstate', monitorKick);
    document.addEventListener('visibilitychange', monitorKick);
    m.schedule();
  }
  function stopMonitor() {
    const m = monitor;
    if (!m) return;
    monitor = null;
    try {
      if (m.mo) m.mo.disconnect();
    } catch {
      /* ignore */
    }
    nativeClearTimeout(m.timer);
    nativeClearInterval(m.interval);
    window.removeEventListener('popstate', monitorKick);
    document.removeEventListener('visibilitychange', monitorKick);
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  function newJobContext(spec) {
    const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs) || 20 * 60_000, 10_000), 4 * 3600_000);
    const conv = spec.conversation && typeof spec.conversation === 'object' ? spec.conversation : { kind: 'new' };
    return {
      id: spec.id,
      prompt: String(spec.prompt || ''),
      model: String(spec.model || ''),
      continueId: conv.kind === 'continue' && conv.conversationId ? String(conv.conversationId) : null,
      temporary: !!spec.temporary,
      startedAt: Date.now(),
      deadline: Date.now() + timeoutMs,
      finished: false,
      cancelled: false,
      armed: false,
      sentAt: 0,
      requestSeen: false,
      requestConversationId: null,
      bytes: 0,
      reducer: Core.createStreamState(),
      ws: Core.createWsTurnTracker(),
      wsBuffer: new Map(),
      wsDone: new Set(),
      wsError: null,
      lastWsAt: 0,
      httpEndedAt: 0,
      handoffWatch: false,
      recovering: false,
      lastStatus: '',
      lastText: '',
      lastTextAt: 0,
      textTimer: null,
      lastThinking: '',
      lastThinkingAt: 0,
      thinkingTimer: null,
      modelLogged: false,
      timers: new Set(),
      wakers: new Set(),
      completion: deferred(),
      requestSignal: deferred(),
      debugFrames: [],
      debugFlushedAt: Date.now(),
    };
  }

  function addTimer(ctx, fn, ms) {
    const id = nativeSetTimeout(
      () =>
        hop(() => {
          ctx.timers.delete(id);
          if (!ctx.finished) safe(fn);
        }),
      Math.max(0, ms),
    );
    ctx.timers.add(id);
    return id;
  }

  function emit(ctx, event) {
    if (!ctx.finished) post({ type: 'event', jobId: ctx.id, event });
  }

  function status(ctx, s, detail) {
    if (ctx.finished || ctx.lastStatus === s) return;
    ctx.lastStatus = s;
    emit(ctx, detail ? { type: 'status', status: s, detail: String(detail).slice(0, 300) } : { type: 'status', status: s });
  }

  function finishJob(ctx, event) {
    if (ctx.finished) return;
    ctx.finished = true;
    ctx.armed = false;
    for (const id of ctx.timers) nativeClearTimeout(id);
    ctx.timers.clear();
    flushDebug(ctx);
    if (event.type === 'done' && event.conversationId) {
      held = { id: event.conversationId, path: location.pathname, search: location.search };
    }
    post({ type: 'event', jobId: ctx.id, event });
    for (const w of [...ctx.wakers]) safe(w);
    ctx.completion.resolve();
    ctx.requestSignal.resolve(false);
  }

  function failJob(ctx, code, message, retryAfterMs) {
    finishJob(ctx, { type: 'error', code, message: String(message).slice(0, 1000), ...(retryAfterMs ? { retryAfterMs } : {}) });
  }

  function checkpoint(ctx) {
    if (ctx.cancelled || ctx.finished) throw new JobError('aborted', 'cancelled');
    if (Date.now() > ctx.deadline) throw new JobError('timeout', 'the job ran out of time in the ChatGPT tab');
  }

  /**
   * Resolve with fn()'s first truthy result (checked on DOM mutations, at most every
   * 100 ms, and by polling), or null after timeoutMs. Rejects when the job is cancelled.
   */
  function waitFor(ctx, fn, timeoutMs, intervalMs = 250) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let mo = null;
      let poll = null;
      let lastCheck = 0;
      const done = (value, err) => {
        if (settled) return;
        settled = true;
        try {
          if (mo) mo.disconnect();
        } catch {
          /* ignore */
        }
        nativeClearTimeout(poll);
        nativeClearTimeout(timer);
        ctx.wakers.delete(check);
        if (err) reject(err);
        else resolve(value);
      };
      const check = () => {
        if (settled) return;
        if (ctx.cancelled || ctx.finished) return done(null, new JobError('aborted', 'cancelled'));
        lastCheck = Date.now();
        let v = null;
        try {
          v = fn();
        } catch {
          v = null;
        }
        if (v) done(v);
      };
      const loop = () => {
        check();
        if (!settled) poll = nativeSetTimeout(() => hop(loop), intervalMs);
      };
      ctx.wakers.add(check);
      try {
        mo = new NativeMutationObserver(() => {
          if (Date.now() - lastCheck >= 100) check();
        });
        mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      } catch {
        mo = null;
      }
      const timer = nativeSetTimeout(() => hop(() => done(null)), Math.max(0, timeoutMs));
      loop();
    });
  }

  async function runJob(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) return;
    if (job && !job.finished) {
      if (job.id !== spec.id)
        post({ type: 'event', jobId: spec.id, event: { type: 'error', code: 'internal', message: 'this ChatGPT tab is already running another job' } });
      return;
    }
    const ctx = newJobContext(spec);
    job = ctx;
    sendState(true);
    try {
      await prepare(ctx);
      await typePrompt(ctx);
      await submit(ctx);
      await ctx.completion.promise;
    } catch (e) {
      if (!ctx.finished) {
        if (ctx.cancelled) failJob(ctx, 'aborted', 'cancelled');
        else if (e instanceof JobError) failJob(ctx, e.code, e.message, e.retryAfterMs);
        else {
          reportBug('job', e);
          failJob(ctx, 'internal', `page agent error: ${e && e.message ? e.message : String(e)}`);
        }
      }
    } finally {
      if (job === ctx) job = null;
      sendState(true);
    }
  }

  function cancelJob(jobId, reason) {
    const ctx = job;
    if (!ctx || ctx.id !== jobId || ctx.finished) return;
    ctx.cancelled = true;
    try {
      if (ctx.sentAt || isGenerating()) {
        const stop = findVisible(SELECTORS.stop);
        if (stop) pressButton(stop);
      } else {
        clearEditor(findComposer()); // typed but not sent: leave the composer clean
      }
    } catch (e) {
      reportBug('cancel', e);
    }
    failJob(ctx, 'aborted', reason ? String(reason) : 'cancelled');
  }

  // Step 1-2: page ready, logged in, not throttled, right conversation, Chat mode.
  async function prepare(ctx) {
    checkpoint(ctx);
    // The composer must exist and stay the same element for a moment: ChatGPT can
    // re-mount it while the page hydrates, which would drop pasted text.
    let seenEl = null;
    let seenSince = 0;
    const res = await waitFor(
      ctx,
      () => {
        const warning = currentWarning();
        if (warning && (warning.type === 'rate_limit' || warning.type === 'usage_cap')) return { warning };
        const composer = findComposer();
        if (!composer) return isAuthPath() || loginCtaVisible() ? { login: true } : null;
        if (isGenerating()) return null;
        if (composer !== seenEl) {
          seenEl = composer;
          seenSince = Date.now();
        }
        if (document.readyState === 'loading' || Date.now() - seenSince < COMPOSER_STABLE_MS) return null;
        return { composer };
      },
      COMPOSER_WAIT_MS,
      150,
    );
    if (!res) {
      if (isCloudflarePage()) throw new JobError('network', 'ChatGPT shows a Cloudflare check ("Just a moment…"); open the worker tab and complete it');
      if (isGenerating()) throw new JobError('ui_error', 'ChatGPT is still generating an earlier reply in the worker tab');
      const w = currentWarning();
      if (w) throw warningError(w);
      throw new JobError('ui_error', 'could not find the ChatGPT message box within 30 s (the page layout may have changed: see SELECTORS in content/page-agent.js)');
    }
    if (res.warning) throw warningError(res.warning);
    if (res.login) throw new JobError('not_logged_in', 'the worker tab is not logged in to ChatGPT: log in there and retry');
    if (loginCtaVisible() && (await sessionLoggedIn()) === false)
      throw new JobError('not_logged_in', 'ChatGPT is open but logged out in the worker tab: log in there and retry');
    checkpoint(ctx);
    if (ctx.continueId) await checkConversation(ctx);
    await ensureChatMode(ctx);
    status(ctx, 'ready');
  }

  async function checkConversation(ctx) {
    const id = ctx.continueId;
    if (ctx.temporary) {
      if (currentHeldConversation() !== id) throw new JobError('conversation_not_found', 'the temporary ChatGPT chat is no longer open in the worker tab');
      return;
    }
    const res = await waitFor(
      ctx,
      () => {
        if (conversationIdFromLocation() !== id) return { gone: true };
        if (countTurns() > 0) return { ok: true };
        const main = document.querySelector('main') || document.body;
        if (main && TEXT.notFound.test(main.innerText || '')) return { gone: true };
        return null;
      },
      15_000,
      300,
    );
    if (res && res.gone) throw new JobError('conversation_not_found', `ChatGPT conversation ${id} could not be opened`);
    if (!res) log('warn', `conversation ${id} shows no messages after 15 s; sending anyway`);
  }

  async function ensureChatMode(ctx) {
    const buttons = queryAll(SELECTORS.composerModeButtons);
    if (!buttons.length) return;
    const label = (b) => (b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
    const selected = buttons.find(isToggleSelected);
    if (!selected || label(selected) !== 'work') return;
    const chat = buttons.find((b) => label(b) === 'chat');
    if (!chat) return;
    pressButton(chat);
    log('info', 'switched the ChatGPT composer from Work to Chat');
    await sleep(400);
    checkpoint(ctx);
  }

  // Steps 3-5: focus, clear, paste in chunks, verify.
  async function typePrompt(ctx) {
    checkpoint(ctx);
    status(ctx, 'typing');
    let el = findComposer();
    if (!el) throw new JobError('ui_error', 'the ChatGPT message box disappeared');
    focusEditor(el);
    clearEditor(el);
    await sleep(50);
    checkpoint(ctx);
    el = findComposer() || el;
    const want = Core.normalizeEditorText(ctx.prompt);
    if (!want) throw new JobError('internal', 'empty prompt');
    const chipsBefore = countChips();
    const verifyMs = 2000 + Math.min(20_000, Math.round(ctx.prompt.length / 50));
    const landed = () => {
      if (countChips() > chipsBefore) return { chip: true };
      return composerText(findComposer()) === want ? { ok: true } : null;
    };

    focusEditor(el);
    if (isTextArea(el)) setTextareaValue(el, ctx.prompt.replace(/\r\n?/g, '\n'));
    else pasteText(el, ctx.prompt);
    let result = await waitFor(ctx, landed, verifyMs, 100);

    if (!result && countChips() <= chipsBefore) {
      const now = findComposer();
      if (now && now !== el && !composerText(now)) {
        // The composer was re-mounted and lost the text: paste once more.
        log('warn', 'the ChatGPT composer was replaced while typing; pasting again');
        focusEditor(now);
        if (isTextArea(now)) setTextareaValue(now, ctx.prompt.replace(/\r\n?/g, '\n'));
        else pasteText(now, ctx.prompt);
        result = await waitFor(ctx, landed, verifyMs, 100);
      } else if (now && !isTextArea(now) && !composerText(now)) {
        // The paste did nothing at all: try the editing command once.
        log('warn', 'synthetic paste did not reach the composer; trying execCommand("insertText")');
        focusEditor(now);
        try {
          document.execCommand('insertText', false, ctx.prompt.replace(/\r\n?/g, '\n'));
        } catch {
          /* ignore */
        }
        result = await waitFor(ctx, landed, verifyMs, 100);
      }
    }
    if (result && result.chip) {
      removeNewChips(chipsBefore);
      clearEditor(findComposer());
      throw new JobError('too_long', `ChatGPT turned the ${ctx.prompt.length}-character prompt into a "Pasted text" attachment; nothing was sent`);
    }
    if (!result) {
      const got = composerText(findComposer());
      let at = 0;
      while (at < got.length && at < want.length && got[at] === want[at]) at++;
      clearEditor(findComposer());
      throw new JobError(
        'ui_error',
        `the prompt did not land intact in the ChatGPT composer (${got.length} of ${want.length} characters, first difference at ${at}); nothing was sent`,
      );
    }
  }

  function waitRequest(ctx, ms) {
    if (ctx.requestSeen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = nativeSetTimeout(() => hop(() => resolve(ctx.requestSeen)), ms);
      ctx.requestSignal.promise.then((v) => {
        nativeClearTimeout(t);
        resolve(!!v);
      });
    });
  }

  // Steps 6-7: arm the observer, click send, confirm that the request started.
  async function submit(ctx) {
    checkpoint(ctx);
    ctx.armed = true;
    await sleep(500); // the send button can be disabled briefly after an insert
    checkpoint(ctx);
    const composer = findComposer();
    const btn = await waitFor(ctx, () => findEnabledSend(composer), 5000, 150);
    checkpoint(ctx);
    pageHadJob = true;
    ctx.sentAt = Date.now();
    if (btn) pressButton(btn);
    else pressEnter(findComposer() || composer);

    let seen = await waitRequest(ctx, 4000);
    if (!seen && !ctx.finished && btn) {
      const el = findComposer();
      if (el && composerText(el) === Core.normalizeEditorText(ctx.prompt) && !isGenerating()) {
        log('warn', 'clicking send did not start a request; pressing Enter');
        pressEnter(el);
      }
    }
    if (!seen) seen = await waitRequest(ctx, REQUEST_WAIT_MS - 4000);
    if (ctx.finished) return;
    if (seen) {
      status(ctx, 'submitted');
      return;
    }
    const w = currentWarning();
    if (w) throw warningError(w);
    if (isGenerating() || !composerText(findComposer())) {
      // ChatGPT took the message but our network hook did not see the request
      // (e.g. the page fetched from a context we do not hook): read the answer back instead.
      status(ctx, 'submitted');
      void recover(ctx, 'the conversation request was not observed');
      return;
    }
    throw new JobError('ui_error', 'send did not start a request (the send button may have changed: see SELECTORS in content/page-agent.js)');
  }

  // ---------------------------------------------------------------------------
  // Stream handling
  // ---------------------------------------------------------------------------

  function feedEvents(ctx, events, source) {
    for (const ev of events) {
      if (config.debug) debugFrame(ctx, source, ev);
      ctx.reducer.push(ev);
    }
  }

  function onStreamBytes(ctx, parser, chunk) {
    if (ctx.finished) return;
    let input = chunk;
    if (typeof chunk !== 'string') {
      if (chunk instanceof Uint8Array) input = chunk;
      else if (chunk && ArrayBuffer.isView(chunk)) input = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else return;
    }
    ctx.bytes += input.length;
    const events = parser.feed(input);
    if (events.length) {
      feedEvents(ctx, events, 'http');
      afterUpdate(ctx);
    }
  }

  function onStreamEnd(ctx, parser, reason) {
    if (ctx.finished) return;
    const tail = parser ? parser.flush() : [];
    if (tail.length) feedEvents(ctx, tail, 'http');
    afterUpdate(ctx);
    if (ctx.finished) return;
    flushDebug(ctx);
    const snap = ctx.reducer.snapshot();
    if (snap.handoffTopics.some((t) => !ctx.wsDone.has(t))) {
      ctx.httpEndedAt = Date.now();
      log('debug', `HTTP stream handed off to WebSocket topic(s) ${snap.handoffTopics.join(', ')}`);
      armHandoffWatchdog(ctx);
      return;
    }
    void recover(ctx, `the ChatGPT stream ended before the reply was complete (${reason})`);
  }

  function streamErrorToJob(text) {
    const kind = Core.classifyUiWarning(text);
    if (kind === 'rate_limit' || kind === 'usage_cap') return { code: 'rate_limited', retryAfterMs: Core.parseRetryAfter(text) };
    if (/too long|too large|context length|maximum context/i.test(text)) return { code: 'too_long' };
    return { code: 'network' };
  }

  /** Move buffered WebSocket items of handed-off topics into the reducer. */
  function drainWs(ctx) {
    let progressed = false;
    for (const topic of ctx.reducer.state.handoffTopics) {
      const items = ctx.wsBuffer.get(topic);
      if (!items || !items.length) continue;
      ctx.wsBuffer.set(topic, []);
      progressed = true;
      for (const it of items) {
        if (it.kind === 'chunk') feedEvents(ctx, Core.parseSseBlock(it.text), 'ws');
        else if (it.kind === 'done') ctx.wsDone.add(topic);
        else if (it.kind === 'error') ctx.wsError = it.message;
      }
    }
    return progressed;
  }

  function afterUpdate(ctx) {
    if (ctx.finished) return;
    for (let i = 0; i < 10 && drainWs(ctx); i++);
    const snap = ctx.reducer.snapshot();
    if (snap.error) {
      const e = streamErrorToJob(snap.error);
      failJob(ctx, e.code, `ChatGPT reported an error: ${snap.error}`, e.retryAfterMs);
      return;
    }
    if (ctx.wsError && !snap.answerFinished) {
      failJob(ctx, 'network', `ChatGPT's WebSocket stream failed: ${ctx.wsError}`);
      return;
    }
    if (!ctx.modelLogged && snap.modelSlug) {
      ctx.modelLogged = true;
      if (ctx.model && snap.modelSlug.replace(/\./g, '-') !== ctx.model.replace(/\./g, '-'))
        log('info', `requested ChatGPT model "${ctx.model}", the stream reports "${snap.modelSlug}"`);
    }
    if (maybeComplete(ctx, snap)) return;
    if (snap.text) status(ctx, 'generating');
    else if (snap.reasoning) pushThinking(ctx, snap.reasoning, false);
    else if (snap.thinking) status(ctx, 'thinking');
    pushText(ctx, snap.text, false);
  }

  /** status "thinking" with the whole reasoning summary so far (throttled like text). */
  function pushThinking(ctx, text, force) {
    if (ctx.finished || !text || text === ctx.lastThinking || ctx.lastText) return;
    const now = Date.now();
    const due = ctx.lastThinkingAt + TEXT_INTERVAL_MS;
    if (force || now >= due) {
      ctx.lastThinking = text;
      ctx.lastThinkingAt = now;
      ctx.lastStatus = 'thinking';
      emit(ctx, { type: 'status', status: 'thinking', detail: text.slice(0, MAX_THINKING_CHARS) });
      return;
    }
    if (!ctx.thinkingTimer)
      ctx.thinkingTimer = addTimer(
        ctx,
        () => {
          ctx.thinkingTimer = null;
          const snap = ctx.reducer.snapshot();
          if (!snap.text) pushThinking(ctx, snap.reasoning, true);
        },
        due - now,
      );
  }

  function maybeComplete(ctx, snap) {
    const topics = snap.handoffTopics;
    const pending = topics.some((t) => !ctx.wsDone.has(t));
    const done =
      (snap.complete && (!pending || snap.answerFinished)) ||
      (snap.doneSeen && snap.answerFinished && !pending) ||
      (topics.length > 0 && !pending);
    if (!done) return false;
    if (!snap.text) {
      void recover(ctx, 'the stream finished without a text answer');
      return true;
    }
    finishFromSnapshot(ctx, snap);
    return true;
  }

  function finishFromSnapshot(ctx, snap) {
    finishJob(ctx, {
      type: 'done',
      text: snap.text,
      conversationId: snap.conversationId || ctx.requestConversationId || conversationIdFromLocation() || '',
      ...(snap.messageId ? { messageId: snap.messageId } : {}),
      finishReason: snap.finishReason || 'stop',
    });
  }

  /** Emit the whole answer text so far, at most every TEXT_INTERVAL_MS (time-based, so hidden tabs are fine). */
  function pushText(ctx, text, force) {
    if (ctx.finished || !text || text === ctx.lastText) return;
    const now = Date.now();
    const due = ctx.lastTextAt + TEXT_INTERVAL_MS;
    if (force || now >= due) {
      ctx.lastText = text;
      ctx.lastTextAt = now;
      emit(ctx, { type: 'text', text });
      return;
    }
    if (!ctx.textTimer)
      ctx.textTimer = addTimer(
        ctx,
        () => {
          ctx.textTimer = null;
          pushText(ctx, ctx.reducer.snapshot().text, true);
        },
        due - now,
      );
  }

  function armNoDataWatchdog(ctx) {
    addTimer(
      ctx,
      () => {
        if (ctx.bytes === 0 && !ctx.recovering) void recover(ctx, 'no stream data was observed 45 s after the response arrived');
      },
      45_000,
    );
  }

  function armHandoffWatchdog(ctx) {
    if (ctx.handoffWatch) return;
    ctx.handoffWatch = true;
    const check = () => {
      if (ctx.recovering) return;
      const idle = Date.now() - Math.max(ctx.lastWsAt, ctx.httpEndedAt);
      if (idle > 90_000) void recover(ctx, 'the WebSocket continuation of the stream went quiet');
      else addTimer(ctx, check, 15_000);
    };
    addTimer(ctx, check, 15_000);
  }

  /**
   * Fallback when the stream broke or was not observed: wait until the page
   * looks finished (no stop control, assistant text stable for 1.5 s), then read
   * the answer from GET /backend-api/conversation/{id}. Non-destructive until
   * then: if the stream completes meanwhile, that wins.
   */
  async function recover(ctx, reason) {
    if (ctx.finished || ctx.recovering) return;
    ctx.recovering = true;
    log('warn', `${reason}; waiting for ChatGPT to finish and reading the conversation back`);
    try {
      status(ctx, 'recovering', reason);
      await waitForDomTerminal(ctx);
      if (ctx.finished) return;
      let snap = ctx.reducer.snapshot();
      const id = snap.conversationId || ctx.requestConversationId || conversationIdFromLocation();
      let detail = 'no conversation id';
      if (id) {
        for (let attempt = 0; attempt < 5 && !ctx.finished; attempt++) {
          const r = await fetchConversationAnswer(id);
          if (ctx.finished) return;
          if (r.ok) {
            finishJob(ctx, {
              type: 'done',
              text: r.answer.text,
              conversationId: r.answer.conversationId || id,
              ...(r.answer.messageId ? { messageId: r.answer.messageId } : {}),
              finishReason: r.answer.finishReason || 'stop',
            });
            return;
          }
          detail = r.reason;
          if (!r.retry) break;
          await sleep(3000);
        }
      }
      snap = ctx.reducer.snapshot();
      // Only trust streamed text that ChatGPT marked finished: a truncated reply
      // could contain a half tool call that the bridge would happily execute.
      if (snap.text && snap.answerFinished) {
        finishFromSnapshot(ctx, snap);
        return;
      }
      const w = currentWarning();
      if (w) {
        const e = warningError(w);
        failJob(ctx, e.code, e.message, e.retryAfterMs);
        return;
      }
      failJob(ctx, 'network', `${reason}, and the reply could not be read back from ChatGPT (${detail})`);
    } catch (e) {
      if (!ctx.finished) failJob(ctx, e instanceof JobError ? e.code : 'network', e && e.message ? e.message : String(e));
    }
  }

  async function waitForDomTerminal(ctx) {
    let lastText = null;
    let stableSince = Date.now();
    for (;;) {
      checkpoint(ctx);
      const t = lastAssistantDomText();
      if (t !== lastText) {
        lastText = t;
        stableSince = Date.now();
      }
      if (!isGenerating() && Date.now() - stableSince >= 1500) return;
      await sleep(500);
    }
  }

  /** Best effort: Cloudflare may challenge programmatic /backend-api reads. Never stores or logs the token. */
  async function fetchConversationAnswer(id) {
    try {
      const s = await nativeFetch.call(window, '/api/auth/session', { credentials: 'include', cache: 'no-store' });
      if (!s.ok) return { ok: false, reason: `auth session HTTP ${s.status}` };
      let token = '';
      try {
        const j = await s.json();
        token = j && typeof j.accessToken === 'string' ? j.accessToken : '';
      } catch {
        token = '';
      }
      if (!token) return { ok: false, reason: 'no access token in the auth session' };
      const r = await nativeFetch.call(window, `/backend-api/conversation/${encodeURIComponent(id)}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      token = '';
      const ct = r.headers.get('content-type') || '';
      if (r.status === 403 || /text\/html/i.test(ct)) return { ok: false, reason: `conversation read blocked (HTTP ${r.status})` };
      if (!r.ok) return { ok: false, reason: `conversation read HTTP ${r.status}` };
      const ans = Core.answerFromConversation(await r.json());
      if (!ans || !ans.text) return { ok: false, reason: 'no answer in the conversation yet', retry: true };
      if (!ans.finished) return { ok: false, reason: 'the answer is not finished yet', retry: true };
      return { ok: true, answer: ans };
    } catch (e) {
      return { ok: false, reason: `conversation read failed (${e && e.name ? e.name : 'error'})` };
    }
  }

  // ---------------------------------------------------------------------------
  // Debug log (opt-in: chrome.storage.local.debug)
  // ---------------------------------------------------------------------------

  function debugFrame(ctx, source, ev) {
    ctx.debugFrames.push(`${source}${ev.event && ev.event !== 'message' ? ` [${ev.event}]` : ''} ${Core.redactFrame(ev.data, 2000)}`);
    if (ctx.debugFrames.length >= 50 || Date.now() - ctx.debugFlushedAt >= 1000) flushDebug(ctx);
  }

  function flushDebug(ctx) {
    if (!ctx.debugFrames.length) return;
    const frames = ctx.debugFrames;
    ctx.debugFrames = [];
    ctx.debugFlushedAt = Date.now();
    post({ type: 'log', level: 'info', message: `debug: ${frames.length} raw stream frame(s), job ${ctx.id.slice(0, 8)}`, data: { jobId: ctx.id, frames } });
  }

  // ---------------------------------------------------------------------------
  // Network observer
  // ---------------------------------------------------------------------------

  function describeRequest(args) {
    const input = args[0];
    const init = args[1];
    let url = '';
    let method = '';
    if (typeof input === 'string') url = input;
    else if (input && typeof input.url === 'string') {
      url = input.url; // Request
      method = input.method || '';
    } else if (input && typeof input.href === 'string') url = input.href; // URL
    else return null;
    if (init && typeof init.method === 'string') method = init.method;
    let u;
    try {
      u = new URL(url, location.href);
    } catch {
      return null;
    }
    if (u.origin !== location.origin && u.hostname !== 'chatgpt.com' && !u.hostname.endsWith('.chatgpt.com')) return null;
    return { pathname: u.pathname, method: (method || 'GET').toUpperCase(), body: init && typeof init.body === 'string' ? init.body : null };
  }

  /** Correlate the request body with our prompt (diagnostics only; never blocks). */
  function inspectRequestBody(ctx, body) {
    if (!body) return;
    try {
      const j = JSON.parse(body);
      if (!j || typeof j !== 'object') return;
      if (typeof j.conversation_id === 'string') ctx.requestConversationId = j.conversation_id;
      if (ctx.continueId && j.conversation_id && j.conversation_id !== ctx.continueId)
        log('warn', `the request continues conversation ${j.conversation_id}, expected ${ctx.continueId}`);
      if (!ctx.continueId && j.conversation_id) log('warn', `a new-chat job was sent into existing conversation ${j.conversation_id}`);
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      const parts = msgs.length && msgs[0] && msgs[0].content && Array.isArray(msgs[0].content.parts) ? msgs[0].content.parts : [];
      const sent = parts.filter((p) => typeof p === 'string').join('\n');
      if (sent && Core.normalizeEditorText(sent).slice(0, 200) !== Core.normalizeEditorText(ctx.prompt).slice(0, 200))
        log('warn', 'the conversation request does not start with the prompt we pasted (continuing)', { sentChars: sent.length, promptChars: ctx.prompt.length });
    } catch {
      /* not JSON: ignore */
    }
  }

  /** Called synchronously inside our fetch wrapper, before the page sees the promise. */
  function maybeObserve(args, result) {
    const ctx = job;
    if (!ctx || !ctx.armed || ctx.finished) return;
    const info = describeRequest(args);
    if (!info || info.method !== 'POST' || !Core.isConversationPath(info.pathname)) return;
    const resume = Core.isResumePath(info.pathname);
    if (resume ? !ctx.requestSeen : ctx.requestSeen) {
      log('debug', `ignoring a ${resume ? 'resume' : 'second conversation'} request during the job`);
      return;
    }
    if (resume) {
      // The page resumes an interrupted stream: same messages (shared reducer), new byte stream.
      log('debug', 'ChatGPT resumed the conversation stream');
    } else {
      ctx.requestSeen = true;
      inspectRequestBody(ctx, info.body);
      ctx.requestSignal.resolve(true);
    }
    // Registered before we hand the promise back, so this runs before the page's
    // own continuation and can wrap the body before the page reads it.
    Promise.resolve(result).then(
      (resp) => safe(() => onResponse(ctx, resp, resume)),
      (err) => safe(() => onFetchFailed(ctx, err, resume)),
    );
  }

  function onFetchFailed(ctx, err, resume) {
    if (ctx.finished || resume) return;
    if (err && err.name === 'AbortError') {
      void recover(ctx, 'the conversation request was aborted');
      return;
    }
    void recover(ctx, `the conversation request failed (${err && err.message ? err.message : 'network error'})`);
  }

  function onResponse(ctx, resp, resume) {
    if (ctx.finished || !resp) return;
    const ct = (resp.headers && resp.headers.get('content-type')) || '';
    if (resp.status >= 400) {
      if (resume) {
        log('debug', `stream resume answered HTTP ${resp.status}`);
        return;
      }
      let p;
      try {
        p = resp.clone().text();
      } catch {
        p = Promise.resolve('');
      }
      p.catch(() => '').then((text) =>
        safe(() => {
          if (ctx.finished) return;
          const e = Core.classifyHttpError(resp.status, text, ct, resp.headers.get('retry-after'));
          if (resp.status === 404 && ctx.continueId) e.code = 'conversation_not_found';
          failJob(ctx, e.code, e.message, e.retryAfterMs);
        }),
      );
      return;
    }
    if (!resp.body) {
      onStreamEnd(ctx, null, 'empty response body');
      return;
    }
    if (!/event-stream/i.test(ct)) log('warn', `conversation response has content-type "${ct}"; reading it as SSE anyway`);
    observeBody(ctx, resp);
    if (!resume) armNoDataWatchdog(ctx);
  }

  function endReason(e) {
    if (e && e.name === 'AbortError') return 'aborted';
    return `error: ${e && e.message ? e.message : String(e)}`;
  }

  /**
   * Observe the bytes the page reads from `resp.body` without adding a consumer.
   * The usual path (getReader) wraps the page's own reader; the other ways of
   * consuming a stream go through a pass-through stream that pulls on demand.
   */
  function observeBody(ctx, resp) {
    const body = resp.body;
    const parser = Core.createSseParser(); // one per HTTP stream (a resume gets its own)
    let closed = false;
    const sink = {
      bytes: (chunk) => {
        if (!closed) onStreamBytes(ctx, parser, chunk);
      },
      end: (reason) => {
        if (closed) return;
        closed = true;
        onStreamEnd(ctx, parser, reason);
      },
    };

    defineValue(body, 'getReader', function getReader(...a) {
      const reader = nativeGetReader.apply(this, a);
      if (this === body) safe(() => wrapReader(reader, sink));
      return reader;
    });

    for (const name of ['pipeThrough', 'pipeTo', 'tee', 'values', Symbol.asyncIterator]) {
      const orig = body[name];
      if (typeof orig !== 'function') continue;
      defineValue(body, name, function (...a) {
        if (this !== body) return orig.apply(this, a);
        let observed;
        try {
          observed = passThrough(body, sink);
        } catch {
          return orig.apply(this, a); // e.g. already locked: same error as native
        }
        return observed[name](...a);
      });
    }

    const origText = resp.text;
    if (typeof origText === 'function')
      defineValue(resp, 'text', function text(...a) {
        const p = origText.apply(this, a);
        if (this === resp)
          p.then(
            (t) => safe(() => (sink.bytes(String(t)), sink.end('eof'))),
            (e) => safe(() => sink.end(endReason(e))),
          );
        return p;
      });
  }

  function wrapReader(reader, sink) {
    const origRead = reader.read;
    const origCancel = reader.cancel;
    defineValue(reader, 'read', function read(...a) {
      const p = origRead.apply(this, a);
      try {
        p.then(
          (r) =>
            safe(() => {
              if (!r || r.done) sink.end('eof');
              else sink.bytes(r.value);
            }),
          (e) => safe(() => sink.end(endReason(e))),
        );
      } catch {
        /* ignore */
      }
      return p; // the native promise, untouched
    });
    defineValue(reader, 'cancel', function cancel(...a) {
      safe(() => sink.end('cancelled'));
      return origCancel.apply(this, a);
    });
  }

  function passThrough(body, sink) {
    const reader = nativeGetReader.call(body);
    return new NativeReadableStream(
      {
        async pull(controller) {
          let r;
          try {
            r = await reader.read();
          } catch (e) {
            safe(() => sink.end(endReason(e)));
            controller.error(e);
            return;
          }
          if (r.done) {
            safe(() => sink.end('eof'));
            controller.close();
            return;
          }
          safe(() => sink.bytes(r.value));
          controller.enqueue(r.value);
        },
        cancel(reason) {
          safe(() => sink.end('cancelled'));
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
  }

  function installFetchHook() {
    if (typeof nativeFetch !== 'function') return;
    const hooked = new Proxy(nativeFetch, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args); // native call first, always
        try {
          maybeObserve(args, result);
        } catch (e) {
          reportBug('fetch hook', e);
        }
        return result;
      },
    });
    try {
      window.fetch = hooked;
    } catch (e) {
      reportBug('install fetch hook', e);
    }
  }

  function onSocketMessage(data) {
    const ctx = job;
    if (!ctx || ctx.finished || !ctx.requestSeen) return;
    if (typeof data !== 'string' || data.indexOf('conversation-turn') === -1) return;
    const r = ctx.ws.process(data);
    if (!r.chunks.length && !r.done.length && !r.errors.length) return;
    ctx.lastWsAt = Date.now();
    const buffer = (topic, item) => {
      let list = ctx.wsBuffer.get(topic);
      if (!list) ctx.wsBuffer.set(topic, (list = []));
      if (list.length < 20_000) list.push(item);
    };
    for (const c of r.chunks) buffer(c.topicId, { kind: 'chunk', text: c.text });
    for (const t of r.done) buffer(t, { kind: 'done' });
    for (const e of r.errors) buffer(e.topicId, { kind: 'error', message: e.message });
    afterUpdate(ctx); // drains the topics this job was handed off to
  }

  function installWebSocketHook() {
    if (typeof NativeWebSocket !== 'function') return;
    const Hooked = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget === Hooked ? target : newTarget);
        try {
          const u = new URL(String(args[0]), location.href);
          if (/^wss?:$/.test(u.protocol) && (u.hostname === 'chatgpt.com' || u.hostname.endsWith('.chatgpt.com')))
            ws.addEventListener('message', (ev) => {
              try {
                onSocketMessage(ev.data);
              } catch (e) {
                reportBug('websocket', e);
              }
            });
        } catch (e) {
          reportBug('websocket hook', e);
        }
        return ws;
      },
    });
    try {
      window.WebSocket = Hooked;
    } catch (e) {
      reportBug('install websocket hook', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  installFetchHook();
  installWebSocketHook();
  sendState(true);
})();

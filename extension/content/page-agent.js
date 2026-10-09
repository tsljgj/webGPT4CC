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
//  * in worker tabs, reports page state (composer found, generating, login...)
//    and a heartbeat, and tracks every conversation stream of the page, so
//    "ChatGPT is generating" never depends on the UI language.
//
// It never creates auth, Sentinel, proof-of-work or Turnstile tokens: ChatGPT's
// own code sends every request. Every hook is wrapped in try/catch and returns
// the native result, so a bug here must never break ChatGPT.
//
// Locale independence: the 2026-09 layout has no data-testid and its labels
// follow the account's language (the primary user's UI is Simplified Chinese).
// Network state (open conversation streams), DOM structure and attributes come
// first; English and localized labels are fallbacks only.
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
    // Explicit send buttons (older builds, English labels, localized labels).
    // The 2026-09 layout has none of these: see composerPrimary.
    send: [
      'button[data-testid="send-button"]',
      '#composer-submit-button[data-testid="send-button"]',
      'button[data-testid*="composer-send"]',
      '[data-composer-submit]',
      'form button[type="submit"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send" i]',
      'form button[aria-label*="发送"]',
      'form button[aria-label*="傳送"]',
      'form button[aria-label*="送信"]',
    ],
    // The 2026-09 primary composer button: type="button", no id or test id, and a
    // localized label that cycles Start Voice -> Send -> Stop. It is found by
    // structure; whether it is Send or Stop is decided from network state and
    // from its label changing after the paste (findEnabledSend, findStopButton).
    composerPrimary: [
      'form[data-chatgpt-composer] button.bg-composer-primary',
      'form[data-chatgpt-composer] button.size-token-button-composer',
      '#composer-submit-button',
    ],
    // Labelled stop controls (a fallback: the network says first whether a reply streams).
    stop: [
      '[data-testid="stop-button"]',
      '[data-testid="composer-stop-button"]',
      'form button[aria-label="Stop"]',
      'form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])',
      'form button[aria-label^="停止"]:not([aria-label*="听写"]):not([aria-label*="聽寫"]):not([aria-label*="语音"]):not([aria-label*="語音"]):not([aria-label*="朗读"]):not([aria-label*="朗讀"])',
      'form button[aria-label*="を停止"]:not([aria-label*="音声"]):not([aria-label*="読み上げ"])',
    ],
    // Present on the answer while it streams (2026-09 layout), whatever the language.
    streamingMarkdown: ['[data-markdown-animated]'],
    pastedTextChip: ['form button[aria-label^="Remove Pasted text"]'],
    composerModeButtons: [
      '[role="group"][aria-label="Composer mode"] button',
      '[role="group"][aria-label="Composer mode"] [role="radio"]',
    ],
    // Chat/Work switch candidates, searched only inside the composer form (so the
    // model or effort toggles elsewhere are never taken for it); classified by
    // data-mode/data-value/value, then by localized labels (Core.composerModeOf).
    composerModeControls: [
      '[role="group"] button',
      '[role="radiogroup"] [role="radio"]',
      '[role="tablist"] [role="tab"]',
      'button[role="radio"]',
      'button[aria-pressed]',
      '[data-mode]',
      'button[value]',
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
    // Cloudflare: bot management loads /cdn-cgi/challenge-platform/ scripts on
    // NORMAL ChatGPT pages too, so the script is weak evidence (Core.cloudflareVerdict).
    cloudflareWidget: [
      '#challenge-form',
      '#challenge-running',
      '#cf-challenge-running',
      '[class*="cf-challenge"]',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="/cdn-cgi/challenge-platform/"]',
    ],
    cloudflareScript: ['script[src*="/challenge-platform/"]'],
    appShell: [
      'form[data-chatgpt-composer]',
      '[data-turn-key]',
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      '[data-testid^="conversation-turn"]',
      'nav a[href*="/c/"]',
    ],
  };

  const TEXT = {
    /** Whole-text labels of login / sign-up buttons and links (a secondary signal: see sessionLoggedIn). */
    loginLabels: [
      'log in',
      'login',
      'sign in',
      'sign up',
      'sign up for free',
      '登录',
      '登入',
      '注册',
      '註冊',
      '免费注册',
      '免費註冊',
      'ログイン',
      '新規登録',
      'サインアップ',
      '無料でサインアップ',
    ],
    notFound:
      /conversation not found|unable to load conversation|couldn[’']t (?:find|load) (?:this |the )?conversation|this conversation (?:doesn[’']t|does not) exist|找不到(?:该|此|這個)?(?:对话|對話)|无法加载(?:该|此)?对话|無法載入(?:此)?對話|对话不存在|對話不存在|会話が見つかりません/i,
    loginWarning:
      /session (?:has )?expired|log ?in again|please (?:log|sign) in|logged out|\blog ?in\b|\bsign in\b|请登录|請登入|重新登录|重新登入|登录已过期|会话已过期|ログイン/i,
    workPlaceholder: /^work on anything/i,
    /** Labels of controls that must never be clicked as Send or Stop (voice mode, dictation). */
    voiceLabel: /voice|dictat|语音|語音|听写|聽寫|音声|ボイス|ディクテーション/i,
  };

  const PASTE_CHUNK = 4000; // ChatGPT turns single pastes above ~10k chars into a "Pasted text" file
  const TEXT_INTERVAL_MS = 250;
  const MAX_THINKING_CHARS = 100_000;
  const COMPOSER_WAIT_MS = 30_000;
  const REQUEST_WAIT_MS = 20_000;
  const COMPOSER_STABLE_MS = 600;
  /** Without anything that looks like a send button, press Enter after this instead of waiting 5 s. */
  const SEND_PROBE_MS = 1000;
  /** Worker tabs re-send their state this often, so the service worker can tell a frozen tab. */
  const HEARTBEAT_MS = 10_000;
  const SESSION_TTL_MS = 60_000;
  /** cancel: wait at most this long for the page to stop streaming before reporting "aborted". */
  const CANCEL_SETTLE_MS = 4000;
  /** After a stop click, keep clicking (at most every 1.5 s) while something still streams, this long. */
  const STOP_RETRY_MS = 8000;
  /** After a stop request, a stream or topic with no traffic for this long counts as ended. */
  const STOP_SETTLE_MS = 4000;
  /** A handed-off WebSocket topic with no traffic for this long counts as ended. */
  const TOPIC_IDLE_MS = 120_000;
  /** An HTTP conversation stream with no traffic for this long counts as ended (stalled). */
  const HTTP_IDLE_MS = 10 * 60_000;
  /** A data-markdown-animated answer whose text has not changed for this long is not "streaming". */
  const ANIMATED_STALE_MS = 60_000;
  /** Our stream delivered no SSE event / WebSocket item for this long: read the conversation back. */
  const STREAM_IDLE_MS = 180_000;
  /** Trusted keyboard/pointer input this recent (with text in the composer) means a person is typing. */
  const USER_INPUT_QUIET_MS = 8000;
  /** recover(): give up reading back after this long without our turn's answer (in_progress keeps waiting). */
  const NO_ANSWER_MAX_MS = 90_000;
  /** recover(): an in_progress answer whose text has not changed for this long (page idle) is abandoned. */
  const IN_PROGRESS_STALE_MS = 5 * 60_000;
  const CF_WEAK_GRACE_MS = 12_000;
  /** A strict-prefix composer result this large is a size cut (too_long), not a paste failure. */
  const TRUNCATION_MIN_WANT = 20_000;
  const TRUNCATION_MIN_GOT = 10_000;

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
  const NativeMutationObserver = window.MutationObserver;
  const NativeRequest = window.Request;
  const nativeLocks = (() => {
    try {
      return navigator.locks || null;
    } catch {
      return null;
    }
  })();

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
  /** Last trusted (real user) keyboard / pointer input in this page. */
  let lastUserInputAt = 0;

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

  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

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

  // Real (trusted) input: someone uses this tab. Observed only, never prevented.
  for (const type of ['keydown', 'pointerdown', 'paste', 'drop', 'compositionstart'])
    window.addEventListener(
      type,
      (ev) => {
        if (ev.isTrusted) lastUserInputAt = Date.now();
      },
      { capture: true, passive: true },
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
        // installed but are pass-through when no job is armed and the tab is no worker.
        stopMonitor();
        config.worker = false;
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

  function matchesAny(el, chain) {
    if (!el || typeof el.matches !== 'function') return false;
    for (const sel of chain) {
      try {
        if (el.matches(sel)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  const findComposer = () => findVisible(SELECTORS.composer);
  const isTextArea = (el) => !!el && el.tagName === 'TEXTAREA';
  const countChips = () => queryAll(SELECTORS.pastedTextChip).length;
  const isAuthPath = () => /^\/(?:auth|login|log-in|signin|sign-in|signup|sign-up)(?:\/|$)/i.test(location.pathname);
  const labelOf = (el) => (el && el.getAttribute ? el.getAttribute('aria-label') || '' : '');
  const isVoiceLike = (el) => TEXT.voiceLabel.test(labelOf(el));
  const isStopLike = (el) => matchesAny(el, SELECTORS.stop);

  function composerForm(composer) {
    const c = composer || findComposer();
    const f = c && c.closest ? c.closest('form') : null;
    return f || document.querySelector('form[data-chatgpt-composer]');
  }

  /** The new layout's primary composer button (voice / send / stop), by structure. */
  function findPrimaryButton(form) {
    const root = form || composerForm();
    return (root && findVisible(SELECTORS.composerPrimary, root)) || findVisible(SELECTORS.composerPrimary);
  }

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

  /** Someone is typing into this tab right now (recent trusted input and text in the composer). */
  function userIsTyping() {
    if (Date.now() - lastUserInputAt > USER_INPUT_QUIET_MS) return false;
    return !!composerText(findComposer());
  }

  let cfWeakSince = 0;
  /** A Cloudflare interstitial (not just the bot-management script every ChatGPT page loads). */
  function isCloudflarePage() {
    let v;
    try {
      const hasAppShell = queryAll(SELECTORS.appShell).length > 0;
      v = Core.cloudflareVerdict({
        title: document.title,
        hasAppShell,
        bodyText: hasAppShell ? '' : String((document.body && document.body.innerText) || '').slice(0, 2000),
        hasChallengeWidget: !hasAppShell && queryAll(SELECTORS.cloudflareWidget).length > 0,
        hasChallengeScript: !hasAppShell && queryAll(SELECTORS.cloudflareScript).length > 0,
      });
    } catch {
      return false;
    }
    if (v.strong) return true;
    if (!v.weak) {
      cfWeakSince = 0;
      return false;
    }
    // Script only, on a short page without the app shell: also how a healthy page looks
    // mid-hydration, so it counts only once it persists.
    if (!cfWeakSince) cfWeakSince = Date.now();
    return Date.now() - cfWeakSince >= CF_WEAK_GRACE_MS;
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

  /**
   * The primary composer button when it is (very likely) Send: no reply streams
   * (then it is Stop), it is not labelled like voice/dictation, and its label
   * changed since the composer was empty (then it was the voice button). The
   * caller also checks that the composer holds exactly our prompt.
   */
  function primarySendCandidate(form, ctx) {
    const p = findPrimaryButton(form);
    if (!p || isStopLike(p) || isVoiceLike(p)) return null;
    if (netGenerating()) return null;
    if (ctx && ctx.idle && ctx.idle.present && labelOf(p) === ctx.idle.label) return null;
    return p;
  }

  /** First enabled send button, preferring the composer's own form; then the structural primary button. */
  function findEnabledSend(composer, ctx) {
    const form = composer && composer.closest ? composer.closest('form') : null;
    for (const root of form ? [form, document] : [document]) {
      for (const el of queryAll(SELECTORS.send, root)) {
        if (isStopLike(el) || isVoiceLike(el)) continue;
        if (isEnabled(el)) return el;
      }
    }
    const p = primarySendCandidate(form, ctx);
    return p && isEnabled(p) ? p : null;
  }

  /** Is there anything that may become a send button (e.g. still disabled right after the paste)? */
  function sendCandidateExists(composer, ctx) {
    const form = composer && composer.closest ? composer.closest('form') : null;
    for (const root of form ? [form, document] : [document])
      for (const el of queryAll(SELECTORS.send, root)) if (!isStopLike(el) && !isVoiceLike(el) && isVisible(el)) return true;
    return !!primarySendCandidate(form, ctx);
  }

  /**
   * The control that stops the streaming reply: a labelled stop button, or the
   * primary composer button, but the latter only while the network shows a
   * conversation stream (otherwise it is Send or voice).
   */
  function findStopButton() {
    const labelled = findVisible(SELECTORS.stop);
    if (labelled) return labelled;
    if (!netGenerating()) return null;
    const p = findPrimaryButton();
    return p && !isVoiceLike(p) ? p : null;
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
  // "Is ChatGPT generating?" — network first, DOM as a fallback
  // ---------------------------------------------------------------------------

  /**
   * Every conversation stream of this page (worker tabs: also the ones no job of
   * ours started, e.g. a cancelled reply or one that was running before the job),
   * so "generating" never depends on finding a localized Stop label.
   */
  const net = {
    streams: new Set(), // open HTTP conversation streams: { startedAt, lastAt, closed }
    topics: new Map(), // WebSocket turn topics: id -> { firstAt, lastAt, done }
    stopAskedAt: 0,
  };

  function streamOpen(s, now) {
    if (s.closed || now - s.lastAt > HTTP_IDLE_MS) return false;
    // Asked to stop: a stream started before that and silent since counts as ended.
    if (net.stopAskedAt >= s.startedAt && now - net.stopAskedAt > STOP_SETTLE_MS && now - s.lastAt > STOP_SETTLE_MS) return false;
    return true;
  }

  function topicOpen(t, now) {
    if (t.done || now - t.lastAt > TOPIC_IDLE_MS) return false;
    if (net.stopAskedAt >= t.firstAt && now - net.stopAskedAt > STOP_SETTLE_MS && now - t.lastAt > STOP_SETTLE_MS) return false;
    return true;
  }

  function netGenerating() {
    const now = Date.now();
    let open = false;
    for (const s of net.streams) {
      if (streamOpen(s, now)) open = true;
      else net.streams.delete(s);
    }
    for (const [id, t] of net.topics) {
      if (topicOpen(t, now)) open = true;
      else if (now - t.lastAt > 10 * 60_000) net.topics.delete(id);
    }
    return open;
  }

  function netChanged() {
    monitorKick();
  }

  function netTopic(id) {
    let t = net.topics.get(id);
    if (!t) {
      const now = Date.now();
      t = { firstAt: now, lastAt: now, done: false };
      net.topics.set(id, t);
      if (net.topics.size > 500) net.topics.delete(net.topics.keys().next().value);
    }
    return t;
  }

  function netStreamStart() {
    const now = Date.now();
    const s = { startedAt: now, lastAt: now, closed: false, topics: [] };
    net.streams.add(s);
    netChanged();
    return s;
  }

  function netStreamEvents(s, events) {
    s.lastAt = Date.now();
    for (const ev of events) {
      const m = Core.scanStreamEvent(ev);
      for (const id of m.topics) {
        s.topics.push(id);
        netTopic(id).lastAt = Date.now();
      }
      if (m.complete) {
        // The turn is complete: its handed-off topics are too.
        for (const id of s.topics) netTopic(id).done = true;
        s.closed = true;
        netChanged();
      } else if (m.done) {
        // [DONE]: the HTTP part is over; handed-off topics continue on the WebSocket.
        s.closed = true;
        netChanged();
      }
    }
  }

  function netStreamEnd(s) {
    if (s.closed) return;
    s.closed = true;
    netChanged();
  }

  let animated = null; // { el, text, since }
  /** The last answer still carries data-markdown-animated and its text changed recently. */
  function answerAnimating() {
    const sel = SELECTORS.streamingMarkdown.join(', ');
    if (!sel || !TURN_SELECTOR) return false;
    let list;
    try {
      list = document.querySelectorAll(sel);
    } catch {
      return false;
    }
    const el = list[list.length - 1];
    if (!el || !el.closest(TURN_SELECTOR)) {
      animated = null;
      return false;
    }
    const text = el.textContent || '';
    const now = Date.now();
    if (!animated || animated.el !== el || animated.text !== text) {
      animated = { el, text, since: now };
      return true;
    }
    return now - animated.since < ANIMATED_STALE_MS; // a stuck attribute must not block the tab forever
  }

  const domGenerating = () => !!findVisible(SELECTORS.stop) || answerAnimating();

  /** ChatGPT is producing a reply in this page (network state, then labelled stop controls, then the streaming answer). */
  const isGenerating = () => netGenerating() || domGenerating();

  let stopper = null;
  /**
   * Stop whatever reply streams in this page, or is about to (a send was just
   * clicked): clicks the stop control as soon as there is one, at most every
   * 1.5 s while something still streams, for STOP_RETRY_MS.
   */
  function requestStop(reason) {
    const now = Date.now();
    net.stopAskedAt = now;
    if (stopper) {
      stopper.until = now + STOP_RETRY_MS;
      return;
    }
    const s = { until: now + STOP_RETRY_MS, lastClick: 0 };
    stopper = s;
    const tick = () => {
      if (stopper !== s) return;
      const t = Date.now();
      if (t > s.until) {
        stopper = null;
        return;
      }
      if (t - s.lastClick >= 1500) {
        const btn = safe(findStopButton);
        if (btn) {
          s.lastClick = t;
          safe(() => pressButton(btn));
          log('debug', `clicked ChatGPT's stop control (${reason})`);
        }
      }
      if (s.lastClick && !isGenerating()) {
        stopper = null;
        return;
      }
      nativeSetTimeout(() => hop(tick), 250);
    };
    // Never click from inside the page's own call stack (e.g. its fetch() call): next task.
    hop(tick);
  }

  // ---------------------------------------------------------------------------
  // Page state (reported to the service worker)
  // ---------------------------------------------------------------------------

  /** Logged-in check through the cookie-authenticated session endpoint (cached; never keeps the token). */
  let sessionProbe = { at: 0, value: null, pending: null };
  function sessionLoggedIn() {
    if (sessionProbe.pending) return sessionProbe.pending;
    if (Date.now() - sessionProbe.at < SESSION_TTL_MS) return Promise.resolve(sessionProbe.value);
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
    let typing = false;
    let cloudflare = false;
    try {
      composer = findComposer();
      generating = isGenerating();
      login =
        isAuthPath() || (!composer && loginCtaVisible()) || (sessionProbe.value === false && Date.now() - sessionProbe.at < SESSION_TTL_MS);
      warning = currentWarning();
      turns = countTurns();
      typing = !busy && userIsTyping();
      cloudflare = isCloudflarePage();
      // Logged-out ChatGPT still shows a guest composer, and its login buttons may be
      // localized and carry no test id: ask the session endpoint (async, cached 60 s).
      if (config.worker && composer && !busy && !sessionProbe.pending && Date.now() - sessionProbe.at >= SESSION_TTL_MS)
        void sessionLoggedIn().then(() => monitorKick());
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
      cloudflare,
      hidden: document.visibilityState === 'hidden', // background tabs are throttled by the browser
      warning,
      turnCount: turns,
      emptyChat: turns === 0 && !conversationIdFromLocation() && !pageHadJob,
      heldConversationId: currentHeldConversation(),
      jobId: busy ? job.id : null,
      userTyping: typing,
      ready: !!composer && !generating && !login && !busy && !typing,
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

  /**
   * Worker tabs only: watch the DOM (throttled to 1/s) and report state changes,
   * plus a heartbeat every HEARTBEAT_MS (a frozen tab stops sending it). Holds a
   * Web Lock while it is a worker: Chrome does not freeze pages that hold one.
   */
  let monitor = null;
  function monitorKick() {
    if (monitor) monitor.schedule();
  }
  function startMonitor() {
    if (monitor) return;
    const m = { mo: null, timer: null, last: 0, schedule: null };
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
        attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label', 'aria-pressed', 'aria-checked', 'data-state', 'hidden', 'role', 'data-markdown-animated'],
      });
    } catch (e) {
      reportBug('monitor', e);
    }
    // Unchained timers (hop) so hidden-tab throttling does not stretch them to a minute.
    const poll = () => {
      if (monitor !== m) return;
      m.schedule();
      nativeSetTimeout(() => hop(poll), 5000);
    };
    const beat = () => {
      if (monitor !== m) return;
      sendState(true);
      nativeSetTimeout(() => hop(beat), HEARTBEAT_MS);
    };
    nativeSetTimeout(() => hop(poll), 5000);
    nativeSetTimeout(() => hop(beat), HEARTBEAT_MS);
    monitor = m;
    window.addEventListener('popstate', monitorKick);
    document.addEventListener('visibilitychange', monitorKick);
    holdWorkerLock();
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
    window.removeEventListener('popstate', monitorKick);
    document.removeEventListener('visibilitychange', monitorKick);
    releaseWorkerLock();
  }

  let workerLock = null;
  function holdWorkerLock() {
    if (workerLock || !nativeLocks || typeof nativeLocks.request !== 'function') return;
    const l = { release: null };
    workerLock = l;
    try {
      const p = nativeLocks.request(`webgpt4cc-worker-${pageId}`, () =>
        new Promise((resolve) => {
          l.release = resolve;
          if (workerLock !== l) resolve();
        }),
      );
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      workerLock = null;
    }
  }
  function releaseWorkerLock() {
    const l = workerLock;
    workerLock = null;
    if (l && l.release) l.release();
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
      idle: null, // primary composer button with an empty composer: { present, label }
      sentAt: 0,
      requestSeen: false,
      requestConversationId: null,
      requestMessageId: null, // messages[0].id of our request: pins our turn in the conversation document
      actualModel: '', // "model" of the request the page sent
      modelSlug: '', // resolved model slug from the stream metadata
      promptMismatch: null,
      bytes: 0,
      responseAt: 0,
      lastEventAt: 0,
      reducer: Core.createStreamState(),
      ws: Core.createWsTurnTracker(),
      wsBuffer: new Map(),
      wsDone: new Set(),
      wsError: null,
      lastWsAt: 0,
      httpEndedAt: 0,
      handoffWatch: false,
      idleWatch: false,
      recovering: false,
      recoverNoted: false,
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
    // A cancelled job ends as "aborted", even if its reply completed meanwhile.
    if (ctx.cancelled && event.type !== 'error') event = { type: 'error', code: 'aborted', message: 'cancelled' };
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
    monitorKick();
  }

  function failJob(ctx, code, message, retryAfterMs) {
    finishJob(ctx, { type: 'error', code, message: String(message).slice(0, 1000), ...(retryAfterMs ? { retryAfterMs } : {}) });
  }

  /** Fields every "done" carries besides the text: what model ran, and whether the prompt arrived intact. */
  function doneExtras(ctx) {
    const out = {};
    if (ctx.model) out.requestedModel = ctx.model;
    if (ctx.actualModel) out.actualModel = ctx.actualModel;
    if (ctx.modelSlug) out.modelSlug = ctx.modelSlug;
    if (ctx.promptMismatch) out.promptMismatch = ctx.promptMismatch;
    return out;
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
      if (ctx.cancelled) await ctx.completion.promise; // cancelJob reports the end
      else if (!ctx.finished) {
        if (e instanceof JobError) failJob(ctx, e.code, e.message, e.retryAfterMs);
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
    if (!ctx || ctx.id !== jobId || ctx.finished || ctx.cancelled) return;
    ctx.cancelled = true;
    const message = reason ? String(reason) : 'cancelled';
    let stopping = false;
    try {
      if (ctx.sentAt || isGenerating()) {
        requestStop('cancel');
        stopping = true;
      } else {
        clearEditor(findComposer()); // typed but not sent: leave the composer clean
      }
    } catch (e) {
      reportBug('cancel', e);
    }
    if (!stopping) {
      failJob(ctx, 'aborted', message);
      return;
    }
    // Report the end once the page stopped streaming (bounded), so the tab is not
    // announced ready while ChatGPT still generates the cancelled reply. The page
    // state keeps saying "generating" after that until the stream really ends.
    void (async () => {
      const end = Date.now() + CANCEL_SETTLE_MS;
      await sleep(150);
      while (Date.now() < end && isGenerating()) await sleep(200);
      failJob(ctx, 'aborted', message);
    })();
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
        if (isGenerating() || userIsTyping()) return null;
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
      if (isGenerating()) throw new JobError('ui_error', 'ChatGPT is still generating an earlier reply in the worker tab');
      if (userIsTyping()) throw new JobError('ui_error', 'someone is typing in the worker tab, so nothing was sent (use a dedicated worker tab)');
      if (isCloudflarePage()) throw new JobError('network', 'ChatGPT shows a Cloudflare check ("Just a moment…"); open the worker tab and complete it');
      const w = currentWarning();
      if (w) throw warningError(w);
      throw new JobError('ui_error', 'could not find the ChatGPT message box within 30 s (the page layout may have changed: see SELECTORS in content/page-agent.js)');
    }
    if (res.warning) throw warningError(res.warning);
    if (res.login) throw new JobError('not_logged_in', 'the worker tab is not logged in to ChatGPT: log in there and retry');
    // Logged-out chatgpt.com shows a working guest composer whose login buttons may be
    // localized and carry no test id: always ask the session endpoint (cached 60 s).
    if ((await sessionLoggedIn()) === false)
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

  /**
   * The Chat/Work switch of the composer: { mode: 'chat' | 'work' | null, chat, work }.
   * Controls inside the composer form are classified by data-mode/data-value/value,
   * then by (localized) labels; an unlabeled two-button switch whose selected
   * button is Work has Chat as its other button.
   */
  function detectComposerMode() {
    const out = { mode: null, chat: null, work: null };
    const form = composerForm();
    let controls = queryAll(SELECTORS.composerModeButtons);
    if (form) for (const el of queryAll(SELECTORS.composerModeControls, form)) if (!controls.includes(el)) controls.push(el);
    controls = controls.filter(isVisible);
    const modeOf = (el) =>
      Core.composerModeOf(el.getAttribute('data-mode') || el.getAttribute('data-value') || el.getAttribute('value'), el.textContent || labelOf(el));
    for (const el of controls) {
      const m = modeOf(el);
      if (m === 'work' && !out.work) out.work = el;
      if (m === 'chat' && !out.chat) out.chat = el;
    }
    const selected = controls.find((el) => isToggleSelected(el) && modeOf(el));
    if (selected) out.mode = modeOf(selected);
    if (out.mode === 'work' && !out.chat && form) {
      const group = selected.closest('[role="group"], [role="radiogroup"], [role="tablist"]');
      if (group && form.contains(group)) {
        const toggles = Array.from(group.querySelectorAll('button, [role="radio"], [role="tab"]')).filter(isVisible);
        if (toggles.length === 2) out.chat = toggles.find((b) => b !== selected) || null;
      }
    }
    if (!out.mode) {
      const c = findComposer();
      const holder = c && (c.matches('[data-placeholder]') ? c : c.querySelector('[data-placeholder]'));
      const ph = (holder && holder.getAttribute('data-placeholder')) || (c && c.getAttribute('placeholder')) || '';
      if (TEXT.workPlaceholder.test(ph.trim())) out.mode = 'work';
    }
    return out;
  }

  /**
   * Work mode draws on another quota and runs server-side agentic tools: switch
   * the composer to Chat before sending, verify it, and refuse to send otherwise.
   */
  async function ensureChatMode(ctx) {
    const workPath = /(?:^|\/)c\/WEB(?::|%3a)/i.test(location.pathname);
    if (workPath || (ctx.continueId && /^WEB(?::|%3a)/i.test(ctx.continueId)))
      // The bridge answers conversation_not_found by replaying the transcript into a new chat.
      throw new JobError('conversation_not_found', 'the ChatGPT conversation is a Work conversation and cannot be continued as a Chat');
    const mode = detectComposerMode();
    if (mode.mode !== 'work') return;
    if (!mode.chat)
      throw new JobError('aborted', "ChatGPT's composer is in Work mode and its Chat switch was not found; switch the worker tab to Chat and retry (nothing was sent)");
    pressButton(mode.chat);
    log('info', 'switched the ChatGPT composer from Work to Chat');
    const after = await waitFor(ctx, () => {
      const m = detectComposerMode().mode;
      return m === 'chat' ? 'chat' : null;
    }, 3000, 100);
    checkpoint(ctx);
    if (!after) {
      if (detectComposerMode().mode === 'work')
        throw new JobError('aborted', 'ChatGPT stayed in Work mode after clicking Chat; switch the worker tab to Chat and retry (nothing was sent)');
      log('warn', 'could not verify Chat mode after clicking Chat (the switch disappeared); the request is checked when it is sent');
    }
    await sleep(200);
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
    // The primary composer button with an empty composer is the voice button: remember its
    // label, so that only a changed label can be taken for Send (never start voice mode).
    const idleBtn = findPrimaryButton(composerForm(el));
    ctx.idle = { present: !!idleBtn, label: labelOf(idleBtn) };
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
      // A strict prefix of a large prompt: the composer cut it to size (ChatGPT truncates very
      // large messages). That is a size problem: too_long makes Claude Code compact.
      if (at === got.length && got.length < want.length && (want.length >= TRUNCATION_MIN_WANT || got.length >= TRUNCATION_MIN_GOT))
        throw new JobError(
          'too_long',
          `the ChatGPT composer kept only the first ${got.length} of the ${want.length} characters of the prompt (it truncates very large messages); nothing was sent`,
        );
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
    // From here on a reload may have sent the message (the service worker then must not re-run the job).
    status(ctx, 'sending');
    await sleep(500); // the send button can be disabled briefly after an insert
    checkpoint(ctx);
    const composer = findComposer();
    const t0 = Date.now();
    const found = await waitFor(
      ctx,
      () => {
        const b = findEnabledSend(composer, ctx);
        if (b) return { btn: b };
        // Nothing that looks like a send button at all: do not wait 5 s for one.
        if (Date.now() - t0 >= SEND_PROBE_MS && !sendCandidateExists(composer, ctx)) return { btn: null };
        return null;
      },
      5000,
      150,
    );
    checkpoint(ctx);
    const btn = found ? found.btn : null;
    // Re-check right before sending (synchronously with the click): anything typed into the
    // tab meanwhile would otherwise go out with the prompt.
    const want = Core.normalizeEditorText(ctx.prompt);
    const current = findComposer();
    if (composerText(current) !== want) {
      clearEditor(current);
      throw new JobError('ui_error', 'the ChatGPT composer changed before sending (did someone type in the worker tab?); nothing was sent');
    }
    pageHadJob = true;
    ctx.sentAt = Date.now();
    if (btn) pressButton(btn);
    else pressEnter(current || composer);

    let seen = await waitRequest(ctx, 4000);
    if (!seen && !ctx.finished && btn) {
      const el = findComposer();
      if (el && composerText(el) === want && !isGenerating()) {
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
    if (events.length) ctx.lastEventAt = Date.now();
    for (const ev of events) {
      if (config.debug) debugFrame(ctx, source, ev);
      ctx.reducer.push(ev);
    }
  }

  function onStreamEnd(ctx, tail, reason) {
    if (ctx.finished) return;
    if (tail && tail.length) feedEvents(ctx, tail, 'http');
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
    if (/too long|too large|context length|maximum context|太长|過長|过长/i.test(text)) return { code: 'too_long' };
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

  /** Stop the reply and refuse a turn that ChatGPT runs in Work mode. */
  function tripWorkMode(ctx, why) {
    if (ctx.finished) return;
    requestStop('Work mode');
    failJob(
      ctx,
      'aborted',
      `ChatGPT ran this turn in Work mode (${why}), so it was stopped: Work uses another quota and runs server-side tools. Switch the worker tab's composer to Chat and retry.`,
    );
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
    const work = Core.workModeReason({
      productExperience: snap.productExperience,
      requestedModelExperience: snap.requestedModelExperience,
      slug: snap.modelSlug,
      conversationId: snap.conversationId,
    });
    if (work) {
      tripWorkMode(ctx, work);
      return;
    }
    if (!ctx.modelLogged && snap.modelSlug) {
      ctx.modelLogged = true;
      ctx.modelSlug = snap.modelSlug;
      if (ctx.model && !Core.sameModel(snap.modelSlug, ctx.model)) log('info', `requested ChatGPT model "${ctx.model}", the stream reports "${snap.modelSlug}"`);
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
      ...doneExtras(ctx),
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

  /** A stream that stays open but delivers no events (keep-alives do not count) is read back instead. */
  function armIdleWatchdog(ctx) {
    if (ctx.idleWatch) return;
    ctx.idleWatch = true;
    const check = () => {
      if (ctx.recovering) return;
      const last = Math.max(ctx.lastEventAt, ctx.lastWsAt, ctx.responseAt);
      if (Date.now() - last > STREAM_IDLE_MS) void recover(ctx, `the ChatGPT stream delivered nothing for ${Math.round(STREAM_IDLE_MS / 1000)} s`);
      else addTimer(ctx, check, 30_000);
    };
    addTimer(ctx, check, 30_000);
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
   * Fallback when the stream broke, stalled or was not observed: read the answer
   * from GET /backend-api/conversation/{id}. While ChatGPT says the answer is
   * still in progress, keep polling (with backoff) until the job's deadline;
   * give up early only on errors that will not resolve (403 / challenge / 404) or
   * when our turn never shows up. Non-destructive meanwhile: if the stream (or a
   * resumed one) completes, that wins.
   */
  async function recover(ctx, reason) {
    if (ctx.finished || ctx.recovering) return;
    ctx.recovering = true;
    log('warn', `${reason}; reading the reply back from the conversation`);
    try {
      status(ctx, 'recovering', reason);
      const startedAt = Date.now();
      const dom = { text: null, since: Date.now() };
      let interval = 3000;
      let lastGet = 0;
      let missingSince = 0; // no answer (or not ours) since
      let progress = { text: null, since: Date.now() };
      let blocked = false;
      let detail = 'no conversation id';
      for (;;) {
        checkpoint(ctx);
        const now = Date.now();
        // The page looks done: nothing streams, no stop control, answer text stable 1.5 s.
        const t = lastAssistantDomText();
        if (t !== dom.text) {
          dom.text = t;
          dom.since = now;
        }
        const terminal = !isGenerating() && now - dom.since >= 1500;
        const snap = ctx.reducer.snapshot();
        const id = snap.conversationId || ctx.requestConversationId || conversationIdFromLocation();
        if (!id || blocked) {
          if (terminal) break;
        } else if (now - lastGet >= (terminal ? interval : Math.max(interval, 10_000))) {
          lastGet = now;
          const r = await fetchConversationAnswer(id, ctx);
          if (ctx.finished) return;
          if (r.ok) {
            finishJob(ctx, {
              type: 'done',
              text: r.answer.text,
              conversationId: r.answer.conversationId || id,
              ...(r.answer.messageId ? { messageId: r.answer.messageId } : {}),
              finishReason: r.answer.finishReason || 'stop',
              ...doneExtras(ctx),
            });
            return;
          }
          detail = r.reason;
          if (r.fatal) blocked = true;
          else {
            // Every 3 s for the first 30 s, then backing off to every 15 s.
            interval = Date.now() - startedAt < 30_000 ? 3000 : Math.min(Math.round(interval * 1.5), 15_000);
            const at = Date.now();
            if (r.state === 'in_progress') {
              missingSince = 0;
              if (r.text !== progress.text) progress = { text: r.text, since: at };
              else if (terminal && at - progress.since > IN_PROGRESS_STALE_MS) break;
            } else {
              if (!missingSince) missingSince = at;
              if (terminal && at - missingSince > NO_ANSWER_MAX_MS) break;
            }
          }
        }
        if (Date.now() - startedAt > 10_000 && !ctx.recoverNoted) {
          ctx.recoverNoted = true;
          log('info', `still reading the reply back (${detail})`);
        }
        await sleep(500);
      }
      const snap = ctx.reducer.snapshot();
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

  // Headers of the page's own /backend-api requests, reused for our read-back so it looks
  // like the page's (workspace accounts need Chatgpt-Account-Id). Never the authorization.
  const CAPTURED_HEADERS = ['chatgpt-account-id', 'oai-device-id', 'oai-client-version', 'oai-language'];
  const pageHeaders = {};

  function headerValue(h, name) {
    if (!h) return null;
    try {
      if (typeof h.get === 'function' && typeof h.has === 'function') return h.has(name) ? h.get(name) : null; // Headers
      if (Array.isArray(h)) {
        for (const pair of h) if (Array.isArray(pair) && String(pair[0]).toLowerCase() === name) return String(pair[1]);
        return null;
      }
      if (typeof h === 'object') for (const k of Object.keys(h)) if (k.toLowerCase() === name) return String(h[k]);
    } catch {
      /* ignore */
    }
    return null;
  }

  function captureHeaders(args) {
    const init = args[1];
    const input = args[0];
    const sources = [init && init.headers, input && typeof input === 'object' ? input.headers : null];
    for (const name of CAPTURED_HEADERS)
      for (const h of sources) {
        const v = headerValue(h, name);
        if (v == null) continue;
        if (/^[\x21-\x7e][\x20-\x7e]{0,199}$/.test(v)) pageHeaders[name] = v;
        break;
      }
  }

  let accountProbe = null;
  /** Workspace (Team/Business) account id from the _account cookie, mapped through accounts/check (once). */
  function workspaceAccountId(token) {
    let ws = '';
    try {
      const m = /(?:^|;\s*)_account=([^;]+)/.exec(document.cookie || '');
      ws = m ? decodeURIComponent(m[1]) : '';
    } catch {
      ws = '';
    }
    if (!ws || ws === 'personal') return Promise.resolve(null);
    if (!accountProbe)
      accountProbe = (async () => {
        try {
          const r = await nativeFetch.call(window, '/backend-api/accounts/check/v4-2023-04-27', {
            credentials: 'include',
            cache: 'no-store',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          });
          if (!r.ok) return null;
          const j = await r.json();
          const a = j && j.accounts && j.accounts[ws];
          const id = a && a.account && a.account.account_id;
          return typeof id === 'string' && /^[\w-]{1,100}$/.test(id) ? id : null;
        } catch {
          return null;
        }
      })();
    return accountProbe;
  }

  /**
   * GET /backend-api/conversation/{id}, pinned to our turn. Never stores or logs the token.
   * Returns { ok, answer } or { ok: false, reason, fatal?, state?, text? } where state is
   * 'in_progress' (keep waiting), 'missing' (no answer for our turn yet) or 'error'.
   */
  async function fetchConversationAnswer(id, ctx) {
    try {
      const s = await nativeFetch.call(window, '/api/auth/session', { credentials: 'include', cache: 'no-store' });
      if (!s.ok) return { ok: false, state: 'error', reason: `auth session HTTP ${s.status}` };
      let token = '';
      try {
        const j = await s.json();
        token = j && typeof j.accessToken === 'string' ? j.accessToken : '';
      } catch {
        token = '';
      }
      if (!token) return { ok: false, fatal: true, reason: 'no access token in the auth session (logged out?)' };
      const headers = { ...pageHeaders, Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (!headers['chatgpt-account-id']) {
        const account = await workspaceAccountId(token);
        if (account) headers['chatgpt-account-id'] = account;
      }
      const r = await nativeFetch.call(window, `/backend-api/conversation/${encodeURIComponent(id)}`, {
        credentials: 'include',
        cache: 'no-store',
        headers,
      });
      token = '';
      const ct = r.headers.get('content-type') || '';
      if (r.status === 401 || r.status === 403 || /text\/html/i.test(ct)) return { ok: false, fatal: true, reason: `conversation read blocked (HTTP ${r.status})` };
      if (r.status === 404) return { ok: false, fatal: true, reason: 'conversation read HTTP 404 (not found)' };
      if (!r.ok) return { ok: false, state: 'error', reason: `conversation read HTTP ${r.status}` };
      const ans = Core.answerFromConversation(await r.json(), { userMessageId: ctx.requestMessageId, prompt: ctx.prompt });
      if (ans && ans.userMissing) return { ok: false, state: 'missing', reason: 'our message is not in the conversation (yet)' };
      if (!ans || !ans.text) return { ok: false, state: 'missing', reason: 'no answer in the conversation yet' };
      if (!ans.finished) return { ok: false, state: 'in_progress', text: ans.text, reason: 'the answer is still being generated' };
      return { ok: true, answer: ans };
    } catch (e) {
      return { ok: false, state: 'error', reason: `conversation read failed (${e && e.name ? e.name : 'error'})` };
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
    let isRequest = false;
    if (typeof input === 'string') url = input;
    else if (input && typeof input.url === 'string') {
      url = input.url; // Request
      method = input.method || '';
      isRequest = true;
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
    const rawBody = init && 'body' in init ? init.body : undefined;
    return {
      pathname: u.pathname,
      method: (method || 'GET').toUpperCase(),
      body: typeof rawBody === 'string' ? rawBody : null,
      rawBody,
      isRequest,
    };
  }

  /**
   * Before the native call (its Request body is consumed by it): when our job's
   * conversation request is a Request object without init.body, clone it to read
   * the body. Only then, and only for that request.
   */
  function preObserve(args) {
    const ctx = job;
    if (!ctx || !ctx.armed || ctx.finished || ctx.requestSeen) return null;
    const input = args[0];
    const init = args[1];
    if (!NativeRequest || !(input instanceof NativeRequest) || (init && 'body' in init)) return null;
    if (String(input.method || '').toUpperCase() !== 'POST') return null;
    let u;
    try {
      u = new URL(input.url, location.href);
    } catch {
      return null;
    }
    if (!Core.isConversationPath(u.pathname) || Core.isResumePath(u.pathname)) return null;
    return { bodyText: input.clone().text() };
  }

  /** Read the request body (string, Blob, buffer, or a pre-cloned Request) and correlate it with our job. */
  function inspectRequestBody(ctx, info, pre) {
    if (info.body !== null) {
      inspectBodyText(ctx, info.body);
      return;
    }
    let p = null;
    try {
      const b = info.rawBody;
      if (pre && pre.bodyText) p = pre.bodyText;
      else if (b && typeof Blob !== 'undefined' && b instanceof Blob) p = b.text();
      else if (b && b instanceof ArrayBuffer) p = Promise.resolve(new TextDecoder().decode(new Uint8Array(b)));
      else if (b && ArrayBuffer.isView(b)) p = Promise.resolve(new TextDecoder().decode(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
      else if (b && typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) p = Promise.resolve(b.toString());
    } catch {
      p = null;
    }
    if (!p) {
      log('warn', 'the conversation request body could not be read; the sent text is not checked');
      return;
    }
    p.then(
      (text) => safe(() => inspectBodyText(ctx, String(text))),
      () => {},
    );
  }

  /**
   * The request body is the authoritative record of what ChatGPT received:
   *  * Work mode (conversation_mode / a "-wm" model) -> stop and refuse the turn;
   *  * the model the page asked for vs the one the bridge wanted;
   *  * the exact text vs our prompt (only outer whitespace may differ). A strict,
   *    much shorter prefix is a size cut (too_long); other changes are reported
   *    (status "prompt_mismatch" and done.promptMismatch) so the bridge can warn.
   */
  function inspectBodyText(ctx, body) {
    if (ctx.finished) return;
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      return; // not JSON
    }
    if (!isObj(j)) return;
    if (typeof j.conversation_id === 'string') ctx.requestConversationId = j.conversation_id;
    if (ctx.continueId && j.conversation_id && j.conversation_id !== ctx.continueId)
      log('warn', `the request continues conversation ${j.conversation_id}, expected ${ctx.continueId}`);
    if (!ctx.continueId && j.conversation_id) log('warn', `a new-chat job was sent into existing conversation ${j.conversation_id}`);
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const first = isObj(msgs[0]) ? msgs[0] : null;
    if (first && typeof first.id === 'string') ctx.requestMessageId = first.id;

    const mode = isObj(j.conversation_mode) ? j.conversation_mode.kind : undefined;
    const work = Core.workModeReason({ conversationMode: mode, model: j.model, conversationId: j.conversation_id });
    if (work) {
      tripWorkMode(ctx, work);
      return;
    }

    if (typeof j.model === 'string') {
      ctx.actualModel = j.model;
      if (ctx.model && !Core.sameModel(j.model, ctx.model)) {
        const detail = `requested "${ctx.model}", the ChatGPT page sent "${j.model}" (the ?model= URL parameter may be ignored: pick the model in the worker tab)`;
        log('warn', detail);
        emit(ctx, { type: 'status', status: 'model_mismatch', detail });
      }
    }

    const parts = first && isObj(first.content) && Array.isArray(first.content.parts) ? first.content.parts : null;
    if (!parts) return;
    const sent = parts.filter((p) => typeof p === 'string').join('');
    const diff = Core.comparePromptFidelity(sent, ctx.prompt);
    if (!diff) return;
    ctx.promptMismatch = diff;
    if (diff.kinds.includes('truncated') && (diff.wantChars - diff.sentChars >= 2000 || diff.sentChars < diff.wantChars * 0.9)) {
      // A reply to half a prompt is worthless (and could act on half a tool result): stop it.
      // A large prompt cut to size is a size problem (too_long makes Claude Code compact).
      requestStop('truncated prompt');
      const large = diff.wantChars >= TRUNCATION_MIN_WANT || diff.sentChars >= TRUNCATION_MIN_GOT;
      failJob(
        ctx,
        large ? 'too_long' : 'ui_error',
        `ChatGPT sent only ${diff.sentChars} of the ${diff.wantChars} characters of the prompt (${large ? 'it truncates very large messages' : 'the composer lost the rest'}), so the reply was stopped`,
      );
      return;
    }
    const detail = JSON.stringify(diff);
    log('warn', `the text ChatGPT sent differs from the prompt (${diff.kinds.join(', ')}) from character ${diff.offset}`, diff);
    emit(ctx, { type: 'status', status: 'prompt_mismatch', detail });
  }

  /** A 429 on Sentinel / conduit prepare after our click: the send was refused for rate limiting. */
  function watchSendPipeline(ctx, result) {
    if (!ctx.sentAt || ctx.requestSeen) return;
    Promise.resolve(result).then(
      (resp) =>
        safe(() => {
          if (!resp || resp.status !== 429 || ctx.finished || ctx.requestSeen) return;
          let p;
          try {
            p = resp.clone().text();
          } catch {
            p = Promise.resolve('');
          }
          p.catch(() => '').then((text) =>
            safe(() => {
              if (ctx.finished || ctx.requestSeen) return;
              const e = Core.classifyHttpError(429, text, resp.headers.get('content-type'), resp.headers.get('retry-after'));
              failJob(ctx, 'rate_limited', e.message, e.retryAfterMs);
            }),
          );
        }),
      () => {},
    );
  }

  /** Called synchronously inside our fetch wrapper, before the page sees the promise. */
  function maybeObserve(args, result, pre) {
    const tracking = config.worker;
    const ctx = job && job.armed && !job.finished ? job : null;
    if (!tracking && !ctx) return; // other tabs: never touch the user's own requests
    const info = describeRequest(args);
    if (!info) return;
    if (tracking && info.pathname.startsWith('/backend-api/')) captureHeaders(args);
    if (info.method !== 'POST') return;
    if (ctx && Core.isSendPipelinePath(info.pathname)) {
      watchSendPipeline(ctx, result);
      return;
    }
    if (!Core.isConversationPath(info.pathname)) return;
    const resume = Core.isResumePath(info.pathname);
    const stream = netStreamStart();
    let mine = null;
    if (ctx && !ctx.cancelled) {
      if (resume ? ctx.requestSeen : !ctx.requestSeen) mine = ctx;
      else log('debug', `ignoring a ${resume ? 'resume' : 'second conversation'} request during the job`);
    }
    // A resume continues an interrupted stream: same messages (shared reducer), new byte stream.
    if (mine && resume) log('debug', 'ChatGPT resumed the conversation stream');
    if (mine && !resume) {
      mine.requestSeen = true;
      inspectRequestBody(mine, info, pre);
      mine.requestSignal.resolve(true);
    }
    // Registered before we hand the promise back, so this runs before the page's
    // own continuation and can wrap the body before the page reads it.
    Promise.resolve(result).then(
      (resp) => safe(() => onResponse(stream, mine, resp, resume)),
      (err) => safe(() => onFetchFailed(stream, mine, err, resume)),
    );
  }

  function onFetchFailed(stream, ctx, err, resume) {
    netStreamEnd(stream);
    if (!ctx || ctx.finished || resume) return;
    if (err && err.name === 'AbortError') {
      void recover(ctx, 'the conversation request was aborted');
      return;
    }
    void recover(ctx, `the conversation request failed (${err && err.message ? err.message : 'network error'})`);
  }

  function onResponse(stream, ctx, resp, resume) {
    if (!resp) {
      netStreamEnd(stream);
      return;
    }
    if (ctx && ctx.finished) ctx = null;
    const ct = (resp.headers && resp.headers.get('content-type')) || '';
    if (resp.status >= 400) {
      netStreamEnd(stream);
      if (!ctx) return;
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
    if (ctx) ctx.responseAt = Date.now();
    if (!resp.body) {
      netStreamEnd(stream);
      if (ctx) onStreamEnd(ctx, null, 'empty response body');
      return;
    }
    if (ctx && !/event-stream/i.test(ct)) log('warn', `conversation response has content-type "${ct}"; reading it as SSE anyway`);
    const parser = Core.createSseParser(); // one per HTTP stream (a resume gets its own)
    observeBody(resp, {
      bytes: (chunk) => onStreamChunk(stream, ctx, parser, chunk),
      end: (reason) => {
        const tail = parser.flush();
        if (tail.length) netStreamEvents(stream, tail);
        netStreamEnd(stream);
        if (ctx) onStreamEnd(ctx, tail, reason);
      },
    });
    if (ctx && !resume) armNoDataWatchdog(ctx);
    if (ctx) armIdleWatchdog(ctx);
  }

  function onStreamChunk(stream, ctx, parser, chunk) {
    let input = chunk;
    if (typeof chunk !== 'string') {
      if (chunk instanceof Uint8Array) input = chunk;
      else if (chunk && ArrayBuffer.isView(chunk)) input = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else return;
    }
    const events = parser.feed(input);
    stream.lastAt = Date.now();
    if (events.length) netStreamEvents(stream, events);
    if (!ctx || ctx.finished) return;
    ctx.bytes += input.length;
    if (events.length) {
      feedEvents(ctx, events, 'http');
      afterUpdate(ctx);
    }
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
  function observeBody(resp, handlers) {
    const body = resp.body;
    let closed = false;
    const sink = {
      bytes: (chunk) => {
        if (!closed) handlers.bytes(chunk);
      },
      end: (reason) => {
        if (closed) return;
        closed = true;
        handlers.end(reason);
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
        let pre = null;
        try {
          pre = preObserve(args);
        } catch (e) {
          pre = null;
          reportBug('fetch hook (body)', e);
        }
        const result = Reflect.apply(target, thisArg, args); // the native call, always, with the page's own arguments
        try {
          maybeObserve(args, result, pre);
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
    if (typeof data !== 'string' || data.indexOf('conversation-turn') === -1) return;
    const ctx = job && !job.finished && job.requestSeen ? job : null;
    if (!ctx && !config.worker) return;
    const items = Core.extractWsTurnItems(data);
    if (!items.length) return;
    // Page level: which turn topics still stream (also turns that are not ours).
    const now = Date.now();
    for (const it of items) {
      const t = netTopic(it.topicId);
      t.lastAt = now;
      if (it.type === 'done' || it.type === 'error') t.done = true;
      else if (it.type === 'chunk' && it.encodedItem.indexOf('message_stream_complete') !== -1 && Core.parseSseBlock(it.encodedItem).some((ev) => Core.scanStreamEvent(ev).complete))
        t.done = true;
    }
    netChanged();
    if (!ctx) return;
    const r = ctx.ws.processItems(items);
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

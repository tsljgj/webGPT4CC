// webGPT4CC stream core: the pure logic of the page agent, kept free of DOM and
// chrome.* access so that it also runs (and is unit-tested) in Node.
//
// Loaded as the first file of the MAIN-world content script (before
// page-agent.js) and attached to globalThis.WebGPT4CC_Core.
//
//  * SSE line parser (byte chunks in, {event, data} out; UTF-8 safe across chunk boundaries)
//  * ChatGPT "delta_encoding v1" reducer + final-answer selection
//  * private-use marker sanitizing ( …  rich-UI blocks)
//  * WebSocket "conversation-turn" stream-item decoding with stream_item_id dedupe
//  * composer (ProseMirror) text reader / normalizer and paste chunking
//  * UI-warning, HTTP-error and retry-after classification
//  * answer extraction from GET /backend-api/conversation/{id}
//  * redaction of raw frames for the opt-in debug log
//
// The delta reducer and WebSocket envelope handling follow the behaviour
// documented by UnlastingR/sse-devtools-panel (MIT, (c) 2026 FatMii) and the
// composer reading rules follow steipete/oracle (MIT, (c) 2026 Peter
// Steinberger). The code here is an independent implementation.
(function (root) {
  'use strict';

  const CORE_VERSION = 1;
  if (root.WebGPT4CC_Core && root.WebGPT4CC_Core.version === CORE_VERSION) return;

  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

  // ---------------------------------------------------------------------------
  // Conversation endpoints
  // ---------------------------------------------------------------------------

  const CONVERSATION_PATHS = new Set([
    '/backend-api/f/conversation',
    '/backend-api/f/conversation/resume',
    '/backend-api/conversation', // legacy POST endpoint (GET /backend-api/conversation/{id} does not match)
  ]);

  function isConversationPath(pathname) {
    return CONVERSATION_PATHS.has(String(pathname || '').replace(/\/+$/, ''));
  }

  function isResumePath(pathname) {
    return /\/conversation\/resume\/?$/.test(String(pathname || ''));
  }

  // ---------------------------------------------------------------------------
  // SSE parser
  // ---------------------------------------------------------------------------

  /**
   * Incremental text/event-stream parser. feed() accepts Uint8Array chunks (decoded
   * as UTF-8 with streaming, so a multi-byte character split across chunks is
   * fine) or strings, and returns the events completed by that chunk.
   * Events: { event: string ('message' when unnamed), data: string }.
   */
  function createSseParser() {
    let decoder = null;
    let buf = '';
    let dataLines = [];
    let hasData = false;
    let eventName = '';
    let out = [];

    function dispatch() {
      if (hasData) out.push({ event: eventName || 'message', data: dataLines.join('\n') });
      dataLines = [];
      hasData = false;
      eventName = '';
    }

    function processLine(line) {
      if (line === '') return dispatch();
      if (line.charCodeAt(0) === 58 /* ':' */) return; // comment / keep-alive
      const i = line.indexOf(':');
      let field = line;
      let value = '';
      if (i !== -1) {
        field = line.slice(0, i);
        value = line.slice(i + 1);
        if (value.charCodeAt(0) === 32) value = value.slice(1);
      }
      if (field === 'data') {
        dataLines.push(value);
        hasData = true;
      } else if (field === 'event') {
        eventName = value;
      }
      // "id" and "retry" are irrelevant here.
    }

    function feedText(text) {
      if (!text) return;
      buf += text;
      const re = /\r\n|\r|\n/g;
      let start = 0;
      let m;
      while ((m = re.exec(buf))) {
        // A lone '\r' at the very end may be the first half of '\r\n': wait for more input.
        if (m[0] === '\r' && m.index === buf.length - 1) break;
        processLine(buf.slice(start, m.index));
        start = m.index + m[0].length;
      }
      buf = buf.slice(start);
    }

    function drain() {
      const r = out;
      out = [];
      return r;
    }

    return {
      /** @param {Uint8Array|ArrayBufferView|string} chunk */
      feed(chunk) {
        if (typeof chunk === 'string') {
          feedText(chunk);
        } else if (chunk) {
          if (!decoder) decoder = new TextDecoder('utf-8');
          const bytes =
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength);
          feedText(decoder.decode(bytes, { stream: true }));
        }
        return drain();
      },
      /** End of stream: process any buffered partial line and pending event. */
      flush() {
        if (decoder) feedText(decoder.decode());
        if (buf) {
          processLine(buf.replace(/\r$/, ''));
          buf = '';
        }
        dispatch();
        return drain();
      },
    };
  }

  /** Parse one self-contained block of SSE text (e.g. a WebSocket encoded_item). */
  function parseSseBlock(text) {
    const p = createSseParser();
    return p.feed(String(text || '')).concat(p.flush());
  }

  // ---------------------------------------------------------------------------
  // Answer selection + sanitizing
  // ---------------------------------------------------------------------------

  /** Join the string parts of a message's content. */
  function messageText(msg) {
    const c = msg && msg.content;
    if (!isObj(c)) return '';
    if (Array.isArray(c.parts)) return c.parts.filter((p) => typeof p === 'string').join('\n\n');
    if (typeof c.text === 'string') return c.text;
    return '';
  }

  /**
   * Is this message eligible to be "the answer"? Assistant text (or multimodal
   * text with string parts) addressed to everyone, not hidden, not a thinking
   * preamble, on the final channel or without a channel.
   */
  function isAnswerCandidate(m) {
    if (!isObj(m)) return false;
    if (!isObj(m.author) || m.author.role !== 'assistant') return false;
    if (m.recipient != null && m.recipient !== '' && m.recipient !== 'all') return false;
    const c = m.content;
    if (!isObj(c)) return false;
    if (c.content_type === 'multimodal_text') {
      if (!Array.isArray(c.parts) || !c.parts.some((p) => typeof p === 'string')) return false;
    } else if (c.content_type !== 'text') {
      return false;
    }
    const md = isObj(m.metadata) ? m.metadata : {};
    if (md.is_visually_hidden_from_conversation === true) return false;
    if (md.is_thinking_preamble_message === true) return false;
    if (m.channel != null && m.channel !== 'final') return false;
    return true;
  }

  /** The last final-channel answer candidate, else the last channel-less one. */
  function selectAnswer(messages) {
    let lastFinal = null;
    let lastPlain = null;
    for (const m of messages || []) {
      if (!isAnswerCandidate(m)) continue;
      if (m.channel === 'final') lastFinal = m;
      else lastPlain = m;
    }
    return lastFinal || lastPlain;
  }

  /** Reasoning / tool / commentary traffic that means "the model is still thinking". */
  function isReasoningMessage(m) {
    if (!isObj(m) || !isObj(m.author)) return false;
    if (m.author.role !== 'assistant' && m.author.role !== 'tool') return false;
    return !isAnswerCandidate(m);
  }

  /**
   * Remove ChatGPT's private-use rich-UI markers: blocks  … 
   * (citations, navlists, genui widgets, products;  separates fields
   * inside them), an unterminated block at the very end (still streaming), and
   * any stray marker characters -. Other text is left untouched.
   */
  function sanitizeAnswerText(text) {
    if (typeof text !== 'string') return '';
    if (!/[-]/.test(text)) return text;
    let t = text;
    for (let i = 0; i < 8; i++) {
      const next = t.replace(/[^]*/g, '');
      if (next === t) break;
      t = next;
    }
    t = t.replace(/[^]*$/, '');
    return t.replace(/[-]/g, '');
  }

  function finishReasonOf(m) {
    const fd = m && isObj(m.metadata) && m.metadata.finish_details;
    return isObj(fd) && typeof fd.type === 'string' ? fd.type : null;
  }

  function errorText(e) {
    if (typeof e === 'string') return e;
    if (isObj(e)) {
      for (const k of ['message', 'detail', 'code', 'type']) if (typeof e[k] === 'string' && e[k]) return e[k];
      try {
        return JSON.stringify(e).slice(0, 500);
      } catch {
        /* fall through */
      }
    }
    return String(e);
  }

  // ---------------------------------------------------------------------------
  // delta_encoding v1 reducer
  // ---------------------------------------------------------------------------

  function splitPointer(path) {
    if (!path) return [];
    return String(path)
      .split('/')
      .slice(path.startsWith('/') ? 1 : 0)
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  }

  function joinPointer(base, child) {
    if (!base) return child || '';
    if (!child) return base;
    return child.startsWith('/') ? base + child : `${base}/${child}`;
  }

  const getKey = (obj, k) => (Array.isArray(obj) ? obj[k === '-' ? obj.length : Number(k)] : obj[k]);
  function setKey(obj, k, v) {
    if (Array.isArray(obj)) {
      if (k === '-') obj.push(v);
      else obj[Number(k)] = v;
    } else {
      obj[k] = v;
    }
  }

  /** Apply one op at a JSON-pointer path (already split) below `target`. */
  function applyAt(target, parts, op, value) {
    if (!parts.length || parts.some((p) => FORBIDDEN_KEYS.has(p))) return;
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      let next = getKey(cur, k);
      if (typeof next !== 'object' || next === null) {
        if (op === 'remove' || op === 'truncate') return;
        next = /^\d+$/.test(parts[i + 1]) || parts[i + 1] === '-' ? [] : {};
        setKey(cur, k, next);
      }
      cur = next;
    }
    const last = parts[parts.length - 1];
    switch (op) {
      case 'add':
      case 'replace':
        setKey(cur, last, value);
        break;
      case 'append': {
        const ex = getKey(cur, last);
        if (typeof ex === 'string' && typeof value === 'string') setKey(cur, last, ex + value);
        else if (Array.isArray(ex)) Array.isArray(value) ? ex.push(...value) : ex.push(value);
        else if (isObj(ex) && isObj(value)) Object.assign(ex, value);
        else setKey(cur, last, value); // nothing (or something incompatible) there yet
        break;
      }
      case 'remove':
        if (Array.isArray(cur)) cur.splice(Number(last), 1);
        else delete cur[last];
        break;
      case 'truncate': {
        // Believed to exist (truncate to length v); handled defensively.
        const ex = getKey(cur, last);
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) break;
        if (typeof ex === 'string') setKey(cur, last, ex.slice(0, n));
        else if (Array.isArray(ex)) ex.length = Math.min(ex.length, n);
        break;
      }
      default:
        break; // unknown op: ignore
    }
  }

  /**
   * Reducer for ChatGPT's conversation stream. push() takes parsed SSE events;
   * snapshot() reports the current answer and stream flags.
   */
  function createStreamState() {
    const st = {
      messages: new Map(), // id -> raw message object (patched in place)
      order: [],
      current: null, // id of the message that implicit-path ops apply to
      lastP: '',
      lastO: '',
      conversationId: null,
      modelSlug: null,
      encoding: null,
      complete: false, // message_stream_complete seen
      doneSeen: false, // data: [DONE] seen
      error: null,
      handoffTopics: [],
      title: null,
      frames: 0,
      parseErrors: 0,
      anon: 0,
    };

    function ingestMessage(m) {
      if (!isObj(m)) return;
      const id = typeof m.id === 'string' && m.id ? m.id : `anon-${++st.anon}`;
      if (!st.messages.has(id)) st.order.push(id);
      // A snapshot replaces what we had for that id (resumes/catch-ups resend full messages).
      st.messages.set(id, m);
      st.current = id;
      st.lastP = '';
      st.lastO = '';
    }

    function applyOp(path, op, value) {
      if (op === 'patch') {
        if (!Array.isArray(value)) return;
        for (const child of value) {
          if (!isObj(child) || typeof child.o !== 'string') continue;
          applyOp(joinPointer(path, typeof child.p === 'string' ? child.p : ''), child.o, child.v);
        }
        return;
      }
      const parts = splitPointer(path);
      if (!parts.length) {
        // Root-level add/replace of a whole {message} envelope.
        if ((op === 'add' || op === 'replace') && isObj(value) && isObj(value.message)) {
          if (typeof value.conversation_id === 'string') st.conversationId = value.conversation_id;
          ingestMessage(value.message);
        }
        return;
      }
      if (parts[0] !== 'message') {
        if (parts.length === 1 && parts[0] === 'conversation_id' && typeof value === 'string') st.conversationId = value;
        return;
      }
      const msg = st.current ? st.messages.get(st.current) : null;
      if (!msg) return;
      if (parts.length === 1) {
        // "/message" itself
        if ((op === 'add' || op === 'replace') && isObj(value)) {
          const id = st.current;
          st.messages.set(id, Object.assign(value, { id: typeof value.id === 'string' ? value.id : id }));
        } else if (op === 'append' && isObj(value)) {
          Object.assign(msg, value);
        }
        return;
      }
      applyAt(msg, parts.slice(1), op, value);
    }

    function applyDelta(obj) {
      const hasP = typeof obj.p === 'string';
      const hasO = typeof obj.o === 'string';
      const v = obj.v;
      // {"v":{"message":…}} or {"p":"","o":"add","v":{"message":…}}: a new current message.
      if (isObj(v) && isObj(v.message) && (!hasP || obj.p === '') && (!hasO || obj.o === 'add' || obj.o === 'replace')) {
        if (typeof v.conversation_id === 'string') st.conversationId = v.conversation_id;
        if (v.error) st.error = errorText(v.error);
        ingestMessage(v.message);
        return;
      }
      // Implicit inheritance: a frame without p and/or o reuses the previous ones.
      if (hasP) st.lastP = obj.p;
      if (hasO) st.lastO = obj.o;
      if (!('v' in obj) && !(hasO && obj.o === 'remove')) return; // "remove" needs no value
      applyOp(st.lastP, st.lastO, v);
    }

    function handleTyped(obj) {
      switch (obj.type) {
        case 'server_ste_metadata': {
          const md = isObj(obj.metadata) ? obj.metadata : {};
          const slug = md.resolved_model_slug || md.model_slug;
          if (typeof slug === 'string') st.modelSlug = slug;
          return true;
        }
        case 'stream_handoff': {
          const add = (t) => {
            if (typeof t === 'string' && t && !st.handoffTopics.includes(t)) st.handoffTopics.push(t);
          };
          if (Array.isArray(obj.options)) for (const o of obj.options) if (isObj(o)) add(o.topic_id);
          add(obj.topic_id);
          return true;
        }
        case 'message_stream_complete':
          st.complete = true;
          return true;
        case 'title_generation':
          if (typeof obj.title === 'string') st.title = obj.title;
          return true;
        case 'input_message':
        case 'message_marker':
        case 'conversation_detail_metadata':
        case 'resume_conversation_token': // carries a credential: never stored or logged
        case 'safety_review_update':
        case 'url_moderation':
          return true;
        default:
          return false;
      }
    }

    function push(ev) {
      if (!ev) return;
      if (ev.event === 'delta_encoding') {
        try {
          st.encoding = JSON.parse(ev.data);
        } catch {
          st.encoding = String(ev.data);
        }
        return;
      }
      const data = typeof ev.data === 'string' ? ev.data.trim() : '';
      if (!data) return;
      if (data === '[DONE]') {
        st.doneSeen = true;
        return;
      }
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        st.parseErrors++;
        return;
      }
      if (!isObj(obj)) return; // e.g. the "v1" string
      st.frames++;
      if (typeof obj.conversation_id === 'string' && obj.conversation_id) st.conversationId = obj.conversation_id;
      if (obj.error) {
        st.error = errorText(obj.error);
        return;
      }
      if (typeof obj.type === 'string' && handleTyped(obj)) return;
      if ('v' in obj || 'p' in obj || 'o' in obj) return applyDelta(obj);
      // Non-delta full-message frame: {"message": {...}, "conversation_id": "..."}
      if (isObj(obj.message)) ingestMessage(obj.message);
    }

    function messages() {
      return st.order.map((id) => st.messages.get(id));
    }

    function snapshot() {
      const msgs = messages();
      const answer = selectAnswer(msgs);
      const text = answer ? sanitizeAnswerText(messageText(answer)) : '';
      const finish = answer ? finishReasonOf(answer) : null;
      const answerFinished = !!answer && (answer.status === 'finished_successfully' || answer.end_turn === true || !!finish);
      return {
        text,
        messageId: answer && typeof answer.id === 'string' && !answer.id.startsWith('anon-') ? answer.id : null,
        conversationId: st.conversationId,
        finishReason: finish || (answerFinished || st.complete ? 'stop' : null),
        answerStatus: answer ? answer.status || null : null,
        answerFinished,
        thinking: !text && msgs.some(isReasoningMessage),
        modelSlug: st.modelSlug,
        complete: st.complete,
        doneSeen: st.doneSeen,
        error: st.error,
        handoffTopics: st.handoffTopics.slice(),
        title: st.title,
        messageCount: msgs.length,
        frames: st.frames,
      };
    }

    return {
      push,
      pushAll(events) {
        for (const ev of events || []) push(ev);
      },
      snapshot,
      messages,
      state: st,
    };
  }

  // ---------------------------------------------------------------------------
  // WebSocket turn stream (stream_handoff continuation)
  // ---------------------------------------------------------------------------

  function collectTopicEntry(entry, out) {
    if (!isObj(entry) || entry.type !== 'message') return;
    const topicId = entry.topic_id;
    if (typeof topicId !== 'string' || !topicId.startsWith('conversation-turn-')) return;
    const outer = entry.payload;
    if (!isObj(outer) || outer.type !== 'conversation-turn-stream' || !isObj(outer.payload)) return;
    const p = outer.payload;
    if (p.type === 'done') out.push({ topicId, type: 'done' });
    else if (p.type === 'error')
      out.push({ topicId, type: 'error', message: typeof p.message === 'string' ? p.message : 'WebSocket turn error' });
    else if (p.type === 'stream-item' && typeof p.encoded_item === 'string')
      out.push({
        topicId,
        type: 'chunk',
        encodedItem: p.encoded_item,
        streamItemId: typeof p.stream_item_id === 'string' ? p.stream_item_id : null,
      });
  }

  /** Turn-stream items in one WebSocket frame (also inside subscribe-reply catch-ups). */
  function extractWsTurnItems(value) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }
    const out = [];
    for (const raw of Array.isArray(value) ? value : [value]) {
      if (!isObj(raw)) continue;
      collectTopicEntry(raw, out);
      if (raw.type === 'reply' && isObj(raw.reply) && Array.isArray(raw.reply.catchups))
        for (const c of raw.reply.catchups) collectTopicEntry(c, out);
    }
    return out;
  }

  /**
   * Per-topic dedupe by stream_item_id (catch-ups re-deliver items). process()
   * returns { chunks:[{topicId,text}], done:[topicId], errors:[{topicId,message}] }.
   */
  function createWsTurnTracker() {
    const topics = new Map();
    const topic = (id) => {
      let t = topics.get(id);
      if (!t) topics.set(id, (t = { seen: new Set(), ended: false }));
      return t;
    };
    return {
      process(value) {
        const res = { chunks: [], done: [], errors: [] };
        for (const item of extractWsTurnItems(value)) {
          const t = topic(item.topicId);
          if (t.ended) continue;
          if (item.type === 'done') {
            t.ended = true;
            res.done.push(item.topicId);
          } else if (item.type === 'error') {
            t.ended = true;
            res.errors.push({ topicId: item.topicId, message: item.message });
          } else {
            if (item.streamItemId) {
              if (t.seen.has(item.streamItemId)) continue;
              t.seen.add(item.streamItemId);
            }
            res.chunks.push({ topicId: item.topicId, text: item.encodedItem });
          }
        }
        return res;
      },
      ended(topicId) {
        return !!topics.get(topicId)?.ended;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Composer text
  // ---------------------------------------------------------------------------

  const BLOCK_TAGS = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6])$/;

  function hasClass(node, cls) {
    if (node.classList && typeof node.classList.contains === 'function') return node.classList.contains(cls);
    return String(node.className || '')
      .split(/\s+/)
      .includes(cls);
  }

  function isBlock(node) {
    return !!node && node.nodeType === 1 && BLOCK_TAGS.test(String(node.nodeName || '').toUpperCase());
  }

  /**
   * Read the text of a composer element the way the user typed it: text nodes,
   * <br> as "\n" (except ProseMirror's decorative trailing break) and a "\n"
   * at every boundary next to a block element. (innerText would add layout
   * spacing between paragraphs.) Works on any object with nodeType/nodeName/
   * nodeValue/childNodes, so it is testable without a DOM.
   */
  function readEditorText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
    const name = String(node.nodeName || '').toUpperCase();
    if (name === 'TEXTAREA' || name === 'INPUT') return String(node.value == null ? '' : node.value);
    if (name === 'BR') return hasClass(node, 'ProseMirror-trailingBreak') ? '' : '\n';
    const kids = Array.from(node.childNodes || []);
    let out = '';
    for (let i = 0; i < kids.length; i++) {
      if (i > 0 && (isBlock(kids[i]) || isBlock(kids[i - 1]))) out += '\n';
      out += readEditorText(kids[i]);
    }
    return out;
  }

  /** Normalize for comparing prompt vs composer: line endings, NBSP, zero-width chars, trailing whitespace. */
  function normalizeEditorText(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .replace(/[​﻿]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\s+$/, '');
  }

  /** Split a prompt into paste chunks of at most `max` chars, never inside a surrogate pair or a CRLF. */
  function splitPasteChunks(text, max = 4000) {
    const s = String(text || '');
    const size = Math.max(2, Math.floor(max));
    const out = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(i + size, s.length);
      if (end < s.length) {
        const c = s.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end--;
        if (s[end - 1] === '\r' && s[end] === '\n') end--;
        if (end <= i) end = Math.min(i + size, s.length);
      }
      out.push(s.slice(i, end));
      i = end;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Error / warning classification
  // ---------------------------------------------------------------------------

  /**
   * Classify visible UI warning text (dialogs, toasts, banners):
   * 'rate_limit' | 'usage_cap' | 'temporary_unavailable' | 'auth_or_challenge' | null.
   */
  function classifyUiWarning(text) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return null;
    if (
      /\btoo many requests\b/.test(t) ||
      /\bsending too many requests\b/.test(t) ||
      /\btoo quickly\b/.test(t) ||
      /\btemporarily limited access\b/.test(t) ||
      /\bplease wait a few minutes\b/.test(t) ||
      /\brate limit(?:ed)?\b/.test(t) ||
      /\bslow down\b/.test(t)
    )
      return 'rate_limit';
    if (/\blimits?\b/.test(t) && /\b(?:resets?|until)\b/.test(t)) return 'usage_cap';
    if (
      /\btemporarily unavailable\b/.test(t) ||
      /\bsomething went wrong\b/.test(t) ||
      /\bfailed to generate\b/.test(t) ||
      /\btry again later\b/.test(t)
    )
      return 'temporary_unavailable';
    if (
      /\bverify you are human\b/.test(t) ||
      /\bunusual activity\b/.test(t) ||
      /\bcloudflare\b/.test(t) ||
      /\bchallenge\b/.test(t) ||
      /\blogin required\b/.test(t) ||
      /\bsign in\b/.test(t)
    )
      return 'auth_or_challenge';
    return null;
  }

  /**
   * Best-effort "when can we retry" from human text: "in 20 minutes",
   * "after 3:45 PM", "until 17:30". Returns milliseconds or undefined.
   */
  function parseRetryAfter(text, now = Date.now()) {
    const t = String(text || '');
    const rel = /\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i.exec(t);
    if (rel) {
      const n = Number(rel[1]);
      const u = rel[2].toLowerCase();
      const unit = u.startsWith('s') ? 1e3 : u.startsWith('m') ? 60e3 : u.startsWith('h') ? 3600e3 : 86400e3;
      return Math.round(n * unit);
    }
    const abs = /\b(?:at|after|until)\s+(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?(?=[\s.,;!)]|$)/i.exec(t);
    if (abs && (abs[2] || abs[3])) {
      let h = Number(abs[1]);
      const min = Number(abs[2] || 0);
      const ap = abs[3] ? abs[3].toLowerCase() : '';
      if (ap === 'p' && h < 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
      if (h > 23 || min > 59) return undefined;
      const d = new Date(now);
      d.setHours(h, min, 0, 0);
      let ms = d.getTime() - now;
      if (ms <= 0) ms += 86400e3;
      return ms;
    }
    return undefined;
  }

  /**
   * Map a failed conversation request to a bridge error code.
   * Returns { code, message, retryAfterMs? }.
   */
  function classifyHttpError(status, bodyText, contentType, retryAfterHeader) {
    const body = String(bodyText || '').slice(0, 8000);
    const lower = body.toLowerCase();
    const html = /text\/html/i.test(String(contentType || '')) || /^\s*<(?:!doctype|html)/i.test(body);
    const cloudflare = lower.includes('cf-mitigated') || (html && (lower.includes('cloudflare') || lower.includes('just a moment')));
    let detail = null;
    try {
      const j = JSON.parse(body);
      if (isObj(j)) detail = j.detail !== undefined ? j.detail : j.error !== undefined ? j.error : null;
    } catch {
      /* not JSON */
    }
    let message = '';
    if (typeof detail === 'string') message = detail;
    else if (isObj(detail)) message = errorText(detail);
    if (!message) message = html ? `HTTP ${status} (HTML page)` : body.trim().slice(0, 300) || `HTTP ${status}`;
    message = `ChatGPT answered HTTP ${status}: ${message.slice(0, 300)}`;

    if (status === 429) {
      let retryAfterMs;
      const clears = isObj(detail) ? Number(detail.clears_in) : NaN;
      if (Number.isFinite(clears) && clears > 0) retryAfterMs = Math.round(clears * 1000);
      else if (retryAfterHeader != null && Number.isFinite(Number(retryAfterHeader)))
        retryAfterMs = Math.round(Number(retryAfterHeader) * 1000);
      else retryAfterMs = parseRetryAfter(message);
      return retryAfterMs ? { code: 'rate_limited', message, retryAfterMs } : { code: 'rate_limited', message };
    }
    if (status === 413 || /\b(?:too long|too large|maximum context|context length)\b/.test(lower))
      return { code: 'too_long', message };
    if (status === 401 || status === 403) {
      if (cloudflare) return { code: 'network', message: `ChatGPT's Cloudflare check blocked the request (HTTP ${status}); open the worker tab and reload it` };
      if (/unusual activity/.test(lower)) return { code: 'network', message };
      return { code: 'not_logged_in', message };
    }
    return { code: 'network', message };
  }

  // ---------------------------------------------------------------------------
  // GET /backend-api/conversation/{id}
  // ---------------------------------------------------------------------------

  /**
   * The answer of the latest turn in a conversation document: walk from
   * current_node to the root, keep the messages after the last user message,
   * apply the same answer filter as the stream.
   */
  function answerFromConversation(doc) {
    if (!isObj(doc) || !isObj(doc.mapping)) return null;
    const chain = [];
    const seen = new Set();
    let id = doc.current_node;
    while (typeof id === 'string' && !seen.has(id) && isObj(doc.mapping[id])) {
      seen.add(id);
      chain.push(doc.mapping[id]);
      id = doc.mapping[id].parent;
    }
    chain.reverse();
    let start = 0;
    chain.forEach((node, i) => {
      if (isObj(node.message) && isObj(node.message.author) && node.message.author.role === 'user') start = i + 1;
    });
    const msgs = chain.slice(start).map((n) => n.message).filter(isObj);
    const ans = selectAnswer(msgs);
    if (!ans) return null;
    return {
      text: sanitizeAnswerText(messageText(ans)),
      messageId: typeof ans.id === 'string' ? ans.id : null,
      conversationId: typeof doc.conversation_id === 'string' ? doc.conversation_id : typeof doc.id === 'string' ? doc.id : null,
      finishReason: finishReasonOf(ans),
      finished: ans.status === 'finished_successfully' || ans.end_turn === true,
    };
  }

  // ---------------------------------------------------------------------------
  // Debug-log redaction
  // ---------------------------------------------------------------------------

  /** Redact credentials from a raw frame before it leaves the page (debug log only). */
  function redactFrame(text, maxLen = 4000) {
    let t = String(text == null ? '' : text);
    t = t.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');
    t = t.replace(
      /("(?:token|accessToken|access_token|refresh_token|authorization|conduit_token|resume_conversation_token|sentinel_token|proof_token|turnstile_token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"[REDACTED]"',
    );
    if (t.length > maxLen) t = `${t.slice(0, maxLen)}…[+${t.length - maxLen} chars]`;
    return t;
  }

  root.WebGPT4CC_Core = Object.freeze({
    version: CORE_VERSION,
    isConversationPath,
    isResumePath,
    createSseParser,
    parseSseBlock,
    createStreamState,
    selectAnswer,
    isAnswerCandidate,
    messageText,
    sanitizeAnswerText,
    extractWsTurnItems,
    createWsTurnTracker,
    readEditorText,
    normalizeEditorText,
    splitPasteChunks,
    classifyUiWarning,
    parseRetryAfter,
    classifyHttpError,
    answerFromConversation,
    redactFrame,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

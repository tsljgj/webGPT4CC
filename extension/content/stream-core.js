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

  const CORE_VERSION = 2;
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

  /**
   * Requests the page makes between a click on Send and the conversation POST
   * (Sentinel and conduit prepare). A 429 there means the send was refused for
   * rate limiting even though no conversation request follows.
   */
  function isSendPipelinePath(pathname) {
    return /^\/backend-api\/(?:sentinel\/chat-requirements(?:\/[\w-]+)?|f\/conversation\/prepare)\/?$/.test(String(pathname || ''));
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

  /**
   * Visible reasoning so far, for Claude Code's thinking block: each thought as
   * "summary\ncontent", then commentary preambles ("Creating the file now."), in
   * stream order, so the text normally grows as a prefix while streaming.
   */
  function reasoningText(messages) {
    const parts = [];
    for (const m of messages || []) {
      if (!isObj(m) || !isObj(m.author) || m.author.role !== 'assistant' || !isObj(m.content)) continue;
      const md = isObj(m.metadata) ? m.metadata : {};
      if (md.is_visually_hidden_from_conversation === true) continue;
      const c = m.content;
      if (c.content_type === 'thoughts' && Array.isArray(c.thoughts)) {
        for (const t of c.thoughts) {
          if (!isObj(t)) continue;
          const entry = [t.summary, t.content]
            .filter((x) => typeof x === 'string' && x.trim())
            .map((x) => x.trim())
            .join('\n');
          if (entry) parts.push(entry);
        }
      } else if (
        c.content_type === 'text' &&
        m.channel === 'commentary' &&
        (m.recipient == null || m.recipient === '' || m.recipient === 'all')
      ) {
        const t = messageText(m).trim();
        if (t) parts.push(t);
      }
    }
    return sanitizeAnswerText(parts.join('\n\n'));
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
      productExperience: null, // server_ste_metadata: "chat" or "work"
      requestedModelExperience: null,
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
          if (typeof md.product_experience === 'string') st.productExperience = md.product_experience;
          if (typeof md.requested_model_experience === 'string') st.requestedModelExperience = md.requested_model_experience;
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
        reasoning: text ? '' : reasoningText(msgs),
        modelSlug: st.modelSlug,
        productExperience: st.productExperience,
        requestedModelExperience: st.requestedModelExperience,
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
    function processItems(items) {
      const res = { chunks: [], done: [], errors: [] };
      for (const item of items || []) {
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
    }
    return {
      /** A raw WebSocket frame (string or parsed JSON). */
      process(value) {
        return processItems(extractWsTurnItems(value));
      },
      /** Items already extracted with extractWsTurnItems. */
      processItems,
      ended(topicId) {
        return !!topics.get(topicId)?.ended;
      },
    };
  }

  /**
   * Cheap look at one SSE event for the page-level "is a reply streaming" tracker
   * (which also watches conversation requests that are not ours): does it end
   * the stream, or hand it off to WebSocket topics? Only frames that mention a
   * marker are parsed.
   * Returns { complete, done, topics: string[] }.
   */
  function scanStreamEvent(ev) {
    const out = { complete: false, done: false, topics: [] };
    const data = ev && typeof ev.data === 'string' ? ev.data.trim() : '';
    if (!data) return out;
    if (data === '[DONE]') {
      out.done = true;
      return out;
    }
    if (data.indexOf('message_stream_complete') === -1 && data.indexOf('stream_handoff') === -1) return out;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return out;
    }
    if (!isObj(obj)) return out;
    if (obj.type === 'message_stream_complete') out.complete = true;
    else if (obj.type === 'stream_handoff') {
      const add = (t) => {
        if (typeof t === 'string' && t && !out.topics.includes(t)) out.topics.push(t);
      };
      if (Array.isArray(obj.options)) for (const o of obj.options) if (isObj(o)) add(o.topic_id);
      add(obj.topic_id);
    }
    return out;
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
  // Localized wording (zh-CN / zh-TW / ja) next to the English patterns: the UI
  // text follows the account's language, so English-only patterns miss every
  // limit dialog of a Chinese or Japanese UI. Network signals (HTTP 429) are
  // classified independently of language; these are the DOM fallback.
  const RATE_LIMIT_LOCAL = /请求过多|请求太多|请求过于频繁|过于频繁|太频繁|发送(?:得|的)?太快|速度太快|暂时限制|已暂时限制|请稍等几分钟|請求過多|過於頻繁|暫時限制|リクエストが多すぎ|リクエスト数が多すぎ/;
  const USAGE_CAP_LOCAL =
    /(?:已达到|已达|达到了|达到|已用完|用完了|用尽了?|已用盡|已達到|達到|已達)[^。.!！?？]{0,40}(?:上限|限额|限制|额度|額度|限額)|(?:上限|限额|额度|額度|限額)[^。.!！?？]{0,40}(?:重置|恢复|恢復)|上限に達し|制限に達し/;
  const TEMPORARY_LOCAL = /出错了|出了点问题|出现错误|发生错误|暂时不可用|暂不可用|无法生成|生成失败|稍后再试|稍後再試|网络错误|網路錯誤|發生錯誤|エラーが発生|しばらくしてから/;
  const CHALLENGE_LOCAL = /验证你是真人|验证您是真人|确认你是真人|确认您是真人|驗證您是真人|异常活动|可疑活动|異常活動|请登录|請登入|请重新登录|重新登录|重新登入|登录已过期|会话已过期|ログインしてください|再度ログイン/;

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
      /\bslow down\b/.test(t) ||
      RATE_LIMIT_LOCAL.test(t)
    )
      return 'rate_limit';
    if ((/\blimits?\b/.test(t) && /\b(?:resets?|until)\b/.test(t)) || USAGE_CAP_LOCAL.test(t)) return 'usage_cap';
    if (
      /\btemporarily unavailable\b/.test(t) ||
      /\bsomething went wrong\b/.test(t) ||
      /\bfailed to generate\b/.test(t) ||
      /\btry again later\b/.test(t) ||
      TEMPORARY_LOCAL.test(t)
    )
      return 'temporary_unavailable';
    if (
      /\bverify you are human\b/.test(t) ||
      /\bunusual activity\b/.test(t) ||
      /\bcloudflare\b/.test(t) ||
      /\bchallenge\b/.test(t) ||
      /\blogin required\b/.test(t) ||
      /\bsign in\b/.test(t) ||
      CHALLENGE_LOCAL.test(t)
    )
      return 'auth_or_challenge';
    return null;
  }

  /** Milliseconds until the next local hh:mm (tomorrow if that time already passed today). */
  function msUntilClock(h, min, now) {
    if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return undefined;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    let ms = d.getTime() - now;
    if (ms <= 0) ms += 86400e3;
    return ms;
  }

  /**
   * Best-effort "when can we retry" from human text: "in 20 minutes",
   * "after 3:45 PM", "until 17:30", "20 分钟后", "将于 18:30 后重置",
   * "下午6:30". Returns milliseconds or undefined.
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
    // zh / ja relative: "20 分钟后", "3个小时后", "1 小時後", "30秒后", "20分後"
    const relLocal = /(\d+(?:\.\d+)?)\s*[个個]?\s*(秒钟|秒鐘|秒|分钟|分鐘|分|小时|小時|時間|天|日)\s*(?:之?后|之?後|以后|以後)/.exec(t);
    if (relLocal) {
      const n = Number(relLocal[1]);
      const u = relLocal[2];
      const unit = u.startsWith('秒') ? 1e3 : u.startsWith('分') ? 60e3 : /^(?:小|時)/.test(u) ? 3600e3 : 86400e3;
      return Math.round(n * unit);
    }
    const abs = /\b(?:at|after|until)\s+(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?(?=[\s.,;!)]|$)/i.exec(t);
    if (abs && (abs[2] || abs[3])) {
      let h = Number(abs[1]);
      const min = Number(abs[2] || 0);
      const ap = abs[3] ? abs[3].toLowerCase() : '';
      if (ap === 'p' && h < 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
      return msUntilClock(h, min, now);
    }
    // zh / ja clock time: "18:30", "下午6:30", "上午 9：05", "午後6:30"
    const absLocal = /(上午|下午|晚上|凌晨|中午|早上|午前|午後)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/.exec(t);
    if (absLocal) {
      let h = Number(absLocal[2]);
      const min = Number(absLocal[3]);
      const part = absLocal[1] || '';
      if (/下午|晚上|午後/.test(part) && h < 12) h += 12;
      if (/上午|凌晨|早上|午前/.test(part) && h === 12) h = 0;
      return msUntilClock(h, min, now);
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

  /** Text compared loosely (whitespace runs and markdown backslash escapes ignored). */
  function looseText(s) {
    return String(s || '')
      .replace(/\\(?=[^\w\s])/g, '')
      .replace(/[\s ​﻿]+/g, ' ')
      .trim();
  }

  const isUserNode = (node) => isObj(node) && isObj(node.message) && isObj(node.message.author) && node.message.author.role === 'user';

  /**
   * The answer to a turn in a conversation document: walk from current_node to
   * the root, keep the messages after that turn's user message (up to the next
   * user message), apply the same answer filter as the stream.
   *
   * `opts.userMessageId` (messages[0].id of the observed request) or
   * `opts.prompt` (the text we sent) pins the turn. If neither is found in the
   * conversation, our message never got stored there: the result is
   * `{ userMissing: true }` instead of the previous turn's answer. Without opts
   * the latest turn is used.
   */
  function answerFromConversation(doc, opts) {
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
    const o = isObj(opts) ? opts : {};
    const pinned = (typeof o.userMessageId === 'string' && o.userMessageId) || (typeof o.prompt === 'string' && o.prompt.trim());
    let userIdx = -1;
    if (pinned) {
      if (typeof o.userMessageId === 'string' && o.userMessageId)
        userIdx = chain.findIndex((n) => isUserNode(n) && n.message.id === o.userMessageId);
      if (userIdx < 0 && typeof o.prompt === 'string' && o.prompt.trim()) {
        const want = looseText(o.prompt).slice(0, 2000);
        for (let i = chain.length - 1; i >= 0; i--) {
          if (!isUserNode(chain[i])) continue;
          if (looseText(messageText(chain[i].message)).slice(0, 2000) === want) userIdx = i;
          break; // only the latest user message can be ours
        }
      }
      if (userIdx < 0) return { userMissing: true, text: '', messageId: null, conversationId: null, finishReason: null, finished: false };
    } else {
      chain.forEach((node, i) => {
        if (isUserNode(node)) userIdx = i;
      });
    }
    let end = chain.length;
    for (let i = userIdx + 1; i < chain.length; i++)
      if (isUserNode(chain[i])) {
        end = i;
        break;
      }
    const msgs = chain.slice(userIdx + 1, end).map((n) => n.message).filter(isObj);
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
  // Prompt fidelity (outgoing request vs the prompt we pasted)
  // ---------------------------------------------------------------------------

  // Each normalizer removes one kind of change a markdown composer could make.
  const FIDELITY_NORMALIZERS = [
    ['zero-width', (s) => s.replace(/[​‌‍⁠﻿]/g, '')],
    ['nbsp', (s) => s.replace(/ /g, ' ')],
    ['unicode-normalization', (s) => (typeof s.normalize === 'function' ? s.normalize('NFC') : s)],
    ['backslash-escape', (s) => s.replace(/\\([\\`*_{}[\]()#+\-.!<>~|])/g, '$1')],
    ['trailing-whitespace', (s) => s.replace(/[ \t ]+$/gm, '')],
    ['tabs-or-spaces', (s) => s.replace(/[\t  ]+/g, ' ')],
    ['blank-lines', (s) => s.replace(/\n{2,}/g, '\n')],
  ];

  /**
   * Compare the text ChatGPT's page actually sent (messages[0].content.parts)
   * with the prompt we pasted. Only whitespace at the very start and end of the
   * whole message is allowed to differ. Returns null when they match, else
   * { offset, sentChars, wantChars, kinds } where `kinds` names the changes
   * ("truncated" when the sent text is a strict prefix; otherwise the
   * normalizers above that explain the difference, or "other").
   */
  function comparePromptFidelity(sentRaw, wantRaw) {
    const sent = String(sentRaw == null ? '' : sentRaw).replace(/\r\n?/g, '\n');
    const want = String(wantRaw == null ? '' : wantRaw).replace(/\r\n?/g, '\n');
    const a = sent.trim();
    const b = want.trim();
    if (a === b) return null;
    let offset = 0;
    while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
    const result = { offset, sentChars: sent.length, wantChars: want.length, kinds: [] };
    if (a.length < b.length && b.startsWith(a)) {
      result.kinds.push('truncated');
      return result;
    }
    for (const [name, fn] of FIDELITY_NORMALIZERS) {
      if (fn(a) === fn(b)) {
        result.kinds.push(name);
        return result;
      }
    }
    let x = a;
    let y = b;
    const changed = [];
    for (const [name, fn] of FIDELITY_NORMALIZERS) {
      const nx = fn(x);
      const ny = fn(y);
      if (nx !== x || ny !== y) changed.push(name);
      x = nx;
      y = ny;
    }
    result.kinds = x === y ? changed : ['other'];
    return result;
  }

  // ---------------------------------------------------------------------------
  // Chat / Work mode, model names
  // ---------------------------------------------------------------------------

  const WORK_LABELS = new Set(['work', '工作', 'ワーク', '作業']);
  const CHAT_LABELS = new Set(['chat', '聊天', '对话', '對話', '交談', 'チャット']);

  /** 'work' | 'chat' | null for a composer mode control, from its value attributes, then its label. */
  function composerModeOf(value, label) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'work' || v === 'chat') return v;
    const l = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (WORK_LABELS.has(l)) return 'work';
    if (CHAT_LABELS.has(l)) return 'chat';
    return null;
  }

  /**
   * Why a turn is a Work-mode turn (Work draws on another quota and runs agentic
   * server-side tools), or null. Inputs come from the request body
   * (conversation_mode.kind, model), server_ste_metadata and the conversation id.
   */
  function workModeReason(sig) {
    const s = isObj(sig) ? sig : {};
    const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : '');
    if (lc(s.conversationMode) === 'work') return 'the request has conversation_mode "work"';
    if (lc(s.productExperience) === 'work') return 'ChatGPT reports product_experience "work"';
    if (lc(s.requestedModelExperience) === 'work') return 'ChatGPT reports requested_model_experience "work"';
    for (const m of [s.model, s.slug]) if (typeof m === 'string' && /-wm(?:$|[-_.])/i.test(m)) return `model "${m}" is a Work model`;
    if (typeof s.conversationId === 'string' && /^WEB(?::|%3a)/i.test(s.conversationId)) return `conversation ${s.conversationId} is a Work conversation`;
    return null;
  }

  /** Model names compared loosely ("gpt-5.5" == "GPT-5-5"). Empty or "auto" never matches a concrete model. */
  function sameModel(a, b) {
    const n = (s) =>
      String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[._\s]+/g, '-');
    return n(a) === n(b);
  }

  // ---------------------------------------------------------------------------
  // Cloudflare interstitial
  // ---------------------------------------------------------------------------

  /**
   * Classify a page from cheap DOM facts. Cloudflare bot management loads its
   * /challenge-platform/ script on normal ChatGPT pages too, so the script alone
   * is only weak evidence (it counts after it persists on a short page without
   * the app shell). strong: challenge title, widget, or verification text on a
   * short page, and no app shell. shell: ChatGPT rendered, never a challenge.
   */
  function cloudflareVerdict(f) {
    const x = isObj(f) ? f : {};
    const title = String(x.title || '').toLowerCase();
    const titleSays =
      /just a moment|请稍候|請稍候|しばらくお待ちください|un instant|einen moment|un momento/.test(title) ||
      (title.includes('attention required') && title.includes('cloudflare'));
    const body = String(x.bodyText || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const isShort = body.length < 600;
    const says =
      /verify(?:ing)? you are human|checking your browser|needs to review the security of your connection|just a moment|确认您是真人|确认你是真人|验证您是真人|验证你是真人|正在验证|正在检查(?:您|你)的浏览器|需要检查(?:您|你)的连接|人間であることを確認/.test(
        body,
      );
    const shell = !!x.hasAppShell;
    return {
      strong: !shell && (titleSays || !!x.hasChallengeWidget || (isShort && says)),
      shell,
      weak: !shell && !!x.hasChallengeScript && isShort,
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
    isSendPipelinePath,
    createSseParser,
    parseSseBlock,
    createStreamState,
    scanStreamEvent,
    selectAnswer,
    isAnswerCandidate,
    messageText,
    reasoningText,
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
    comparePromptFidelity,
    composerModeOf,
    workModeReason,
    sameModel,
    cloudflareVerdict,
    redactFrame,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

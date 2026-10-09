// Fake chatgpt.com front end for the webGPT4CC end-to-end tests.
//
// It mimics what the browser extension touches on the real site (2026-09 layout,
// see docs/EXTENSION.md): a ProseMirror-like composer inside
// form[data-chatgpt-composer], "Send prompt" / "Stop" buttons, the Chat/Work
// switch, assistant turns keyed by data-content-search-unit-key, and the network
// traffic of a send: Sentinel calls, then POST /backend-api/f/conversation whose
// delta-v1 SSE body is read with response.body.getReader() (the extension
// observes exactly that reader), optionally continued over a ws.chatgpt.com
// WebSocket topic after a stream_handoff.
//
// Deliberately realistic traps: the rendered answer is lossy markdown (DOM text
// is NOT the raw reply), a single large paste becomes a "Pasted text" chip, and
// pasted HTML is parsed like ProseMirror does by default (whitespace collapses
// unless the pasted block has white-space: pre/pre-wrap; text/plain-only pastes
// split into one paragraph per line and drop blank lines).
//
// Test-only hook: window.__fakeChatGPT (composer text, state). The extension must
// not use it.
(function () {
  'use strict';

  const CONFIG = Object.assign(
    { composerMode: 'chat', hydrationDelayMs: 300, pasteChipThreshold: 10000 },
    window.__FAKE_CHATGPT__ || {},
  );
  const params = new URLSearchParams(location.search);
  const state = {
    token: null,
    temporary: params.get('temporary-chat') === 'true',
    model: params.get('model') || 'auto',
    mode: CONFIG.composerMode === 'work' ? 'work' : 'chat',
    conversationId: null,
    currentNode: null,
    turnCount: 0,
    generating: null,
    chips: [],
    deviceId: crypto.randomUUID(),
    loadedAt: Date.now(),
  };
  let root, editor, attachmentsEl, submitSlot, thread, announcer, modeGroup, historyEl;

  // ------------------------------------------------------------------ helpers

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const authHeaders = () => ({ authorization: `Bearer ${state.token}`, 'oai-device-id': state.deviceId, 'oai-language': 'en-US' });

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} -> ${r.status}`), { status: r.status });
    return r.json();
  }

  function toast(text) {
    const t = h('div', { class: 'toast', role: 'alert', 'data-testid': 'toast' }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 8000);
  }

  // ---------------------------------------------------------- composer model
  //
  // The document is an array of paragraphs; '\n' inside a paragraph is a hard
  // break (<br>). The DOM is always re-rendered from this model in ProseMirror's
  // shape: <p>text<br>text</p>, an empty or break-terminated paragraph gets a
  // <br class="ProseMirror-trailingBreak">, an empty document is the placeholder
  // paragraph. Native edits (execCommand, innerHTML + input, typing) are read
  // back from the DOM by a MutationObserver, like ProseMirror's DOMObserver.

  let paras = [''];
  let rendering = false;
  let observer = null;

  const serialize = () => paras.join('\n');
  const isEmpty = () => serialize().trim() === '';
  const endPos = () => ({ p: paras.length - 1, o: paras[paras.length - 1].length });
  const BLOCK = /^(P|DIV|PRE|LI|H[1-6]|BLOCKQUOTE|TR|UL|OL|TABLE)$/;

  function renderEditor(caret) {
    rendering = true;
    editor.textContent = '';
    renderShape(editor);
    if (caret) setCaret(caret);
    observer.takeRecords();
    rendering = false;
    updateSubmit();
  }

  /** Text of a subtree in composer terms (<br> = '\n', trailing breaks ignored). */
  function nodeText(node) {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) s += c.data;
      else if (c.nodeName === 'BR') {
        if (!c.classList.contains('ProseMirror-trailingBreak')) s += '\n';
      } else if (c.nodeType === Node.ELEMENT_NODE) s += nodeText(c);
    }
    return s;
  }

  /** Like nodeText, but a <br> that ends a block is the browser's placeholder, not content. */
  function blockText(el) {
    let s = nodeText(el);
    const last = [...el.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && n.data === '')).pop();
    if (last && last.nodeName === 'BR' && !last.classList.contains('ProseMirror-trailingBreak')) s = s.slice(0, -1);
    return s;
  }

  function posFromBoundary(container, offset) {
    if (!editor.contains(container)) return endPos();
    if (container === editor) {
      if (offset >= editor.childNodes.length) return endPos();
      return { p: Math.min(offset, paras.length - 1), o: 0 };
    }
    let block = container;
    while (block.parentNode !== editor) block = block.parentNode;
    const index = Math.min(Math.max(Array.prototype.indexOf.call(editor.childNodes, block), 0), paras.length - 1);
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(container, offset);
    return { p: index, o: Math.min(nodeText(r.cloneContents()).length, paras[index].length) };
  }

  function selectionPositions() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { start: endPos(), end: endPos() };
    const r = sel.getRangeAt(0);
    if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return { start: endPos(), end: endPos() };
    return { start: posFromBoundary(r.startContainer, r.startOffset), end: posFromBoundary(r.endContainer, r.endOffset) };
  }

  function setCaret(pos) {
    const p = editor.childNodes[pos.p];
    if (!p) return;
    let remaining = pos.o;
    let target = null;
    let off = 0;
    for (const c of p.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        if (remaining <= c.data.length) {
          target = c;
          off = remaining;
          break;
        }
        remaining -= c.data.length;
      } else if (c.nodeName === 'BR' && !c.classList.contains('ProseMirror-trailingBreak')) {
        if (remaining === 0) {
          target = p;
          off = Array.prototype.indexOf.call(p.childNodes, c);
          break;
        }
        remaining -= 1;
      }
    }
    if (!target) {
      target = p;
      const tb = p.querySelector(':scope > br.ProseMirror-trailingBreak');
      off = tb ? Array.prototype.indexOf.call(p.childNodes, tb) : p.childNodes.length;
    }
    const r = document.createRange();
    r.setStart(target, off);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function deleteRange(a, b) {
    if (b.p < a.p || (b.p === a.p && b.o < a.o)) [a, b] = [b, a];
    const merged = paras[a.p].slice(0, a.o) + paras[b.p].slice(b.o);
    paras.splice(a.p, b.p - a.p + 1, merged);
    return { p: a.p, o: a.o };
  }

  function insertParas(pos, ins) {
    const cur = paras[pos.p];
    const head = cur.slice(0, pos.o);
    const tail = cur.slice(pos.o);
    const out = ins.slice();
    const caretO = (out.length === 1 ? head.length : 0) + out[out.length - 1].length;
    out[0] = head + out[0];
    out[out.length - 1] += tail;
    paras.splice(pos.p, 1, ...out);
    return { p: pos.p + out.length - 1, o: caretO };
  }

  /** Parse pasted HTML into paragraphs, with ProseMirror's default whitespace rules. */
  function parseHtmlParas(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    let cur = null;
    const flush = () => {
      if (cur !== null) out.push(cur.preserve ? cur.text : cur.text.replace(/^ +/, '').replace(/ +$/, '').replace(/\n /g, '\n'));
      cur = null;
    };
    const walk = (node, preserve) => {
      for (const c of node.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) {
          let t = c.data;
          if (preserve === 'full') t = t.replace(/\r\n?/g, '\n');
          else if (preserve) t = t.replace(/\r?\n|\r/g, ' ');
          else t = t.replace(/[ \t\r\n\f]+/g, ' ');
          if (cur === null) cur = { text: '', preserve: !!preserve };
          if (!preserve && t.startsWith(' ') && (cur.text === '' || /[ \n]$/.test(cur.text))) t = t.slice(1);
          cur.text += t;
        } else if (c.nodeName === 'BR') {
          if (cur === null) cur = { text: '', preserve: !!preserve };
          cur.text += '\n';
        } else if (c.nodeType === Node.ELEMENT_NODE) {
          const ws = c.nodeName === 'PRE' ? 'full' : /pre/.test(c.style?.whiteSpace || '') ? 'wrap' : preserve;
          if (BLOCK.test(c.nodeName)) {
            flush();
            cur = { text: '', preserve: !!ws };
            walk(c, ws);
            flush();
          } else walk(c, ws);
        }
      }
    };
    walk(doc.body, false);
    flush();
    return out.length ? out : [''];
  }

  function onPaste(e) {
    e.preventDefault();
    const dt = e.clipboardData;
    if (!dt || state.generating) return;
    const html = dt.getData('text/html');
    const plain = dt.getData('text/plain');
    // Like ProseMirror: prefer HTML; plain text becomes one paragraph per line (blank lines dropped).
    const ins = html ? parseHtmlParas(html) : plain.split(/(?:\r\n?|\n)+/);
    const size = plain ? plain.length : ins.join('\n').length;
    if (size > CONFIG.pasteChipThreshold) {
      addChip(plain || ins.join('\n'));
      return;
    }
    if (ins.length === 1 && ins[0] === '') return;
    const { start, end } = selectionPositions();
    const pos = insertParas(deleteRange(start, end), ins);
    renderEditor(pos);
  }

  /** Re-read the document after a native edit. */
  function syncFromDom() {
    if (rendering) return;
    const blocks = [];
    let loose = null;
    for (const c of editor.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE && BLOCK.test(c.nodeName)) {
        if (loose !== null) blocks.push(loose);
        loose = null;
        blocks.push(blockText(c));
      } else if (c.nodeName === 'BR') {
        if (!c.classList.contains('ProseMirror-trailingBreak')) loose = (loose ?? '') + '\n';
      } else if (c.nodeType === Node.TEXT_NODE || c.nodeType === Node.ELEMENT_NODE) {
        loose = (loose ?? '') + (c.nodeType === Node.TEXT_NODE ? c.data : nodeText(c));
      }
    }
    if (loose !== null) blocks.push(loose.replace(/\n$/, ''));
    const before = editor.innerHTML;
    const hadFocus = document.activeElement === editor;
    paras = blocks.length ? blocks : [''];
    // Re-render only when the DOM is not already in canonical shape (keeps the caret while typing).
    const probe = document.createElement('div');
    renderShape(probe);
    if (probe.innerHTML !== before) renderEditor(hadFocus ? endPos() : null);
    else updateSubmit();
  }

  /** Render the canonical shape of `paras` into an arbitrary element (no side effects). */
  function renderShape(target) {
    if (paras.length === 1 && paras[0] === '') {
      target.append(h('p', { 'data-empty-paragraph': 'true', 'data-placeholder': 'Ask ChatGPT', class: 'placeholder' }, h('br', { class: 'ProseMirror-trailingBreak' })));
      return;
    }
    for (const text of paras) {
      const p = document.createElement('p');
      text.split('\n').forEach((line, i) => {
        if (i) p.append(document.createElement('br'));
        if (line) p.append(document.createTextNode(line));
      });
      if (text === '' || text.endsWith('\n')) p.append(h('br', { class: 'ProseMirror-trailingBreak' }));
      target.append(p);
    }
  }

  function clearComposer() {
    paras = [''];
    renderEditor(null);
  }

  function addChip(text) {
    const id = crypto.randomUUID();
    const chip = h(
      'div',
      { class: 'chip', 'data-testid': 'attachment-chip' },
      h('span', {}, 'Pasted text'),
      h(
        'button',
        {
          type: 'button',
          'aria-label': 'Remove Pasted text',
          onclick: () => {
            state.chips = state.chips.filter((c) => c.id !== id);
            chip.remove();
            updateSubmit();
          },
        },
        '×',
      ),
    );
    state.chips.push({ id, text, el: chip });
    attachmentsEl.append(chip);
    updateSubmit();
  }

  function updateSubmit() {
    if (!submitSlot) return;
    const cur = submitSlot.firstElementChild;
    if (state.generating) {
      if (!cur || cur.getAttribute('aria-label') !== 'Stop')
        submitSlot.replaceChildren(h('button', { type: 'button', 'aria-label': 'Stop', class: 'stop-btn', onclick: stop }, '■'));
      return;
    }
    let send = cur;
    if (!cur || cur.getAttribute('aria-label') !== 'Send prompt') {
      send = h('button', { type: 'submit', 'aria-label': 'Send prompt', id: 'composer-submit-button', class: 'send-btn' }, '↑');
      submitSlot.replaceChildren(send);
    }
    send.disabled = isEmpty() && state.chips.length === 0;
  }

  function setMode(mode) {
    state.mode = mode;
    for (const b of modeGroup.querySelectorAll('button')) {
      const on = b.textContent === (mode === 'work' ? 'Work' : 'Chat');
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('data-state', on ? 'on' : 'off');
    }
  }

  // ------------------------------------------------------------ thread DOM

  /** Lossy markdown rendering: the DOM text is NOT the raw reply (on purpose). */
  function renderMarkdown(src) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    const out = [];
    const lines = src.split('\n');
    let i = 0;
    while (i < lines.length) {
      if (/^\s*```/.test(lines[i])) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      } else if (/^\s*[-*] /.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*] /, ''))}</li>`);
        out.push(`<ul>${items.join('')}</ul>`);
      } else if (!lines[i].trim()) i++;
      else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*[-*] /.test(lines[i])) para.push(lines[i++].trim());
        out.push(`<p>${inline(para.join(' '))}</p>`);
      }
    }
    return out.join('');
  }

  function newTurn(userText, userMsgId) {
    const n = state.turnCount++;
    const key = `turn-${n}`;
    const group = h('div', { class: 'flex flex-col gap-1.5', 'data-content-search-turn-key': key });
    const turnEl = h('div', { 'data-turn-key': userMsgId }, group);
    group.append(
      h(
        'div',
        { 'data-chatgpt-search-unit-key': `${key}:0:user`, 'data-chatgpt-search-message-ids': userMsgId },
        h(
          'div',
          { class: 'w-full', 'data-content-search-unit-key': `${key}:0:user` },
          h('div', { class: 'user-row group/user-message' }, h('div', { 'data-user-message-bubble': 'true', class: 'bg-user-message' }, h('div', { class: 'whitespace-pre-wrap' }, userText))),
        ),
      ),
    );
    thread.append(turnEl);
    thread.scrollTop = thread.scrollHeight;
    return { key, group, turnEl, units: 1, thoughtsEl: null, answerRoot: null, answerId: null, raw: '' };
  }

  function unitAttrs(turn, ids) {
    const k = `${turn.key}:${turn.units++}:assistant`;
    return { 'data-content-search-unit-key': k, 'data-chatgpt-search-unit-key': k, 'data-chatgpt-search-message-ids': ids };
  }

  function setThoughts(turn, msgId, text) {
    if (!turn.thoughtsEl) {
      turn.thoughtsEl = h('div', { class: 'thoughts' });
      turn.group.append(h('div', unitAttrs(turn, msgId), turn.thoughtsEl));
    }
    turn.thoughtsEl.textContent = text;
  }

  function setAnswer(turn, msgId, text, streaming) {
    if (!turn.answerRoot || turn.answerId !== msgId) {
      turn.answerRoot = h('div', { dir: 'auto', 'data-markdown-text-style': 'assistant-message', class: 'MarkdownRoot markdown prose' });
      turn.answerId = msgId;
      turn.group.append(
        h(
          'div',
          unitAttrs(turn, msgId),
          h('h4', { class: 'sr-only', 'data-conversation-role': 'assistant' }, 'ChatGPT said:'),
          h('div', { class: 'group flex min-w-0 flex-col', 'data-chatgpt-selection-conversation-id': state.conversationId || '', 'data-chatgpt-selection-message-id': msgId }, turn.answerRoot),
        ),
      );
    }
    turn.raw = text;
    turn.answerRoot.innerHTML = renderMarkdown(text);
    if (streaming) turn.answerRoot.setAttribute('data-markdown-animated', 'true');
    else turn.answerRoot.removeAttribute('data-markdown-animated');
    thread.scrollTop = thread.scrollHeight;
  }

  function finishTurnDom(turn) {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(turn.raw);
      } catch {
        /* clipboard permission is not granted in tests */
      }
    };
    turn.group.append(
      h(
        'div',
        { class: 'turn-action-controls' },
        h('button', { type: 'button', 'aria-label': 'Copy', onclick: copy }, 'Copy'),
        h('button', { type: 'button', 'aria-label': 'Rate response' }, 'Rate'),
        h('button', { type: 'button', 'aria-label': 'Regenerate response' }, 'Regenerate'),
        h('button', { type: 'button', 'aria-label': 'Share' }, 'Share'),
      ),
    );
  }

  function showTurnError(turn, text) {
    turn.group.append(
      h('div', { class: 'text-token-text-error', role: 'alert' }, h('span', {}, text), ' ', h('button', { type: 'button', 'data-testid': 'regenerate-thread-error-button' }, 'Retry')),
    );
  }

  /** Render a stored message chain (GET /backend-api/conversation/{id}). */
  function renderStored(messages) {
    let turn = null;
    for (const m of messages) {
      const role = m.author && m.author.role;
      const ct = m.content && m.content.content_type;
      if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
      if (role === 'user') {
        turn = newTurn((m.content.parts || []).join(''), m.id);
        continue;
      }
      if (!turn || role !== 'assistant') continue;
      if (ct === 'thoughts' || ct === 'reasoning_recap') setThoughts(turn, m.id, ct === 'reasoning_recap' ? m.content.content : 'Thinking');
      else if (ct === 'text' && (m.channel === 'final' || m.channel == null) && !(m.metadata && m.metadata.is_thinking_preamble_message)) {
        setAnswer(turn, m.id, (m.content.parts || []).join(''), false);
        finishTurnDom(turn);
      }
    }
  }

  // --------------------------------------------------------- stream reading

  function createSseParser(onData) {
    let buf = '';
    let data = [];
    return (text) => {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line === '') {
          if (data.length) onData(data.join('\n'));
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    };
  }

  function applyOp(rootObj, path, op, value) {
    if (op === 'patch') {
      for (const c of value || []) rootObj = applyOp(rootObj, path + (c.p || ''), c.o || 'replace', c.v);
      return rootObj;
    }
    if (path === '') return op === 'add' || op === 'replace' ? value : op === 'append' ? Object.assign(rootObj, value) : rootObj;
    const keys = path.split('/').slice(1);
    let node = rootObj;
    for (const k of keys.slice(0, -1)) {
      if (node[k] === null || typeof node[k] !== 'object') node[k] = {};
      node = node[k];
    }
    const key = keys[keys.length - 1];
    const cur = node[key];
    if (op === 'add' || op === 'replace') node[key] = value;
    else if (op === 'append') {
      if (typeof cur === 'string') node[key] = cur + value;
      else if (Array.isArray(cur)) Array.isArray(value) ? cur.push(...value) : cur.push(value);
      else if (cur && typeof cur === 'object') Object.assign(cur, value);
      else node[key] = value;
    } else if (op === 'remove') Array.isArray(node) ? node.splice(Number(key), 1) : delete node[key];
    else if (op === 'truncate' && cur != null && cur.slice) node[key] = cur.slice(0, value);
    return rootObj;
  }

  /** One assistant turn being received (delta_encoding v1). */
  class TurnStream {
    constructor(turn) {
      this.turn = turn;
      this.root = null;
      this.lastP = undefined;
      this.lastO = undefined;
      this.messages = new Map();
      this.answerId = null;
      this.complete = false;
      this.handoff = null;
      this.error = null;
      this.lastMessageId = null;
      this.parser = createSseParser((d) => this.onData(d));
    }

    onData(raw) {
      if (raw === '[DONE]' || raw === '"v1"') return;
      let v;
      try {
        v = JSON.parse(raw);
      } catch {
        return;
      }
      if (!v || typeof v !== 'object') return;
      if (typeof v.conversation_id === 'string') onConversationId(v.conversation_id);
      if (v.error) {
        this.error = typeof v.error === 'string' ? v.error : v.error.message || 'Something went wrong';
        return;
      }
      if (typeof v.type === 'string') {
        if (v.type === 'message_stream_complete') this.complete = true;
        else if (v.type === 'stream_handoff') this.handoff = ((v.options || []).find((o) => o.type === 'subscribe_ws_topic') || {}).topic_id || null;
        else if (v.type === 'title_generation' && v.title) document.title = v.title;
        return;
      }
      if (!('v' in v) && !('o' in v)) return;
      const starts = v.v && typeof v.v === 'object' && v.v.message && (v.p === undefined || v.p === '') && (v.o === undefined || v.o === 'add' || v.o === 'replace');
      if (starts) {
        this.root = v.v;
        this.lastP = this.lastO = undefined;
        if (typeof v.v.conversation_id === 'string') onConversationId(v.v.conversation_id);
      } else {
        const p = v.p !== undefined ? v.p : this.lastP;
        const o = v.o !== undefined ? v.o : this.lastO;
        if (p === undefined || o === undefined || !this.root) return;
        this.root = applyOp(this.root, p, o, v.v);
        this.lastP = p;
        this.lastO = o;
      }
      const m = this.root && this.root.message;
      if (m && m.id) {
        this.messages.set(m.id, m);
        if (m.author && m.author.role === 'assistant') this.lastMessageId = m.id;
        this.render(m);
      }
    }

    render(m) {
      const ct = m.content && m.content.content_type;
      if (m.author.role !== 'assistant' || (m.recipient && m.recipient !== 'all')) return;
      if (ct === 'thoughts') {
        const t = (m.content.thoughts || []).map((x) => x.summary).filter(Boolean);
        setThoughts(this.turn, m.id, t.length ? `Thinking: ${t[t.length - 1]}` : 'Thinking');
      } else if (ct === 'reasoning_recap') setThoughts(this.turn, m.id, m.content.content || 'Thought');
      else if (ct === 'text' && m.channel === 'commentary') setThoughts(this.turn, m.id, (m.content.parts || []).join(''));
      else if (ct === 'text' && !(m.metadata && (m.metadata.is_visually_hidden_from_conversation || m.metadata.is_thinking_preamble_message))) {
        this.answerId = m.id;
        setAnswer(this.turn, m.id, (m.content.parts || []).join(''), m.status !== 'finished_successfully');
      }
    }
  }

  function onConversationId(id) {
    if (state.conversationId === id) return;
    state.conversationId = id;
    // The real site moves to /c/<id> while the first reply streams (not for temporary chats).
    if (!state.temporary && location.pathname !== `/c/${id}`) history.pushState({}, '', `/c/${id}`);
  }

  // ------------------------------------------------------------- WebSocket

  let socket = null;
  let socketReady = null;
  let commandId = 0;
  const topicHandlers = new Map();

  async function ensureSocket() {
    if (socket && socket.readyState <= 1) return socketReady;
    const info = await api('GET', '/backend-api/celsius/ws/user');
    socket = new WebSocket(info.websocket_url);
    socketReady = new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(socket), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    });
    socket.addEventListener('message', (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const e of Array.isArray(data) ? data : [data]) {
        if (e && e.type === 'reply' && e.reply && Array.isArray(e.reply.catchups)) e.reply.catchups.forEach(routeEntry);
        else routeEntry(e);
      }
    });
    socket.addEventListener('close', () => {
      for (const fn of topicHandlers.values()) fn({ type: 'error', message: 'WebSocket closed' });
    });
    return socketReady;
  }

  function routeEntry(e) {
    if (!e || e.type !== 'message' || !e.payload || e.payload.type !== 'conversation-turn-stream') return;
    const fn = topicHandlers.get(e.topic_id);
    if (fn) fn(e.payload.payload || {});
  }

  /** Follow a handed-off turn on its WebSocket topic until done/error/stop. */
  async function followTopic(stream, topicId, gen) {
    const ws = await ensureSocket();
    const seen = new Set();
    await new Promise((resolve) => {
      const finish = (why) => {
        topicHandlers.delete(topicId);
        gen.wsCancel = null;
        resolve(why);
      };
      gen.wsCancel = () => {
        try {
          ws.send(JSON.stringify({ type: 'unsubscribe', id: ++commandId, topic_id: topicId }));
        } catch {
          /* closed */
        }
        finish('stopped');
      };
      topicHandlers.set(topicId, (p) => {
        if (p.type === 'stream-item') {
          if (p.stream_item_id && seen.has(p.stream_item_id)) return;
          if (p.stream_item_id) seen.add(p.stream_item_id);
          stream.parser(p.encoded_item || '');
        } else if (p.type === 'done') finish('done');
        else if (p.type === 'error') {
          stream.error = p.message || 'Stream error';
          finish('error');
        }
      });
      ws.send(JSON.stringify({ type: 'subscribe', id: ++commandId, topic_id: topicId, offset: 0 }));
    });
  }

  // ------------------------------------------------------------------- send

  async function sentinel() {
    const prep = await api('POST', '/backend-api/sentinel/chat-requirements/prepare', { p: 'gAAAAAC-fake-requirements' });
    const fin = await api('POST', '/backend-api/sentinel/chat-requirements/finalize', { prepare_token: prep.prepare_token });
    const conduit = await api('POST', '/backend-api/f/conversation/prepare', {
      action: 'next',
      conversation_id: state.conversationId || undefined,
      model: state.model,
      client_prepare_state: 'none',
      supported_encodings: ['v1'],
    });
    return { token: fin.token, conduit: conduit.conduit_token };
  }

  async function submit() {
    if (state.generating) return;
    const prompt = serialize();
    if (prompt.trim() === '' && state.chips.length === 0) return;
    const attachments = state.chips.map((c) => ({ id: c.id, name: 'Pasted text.txt', mime_type: 'text/plain', size: c.text.length }));
    state.chips.forEach((c) => c.el.remove());
    state.chips = [];
    clearComposer();

    const userMsgId = crypto.randomUUID();
    const turn = newTurn(prompt, userMsgId);
    const gen = { ctrl: new AbortController(), wsCancel: null, stopped: false };
    state.generating = gen;
    announcer.textContent = '';
    updateSubmit();
    let stream = null;
    try {
      const { token, conduit } = await sentinel();
      const body = {
        action: 'next',
        messages: [
          {
            id: userMsgId,
            author: { role: 'user' },
            create_time: Date.now() / 1000,
            content: { content_type: 'text', parts: [prompt] },
            metadata: { serialization_metadata: { custom_symbol_offsets: [] }, ...(attachments.length ? { attachments } : {}) },
          },
        ],
        parent_message_id: state.currentNode || 'client-created-root',
        model: state.model,
        client_prepare_state: 'success',
        timezone_offset_min: new Date().getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        conversation_mode: { kind: state.mode === 'work' ? 'work' : 'primary_assistant' },
        enable_message_followups: true,
        system_hints: [],
        supports_buffering: true,
        supported_encodings: ['v1'],
        client_contextual_info: { is_dark_mode: false, time_since_loaded: Math.round((Date.now() - state.loadedAt) / 1000), app_name: 'chatgpt.com' },
        paragen_cot_summary_display_override: 'allow',
        force_parallel_switch: 'auto',
      };
      if (state.conversationId) body.conversation_id = state.conversationId;
      if (state.temporary) body.history_and_training_disabled = true;
      const res = await fetch('/backend-api/f/conversation', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'openai-sentinel-chat-requirements-token': token,
          'x-conduit-token': conduit,
          'x-openai-target-path': '/backend-api/f/conversation',
          'x-openai-target-route': '/backend-api/f/conversation',
        },
        body: JSON.stringify(body),
        signal: gen.ctrl.signal,
      });
      if (!res.ok) {
        let detail = null;
        try {
          detail = (await res.json()).detail;
        } catch {
          /* not JSON */
        }
        const msg =
          (detail && (detail.message || (typeof detail === 'string' ? detail : null))) ||
          (res.status === 429 ? 'Too many requests. Please try again later.' : 'Something went wrong. If this issue persists please contact us through our help center at help.openai.com.');
        showTurnError(turn, msg);
        return;
      }
      stream = new TurnStream(turn);
      // Read the body exactly like the real page: through response.body.getReader().
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stream.parser(decoder.decode(value, { stream: true }));
          if (stream.complete) {
            // The real page stops reading (aborts) once the turn is complete.
            gen.ctrl.abort();
            break;
          }
        }
      } catch (e) {
        if (!(e && e.name === 'AbortError')) throw e;
      }
      if (stream.handoff && !stream.complete && !gen.stopped) await followTopic(stream, stream.handoff, gen);
      if (stream.error) showTurnError(turn, stream.error);
      else if (!stream.complete && !gen.stopped) showTurnError(turn, 'Network error. The response was interrupted.');
    } catch (e) {
      if (!(e && e.name === 'AbortError')) showTurnError(turn, 'Something went wrong. Network connection lost.');
    } finally {
      if (stream) {
        if (stream.answerId) {
          const m = stream.messages.get(stream.answerId);
          setAnswer(turn, stream.answerId, (m.content.parts || []).join(''), false);
          finishTurnDom(turn);
        }
        state.currentNode = stream.answerId || stream.lastMessageId || state.currentNode;
      }
      state.generating = null;
      updateSubmit();
      if (stream && stream.complete) announcer.textContent = 'Response complete';
      refreshHistory();
    }
  }

  function stop() {
    const g = state.generating;
    if (!g) return;
    g.stopped = true;
    g.ctrl.abort();
    if (g.wsCancel) g.wsCancel();
  }

  // ---------------------------------------------------------------- layout

  function renderLoggedOut() {
    root.replaceChildren(
      h(
        'div',
        { class: 'login' },
        h('h1', {}, 'Get smarter responses, upload files and images, and more.'),
        h('a', { href: '/auth/login', 'data-testid': 'login-button' }, 'Log in'),
        h('button', { type: 'button', 'data-testid': 'signup-button' }, 'Sign up for free'),
      ),
    );
  }

  async function refreshHistory() {
    if (!historyEl) return;
    try {
      const list = await api('GET', '/backend-api/conversations?offset=0&limit=28&order=updated');
      historyEl.replaceChildren(...list.items.map((c) => h('a', { href: `/c/${c.id}` }, c.title)));
    } catch {
      /* ignore */
    }
  }

  function renderApp() {
    thread = h('div', { id: 'thread' });
    announcer = h('span', { class: 'sr-only m-0', role: 'status', 'aria-live': 'polite' });
    editor = h('div', {
      contenteditable: 'true',
      'aria-multiline': 'true',
      dir: 'auto',
      role: 'textbox',
      spellcheck: 'true',
      translate: 'no',
      class: 'ProseMirror',
      'data-composer-markdown': '',
      'aria-label': 'Ask ChatGPT',
      'data-virtualkeyboard': 'true',
    });
    attachmentsEl = h('div', { class: 'attachments' });
    submitSlot = h('span', { class: 'submit-slot' });
    modeGroup = h(
      'div',
      { role: 'group', 'aria-label': 'Composer mode' },
      h('button', { type: 'button', onclick: () => setMode('chat') }, 'Chat'),
      h('button', { type: 'button', onclick: () => setMode('work') }, 'Work'),
    );
    const form = h(
      'form',
      { class: 'relative flex flex-col gap-2', 'data-composer-placement': 'thread', 'data-chatgpt-composer': '', 'data-thread-find-composer': 'true' },
      attachmentsEl,
      h('div', { class: 'editor-wrap', 'data-composer-input-layout': 'single-line' }, editor),
      h(
        'div',
        { class: 'toolbar' },
        modeGroup,
        h('button', { type: 'button', 'aria-label': 'Select ChatGPT model', 'data-codex-intelligence-trigger': 'true', 'data-selected-reasoning-effort': 'medium' }, 'Thinking'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', 'aria-label': 'Start dictation' }, 'Dictate'),
        submitSlot,
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    historyEl = h('div', { class: 'history' });
    root.replaceChildren(
      h(
        'div',
        { class: 'app' },
        h('nav', { class: 'sidebar', 'aria-label': 'Chat history' }, h('a', { href: '/', 'data-testid': 'create-new-chat-button' }, 'New chat'), historyEl),
        h(
          'main',
          {},
          h('header', { class: 'top' }, h('strong', {}, state.temporary ? 'Temporary Chat' : 'ChatGPT')),
          thread,
          h('div', { class: 'composer-area' }, form),
          h('h4', { class: 'sr-only m-0' }, 'Latest response'),
          announcer,
        ),
      ),
    );

    observer = new MutationObserver(() => {
      if (!rendering) queueMicrotask(syncFromDom);
    });
    observer.observe(editor, { childList: true, characterData: true, subtree: true });
    editor.addEventListener('paste', onPaste);
    editor.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (e.shiftKey) {
        const { start, end } = selectionPositions();
        renderEditor(insertParas(deleteRange(start, end), ['\n']));
      } else submit();
    });
    editor.addEventListener('input', () => queueMicrotask(syncFromDom));
    setMode(state.mode);
    renderEditor(null);
  }

  async function init() {
    root = document.getElementById('root');
    await sleep(CONFIG.hydrationDelayMs);
    let session = {};
    try {
      session = await (await fetch('/api/auth/session')).json();
    } catch {
      /* offline */
    }
    if (!session.accessToken) return renderLoggedOut();
    state.token = session.accessToken;
    // ?model= selects the model and is then dropped from the URL (temporary-chat stays).
    if (params.has('model')) {
      params.delete('model');
      const q = params.toString();
      history.replaceState({}, '', location.pathname + (q ? `?${q}` : ''));
    }
    renderApp();
    const m = /^\/c\/([^/?#]+)/.exec(location.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      try {
        const conv = await api('GET', `/backend-api/conversation/${encodeURIComponent(id)}`);
        const chain = [];
        for (let node = conv.current_node; node && conv.mapping[node]; node = conv.mapping[node].parent)
          if (conv.mapping[node].message) chain.unshift(conv.mapping[node].message);
        state.conversationId = id;
        state.currentNode = conv.current_node;
        renderStored(chain);
      } catch (e) {
        toast(e.status === 404 ? 'Unable to load conversation. Conversation not found.' : 'Unable to load conversation.');
      }
    }
    refreshHistory();
  }

  window.__fakeChatGPT = {
    composerText: () => serialize(),
    composerParagraphs: () => paras.slice(),
    get state() {
      return { ...state, generating: !!state.generating, chips: state.chips.length };
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// Unit tests for extension/content/stream-core.js (run: node --test extension/test/).
// The file is a classic script that attaches to globalThis.WebGPT4CC_Core, so it is
// evaluated in this context with node:vm (same realm, so deepStrictEqual works).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = new URL('../content/stream-core.js', import.meta.url);
vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file.pathname });
const Core = globalThis.WebGPT4CC_Core;

// ---------------------------------------------------------------------------
// helpers

const enc = new TextEncoder();

/** SSE text for a list of frames: strings are data lines, [event, data] pairs are named events. */
function sse(frames) {
  return frames
    .map((f) => {
      if (Array.isArray(f)) return `event: ${f[0]}\ndata: ${typeof f[1] === 'string' ? f[1] : JSON.stringify(f[1])}\n\n`;
      return `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`;
    })
    .join('');
}

/** Run SSE text through parser + reducer, optionally split into byte chunks of `chunkSize`. */
function run(text, chunkSize = 0) {
  const parser = Core.createSseParser();
  const st = Core.createStreamState();
  const bytes = enc.encode(text);
  if (!chunkSize) st.pushAll(parser.feed(bytes));
  else for (let i = 0; i < bytes.length; i += chunkSize) st.pushAll(parser.feed(bytes.subarray(i, i + chunkSize)));
  st.pushAll(parser.flush());
  return st;
}

const msg = (id, extra = {}) => ({
  id,
  author: { role: 'assistant' },
  content: { content_type: 'text', parts: [''] },
  status: 'in_progress',
  recipient: 'all',
  metadata: {},
  ...extra,
});

/** The canonical stream from docs/EXTENSION.md. */
const BASIC = [
  ['delta_encoding', '"v1"'],
  ['delta', { p: '', o: 'add', v: { message: msg('m1', { channel: 'final' }), conversation_id: 'conv-1' }, c: 0 }],
  ['delta', { p: '/message/content/parts/0', o: 'append', v: 'Hel' }],
  ['delta', { v: 'lo' }],
  [
    'delta',
    {
      p: '',
      o: 'patch',
      v: [
        { p: '/message/content/parts/0', o: 'append', v: '!' },
        { p: '/message/status', o: 'replace', v: 'finished_successfully' },
        { p: '/message/end_turn', o: 'replace', v: true },
        { p: '/message/metadata', o: 'append', v: { finish_details: { type: 'stop' } } },
      ],
    },
  ],
  { type: 'message_stream_complete', conversation_id: 'conv-1' },
  '[DONE]',
];

// ---------------------------------------------------------------------------
// SSE parser

test('SSE parser: events, named events, multi-line data, comments, CRLF', () => {
  const p = Core.createSseParser();
  const evs = p.feed(': keep-alive\r\nevent: delta\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\nevent: x\ndata:nospace\n\n');
  assert.deepEqual(evs, [
    { event: 'delta', data: '{"a":1}' },
    { event: 'message', data: 'line1\nline2' },
    { event: 'x', data: 'nospace' },
  ]);
  assert.deepEqual(p.flush(), []);
});

test('SSE parser: lines split across chunks, CR/LF split across chunks, flush of a trailing event', () => {
  const p = Core.createSseParser();
  const out = [];
  for (const piece of ['da', 'ta: {"x"', ':1}\r', '\n', '\r\nevent: delta\ndata: tail']) out.push(...p.feed(piece));
  assert.deepEqual(out, [{ event: 'message', data: '{"x":1}' }]);
  assert.deepEqual(p.flush(), [{ event: 'delta', data: 'tail' }]);
});

test('SSE parser: UTF-8 multi-byte characters split across byte chunks', () => {
  const text = sse([{ v: '你好, 世界 — 🚀 ok' }, { v: 'Ünïcödé ✓' }]);
  const bytes = enc.encode(text);
  for (const size of [1, 2, 3, 5, 7]) {
    const p = Core.createSseParser();
    const evs = [];
    for (let i = 0; i < bytes.length; i += size) evs.push(...p.feed(bytes.subarray(i, i + size)));
    evs.push(...p.flush());
    assert.deepEqual(
      evs.map((e) => JSON.parse(e.data).v),
      ['你好, 世界 — 🚀 ok', 'Ünïcödé ✓'],
      `chunk size ${size}`,
    );
  }
});

test('parseSseBlock flushes an event without a trailing blank line', () => {
  assert.deepEqual(Core.parseSseBlock('event: delta\ndata: {"v":"x"}'), [{ event: 'delta', data: '{"v":"x"}' }]);
});

// ---------------------------------------------------------------------------
// delta-v1 reducer

test('reducer: basic stream, implicit p/o inheritance, patch, completion', () => {
  const st = run(sse(BASIC));
  const s = st.snapshot();
  assert.equal(s.text, 'Hello!');
  assert.equal(s.messageId, 'm1');
  assert.equal(s.conversationId, 'conv-1');
  assert.equal(s.finishReason, 'stop');
  assert.equal(s.answerFinished, true);
  assert.equal(s.complete, true);
  assert.equal(s.doneSeen, true);
  assert.equal(s.error, null);
  assert.equal(st.state.encoding, 'v1');
});

test('reducer: same result for every byte-chunking of the stream', () => {
  const text = sse(BASIC);
  for (const size of [1, 3, 17, 64]) assert.equal(run(text, size).snapshot().text, 'Hello!', `chunk ${size}`);
});

test('reducer: implicit inheritance of o only and p only', () => {
  const st = run(
    sse([
      { v: { message: msg('a') } },
      { p: '/message/content/parts/0', o: 'append', v: 'x' },
      { o: 'append', v: 'y' }, // p inherited
      { p: '/message/content/parts/0', v: 'z' }, // o inherited
      { v: '1' }, // both inherited
    ]),
  );
  assert.equal(st.snapshot().text, 'xyz1');
});

test('reducer: a {v:{message}} snapshot resets the current message and the inherited p/o', () => {
  const st = run(
    sse([
      { v: { message: msg('a', { channel: 'final' }) } },
      { p: '/message/content/parts/0', o: 'append', v: 'A' },
      { v: { message: msg('b', { channel: 'final' }) } },
      { v: 'ignored' }, // no inherited p/o after a snapshot
      { p: '/message/content/parts/0', o: 'append', v: 'B' },
    ]),
  );
  const [a, b] = st.messages();
  assert.equal(a.content.parts[0], 'A');
  assert.equal(b.content.parts[0], 'B');
  assert.equal(st.snapshot().text, 'B');
});

test('reducer: add / replace / append (string, array, object) / remove / truncate', () => {
  const st = run(
    sse([
      { v: { message: msg('a', { channel: 'final' }) } },
      { p: '/message/content/parts/0', o: 'replace', v: 'abcdef' },
      { p: '/message/content/parts/0', o: 'truncate', v: 3 },
      { p: '/message/content/parts/0', o: 'append', v: 'Z' },
      { p: '/message/metadata/list', o: 'add', v: [1] },
      { p: '/message/metadata/list', o: 'append', v: [2, 3] },
      { p: '/message/metadata/list', o: 'append', v: 4 },
      { p: '/message/metadata/list', o: 'truncate', v: 3 },
      { p: '/message/metadata/obj', o: 'add', v: { a: 1 } },
      { p: '/message/metadata/obj', o: 'append', v: { b: 2 } },
      { p: '/message/metadata/gone', o: 'add', v: true },
      { p: '/message/metadata/gone', o: 'remove' },
      { p: '/message/metadata/deep/0/x', o: 'add', v: 'created' },
      { p: '/message/metadata/__proto__/polluted', o: 'add', v: true },
    ]),
  );
  const m = st.messages()[0];
  assert.equal(m.content.parts[0], 'abcZ');
  assert.deepEqual(m.metadata.list, [1, 2, 3]);
  assert.deepEqual(m.metadata.obj, { a: 1, b: 2 });
  assert.equal('gone' in m.metadata, false);
  assert.deepEqual(m.metadata.deep, [{ x: 'created' }]);
  assert.equal({}.polluted, undefined);
  assert.equal(st.snapshot().text, 'abcZ');
});

test('reducer: patch with nested paths and children relative to a non-empty base', () => {
  const st = run(
    sse([
      { v: { message: msg('a', { channel: 'final' }) } },
      {
        p: '/message',
        o: 'patch',
        v: [
          { p: '/content/parts/0', o: 'append', v: 'hi' },
          { p: '/status', o: 'replace', v: 'finished_successfully' },
        ],
      },
    ]),
  );
  const s = st.snapshot();
  assert.equal(s.text, 'hi');
  assert.equal(s.answerStatus, 'finished_successfully');
  assert.equal(s.answerFinished, true);
});

test('reducer: thoughts + reasoning recap + final answer; thinking flag before the answer', () => {
  const thoughts = {
    id: 't1',
    author: { role: 'assistant' },
    content: { content_type: 'thoughts', thoughts: [] },
    recipient: 'all',
    channel: 'analysis',
    metadata: {},
  };
  const head = [
    ['delta_encoding', '"v1"'],
    { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-6-thinking', resolved_model_slug: 'gpt-5-6-thinking' } },
    ['delta', { p: '', o: 'add', v: { message: thoughts, conversation_id: 'c9' } }],
    ['delta', { p: '/message/content/thoughts', o: 'append', v: [{ summary: 'Plan', content: '' }] }],
    ['delta', { p: '/message/content/thoughts/0/content', o: 'append', v: 'I should answer.' }],
  ];
  let s = run(sse(head)).snapshot();
  assert.equal(s.text, '');
  assert.equal(s.thinking, true);
  assert.equal(s.modelSlug, 'gpt-5-6-thinking');
  assert.equal(s.reasoning, 'Plan\nI should answer.');

  const tail = [
    [
      'delta',
      {
        v: {
          message: {
            id: 'r1',
            author: { role: 'assistant' },
            content: { content_type: 'reasoning_recap', content: 'Thought for 3s' },
            recipient: 'all',
            channel: 'analysis',
            metadata: {},
          },
        },
      },
    ],
    ['delta', { v: { message: msg('final1', { channel: 'final' }) } }],
    ['delta', { p: '/message/content/parts/0', o: 'append', v: 'Answer' }],
    ['delta', { v: ' text' }],
  ];
  // a commentary preamble joins the reasoning; it grows as a prefix
  const pre = [
    ['delta', { p: '/message/content/thoughts', o: 'append', v: [{ summary: 'Check', content: '' }] }],
    ['delta', { p: '/message/content/thoughts/1/content', o: 'append', v: 'Looks fine.' }],
    ['delta', { v: { message: msg('pre1', { channel: 'commentary', metadata: { is_thinking_preamble_message: true }, content: { content_type: 'text', parts: ['Writing it now.'] } }) } }],
  ];
  const prefixes = [];
  for (let i = 1; i <= pre.length; i++) prefixes.push(run(sse([...head, ...pre.slice(0, i)])).snapshot().reasoning);
  assert.deepEqual(prefixes, ['Plan\nI should answer.\n\nCheck', 'Plan\nI should answer.\n\nCheck\nLooks fine.', 'Plan\nI should answer.\n\nCheck\nLooks fine.\n\nWriting it now.']);
  for (let i = 1; i < prefixes.length; i++) assert.ok(prefixes[i].startsWith(prefixes[i - 1]));

  const st = run(sse([...head, ...tail]));
  s = st.snapshot();
  assert.equal(s.text, 'Answer text');
  assert.equal(s.reasoning, ''); // only reported until the answer starts
  assert.equal(s.messageId, 'final1');
  assert.equal(s.thinking, false);
  assert.equal(s.answerFinished, false);
  assert.equal(st.messages()[0].content.thoughts[0].content, 'I should answer.');
});

test('reducer: channel / recipient / hidden / preamble filtering', () => {
  const st = run(
    sse([
      { v: { message: msg('hidden', { channel: 'commentary', content: { content_type: 'text', parts: ['Cam'] } }) } },
      { p: '', o: 'patch', v: [{ p: '/message/metadata', o: 'append', v: { is_visually_hidden_from_conversation: true } }] },
      { v: { message: msg('pre', { channel: 'commentary', metadata: { is_thinking_preamble_message: true }, content: { content_type: 'text', parts: ['checking'] } }) } },
      { v: { message: msg('tool', { recipient: 'web.run', channel: 'commentary', content: { content_type: 'code', text: '{"q":1}' } }) } },
      { v: { message: msg('py', { recipient: 'python', content: { content_type: 'text', parts: ['print(1)'] } }) } },
      { v: { message: { id: 'toolres', author: { role: 'tool', name: 'python' }, content: { content_type: 'execution_output', text: '1' }, recipient: 'all', metadata: {} } } },
      { v: { message: msg('final', { channel: 'final', content: { content_type: 'text', parts: ['`a'] } }) } },
      { p: '/message/content/parts/0', o: 'append', v: 'b`' },
      { v: { message: msg('hidden2', { channel: 'final', metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: 'text', parts: ['nope'] } }) } },
      { type: 'message_stream_complete' },
    ]),
  );
  const s = st.snapshot();
  assert.equal(s.text, '`ab`');
  assert.equal(s.messageId, 'final');
});

test('selectAnswer: last final wins; channel-less fallback; multimodal string parts', () => {
  const plainA = msg('a', { channel: null, content: { content_type: 'text', parts: ['first'] } });
  const plainB = msg('b', { content: { content_type: 'text', parts: ['second'] } });
  delete plainB.channel;
  assert.equal(Core.selectAnswer([plainA, plainB]).id, 'b');
  const fin = msg('f', { channel: 'final', content: { content_type: 'text', parts: ['final'] } });
  assert.equal(Core.selectAnswer([fin, plainB]).id, 'f');
  const mm = msg('mm', { content: { content_type: 'multimodal_text', parts: [{ asset: 'x' }, 'caption'] } });
  assert.equal(Core.selectAnswer([mm]).id, 'mm');
  assert.equal(Core.messageText(mm), 'caption');
  const imgOnly = msg('img', { content: { content_type: 'multimodal_text', parts: [{ asset: 'x' }] } });
  assert.equal(Core.selectAnswer([imgOnly]), null);
  const user = { id: 'u', author: { role: 'user' }, content: { content_type: 'text', parts: ['q'] } };
  assert.equal(Core.selectAnswer([user]), null);
});

test('reducer: top-level events (title, metadata, markers) do not disturb the answer; non-delta frames', () => {
  const st = run(
    sse([
      { type: 'resume_conversation_token', token: 'secret', conversation_id: 'c2' },
      { type: 'input_message', input_message: { id: 'u1', author: { role: 'user' } } },
      { type: 'message_marker', conversation_id: 'c2', message_id: 'x', marker: 'user_visible_token', event: 'first' },
      { message: msg('legacy', { content: { content_type: 'text', parts: ['legacy full frame'] }, status: 'finished_successfully', end_turn: true }), conversation_id: 'c2', error: null },
      { type: 'title_generation', title: 'A title', conversation_id: 'c2' },
      { type: 'conversation_detail_metadata', banner_info: null },
      '[DONE]',
    ]),
  );
  const s = st.snapshot();
  assert.equal(s.text, 'legacy full frame');
  assert.equal(s.title, 'A title');
  assert.equal(s.conversationId, 'c2');
  assert.equal(s.doneSeen, true);
  assert.equal(s.complete, false);
  assert.equal(s.answerFinished, true);
  assert.equal(s.error, null);
});

test('reducer: top-level error', () => {
  const s1 = run(sse([{ v: { message: msg('a') } }, { error: 'Something went wrong while generating the response.' }])).snapshot();
  assert.match(s1.error, /Something went wrong/);
  const s2 = run(sse([{ error: { message: 'boom', code: 'x' } }])).snapshot();
  assert.equal(s2.error, 'boom');
  const s3 = run(sse([{ p: '', o: 'add', v: { message: msg('a'), error: 'bad' } }])).snapshot();
  assert.equal(s3.error, 'bad');
});

test('reducer: stream_handoff detection', () => {
  const s = run(
    sse([
      { v: { message: msg('a', { channel: 'final' }) } },
      {
        type: 'stream_handoff',
        conversation_id: 'conv',
        turn_exchange_id: 'work-turn',
        options: [{ type: 'subscribe_ws_topic', topic_id: 'conversation-turn-abc' }, { type: 'other' }],
      },
      { type: 'stream_handoff', options: [{ type: 'subscribe_ws_topic', topic_id: 'conversation-turn-abc' }] },
    ]),
  ).snapshot();
  assert.deepEqual(s.handoffTopics, ['conversation-turn-abc']);
  assert.equal(s.conversationId, 'conv');
});

test('reducer: max_tokens and interrupted finish reasons', () => {
  const base = [{ v: { message: msg('a', { channel: 'final' }) } }, { p: '/message/content/parts/0', o: 'append', v: 'partial' }];
  const mk = (type) =>
    run(sse([...base, { p: '', o: 'patch', v: [{ p: '/message/metadata', o: 'append', v: { finish_details: { type } } }] }])).snapshot();
  assert.equal(mk('max_tokens').finishReason, 'max_tokens');
  assert.equal(mk('interrupted').finishReason, 'interrupted');
  assert.equal(mk('max_tokens').answerFinished, true);
});

test('reducer: junk lines and unknown ops are ignored', () => {
  const st = run('data: {not json\n\ndata: "v1"\n\n' + sse([{ v: { message: msg('a', { channel: 'final' }) } }, { p: '/message/content/parts/0', o: 'frobnicate', v: 'x' }, { p: '/message/content/parts/0', o: 'append', v: 'ok' }]));
  assert.equal(st.snapshot().text, 'ok');
  assert.equal(st.state.parseErrors, 1);
});

// ---------------------------------------------------------------------------
// sanitizing

test('sanitizeAnswerText strips \\uE200…\\uE201 blocks, unterminated trailing blocks and stray markers', () => {
  const rich =
    '正文\nciteturn1news2\nnavlist继续阅读turn1news2\ngenui{"x":1}';
  assert.equal(Core.sanitizeAnswerText(rich).trim(), '正文');
  assert.equal(Core.sanitizeAnswerText('a citeturn0search1b'), 'a b');
  assert.equal(Core.sanitizeAnswerText('streaming citetur'), 'streaming ');
  assert.equal(Core.sanitizeAnswerText('xyz'), 'xyz');
  assert.equal(Core.sanitizeAnswerText('  plain\ttext  \n'), '  plain\ttext  \n');
  // through the reducer
  const s = run(sse([{ v: { message: msg('a', { channel: 'final' }) } }, { p: '/message/content/parts/0', o: 'append', v: 'See citeturn0 here' }])).snapshot();
  assert.equal(s.text, 'See  here');
});

// ---------------------------------------------------------------------------
// WebSocket turn stream

test('WebSocket stream items: decoding, catch-ups, dedupe by stream_item_id, done/error', () => {
  const item = (id, encoded) => ({
    type: 'message',
    topic_id: 'conversation-turn-1',
    payload: { type: 'conversation-turn-stream', payload: { type: 'stream-item', stream_item_id: id, encoded_item: encoded } },
  });
  const tracker = Core.createWsTurnTracker();
  const st = Core.createStreamState();
  const feed = (frame) => {
    const r = tracker.process(typeof frame === 'string' ? frame : JSON.stringify(frame));
    for (const c of r.chunks) st.pushAll(Core.parseSseBlock(c.text));
    return r;
  };
  const first = sse([['delta', { v: { message: msg('w1', { channel: 'final' }), conversation_id: 'cw' } }]]);
  const second = 'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"via ws"}'; // no trailing blank line
  let r = feed({ type: 'reply', reply: { catchups: [item('s1', first), item('s2', second)] } });
  assert.equal(r.chunks.length, 2);
  r = feed([item('s1', first), item('s2', second)]); // re-delivered: dropped
  assert.equal(r.chunks.length, 0);
  r = feed(item('s3', sse([['delta', { v: '!' }]])));
  assert.equal(r.chunks.length, 1);
  assert.equal(st.snapshot().text, 'via ws!');
  r = feed({ type: 'message', topic_id: 'conversation-turn-1', payload: { type: 'conversation-turn-stream', payload: { type: 'done' } } });
  assert.deepEqual(r.done, ['conversation-turn-1']);
  assert.equal(tracker.ended('conversation-turn-1'), true);
  r = feed(item('s4', sse([['delta', { v: 'late' }]]))); // after done: ignored
  assert.equal(r.chunks.length, 0);

  const t2 = Core.createWsTurnTracker();
  const er = t2.process({ type: 'message', topic_id: 'conversation-turn-2', payload: { type: 'conversation-turn-stream', payload: { type: 'error', message: 'stream failed' } } });
  assert.deepEqual(er.errors, [{ topicId: 'conversation-turn-2', message: 'stream failed' }]);
  // unrelated frames
  assert.deepEqual(Core.extractWsTurnItems('not json'), []);
  assert.deepEqual(Core.extractWsTurnItems({ type: 'message', topic_id: 'presence', payload: {} }), []);
});

// ---------------------------------------------------------------------------
// composer text

/** Minimal DOM-ish node builders for readEditorText. */
const T = (text) => ({ nodeType: 3, nodeName: '#text', nodeValue: text });
const E = (name, children = [], className = '') => ({ nodeType: 1, nodeName: name, className, childNodes: children });
const BR = (cls = '') => E('BR', [], cls);

test('readEditorText: paragraphs, hard breaks, trailing breaks, nested inline nodes', () => {
  // <div><p>line 1<br>line 2</p><p><br class=trailing></p><p>  indented <strong>bold</strong></p></div>
  const editor = E('DIV', [
    E('P', [T('line 1'), BR(), T('line 2')]),
    E('P', [BR('ProseMirror-trailingBreak')]),
    E('P', [T('  indented '), E('STRONG', [T('bold')])]),
  ]);
  assert.equal(Core.readEditorText(editor), 'line 1\nline 2\n\n  indented bold');
  // a hard break at the end of a paragraph followed by ProseMirror's trailing break
  assert.equal(Core.readEditorText(E('DIV', [E('P', [T('a'), BR(), BR('ProseMirror-trailingBreak')])])), 'a\n');
  // empty composer
  assert.equal(Core.readEditorText(E('DIV', [E('P', [BR('placeholder ProseMirror-trailingBreak')])])), '');
  // textarea
  assert.equal(Core.readEditorText({ nodeType: 1, nodeName: 'TEXTAREA', value: 'x\ny', childNodes: [] }), 'x\ny');
  // lists and pre
  assert.equal(Core.readEditorText(E('DIV', [E('PRE', [T('code()')]), E('UL', [E('LI', [T('a')]), E('LI', [T('b')])])])), 'code()\na\nb');
});

test('normalizeEditorText: CRLF, NBSP, zero-width, trailing whitespace', () => {
  assert.equal(Core.normalizeEditorText('a \r\nb c​\t\r\n\n  '), 'a\nb c');
  assert.equal(Core.normalizeEditorText('  keep leading\n    indent'), '  keep leading\n    indent');
  assert.equal(Core.normalizeEditorText(Core.readEditorText(E('DIV', [E('P', [T('x  ')]), E('P', [T('y')])]))), 'x\ny');
});

test('splitPasteChunks never splits surrogate pairs or CRLF and reassembles exactly', () => {
  const s = 'a'.repeat(3) + '😀' + 'b\r\nc' + 'd'.repeat(10);
  for (const max of [2, 3, 4, 5, 6, 7, 4000]) {
    const chunks = Core.splitPasteChunks(s, max);
    assert.equal(chunks.join(''), s, `max ${max}`);
    for (const c of chunks) {
      assert.ok(c.length <= max, `chunk too long for max ${max}`);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(c), `chunk starts with a low surrogate (max ${max})`);
      assert.ok(!c.startsWith('\n') || !chunks[chunks.indexOf(c) - 1]?.endsWith('\r'), `CRLF split (max ${max})`);
    }
  }
  assert.deepEqual(Core.splitPasteChunks('', 4000), []);
});

// ---------------------------------------------------------------------------
// classifiers

test('classifyUiWarning', () => {
  assert.equal(Core.classifyUiWarning("Too many requests. We've temporarily limited access to your conversations. Please wait a few minutes."), 'rate_limit');
  assert.equal(Core.classifyUiWarning("You've hit the Plus plan limit for GPT-5 Thinking. Responses will use another model until your limit resets after 3:45 PM."), 'usage_cap');
  assert.equal(Core.classifyUiWarning('Something went wrong. Try again later.'), 'temporary_unavailable');
  assert.equal(Core.classifyUiWarning('Please verify you are human'), 'auth_or_challenge');
  assert.equal(Core.classifyUiWarning('Response complete'), null);
  assert.equal(Core.classifyUiWarning(''), null);
});

test('parseRetryAfter: relative and clock times', () => {
  assert.equal(Core.parseRetryAfter('try again in 20 minutes'), 20 * 60e3);
  assert.equal(Core.parseRetryAfter('after 2 hours'), 2 * 3600e3);
  const now = new Date(2026, 9, 9, 15, 0, 0).getTime(); // 15:00 local
  assert.equal(Core.parseRetryAfter('until your limit resets after 3:45 PM.', now), 45 * 60e3);
  assert.equal(Core.parseRetryAfter('until 14:30', now), 23.5 * 3600e3);
  assert.equal(Core.parseRetryAfter('after 2 attempts'), undefined);
  assert.equal(Core.parseRetryAfter('no time here'), undefined);
});

test('classifyHttpError', () => {
  const r429 = Core.classifyHttpError(429, JSON.stringify({ detail: { message: "You've reached our limit of messages per hour.", clears_in: 3600 } }), 'application/json');
  assert.equal(r429.code, 'rate_limited');
  assert.equal(r429.retryAfterMs, 3600e3);
  assert.equal(Core.classifyHttpError(429, '', 'text/plain', '30').retryAfterMs, 30e3);
  assert.equal(Core.classifyHttpError(401, '{"detail":"Unauthorized"}', 'application/json').code, 'not_logged_in');
  assert.equal(Core.classifyHttpError(403, '<!DOCTYPE html><title>Just a moment...</title> cloudflare', 'text/html').code, 'network');
  assert.equal(Core.classifyHttpError(403, '{"detail":"Unusual activity has been detected from your device. Try again later."}', 'application/json').code, 'network');
  assert.equal(Core.classifyHttpError(413, '', '').code, 'too_long');
  assert.equal(Core.classifyHttpError(400, '{"detail":"The message you submitted was too long, please reload the conversation and submit something shorter."}', 'application/json').code, 'too_long');
  assert.equal(Core.classifyHttpError(500, 'oops', 'text/plain').code, 'network');
});

// ---------------------------------------------------------------------------
// conversation document

test('answerFromConversation walks current_node and picks the last turn answer', () => {
  const node = (id, parent, message) => ({ id, parent, children: [], message });
  const doc = {
    conversation_id: 'conv-x',
    current_node: 'a2',
    mapping: {
      root: node('root', null, null),
      sys: node('sys', 'root', { id: 'sys', author: { role: 'system' }, content: { content_type: 'text', parts: [''] } }),
      u1: node('u1', 'sys', { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['q1'] } }),
      a1: node('a1', 'u1', msg('a1', { channel: 'final', content: { content_type: 'text', parts: ['old answer'] }, status: 'finished_successfully' })),
      u2: node('u2', 'a1', { id: 'u2', author: { role: 'user' }, content: { content_type: 'text', parts: ['q2'] } }),
      t2: node('t2', 'u2', { id: 't2', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [] }, channel: 'analysis', recipient: 'all' }),
      a2: node('a2', 't2', msg('a2', { channel: 'final', content: { content_type: 'text', parts: ['new citexanswer'] }, status: 'finished_successfully', end_turn: true, metadata: { finish_details: { type: 'stop' } } })),
    },
  };
  assert.deepEqual(Core.answerFromConversation(doc), {
    text: 'new answer',
    messageId: 'a2',
    conversationId: 'conv-x',
    finishReason: 'stop',
    finished: true,
  });
  assert.equal(Core.answerFromConversation({ ...doc, current_node: 'u2' }), null);
  assert.equal(Core.answerFromConversation({}), null);
  // cycles do not hang
  assert.equal(Core.answerFromConversation({ current_node: 'x', mapping: { x: node('x', 'y', null), y: node('y', 'x', null) } }), null);
});

// ---------------------------------------------------------------------------
// misc

test('redactFrame removes credentials and truncates', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  const out = Core.redactFrame(JSON.stringify({ type: 'resume_conversation_token', token: 'opaque-secret', other: jwt }));
  assert.ok(!out.includes('opaque-secret'));
  assert.ok(!out.includes(jwt));
  assert.match(out, /\[REDACTED\]/);
  assert.match(Core.redactFrame('x'.repeat(50), 10), /^x{10}…\[\+40 chars\]$/);
});

test('isConversationPath', () => {
  assert.equal(Core.isConversationPath('/backend-api/f/conversation'), true);
  assert.equal(Core.isConversationPath('/backend-api/f/conversation/resume'), true);
  assert.equal(Core.isConversationPath('/backend-api/conversation'), true);
  assert.equal(Core.isConversationPath('/backend-api/conversation/123'), false);
  assert.equal(Core.isConversationPath('/backend-api/f/conversation/prepare'), false);
  assert.equal(Core.isResumePath('/backend-api/f/conversation/resume'), true);
});

// ---------------------------------------------------------------------------
// localized UI text (the UI language follows the ChatGPT account, e.g. zh-CN)

test('classifyUiWarning: Simplified Chinese, Traditional Chinese and Japanese limit texts', () => {
  assert.equal(Core.classifyUiWarning('请求过多。我们已暂时限制对你的对话的访问。请稍等几分钟。'), 'rate_limit');
  assert.equal(Core.classifyUiWarning('请求过多，请稍后再试。'), 'rate_limit');
  assert.equal(Core.classifyUiWarning('您已达到 GPT-5 的使用上限。你的限额将于 18:30 后重置。'), 'usage_cap');
  assert.equal(Core.classifyUiWarning('你已用完 GPT-5 Thinking 的额度，额度将在 3 小时后恢复。'), 'usage_cap');
  assert.equal(Core.classifyUiWarning('請求過多。請稍後再試。'), 'rate_limit');
  assert.equal(Core.classifyUiWarning('GPT-5 の上限に達しました。'), 'usage_cap');
  assert.equal(Core.classifyUiWarning('出错了。如果此问题仍然存在，请通过 help.openai.com 联系我们。'), 'temporary_unavailable');
  assert.equal(Core.classifyUiWarning('请验证您是真人'), 'auth_or_challenge');
  assert.equal(Core.classifyUiWarning('你的会话已过期，请重新登录。'), 'auth_or_challenge');
  assert.equal(Core.classifyUiWarning('回复已完成'), null);
  assert.equal(Core.classifyUiWarning('已复制'), null);
});

test('parseRetryAfter: Chinese and Japanese relative and clock times', () => {
  const now = new Date(2026, 9, 9, 15, 0, 0).getTime(); // 15:00 local
  assert.equal(Core.parseRetryAfter('你的限额将在 20 分钟后重置', now), 20 * 60e3);
  assert.equal(Core.parseRetryAfter('请在3个小时后再试', now), 3 * 3600e3);
  assert.equal(Core.parseRetryAfter('1 小時後重置', now), 3600e3);
  assert.equal(Core.parseRetryAfter('30秒后重试', now), 30e3);
  assert.equal(Core.parseRetryAfter('20分後にもう一度お試しください', now), 20 * 60e3);
  assert.equal(Core.parseRetryAfter('你的限额将于 18:30 后重置。', now), 3.5 * 3600e3);
  assert.equal(Core.parseRetryAfter('限额将于下午6:30重置', now), 3.5 * 3600e3);
  assert.equal(Core.parseRetryAfter('额度将于上午 9：05 恢复', now), 18 * 3600e3 + 5 * 60e3);
  assert.equal(Core.parseRetryAfter('请稍后再试', now), undefined);
});

// ---------------------------------------------------------------------------
// page-level stream tracking, Work mode, models, Cloudflare

test('scanStreamEvent finds completion, [DONE] and handoff topics without parsing other frames', () => {
  assert.deepEqual(Core.scanStreamEvent({ data: '[DONE]' }), { complete: false, done: true, topics: [] });
  assert.deepEqual(Core.scanStreamEvent({ data: JSON.stringify({ type: 'message_stream_complete', conversation_id: 'c' }) }), { complete: true, done: false, topics: [] });
  assert.deepEqual(
    Core.scanStreamEvent({ data: JSON.stringify({ type: 'stream_handoff', options: [{ type: 'subscribe_ws_topic', topic_id: 'conversation-turn-1' }] }) }),
    { complete: false, done: false, topics: ['conversation-turn-1'] },
  );
  // The words inside a reply's text are not markers.
  assert.deepEqual(Core.scanStreamEvent({ data: JSON.stringify({ v: 'type message_stream_complete stream_handoff' }) }), { complete: false, done: false, topics: [] });
  assert.deepEqual(Core.scanStreamEvent({ data: '{broken message_stream_complete' }), { complete: false, done: false, topics: [] });
  assert.deepEqual(Core.scanStreamEvent(null), { complete: false, done: false, topics: [] });
});

test('reducer keeps product_experience and requested_model_experience from server_ste_metadata', () => {
  const st = run(sse([{ type: 'server_ste_metadata', metadata: { model_slug: 'gpt-6-luna-wm', product_experience: 'work', requested_model_experience: 'work' } }]));
  const snap = st.snapshot();
  assert.equal(snap.modelSlug, 'gpt-6-luna-wm');
  assert.equal(snap.productExperience, 'work');
  assert.equal(snap.requestedModelExperience, 'work');
});

test('workModeReason: request body, stream metadata, Work model slugs and WEB: conversation ids', () => {
  assert.match(Core.workModeReason({ conversationMode: 'work' }), /conversation_mode/);
  assert.match(Core.workModeReason({ productExperience: 'work' }), /product_experience/);
  assert.match(Core.workModeReason({ requestedModelExperience: 'work' }), /requested_model_experience/);
  assert.match(Core.workModeReason({ model: 'gpt-6-sol-wm' }), /Work model/);
  assert.match(Core.workModeReason({ slug: 'gpt-6-luna-wm-2026-09' }), /Work model/);
  assert.match(Core.workModeReason({ conversationId: 'WEB:0d3c-11' }), /Work conversation/);
  assert.match(Core.workModeReason({ conversationId: 'WEB%3A0d3c-11' }), /Work conversation/);
  assert.equal(Core.workModeReason({ conversationMode: 'primary_assistant', productExperience: 'chat', requestedModelExperience: 'thinking', model: 'gpt-5-6-thinking', slug: 'gpt-5-wmx', conversationId: '68e5-uuid' }), null);
  assert.equal(Core.workModeReason(undefined), null);
});

test('composerModeOf: value attributes first, then localized labels', () => {
  assert.equal(Core.composerModeOf('work', '聊天'), 'work');
  assert.equal(Core.composerModeOf('', 'Work'), 'work');
  assert.equal(Core.composerModeOf(null, ' 工作 '), 'work');
  assert.equal(Core.composerModeOf(null, 'ワーク'), 'work');
  assert.equal(Core.composerModeOf(null, '聊天'), 'chat');
  assert.equal(Core.composerModeOf(null, 'チャット'), 'chat');
  assert.equal(Core.composerModeOf('chat', ''), 'chat');
  assert.equal(Core.composerModeOf(null, 'Thinking'), null);
});

test('sameModel compares model names loosely', () => {
  assert.equal(Core.sameModel('gpt-5.5', 'GPT-5-5'), true);
  assert.equal(Core.sameModel('gpt-5-thinking', 'gpt-5-thinking'), true);
  assert.equal(Core.sameModel('gpt-5-thinking', 'auto'), false);
  assert.equal(Core.sameModel('gpt-5-thinking', ''), false);
});

test('cloudflareVerdict: the bot-management script alone is weak evidence, the app shell wins', () => {
  // A healthy ChatGPT page also loads /cdn-cgi/challenge-platform/... (oracle, 2026-07).
  assert.deepEqual(Core.cloudflareVerdict({ title: 'ChatGPT', bodyText: 'x'.repeat(5000), hasAppShell: true, hasChallengeScript: true }), { strong: false, shell: true, weak: false });
  assert.deepEqual(Core.cloudflareVerdict({ title: 'Just a moment...', bodyText: 'Checking your browser', hasAppShell: false }), { strong: true, shell: false, weak: false });
  assert.equal(Core.cloudflareVerdict({ title: '请稍候…', bodyText: '', hasAppShell: false }).strong, true);
  assert.equal(Core.cloudflareVerdict({ title: 'chatgpt.com', bodyText: '正在验证您是否是真人。这可能需要几秒钟时间。', hasAppShell: false }).strong, true);
  assert.equal(Core.cloudflareVerdict({ title: '', bodyText: '', hasAppShell: false, hasChallengeWidget: true }).strong, true);
  assert.deepEqual(Core.cloudflareVerdict({ title: '', bodyText: 'Loading', hasAppShell: false, hasChallengeScript: true }), { strong: false, shell: false, weak: true });
  assert.deepEqual(Core.cloudflareVerdict({ title: 'Just a moment...', bodyText: '', hasAppShell: true }), { strong: false, shell: true, weak: false });
});

test('isSendPipelinePath: Sentinel and conduit prepare, not the conversation itself', () => {
  assert.equal(Core.isSendPipelinePath('/backend-api/sentinel/chat-requirements'), true);
  assert.equal(Core.isSendPipelinePath('/backend-api/sentinel/chat-requirements/prepare'), true);
  assert.equal(Core.isSendPipelinePath('/backend-api/sentinel/chat-requirements/finalize'), true);
  assert.equal(Core.isSendPipelinePath('/backend-api/f/conversation/prepare'), true);
  assert.equal(Core.isSendPipelinePath('/backend-api/f/conversation'), false);
  assert.equal(Core.isSendPipelinePath('/backend-api/conversations'), false);
});

// ---------------------------------------------------------------------------
// prompt fidelity

test('comparePromptFidelity: exact match, outer whitespace tolerated', () => {
  assert.equal(Core.comparePromptFidelity('a\tb  \n\\x', 'a\tb  \n\\x'), null);
  assert.equal(Core.comparePromptFidelity('hello\nworld', 'hello\r\nworld\n\n'), null);
  assert.equal(Core.comparePromptFidelity('  hello', 'hello'), null);
});

test('comparePromptFidelity classifies what changed and where', () => {
  const want = '12\tconst a = b * c;  \nnext \\ line';
  const r1 = Core.comparePromptFidelity('12    const a = b * c;  \nnext \\ line', want);
  assert.deepEqual(r1.kinds, ['tabs-or-spaces']);
  assert.equal(r1.offset, 2);
  assert.deepEqual(Core.comparePromptFidelity('12\tconst a = b * c;\nnext \\ line', want).kinds, ['trailing-whitespace']);
  assert.deepEqual(Core.comparePromptFidelity('12\tconst a = b \\* c;  \nnext \\\\ line', want).kinds, ['backslash-escape']);
  assert.deepEqual(Core.comparePromptFidelity('a b', 'a b').kinds, ['nbsp']);
  assert.deepEqual(Core.comparePromptFidelity('a\n\nb', 'a\n\n\n\nb').kinds, ['blank-lines']);
  assert.deepEqual(Core.comparePromptFidelity('12 const a = b \\* c;\nnext \\\\ line', want).kinds, ['backslash-escape', 'trailing-whitespace', 'tabs-or-spaces']);
  assert.deepEqual(Core.comparePromptFidelity('something else entirely', want).kinds, ['other']);
  const cut = Core.comparePromptFidelity('x'.repeat(60_000), 'x'.repeat(70_000));
  assert.deepEqual(cut, { offset: 60_000, sentChars: 60_000, wantChars: 70_000, kinds: ['truncated'] });
});

// ---------------------------------------------------------------------------
// conversation document: pinning the answer to our own user message

test('answerFromConversation pins the turn by user message id or prompt text', () => {
  const node = (id, parent, message) => ({ id, parent, children: [], message });
  const user = (id, text) => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts: [text] } });
  const answer = (id, text, extra = {}) => msg(id, { channel: 'final', content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: true, ...extra });
  const doc = {
    conversation_id: 'conv-y',
    current_node: 'a2',
    mapping: {
      u1: node('u1', null, user('u1', 'first prompt')),
      a1: node('a1', 'u1', answer('a1', 'first answer')),
      u2: node('u2', 'a1', user('u2', 'second   prompt with \\* escapes')),
      a2: node('a2', 'u2', answer('a2', 'second answer', { status: 'in_progress', end_turn: null })),
    },
  };
  // Our message is the latest one: its (unfinished) answer.
  const r = Core.answerFromConversation(doc, { userMessageId: 'u2' });
  assert.equal(r.text, 'second answer');
  assert.equal(r.finished, false);
  // An earlier turn by id: only the messages up to the next user message count.
  assert.equal(Core.answerFromConversation(doc, { userMessageId: 'u1' }).text, 'first answer');
  // By prompt text (loose: whitespace runs and backslash escapes ignored).
  assert.equal(Core.answerFromConversation(doc, { prompt: 'second prompt with * escapes' }).text, 'second answer');
  // Our message never reached the conversation: never the previous turn's answer.
  assert.deepEqual(Core.answerFromConversation({ ...doc, current_node: 'a1' }, { userMessageId: 'u-ours', prompt: 'my new prompt' }).userMissing, true);
  assert.equal(Core.answerFromConversation({ ...doc, current_node: 'a1' }, { prompt: 'my new prompt' }).userMissing, true);
  // Without opts: the latest turn, as before.
  assert.equal(Core.answerFromConversation(doc).text, 'second answer');
});

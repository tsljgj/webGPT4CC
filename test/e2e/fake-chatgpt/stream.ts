// Builds chatgpt.com-style conversation streams (delta_encoding "v1" SSE) for
// the fake backend, and the stored messages that GET /backend-api/conversation/{id}
// returns afterwards. The shapes follow docs/EXTENSION.md and the 2026-09/10
// research notes (sse-devtools-panel, g4f, oracle): a full message is added,
// then small appends that rely on the implicit "reuse last p and o" rule, then a
// final patch, then message_stream_complete and [DONE].
//
// Nothing here talks to a browser; backend.ts feeds the result to Playwright.

export interface SseEvent {
  /** SSE `event:` name; omitted for typed JSON events, as on the real site. */
  event?: string;
  /** Raw `data:` payload (JSON text, `"v1"` or `[DONE]`). */
  data: string;
}

export function formatSse(events: SseEvent[]): string {
  return events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${e.data}\n\n`).join('');
}

/** A message as stored in a conversation's `mapping` (subset of the real schema). */
export interface StoredMessage {
  id: string;
  author: { role: 'system' | 'user' | 'assistant' | 'tool'; name: string | null; metadata: Record<string, unknown> };
  create_time: number;
  update_time: number | null;
  content: Record<string, unknown>;
  status: string;
  end_turn: boolean | null;
  weight: number;
  metadata: Record<string, unknown>;
  recipient: string;
  channel: string | null;
}

export interface TurnStreamSpec {
  conversationId: string;
  /** True for the first turn of a conversation (adds the hidden system message and a title). */
  newConversation: boolean;
  temporary: boolean;
  userMessage: StoredMessage;
  /** Id of the final answer message. */
  assistantMessageId: string;
  modelSlug: string;
  answer: string;
  finishReason: 'stop' | 'max_tokens' | 'interrupted';
  /** Reasoning summaries streamed as a `thoughts` message (+ a `reasoning_recap`) before the answer. */
  thoughts?: string[];
  /** A commentary-channel preamble ("is_thinking_preamble_message") before the answer. */
  preamble?: string;
  title?: string;
  /**
   * When set, the HTTP stream stops after a stream_handoff and the rest is returned in `ws`.
   * `httpDone` (default true) ends the HTTP body with `[DONE]` although no answer was sent
   * over HTTP: a client must not treat that [DONE] as the end of the turn.
   */
  handoff?: { topicId: string; turnExchangeId: string; httpDone?: boolean };
  /** Seed for the deterministic chunk sizes. */
  seed: number;
  newId: () => string;
}

export interface TurnStream {
  /** Events sent in the HTTP response body. */
  http: SseEvent[];
  /** Events delivered over the WebSocket topic (empty unless `handoff`). */
  ws: SseEvent[];
  /** Messages to append to the stored conversation, in order (excluding the user message). */
  messages: StoredMessage[];
}

/** Small deterministic PRNG so failures are reproducible. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Split text into small chunks of 1-9 code points (never splits a surrogate pair). */
export function splitChunks(text: string, seed: number, max = 9): string[] {
  const cps = Array.from(text);
  const rnd = lcg(seed);
  const out: string[] = [];
  for (let i = 0; i < cps.length; ) {
    const n = 1 + Math.floor(rnd() * max);
    out.push(cps.slice(i, i + n).join(''));
    i += n;
  }
  return out;
}

const now = () => Date.now() / 1000;

function message(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'author' | 'content'>): StoredMessage {
  return {
    create_time: now(),
    update_time: null,
    status: 'in_progress',
    end_turn: null,
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: null,
    ...partial,
  };
}

const assistant = { role: 'assistant' as const, name: null, metadata: {} };

/**
 * Build the event sequence of one assistant turn.
 * Returned messages are already in their final (finished) state.
 */
export function buildTurnStream(spec: TurnStreamSpec): TurnStream {
  const C = spec.conversationId;
  const http: SseEvent[] = [];
  const ws: SseEvent[] = [];
  const messages: StoredMessage[] = [];
  let counter = 0;
  // After the handoff point, everything goes to the WebSocket list.
  let out = http;
  const delta = (v: unknown) => out.push({ event: 'delta', data: JSON.stringify(v) });
  const typed = (v: unknown) => out.push({ data: JSON.stringify(v) });
  const rnd = lcg(spec.seed ^ 0x9e3779b9);

  http.push({ event: 'delta_encoding', data: '"v1"' });
  // The real stream starts with a resume token (a JWT). Extensions must never log it.
  typed({ type: 'resume_conversation_token', kind: 'topic', token: 'eyJhbGciOiJIUzI1NiJ9.ZmFrZS1yZXN1bWUtdG9rZW4.c2lnbmF0dXJl', conversation_id: C });

  if (spec.newConversation) {
    // Hidden context message that every new conversation starts with.
    const sys = message({
      id: spec.newId(),
      author: { role: 'system', name: null, metadata: {} },
      content: { content_type: 'text', parts: [''] },
      status: 'finished_successfully',
      end_turn: true,
      weight: 0,
      metadata: { is_visually_hidden_from_conversation: true },
    });
    delta({ p: '', o: 'add', v: { message: sys, conversation_id: C, error: null }, c: counter++ });
    messages.push(sys);
  }
  typed({ type: 'input_message', input_message: spec.userMessage, conversation_id: C });
  typed({
    type: 'server_ste_metadata',
    metadata: {
      conduit_prewarmed: true,
      fast_convo: true,
      warmup_state: 'warm',
      is_first_turn: spec.newConversation,
      model_slug: spec.modelSlug,
      resolved_model_slug: spec.modelSlug,
      requested_model_experience: spec.thoughts ? 'thinking' : 'chat',
      product_experience: 'chat',
      did_auto_switch_to_reasoning: false,
      is_search: false,
      message_id: spec.assistantMessageId,
      turn_exchange_id: spec.handoff?.turnExchangeId ?? spec.newId(),
      resume_with_websockets: !!spec.handoff,
    },
    conversation_id: C,
  });

  if (spec.handoff) {
    typed({
      type: 'stream_handoff',
      conversation_id: C,
      turn_exchange_id: spec.handoff.turnExchangeId,
      options: [{ type: 'subscribe_ws_topic', topic_id: spec.handoff.topicId }],
    });
    out = ws;
  }

  let parent = spec.userMessage.id;

  // --- reasoning ("thoughts" + "reasoning_recap"), never part of the answer ---
  if (spec.thoughts?.length) {
    const thoughtsId = spec.newId();
    const t = message({
      id: thoughtsId,
      author: assistant,
      content: { content_type: 'thoughts', thoughts: [], source_analysis_msg_id: spec.newId() },
      metadata: { reasoning_status: 'is_reasoning', model_slug: spec.modelSlug, parent_id: parent },
    });
    delta({ p: '', o: 'add', v: { message: structuredClone(t), conversation_id: C, error: null }, c: counter++ });
    const thoughts: Array<{ summary: string; content: string; chunks: string[]; finished: boolean }> = [];
    spec.thoughts.forEach((summary, i) => {
      delta({ p: '/message/content/thoughts', o: 'append', v: [{ summary, content: '', chunks: [], finished: false }] });
      const body = `Considering: ${summary}. The user wants the requested change; I will answer in the required format.`;
      const parts = splitChunks(body, spec.seed + i);
      // First chunk names the path; the rest use the implicit path/op (same rule as answer text).
      delta({ p: `/message/content/thoughts/${i}/content`, o: 'append', v: parts[0] });
      for (const p of parts.slice(1)) delta({ v: p });
      delta({ p: '', o: 'patch', v: [{ p: `/message/content/thoughts/${i}/finished`, o: 'replace', v: true }] });
      thoughts.push({ summary, content: body, chunks: [], finished: true });
    });
    delta({
      p: '',
      o: 'patch',
      v: [
        { p: '/message/status', o: 'replace', v: 'finished_successfully' },
        { p: '/message/metadata', o: 'append', v: { reasoning_status: 'reasoning_ended' } },
      ],
    });
    messages.push({ ...t, content: { ...t.content, thoughts }, status: 'finished_successfully', metadata: { ...t.metadata, reasoning_status: 'reasoning_ended' } });
    parent = thoughtsId;

    const recap = message({
      id: spec.newId(),
      author: assistant,
      content: { content_type: 'reasoning_recap', content: `Thought for ${spec.thoughts.length + 1}s` },
      status: 'finished_successfully',
      metadata: { finished_duration_sec: spec.thoughts.length + 1, reasoning_status: 'reasoning_ended', parent_id: parent },
    });
    // Snapshot form `{v:{message}}` (no p/o): resets the "current message".
    delta({ v: { message: recap, conversation_id: C, error: null }, c: counter++ });
    messages.push(recap);
    parent = recap.id;
  }

  // --- commentary preamble: assistant text that is NOT the answer ---
  if (spec.preamble) {
    const pre = message({
      id: spec.newId(),
      author: assistant,
      content: { content_type: 'text', parts: [''] },
      channel: 'commentary',
      metadata: { is_thinking_preamble_message: true, parent_id: parent, model_slug: spec.modelSlug },
    });
    delta({ p: '', o: 'add', v: { message: structuredClone(pre), conversation_id: C, error: null }, c: counter++ });
    const parts = splitChunks(spec.preamble, spec.seed + 77);
    delta({ p: '/message/content/parts/0', o: 'append', v: parts[0] });
    for (const p of parts.slice(1)) delta({ v: p });
    delta({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] });
    messages.push({ ...pre, content: { content_type: 'text', parts: [spec.preamble] }, status: 'finished_successfully' });
    parent = pre.id;
  }

  // --- the answer (final channel) ---
  const answerMeta = {
    citations: [],
    content_references: [],
    model_slug: spec.modelSlug,
    default_model_slug: 'auto',
    parent_id: parent,
    request_id: spec.newId(),
  };
  const ans = message({
    id: spec.assistantMessageId,
    author: assistant,
    content: { content_type: 'text', parts: [''] },
    channel: 'final',
    metadata: answerMeta,
  });
  delta({ p: '', o: 'add', v: { message: structuredClone(ans), conversation_id: C, error: null }, c: counter++ });
  typed({ type: 'message_marker', conversation_id: C, message_id: ans.id, marker: 'user_visible_token', event: 'first' });

  const chunks = splitChunks(spec.answer, spec.seed);
  const last = chunks.length > 1 ? chunks.pop()! : '';
  let explicit = true; // the next text frame must name its path and op
  chunks.forEach((chunk, i) => {
    // Now and then a mid-stream patch bundles a text append with metadata, like the real site does.
    if (i > 0 && i % 23 === 0 && rnd() < 0.8) {
      delta({
        p: '',
        o: 'patch',
        v: [
          { p: '/message/content/parts/0', o: 'append', v: chunk },
          { p: '/message/metadata/content_references', o: 'append', v: [] },
        ],
      });
      explicit = true;
      return;
    }
    if (explicit) delta({ p: '/message/content/parts/0', o: 'append', v: chunk });
    else delta({ v: chunk });
    explicit = false;
  });
  const finishType = spec.finishReason;
  delta({
    p: '',
    o: 'patch',
    v: [
      { p: '/message/content/parts/0', o: 'append', v: last },
      { p: '/message/status', o: 'replace', v: 'finished_successfully' },
      { p: '/message/end_turn', o: 'replace', v: finishType === 'stop' },
      { p: '/message/metadata', o: 'append', v: { is_complete: true, finish_details: { type: finishType, stop_tokens: [200002] } } },
    ],
  });
  messages.push({
    ...ans,
    content: { content_type: 'text', parts: [spec.answer] },
    status: 'finished_successfully',
    end_turn: finishType === 'stop',
    update_time: now(),
    metadata: { ...answerMeta, is_complete: true, finish_details: { type: finishType, stop_tokens: [200002] } },
  });

  typed({ type: 'message_stream_complete', conversation_id: C });
  typed({ type: 'conversation_detail_metadata', banner_info: null, blocked_features: [], model_limits: [], default_model_slug: 'auto', conversation_id: C });
  if (spec.newConversation && !spec.temporary) typed({ type: 'title_generation', title: spec.title ?? 'New chat', conversation_id: C });
  // The HTTP body always ends with [DONE]. A WebSocket topic ends with a
  // `{"type":"done"}` envelope instead (added by the backend), not with [DONE].
  if (!spec.handoff || spec.handoff.httpDone !== false) http.push({ data: '[DONE]' });
  return { http, ws, messages };
}

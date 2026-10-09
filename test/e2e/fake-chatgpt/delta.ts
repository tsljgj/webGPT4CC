// Reference delta_encoding "v1" reducer (Node side), written from the rules in
// docs/EXTENSION.md. The fake's self-test uses it to check that the streams the
// fake produces decode to the scripted answer; the extension has its own copy.

export interface ReducedTurn {
  conversationId?: string;
  /** Final-channel assistant text. */
  answer: string;
  messageId?: string;
  finishReason?: string;
  /** message_stream_complete was seen. */
  complete: boolean;
  /** topic_id of a stream_handoff, if any. */
  handoffTopic?: string;
  /** Every message seen, by id, in its latest state. */
  messages: Map<string, Record<string, unknown>>;
  errors: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function applyOp(root: Json, path: string, op: string, value: unknown): Json {
  if (op === 'patch') {
    for (const child of (value as Array<{ p?: string; o?: string; v?: unknown }>) ?? [])
      root = applyOp(root, path + (child.p ?? ''), child.o ?? 'replace', child.v);
    return root;
  }
  if (path === '') {
    if (op === 'add' || op === 'replace') return value as Json;
    if (op === 'append' && isObj(value)) return Object.assign(root, value);
    return root;
  }
  const keys = path.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node: Record<string, unknown> | unknown[] = root;
  for (const k of keys.slice(0, -1)) {
    const next = (node as Record<string, unknown>)[k];
    if (next === null || typeof next !== 'object') (node as Record<string, unknown>)[k] = {};
    node = (node as Record<string, unknown>)[k] as Record<string, unknown>;
  }
  const key = keys[keys.length - 1]!;
  const cur = (node as Record<string, unknown>)[key];
  switch (op) {
    case 'add':
    case 'replace':
      (node as Record<string, unknown>)[key] = value;
      break;
    case 'append':
      if (typeof cur === 'string') (node as Record<string, unknown>)[key] = cur + String(value);
      else if (Array.isArray(cur)) Array.isArray(value) ? cur.push(...value) : cur.push(value);
      else if (isObj(cur) && isObj(value)) Object.assign(cur, value);
      else (node as Record<string, unknown>)[key] = value;
      break;
    case 'remove':
      if (Array.isArray(node)) node.splice(Number(key), 1);
      else delete (node as Record<string, unknown>)[key];
      break;
    case 'truncate':
      if (typeof cur === 'string' || Array.isArray(cur)) (node as Record<string, unknown>)[key] = cur.slice(0, Number(value));
      break;
  }
  return root;
}

/** True when `m` is a candidate for "the answer" (see docs/EXTENSION.md). */
export function isAnswerMessage(m: Json): boolean {
  const author = m.author as Json | undefined;
  const content = m.content as Json | undefined;
  const meta = (m.metadata as Json | undefined) ?? {};
  if (author?.role !== 'assistant') return false;
  if (m.recipient && m.recipient !== 'all') return false;
  const ct = content?.content_type;
  if (ct !== 'text' && ct !== 'multimodal_text') return false;
  if (meta.is_visually_hidden_from_conversation === true || meta.is_thinking_preamble_message === true) return false;
  return m.channel === 'final' || m.channel == null;
}

export function stripMarkers(text: string): string {
  return text.replace(/[\s\S]*?/g, '').replace(/[-]/g, '');
}

export class DeltaReducer {
  private root: Json | null = null;
  private lastP: string | undefined;
  private lastO: string | undefined;
  private buf = '';
  private dataLines: string[] = [];
  readonly turn: ReducedTurn = { answer: '', complete: false, messages: new Map(), errors: [] };
  private answerId: string | undefined;

  /** Feed raw SSE text (any chunking). */
  feedSse(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line === '') {
        if (this.dataLines.length) this.feedData(this.dataLines.join('\n'));
        this.dataLines = [];
      } else if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  /** Feed one SSE `data:` payload. */
  feedData(data: string): void {
    if (data === '[DONE]') return;
    let v: unknown;
    try {
      v = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(v)) return; // "v1"
    if (typeof v.conversation_id === 'string') this.turn.conversationId ??= v.conversation_id;
    if (v.error) this.turn.errors.push(String(isObj(v.error) ? JSON.stringify(v.error) : v.error));
    if (typeof v.type === 'string') {
      if (v.type === 'message_stream_complete') this.turn.complete = true;
      if (v.type === 'stream_handoff') {
        const opt = (v.options as Json[] | undefined)?.find((o) => o.type === 'subscribe_ws_topic');
        if (opt) this.turn.handoffTopic = String(opt.topic_id);
      }
      return;
    }
    if (!('v' in v) && !('o' in v)) return;
    const vv = v.v as Json | undefined;
    const startsMessage = isObj(vv) && isObj(vv.message) && (v.p === undefined || v.p === '') && (v.o === undefined || v.o === 'add' || v.o === 'replace');
    if (startsMessage) {
      this.root = vv as Json;
      this.lastP = undefined;
      this.lastO = undefined;
      if (typeof vv!.conversation_id === 'string') this.turn.conversationId ??= vv!.conversation_id as string;
    } else {
      const p = (v.p as string | undefined) ?? this.lastP;
      const o = (v.o as string | undefined) ?? this.lastO;
      if (p === undefined || o === undefined || !this.root) return;
      this.root = applyOp(this.root, p, o, v.v);
      this.lastP = p;
      this.lastO = o;
    }
    const msg = this.root?.message as Json | undefined;
    if (isObj(msg) && typeof msg.id === 'string') {
      this.turn.messages.set(msg.id, msg);
      if (isAnswerMessage(msg)) this.answerId = msg.id;
    }
    this.updateAnswer();
  }

  private updateAnswer(): void {
    if (!this.answerId) return;
    const m = this.turn.messages.get(this.answerId)!;
    const parts = ((m.content as Json).parts as unknown[]) ?? [];
    this.turn.answer = stripMarkers(parts.filter((p) => typeof p === 'string').join(''));
    this.turn.messageId = this.answerId;
    const fd = ((m.metadata as Json | undefined)?.finish_details as Json | undefined)?.type;
    if (typeof fd === 'string') this.turn.finishReason = fd;
  }
}

/** Decode a complete SSE body. */
export function reduceSse(text: string): ReducedTurn {
  const r = new DeltaReducer();
  r.feedSse(text.endsWith('\n\n') ? text : text + '\n\n');
  return r.turn;
}

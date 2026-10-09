// Maps Claude Code transcripts onto ChatGPT conversations.
//
// Claude Code resends the whole transcript on every request, while a ChatGPT
// conversation is stateful. After we answer a request we remember a
// fingerprint of the assistant message we produced. When the next request
// arrives, its last assistant message is (an echo of) that reply, so we can
// continue the same ChatGPT conversation and only send the new tail
// (tool results, user text). Anything we can't match starts a new ChatGPT
// conversation that replays the transcript.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContentBlock, MessageParam, MessagesRequest, ResponseBlock, TextBlock, ToolUseBlock } from '../anthropic/types.ts';
import { systemText } from '../translate/render.ts';

export function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Fingerprint of an assistant message, stable across Claude Code's re-serialization. */
export function assistantFingerprint(content: MessageParam['content'] | ResponseBlock[], scope = ''): string {
  const blocks: ContentBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (content as ContentBlock[]);
  const ids = blocks.filter((b) => b.type === 'tool_use').map((b) => (b as ToolUseBlock).id);
  // tool_use ids are unique; a text-only reply ("Done.") is only unique within a session.
  if (ids.length) return sha(`tools:${ids.join(',')}`);
  if (scope) return sha(`text:${scope}:${blocks
    .filter((b) => b.type === 'text')
    .map((b) => normText((b as TextBlock).text))
    .filter(Boolean)
    .join(' ')}`);
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => normText((b as TextBlock).text))
    .filter(Boolean)
    .join(' ');
  return sha(`text:${text}`);
}

/** Hash of everything that, if changed, means the ChatGPT conversation's preamble is stale. */
export function contextHash(req: MessagesRequest, chatModel: string): string {
  const tools = (req.tools ?? []).map((t) => t.name).sort().join(',');
  return sha(`${chatModel}\n${tools}\n${normText(systemText(req.system))}`);
}

function canonicalBlock(b: ContentBlock): unknown {
  switch (b.type) {
    case 'text':
      return { t: normText((b as TextBlock).text) };
    case 'tool_use':
      return { u: (b as ToolUseBlock).id, n: (b as ToolUseBlock).name, i: (b as ToolUseBlock).input };
    case 'tool_result': {
      const r = b as { tool_use_id: string; content?: unknown; is_error?: boolean };
      const c = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : (r.content ?? []);
      return { r: r.tool_use_id, e: !!r.is_error, c: (c as ContentBlock[]).map(canonicalBlock) };
    }
    case 'thinking':
    case 'redacted_thinking':
      return null;
    case 'image': {
      const src = (b as { source?: { data?: string; url?: string } }).source;
      return { img: src?.data ? sha(src.data) : src?.url };
    }
    default: {
      const { cache_control: _cc, ...rest } = b as Record<string, unknown>;
      return rest;
    }
  }
}

export function canonicalMessages(messages: MessageParam[]): unknown[] {
  return messages.map((m) => {
    const blocks: ContentBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    return {
      r: m.role,
      c: blocks
        .map(canonicalBlock)
        .filter((x) => x !== null && !(typeof x === 'object' && 't' in (x as object) && (x as { t: string }).t === '')),
    };
  });
}

/**
 * Hash of a whole request, used to deduplicate client retries. Claude Code sends
 * its session id (x-claude-code-session-id, also inside metadata.user_id), which
 * keeps two sessions that happen to send the same request apart.
 */
export function requestHash(req: MessagesRequest, chatModel: string, sessionId = ''): string {
  const scope = sessionId || (typeof req.metadata?.user_id === 'string' ? req.metadata.user_id : '');
  return sha(JSON.stringify([scope, contextHash(req, chatModel), canonicalMessages(req.messages)]));
}

export interface TurnRecord {
  conversationId: string;
  /** ChatGPT message id of the assistant reply (if the provider reported it). */
  assistantMessageId?: string;
  /** Worker (browser tab) that holds the conversation, if any. */
  workerId?: string;
  /** Index of the assistant message inside the Anthropic messages array. */
  messageIndex: number;
  contextHash: string;
  chatModel: string;
  /** Rough size of the ChatGPT conversation so far, in tokens. */
  conversationTokens: number;
  /** Number of messages sent in this ChatGPT conversation so far. */
  turns: number;
}

interface StoredTurn extends TurnRecord {
  seq: number;
  at: number;
}

export class SessionStore {
  private readonly turns = new Map<string, StoredTurn>();
  private readonly head = new Map<string, number>();
  private seq = 0;
  private readonly maxEntries: number;
  /** JSON file the store is persisted to (so a bridge restart can keep continuing chats); '' = memory only. */
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(maxEntries = 5000, file = '') {
    this.maxEntries = maxEntries;
    this.file = file;
    if (file) this.load();
  }

  record(fingerprint: string, turn: TurnRecord): void {
    const seq = ++this.seq;
    this.turns.delete(fingerprint);
    this.turns.set(fingerprint, { ...turn, seq, at: Date.now() });
    this.head.set(turn.conversationId, seq);
    if (this.turns.size > this.maxEntries) {
      // Drop the oldest entries (Map preserves insertion order).
      const drop = this.turns.size - this.maxEntries;
      let i = 0;
      for (const k of this.turns.keys()) {
        if (i++ >= drop) break;
        this.turns.delete(k);
      }
      const live = new Set([...this.turns.values()].map((t) => t.conversationId));
      for (const c of this.head.keys()) if (!live.has(c)) this.head.delete(c);
    }
    this.scheduleSave();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as {
        version: number;
        seq: number;
        turns: Array<[string, StoredTurn]>;
        head: Array<[string, number]>;
      };
      if (data.version !== 1) return;
      for (const [k, v] of data.turns) this.turns.set(k, v);
      for (const [k, v] of data.head) this.head.set(k, v);
      this.seq = data.seq;
    } catch {
      /* missing or corrupt: start empty */
    }
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 1000);
    this.saveTimer.unref?.();
  }

  /** Write the store to disk now (called on shutdown). */
  flush(): void {
    if (!this.file) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, seq: this.seq, turns: [...this.turns], head: [...this.head] }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      /* best effort */
    }
  }

  /**
   * Find the ChatGPT conversation to continue for a request whose last
   * assistant message has `fingerprint` at `messageIndex`. Only the newest
   * turn of a conversation can be continued (older ones would need a branch).
   */
  lookup(fingerprint: string, messageIndex: number, ctxHash: string): TurnRecord | undefined {
    const t = this.turns.get(fingerprint);
    if (!t) return undefined;
    if (t.messageIndex !== messageIndex || t.contextHash !== ctxHash) return undefined;
    if (this.head.get(t.conversationId) !== t.seq) return undefined;
    return t;
  }

  /** Forget a conversation (e.g. the worker reported it is gone). */
  dropConversation(conversationId: string): void {
    this.head.delete(conversationId);
    this.scheduleSave();
  }

  get size(): number {
    return this.turns.size;
  }
}

/**
 * Cache of in-flight and recently finished responses keyed by request hash, so
 * a client retry of an identical request does not cost another ChatGPT turn.
 * Entries live while in flight and for `ttlMs` after they settle.
 */
export class ResponseCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; settledAt?: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 3 * 60_000) {
    this.ttlMs = ttlMs;
  }

  private expired(e: { settledAt?: number }): boolean {
    return e.settledAt !== undefined && Date.now() - e.settledAt > this.ttlMs;
  }

  get(key: string): Promise<T> | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.expired(e)) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: Promise<T>): void {
    const entry: { value: Promise<T>; settledAt?: number } = { value };
    this.entries.set(key, entry);
    value.then(
      () => (entry.settledAt = Date.now()),
      // Failed generations must not be replayed to retries.
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    for (const [k, e] of this.entries) if (this.expired(e)) this.entries.delete(k);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

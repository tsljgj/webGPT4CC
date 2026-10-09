// Fake chatgpt.com for end-to-end tests: serves the fake front end (index.html +
// app.js) and its backend through Playwright routing, so nothing listens on a
// port and all state lives in this Node process.
//
//   context.route('https://chatgpt.com/**')      -> pages, /api/auth/session, /backend-api/*
//   context.routeWebSocket('wss://ws.chatgpt.com/**') -> the stream_handoff topic socket
//
// Limitation: Playwright's route.fulfill() delivers a response body in one
// piece, so SSE frames reach the page together (the page still reads them via
// response.body.getReader(), which is what the extension observes). The
// WebSocket handoff mode delivers its frames one by one with real delays.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Route, WebSocketRoute } from 'playwright';
import { buildTurnStream, formatSse, type SseEvent, type StoredMessage } from './stream.ts';

const HERE = import.meta.dirname;

/** What the scripted "LLM" returns: a plain string, or a string plus streaming options. */
export interface FakeReply {
  /** Final-channel answer text (raw markdown, may contain <tool_call> blocks). */
  text: string;
  /** Reasoning summaries streamed as a `thoughts` message before the answer. */
  thoughts?: string[];
  /** A commentary-channel preamble message before the answer (not part of the answer). */
  preamble?: string;
  /** Override the transport for this turn. */
  transport?: 'sse' | 'ws';
  finishReason?: 'stop' | 'max_tokens' | 'interrupted';
  /** Wait this long before answering the POST (the page shows the stop button meanwhile). */
  delayMs?: number;
  /** Answer the POST with this status and JSON body instead of a stream. */
  httpError?: { status: number; body: unknown };
}

export interface LlmContext {
  conversationId: string;
  /** 0-based index of this turn in its conversation. */
  turn: number;
  /** Earlier turns of the same conversation. */
  history: Array<{ prompt: string; reply: string }>;
  temporary: boolean;
  model: string;
  request: RecordedRequest;
}

export type FakeLlm = (prompt: string, ctx: LlmContext) => string | FakeReply | Promise<string | FakeReply>;

export interface FakeOptions {
  llm: FakeLlm;
  /** Default transport for replies: plain SSE, or stream_handoff + WebSocket. */
  transport: 'sse' | 'ws';
  /** Add a reasoning ("thoughts") message before every answer. */
  thoughts: boolean;
  /** When set, every conversation POST is answered with HTTP 429. */
  rateLimit: { clearsInSec?: number; message?: string } | null;
  loggedIn: boolean;
  /** Initial state of the Chat/Work switch in the composer. */
  composerMode: 'chat' | 'work';
  /** Delay before the app renders (pages hydrate after load on the real site). */
  hydrationDelayMs: number;
  /** A single paste longer than this becomes a "Pasted text" chip (real site: 10k). */
  pasteChipThreshold: number;
  /** GET /backend-api/conversation/{id}: normal, or a Cloudflare challenge (403 HTML). */
  conversationApi: 'ok' | 'cloudflare';
  /** Model slug reported in stream metadata when the request says "auto". */
  modelSlug: string;
  /** Delay between WebSocket frames in handoff mode. */
  wsFrameDelayMs: number;
  /** Stream items sent as subscribe catch-ups (the first of the live items repeats the last catch-up). */
  wsCatchups: number;
  /** Print every handled request (or pass a function). */
  log: boolean | ((line: string) => void);
}

export interface RecordedRequest {
  index: number;
  at: number;
  /** conversation_id the page sent (undefined for a new chat). */
  conversationId?: string;
  parentMessageId?: string;
  /** messages[0].content.parts[0] */
  prompt: string;
  model: string;
  temporary: boolean;
  composerMode: string;
  body: Record<string, unknown>;
  /** HTTP status the fake answered with. */
  status: number;
  /** Conversation the reply belongs to. */
  responseConversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  transport?: 'sse' | 'ws';
  reply?: string;
  /** For continuations: whether parent_message_id was the conversation's current node. */
  parentIsCurrentNode?: boolean;
}

export interface FakeConversation {
  id: string;
  title: string;
  temporary: boolean;
  createTime: number;
  /** Linear message chain (system, user, assistant...). */
  messages: StoredMessage[];
  currentNode: string;
  turns: Array<{ prompt: string; reply: string }>;
}

interface PendingTopic {
  topicId: string;
  items: Array<{ id: string; encoded: string }>;
  delivered: boolean;
}

export const FAKE_USER = { id: 'user-FAKE0000000000000000001', name: 'Fake User', email: 'fake.user@example.com', image: '', picture: '', idp: 'auth0', iat: 1, mfa: false, groups: [], intercom_hash: 'x' };

/** Default LLM: echo the last line of the prompt. */
export const echoLlm: FakeLlm = (prompt) => `Echo: ${prompt.trim().split('\n').pop()}`;

export class FakeChatGPT {
  options: FakeOptions;
  /** Every POST /backend-api/f/conversation, in order. */
  readonly requests: RecordedRequest[] = [];
  readonly conversations = new Map<string, FakeConversation>();
  /** Every subscribe command received on the WebSocket. */
  readonly wsSubscriptions: Array<{ topicId: string; at: number }> = [];
  /** Every handled HTTP request ("METHOD /path STATUS"). */
  readonly httpLog: string[] = [];
  readonly accessToken = `fake-access-token-${randomUUID()}`;
  private readonly topics = new Map<string, PendingTopic>();
  private seq = 0;

  constructor(options: Partial<FakeOptions> = {}) {
    this.options = {
      llm: echoLlm,
      transport: 'sse',
      thoughts: false,
      rateLimit: null,
      loggedIn: true,
      composerMode: 'chat',
      hydrationDelayMs: 300,
      pasteChipThreshold: 10_000,
      conversationApi: 'ok',
      modelSlug: 'gpt-5-6-thinking',
      wsFrameDelayMs: 25,
      wsCatchups: 3,
      log: false,
      ...options,
    };
  }

  /** Route chatgpt.com (HTTP) and ws.chatgpt.com (WebSocket) for a context or page. */
  async install(target: BrowserContext | Page): Promise<void> {
    await target.route(/^https:\/\/chatgpt\.com\//, (route) => this.handle(route));
    await target.routeWebSocket(/^wss:\/\/ws\.chatgpt\.com\//, (ws) => this.handleWebSocket(ws));
  }

  /** Wait until at least `n` conversation requests were received. */
  async waitForRequests(n: number, timeoutMs = 30_000): Promise<RecordedRequest[]> {
    const end = Date.now() + timeoutMs;
    while (this.requests.length < n) {
      if (Date.now() > end) throw new Error(`fake chatgpt: expected ${n} conversation requests, got ${this.requests.length}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.requests;
  }

  private log(line: string): void {
    this.httpLog.push(line);
    if (this.options.log === true) process.stderr.write(`[fake-chatgpt] ${line}\n`);
    else if (typeof this.options.log === 'function') this.options.log(line);
  }

  private newId(): string {
    return randomUUID();
  }

  // ------------------------------------------------------------------ HTTP

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let status = 200;
    try {
      status = await this.dispatch(route, url, method);
    } catch (e) {
      status = 500;
      this.log(`ERROR ${method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: `fake chatgpt error: ${(e as Error).message}` }) }).catch(() => {});
      return;
    }
    this.log(`${method} ${url.pathname}${url.search} ${status}`);
  }

  private json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}): Promise<number> {
    return route
      .fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers })
      .then(() => status)
      .catch(() => status); // the page may have navigated away / aborted
  }

  private authorized(route: Route): boolean {
    return route.request().headers()['authorization'] === `Bearer ${this.accessToken}`;
  }

  private async dispatch(route: Route, url: URL, method: string): Promise<number> {
    const path = url.pathname;
    const req = route.request();

    // Static assets of the fake front end.
    if (path === '/cdn/assets/fake-chatgpt-app.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(HERE, 'app.js'), 'utf8') });
      return 200;
    }
    if (path === '/favicon.ico' || path.startsWith('/cdn/')) return this.json(route, 404, { detail: 'Not found' });

    if (path === '/api/auth/session') {
      if (!this.options.loggedIn) return this.json(route, 200, {});
      return this.json(route, 200, {
        user: FAKE_USER,
        expires: new Date(Date.now() + 30 * 86400_000).toISOString(),
        accessToken: this.accessToken,
        authProvider: 'auth0',
      });
    }

    if (path.startsWith('/backend-api/')) {
      if (!this.options.loggedIn || !this.authorized(route)) return this.json(route, 401, { detail: 'Unauthorized - Access token is missing' });
      return this.backend(route, url, method);
    }

    // Everything else that the browser navigates to is the single-page app.
    if (method === 'GET' && (req.resourceType() === 'document' || req.headers()['accept']?.includes('text/html'))) {
      const config = {
        composerMode: this.options.composerMode,
        hydrationDelayMs: this.options.hydrationDelayMs,
        pasteChipThreshold: this.options.pasteChipThreshold,
      };
      const html = readFileSync(join(HERE, 'index.html'), 'utf8').replace(
        '<!--FAKE_CONFIG-->',
        `<script>window.__FAKE_CHATGPT__ = ${JSON.stringify(config)};</script>`,
      );
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      return 200;
    }
    return this.json(route, 404, { detail: 'Not found' });
  }

  private async backend(route: Route, url: URL, method: string): Promise<number> {
    const path = url.pathname;
    const req = route.request();

    // The Sentinel / prepare calls the real page makes before every send.
    if (method === 'POST' && path === '/backend-api/sentinel/chat-requirements/prepare')
      return this.json(route, 200, { persona: 'chatgpt-paid', prepare_token: `prep-${this.seq++}`, proofofwork: { required: false }, turnstile: { required: false } });
    if (method === 'POST' && path === '/backend-api/sentinel/chat-requirements/finalize') return this.json(route, 200, { token: `gAAAAAB-fake-${this.seq++}` });
    if (method === 'POST' && path === '/backend-api/f/conversation/prepare') return this.json(route, 200, { status: 'ok', conduit_token: `conduit-${this.seq++}` });

    if (method === 'POST' && path === '/backend-api/f/conversation') return this.conversationPost(route, req.postData() ?? '');

    if (method === 'GET' && path === '/backend-api/celsius/ws/user')
      return this.json(route, 200, { websocket_url: `wss://ws.chatgpt.com/celsius/ws/user/${FAKE_USER.id}?verify=fake-${this.seq++}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });

    if (method === 'GET' && path === '/backend-api/models')
      return this.json(route, 200, { models: [{ slug: 'auto', title: 'Auto' }, { slug: 'gpt-5-6-thinking', title: 'Thinking' }, { slug: 'gpt-5-5-instant', title: 'Instant' }] });

    if (method === 'GET' && path === '/backend-api/conversations') {
      const items = [...this.conversations.values()]
        .filter((c) => !c.temporary)
        .reverse()
        .map((c) => ({ id: c.id, title: c.title, create_time: new Date(c.createTime * 1000).toISOString(), update_time: new Date().toISOString() }));
      return this.json(route, 200, { items, total: items.length, limit: 28, offset: 0 });
    }

    const m = /^\/backend-api\/conversation\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      if (this.options.conversationApi === 'cloudflare') {
        await route.fulfill({
          status: 403,
          contentType: 'text/html; charset=UTF-8',
          headers: { 'cf-mitigated': 'challenge' },
          body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
        });
        return 403;
      }
      const conv = this.conversations.get(decodeURIComponent(m[1]!));
      if (!conv) return this.json(route, 404, { detail: { code: 'conversation_not_found', message: "Can't load conversation" } });
      return this.json(route, 200, this.conversationJson(conv));
    }

    return this.json(route, 404, { detail: 'Not found' });
  }

  /** GET /backend-api/conversation/{id} body (mapping + current_node). */
  conversationJson(conv: FakeConversation): Record<string, unknown> {
    const mapping: Record<string, unknown> = {
      'client-created-root': { id: 'client-created-root', message: null, parent: null, children: conv.messages.length ? [conv.messages[0]!.id] : [] },
    };
    conv.messages.forEach((msg, i) => {
      mapping[msg.id] = {
        id: msg.id,
        message: msg,
        parent: i === 0 ? 'client-created-root' : conv.messages[i - 1]!.id,
        children: i + 1 < conv.messages.length ? [conv.messages[i + 1]!.id] : [],
      };
    });
    return {
      title: conv.title,
      create_time: conv.createTime,
      update_time: Date.now() / 1000,
      mapping,
      moderation_results: [],
      current_node: conv.currentNode,
      plugin_ids: null,
      conversation_id: conv.id,
      conversation_template_id: null,
      gizmo_id: null,
      is_archived: false,
      is_temporary_chat: conv.temporary,
      safe_urls: [],
      default_model_slug: 'auto',
    };
  }

  private async conversationPost(route: Route, raw: string): Promise<number> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.json(route, 400, { detail: 'invalid JSON' });
    }
    const msgs = (body.messages as Array<Record<string, unknown>>) ?? [];
    const first = msgs[0] ?? {};
    const parts = ((first.content as Record<string, unknown> | undefined)?.parts as unknown[]) ?? [];
    const prompt = parts.filter((p) => typeof p === 'string').join('');
    const temporary = body.history_and_training_disabled === true;
    const mode = String(((body.conversation_mode as Record<string, unknown> | undefined)?.kind as string) ?? 'primary_assistant');
    const rec: RecordedRequest = {
      index: this.requests.length,
      at: Date.now(),
      conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
      parentMessageId: typeof body.parent_message_id === 'string' ? body.parent_message_id : undefined,
      prompt,
      model: String(body.model ?? ''),
      temporary,
      composerMode: mode === 'work' ? 'work' : 'chat',
      body,
      status: 0,
    };
    this.requests.push(rec);

    if (this.options.rateLimit) {
      const clears = this.options.rateLimit.clearsInSec ?? 3600;
      rec.status = 429;
      return this.json(route, 429, {
        detail: {
          message: this.options.rateLimit.message ?? "You've reached our limit of messages per hour. Please try again later.",
          code: 'rate_limit_exceeded',
          clears_in: clears,
        },
      });
    }

    // Find or create the conversation.
    let conv: FakeConversation | undefined;
    if (rec.conversationId) {
      conv = this.conversations.get(rec.conversationId);
      if (!conv) {
        rec.status = 404;
        return this.json(route, 404, { detail: { code: 'conversation_not_found', message: 'Conversation not found' } });
      }
      rec.parentIsCurrentNode = rec.parentMessageId === conv.currentNode;
    }
    const isNew = !conv;
    if (!conv) {
      conv = {
        id: this.newId(),
        title: prompt.replace(/[#*`<>]/g, ' ').trim().split(/\s+/).slice(0, 5).join(' ') || 'New chat',
        temporary,
        createTime: Date.now() / 1000,
        messages: [],
        currentNode: 'client-created-root',
        turns: [],
      };
      this.conversations.set(conv.id, conv);
    }

    const ctx: LlmContext = { conversationId: conv.id, turn: conv.turns.length, history: conv.turns.map((t) => ({ ...t })), temporary, model: rec.model, request: rec };
    const out = await this.options.llm(prompt, ctx);
    const reply: FakeReply = typeof out === 'string' ? { text: out } : out;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (reply.httpError) {
      rec.status = reply.httpError.status;
      if (isNew) this.conversations.delete(conv.id);
      return this.json(route, reply.httpError.status, reply.httpError.body);
    }

    const work = rec.composerMode === 'work';
    const transport = work ? 'ws' : (reply.transport ?? this.options.transport);
    const userMessage: StoredMessage = {
      id: typeof first.id === 'string' ? first.id : this.newId(),
      author: { role: 'user', name: null, metadata: {} },
      create_time: Date.now() / 1000,
      update_time: null,
      content: { content_type: 'text', parts: [prompt] },
      status: 'finished_successfully',
      end_turn: null,
      weight: 1,
      metadata: { serialization_metadata: { custom_symbol_offsets: [] } },
      recipient: 'all',
      channel: null,
    };
    const assistantMessageId = this.newId();
    const turnExchangeId = this.newId();
    const topicId = `conversation-turn-${turnExchangeId}`;
    const thoughts = reply.thoughts ?? (this.options.thoughts ? ['Reading the request', 'Planning the answer'] : undefined);
    const stream = buildTurnStream({
      conversationId: conv.id,
      newConversation: isNew,
      temporary,
      userMessage,
      assistantMessageId,
      modelSlug: work ? 'gpt-6-luna-wm' : !rec.model || rec.model === 'auto' ? this.options.modelSlug : rec.model,
      answer: reply.text,
      finishReason: reply.finishReason ?? 'stop',
      thoughts,
      preamble: reply.preamble,
      title: conv.title,
      handoff: transport === 'ws' ? { topicId, turnExchangeId } : undefined,
      seed: this.requests.length * 7919 + 17,
      newId: () => this.newId(),
    });

    // Commit the turn to the stored conversation.
    // A new conversation's stream starts with the hidden system message, which precedes the user message.
    const rest = isNew ? stream.messages.slice(1) : stream.messages;
    if (isNew) conv.messages.push(stream.messages[0]!);
    conv.messages.push(userMessage, ...rest);
    conv.currentNode = assistantMessageId;
    conv.turns.push({ prompt, reply: reply.text });
    Object.assign(rec, {
      responseConversationId: conv.id,
      userMessageId: userMessage.id,
      assistantMessageId,
      transport,
      reply: reply.text,
      status: 200,
    });

    if (transport === 'ws') {
      this.topics.set(topicId, {
        topicId,
        delivered: false,
        items: stream.ws.map((e, i) => ({ id: `${turnExchangeId}:${i}`, encoded: formatSse([e]) })),
      });
    }
    await route
      .fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-oai-request-id': this.newId() },
        body: formatSse(stream.http),
      })
      .catch(() => {});
    return 200;
  }

  // ------------------------------------------------------------- WebSocket

  private handleWebSocket(ws: WebSocketRoute): void {
    // No connectToServer(): Playwright opens the socket for the page without a network connection.
    let closed = false;
    ws.onClose(() => {
      closed = true;
    });
    const send = (v: unknown) => {
      if (!closed) ws.send(JSON.stringify(v));
    };
    const envelope = (topicId: string, payload: Record<string, unknown>) => ({
      type: 'message',
      topic_id: topicId,
      payload: { type: 'conversation-turn-stream', payload },
    });
    ws.onMessage((raw) => {
      let cmd: Record<string, unknown>;
      try {
        cmd = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (cmd.type === 'ping') return send({ type: 'pong', id: cmd.id });
      if (cmd.type !== 'subscribe') return;
      const topicId = String(cmd.topic_id);
      this.wsSubscriptions.push({ topicId, at: Date.now() });
      this.log(`WS subscribe ${topicId}`);
      const topic = this.topics.get(topicId);
      if (!topic) return send({ type: 'reply', id: cmd.id, reply: { ok: false, error: 'unknown_topic', catchups: [] } });
      topic.delivered = true;
      const item = (it: { id: string; encoded: string }) => envelope(topicId, { type: 'stream-item', stream_item_id: it.id, encoded_item: it.encoded });
      const k = Math.min(this.options.wsCatchups, topic.items.length);
      send({ type: 'reply', id: cmd.id, reply: { ok: true, catchups: topic.items.slice(0, k).map(item) } });
      // Live items start with a repeat of the last catch-up (clients deduplicate by
      // stream_item_id); one frame carries two envelopes as a JSON array.
      const live: unknown[] = [];
      const rest = topic.items.slice(Math.max(0, k - 1));
      for (let i = 0; i < rest.length; i++) {
        if (i === 2 && i + 1 < rest.length) {
          live.push([item(rest[i]!), item(rest[i + 1]!)]);
          i++;
        } else live.push(item(rest[i]!));
      }
      live.push(envelope(topicId, { type: 'done' }));
      let n = 0;
      const tick = () => {
        if (closed || n >= live.length) return;
        send(live[n++]);
        setTimeout(tick, this.options.wsFrameDelayMs);
      };
      setTimeout(tick, this.options.wsFrameDelayMs);
    });
  }
}

/** Parse an SSE body into events (for tests that inspect what the fake sent). */
export function parseSseEvents(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((c) => c.trim())
    .map((chunk) => {
      const ev = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return ev ? { event: ev, data } : { data };
    });
}

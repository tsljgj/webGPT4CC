// POST /v1/messages: translate an Anthropic request into one ChatGPT turn.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  ErrorType,
  MessageParam,
  MessagesRequest,
  ResponseBlock,
  StopReason,
  ToolDefinition,
  Usage,
} from './anthropic/types.ts';
import { SseMessageWriter, buildMessageResponse, newMessageId, newToolUseId, sendJson, sendJsonError } from './anthropic/sse.ts';
import { type BridgeConfig, resolveChatModel } from './config.ts';
import type { Logger } from './log.ts';
import { localBackgroundReply, classifyRequest, webSearchPrompt, type RequestKind } from './background.ts';
import type { ChatEvent, ChatJob, ChatProvider, ConversationTarget, ProviderErrorCode } from './providers/types.ts';
import {
  ResponseCache,
  SessionStore,
  assistantFingerprint,
  contextHash,
  requestHash,
} from './session/store.ts';
import { parseReply, safeStreamPrefix } from './translate/parser.ts';
import {
  estimateRequestTokens,
  estimateTokens,
  lastAssistantIndex,
  renderDeltaPrompt,
  renderFullPrompt,
  visibleTools,
} from './translate/render.ts';

export interface Completed {
  blocks: ResponseBlock[];
  stopReason: StopReason;
  outputTokens: number;
}

export interface BridgeState {
  config: BridgeConfig;
  provider: ChatProvider;
  sessions: SessionStore;
  cache: ResponseCache<Completed>;
  log: Logger;
  /** Conversations whose last reply was interrupted (next message gets a note). */
  interrupted: Set<string>;
  /**
   * Turns whose client went away. They keep running for a grace period so that
   * a retry of the same request (Claude Code retries after stream watchdog
   * aborts) can adopt them instead of starting a new ChatGPT turn.
   */
  orphans: Map<string, { timer: NodeJS.Timeout; conversationId?: string; cancel: () => void }>;
  /** When ChatGPT reported a usage cap, fail fast until this time. */
  rateLimitedUntil: number;
  rateLimitMessage: string;
  stats: { requests: number; chatgptTurns: number; localReplies: number; errors: number; continued: number; replayed: number };
}

export function createState(config: BridgeConfig, provider: ChatProvider, log: Logger): BridgeState {
  return {
    config,
    provider,
    sessions: new SessionStore(),
    cache: new ResponseCache<Completed>(),
    log,
    interrupted: new Set(),
    orphans: new Map(),
    rateLimitedUntil: 0,
    rateLimitMessage: '',
    stats: { requests: 0, chatgptTurns: 0, localReplies: 0, errors: 0, continued: 0, replayed: 0 },
  };
}

export class BridgeError extends Error {
  readonly type: ErrorType;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Provider error code this error was mapped from, if any. */
  providerCode?: ProviderErrorCode;
  constructor(type: ErrorType, message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.type = type;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function providerErrorToBridge(code: ProviderErrorCode, message: string, retryAfterMs?: number): BridgeError {
  const err = mapProviderError(code, message, retryAfterMs);
  err.providerCode = code;
  return err;
}

function mapProviderError(code: ProviderErrorCode, message: string, retryAfterMs?: number): BridgeError {
  switch (code) {
    case 'no_worker':
      return new BridgeError(
        'overloaded_error',
        `${message} — open https://chatgpt.com in Chrome with the webGPT4CC extension connected (see \`webgpt4cc doctor\`).`,
        true,
      );
    case 'rate_limited':
      return new BridgeError('rate_limit_error', `ChatGPT usage limit: ${message}`, false, retryAfterMs);
    case 'too_long':
      // Claude Code reacts to "prompt is too long" by compacting the conversation.
      return new BridgeError('invalid_request_error', `prompt is too long: ${message}`, false);
    case 'not_logged_in':
      return new BridgeError('authentication_error', `ChatGPT is not logged in: ${message}`, false);
    case 'timeout':
      return new BridgeError('api_error', `ChatGPT did not finish in time: ${message}`, true);
    case 'aborted':
      return new BridgeError('api_error', `aborted: ${message}`, false);
    case 'conversation_not_found':
      return new BridgeError('api_error', `ChatGPT conversation not found: ${message}`, true);
    case 'ui_error':
      return new BridgeError('api_error', `Could not drive the ChatGPT page: ${message}`, true);
    case 'network':
      return new BridgeError('api_error', `ChatGPT error: ${message}`, true);
    default:
      return new BridgeError('api_error', message, true);
  }
}

function sendBridgeError(res: ServerResponse, err: BridgeError): void {
  const headers: Record<string, string> = { 'x-should-retry': err.retryable ? 'true' : 'false' };
  if (err.retryAfterMs) headers['retry-after'] = String(Math.ceil(err.retryAfterMs / 1000));
  sendJsonError(res, err.type, err.message, headers);
}

function usage(input: number, output: number): Usage {
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

export function validateRequest(body: unknown): MessagesRequest {
  if (!body || typeof body !== 'object') throw new BridgeError('invalid_request_error', 'request body must be a JSON object', false);
  const b = body as MessagesRequest;
  if (typeof b.model !== 'string') throw new BridgeError('invalid_request_error', 'model: field required', false);
  if (!Array.isArray(b.messages) || b.messages.length === 0)
    throw new BridgeError('invalid_request_error', 'messages: at least one message is required', false);
  for (const m of b.messages) {
    if (!m || typeof m !== 'object' || (typeof m.content !== 'string' && !Array.isArray(m.content)))
      throw new BridgeError('invalid_request_error', 'messages: each message needs string or array content', false);
  }
  return b;
}

interface Plan {
  kind: RequestKind;
  chatModel: string;
  conversation: ConversationTarget;
  prompt: string;
  fromTurn?: { conversationTokens: number; turns: number };
  tools: ToolDefinition[];
}

function planTurn(state: BridgeState, req: MessagesRequest, kind: RequestKind, chatModel: string): Plan {
  const { config } = state;
  const tools = kind === 'main' ? visibleTools(req.tools, config.render) : [];
  if (kind === 'web_search') {
    return { kind, chatModel, conversation: { kind: 'new' }, prompt: webSearchPrompt(req), tools: [] };
  }
  const reqForRender: MessagesRequest = kind === 'main' ? req : { ...req, tools: [] };
  if (kind === 'main' && config.conversationMode === 'continue') {
    const i = lastAssistantIndex(req.messages);
    if (i >= 0) {
      const fp = assistantFingerprint(req.messages[i]!.content);
      const turn = state.sessions.lookup(fp, i, contextHash(req, chatModel));
      if (turn && turn.conversationTokens < config.maxConversationTokens) {
        let prompt = renderDeltaPrompt(reqForRender, i + 1, config.render).text;
        if (state.interrupted.has(turn.conversationId)) {
          prompt =
            '[Note from the bridge: your previous reply was interrupted by the user before it was used. None of its tool calls were executed; continue from the message below.]\n\n' +
            prompt;
        }
        return {
          kind,
          chatModel,
          conversation: {
            kind: 'continue',
            conversationId: turn.conversationId,
            parentMessageId: turn.assistantMessageId,
            workerId: turn.workerId,
          },
          prompt,
          fromTurn: { conversationTokens: turn.conversationTokens, turns: turn.turns },
          tools,
        };
      }
    }
  }
  return { kind, chatModel, conversation: { kind: 'new' }, prompt: renderFullPrompt(reqForRender, config.render).text, tools };
}

/** Drive one provider job, streaming safe text through `onText`. Resolves with the parsed result. */
async function runJob(
  state: BridgeState,
  plan: Plan,
  signal: AbortSignal,
  onProgress: (ev: ChatEvent) => void,
): Promise<{ text: string; conversationId: string; messageId?: string; workerId?: string; finishReason?: string }> {
  const job: ChatJob = {
    id: randomUUID(),
    model: plan.chatModel,
    conversation: plan.conversation,
    prompt: plan.prompt,
    purpose: plan.kind === 'web_search' ? 'web_search' : plan.kind === 'background' ? 'background' : 'main',
    timeoutMs: state.config.jobTimeoutMs,
    temporary: state.config.temporaryChats || plan.kind !== 'main',
    allowWebSearch: plan.kind === 'web_search',
  };
  state.log.dump(`${Date.now()}-${job.id}-prompt.txt`, plan.prompt);
  state.log.info(
    `job ${job.id.slice(0, 8)} ${job.purpose} model=${job.model || '(ui)'} ${plan.conversation.kind === 'continue' ? `continue ${plan.conversation.conversationId.slice(0, 8)}` : 'new chat'} prompt=${plan.prompt.length} chars`,
  );
  for await (const ev of state.provider.run(job, signal)) {
    if (ev.type === 'error') throw providerErrorToBridge(ev.code, ev.message, ev.retryAfterMs);
    if (ev.type === 'done') {
      state.log.dump(`${Date.now()}-${job.id}-reply.txt`, ev.text);
      return ev;
    }
    onProgress(ev);
  }
  throw new BridgeError('api_error', 'provider finished without a reply', true);
}

function finalize(parsed: ReturnType<typeof parseReply>, emittedText: string, finishReason: string | undefined): Completed & { extraText: string } {
  const blocks: ResponseBlock[] = [];
  let extraText = '';
  let first = true;
  for (const b of parsed.blocks) {
    if (b.type === 'text') {
      if (first && emittedText) {
        // The prefix was already streamed; only the remainder is new.
        if (b.text.startsWith(emittedText)) extraText = b.text.slice(emittedText.length);
        else if (!emittedText.startsWith(b.text)) extraText = '';
        blocks.push({ type: 'text', text: emittedText + extraText });
      } else {
        blocks.push({ type: 'text', text: b.text });
        if (first) extraText = b.text;
      }
    } else {
      if (first && emittedText) blocks.push({ type: 'text', text: emittedText });
      blocks.push({ type: 'tool_use', id: newToolUseId(), name: b.name, input: b.input });
    }
    first = false;
  }
  if (first && emittedText) blocks.push({ type: 'text', text: emittedText });
  const hasTools = blocks.some((b) => b.type === 'tool_use');
  const stopReason: StopReason = hasTools ? 'tool_use' : finishReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
  const outputTokens = estimateTokens(blocks.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b.input))).join('\n'));
  return { blocks, stopReason, outputTokens, extraText };
}

function writeCompleted(writer: SseMessageWriter, done: Completed, alreadyStreamedText: string, inputTokens: number): void {
  let first = true;
  for (const b of done.blocks) {
    if (b.type === 'text') {
      if (first && alreadyStreamedText && b.text.startsWith(alreadyStreamedText)) writer.text(b.text.slice(alreadyStreamedText.length));
      else writer.text(b.text);
    } else writer.block(b);
    first = false;
  }
  writer.finish(done.stopReason, usage(inputTokens, done.outputTokens));
}

export async function handleMessages(state: BridgeState, httpReq: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  state.stats.requests++;
  let req: MessagesRequest;
  try {
    req = validateRequest(body);
  } catch (e) {
    sendBridgeError(res, e as BridgeError);
    return;
  }
  const { config, log } = state;
  const stream = req.stream === true;
  const resolved = resolveChatModel(req.model, config.models);
  const kind = classifyRequest(req, resolved.background, config);
  const inputTokens = estimateRequestTokens(req, config.render);
  log.debug(`request model=${req.model} kind=${kind} messages=${req.messages.length} tools=${req.tools?.length ?? 0} stream=${stream}`);

  // 1. Requests we answer locally (quota probes, optional background helpers).
  const local = kind === 'probe' || (kind === 'background' && config.backgroundRequests === 'local') ? localBackgroundReply(req, kind) : null;
  if (local !== null) {
    state.stats.localReplies++;
    const blocks: ResponseBlock[] = [{ type: 'text', text: local.text }];
    const out = estimateTokens(local.text);
    if (stream) {
      const w = new SseMessageWriter(res, req.model);
      w.start(usage(inputTokens, 1), 0);
      writeCompleted(w, { blocks, stopReason: local.stopReason, outputTokens: out }, '', inputTokens);
    } else {
      sendJson(res, 200, buildMessageResponse(req.model, blocks, local.stopReason, usage(inputTokens, out)));
    }
    return;
  }
  if (kind === 'web_search' && config.webSearch === 'disabled') {
    sendBridgeError(res, new BridgeError('invalid_request_error', 'web search is disabled in the webGPT4CC bridge config', false));
    return;
  }
  if (state.rateLimitedUntil > Date.now()) {
    sendBridgeError(
      res,
      new BridgeError('rate_limit_error', `ChatGPT usage limit: ${state.rateLimitMessage}`, false, state.rateLimitedUntil - Date.now()),
    );
    return;
  }

  // 2. Deduplicate client retries of an identical request.
  const chatModel = resolved.slug;
  const rHash = requestHash(req, chatModel);
  const cached = state.cache.get(rHash);
  if (cached) {
    const orphan = state.orphans.get(rHash);
    if (orphan) {
      clearTimeout(orphan.timer);
      state.orphans.delete(rHash);
      log.info('retry adopted the ChatGPT turn that is still running');
      res.on('close', () => {
        if (!res.writableEnded) armOrphan(state, rHash, orphan.conversationId, orphan.cancel);
      });
    } else log.info('duplicate request: reusing the reply already produced for it');
    try {
      const done = await cached;
      if (res.destroyed) return;
      if (stream) {
        const w = new SseMessageWriter(res, req.model);
        w.start(usage(inputTokens, 1));
        writeCompleted(w, done, '', inputTokens);
      } else sendJson(res, 200, buildMessageResponse(req.model, done.blocks, done.stopReason, usage(inputTokens, done.outputTokens)));
    } catch (e) {
      sendBridgeError(res, e instanceof BridgeError ? e : new BridgeError('api_error', String(e), true));
    }
    return;
  }

  // 3. Plan the ChatGPT turn (continue an existing conversation or start a new one).
  let plan = planTurn(state, req, kind, chatModel);
  if (plan.conversation.kind === 'continue') {
    state.stats.continued++;
    // A new request for this conversation supersedes an abandoned turn on it.
    const convId = plan.conversation.conversationId;
    for (const [key, o] of state.orphans)
      if (o.conversationId === convId) {
        log.info('cancelling an abandoned turn in the same conversation');
        clearTimeout(o.timer);
        state.orphans.delete(key);
        o.cancel();
      }
  } else if (lastAssistantIndex(req.messages) >= 0 && kind === 'main') state.stats.replayed++;

  const abort = new AbortController();
  let finished = false;
  const conversationId = plan.conversation.kind === 'continue' ? plan.conversation.conversationId : undefined;
  res.on('close', () => {
    if (!finished) armOrphan(state, rHash, conversationId, () => abort.abort());
  });

  let writer: SseMessageWriter | undefined;
  const startStream = () => {
    if (stream && !writer) {
      writer = new SseMessageWriter(res, req.model, newMessageId());
      writer.start(usage(inputTokens, 1));
    }
  };
  let emitted = '';
  let lastFull = '';
  const onProgress = (ev: ChatEvent) => {
    if (ev.type === 'status' && (ev.status === 'submitted' || ev.status === 'generating')) startStream();
    if (ev.type !== 'text') return;
    startStream();
    lastFull = ev.text;
    if (!stream || !config.stream || plan.kind !== 'main') return;
    const { safe } = safeStreamPrefix(ev.text);
    if (safe.length > emitted.length && safe.startsWith(emitted)) {
      writer!.text(safe.slice(emitted.length));
      emitted = safe;
    }
  };

  let resolveDone!: (c: Completed) => void;
  let rejectDone!: (e: unknown) => void;
  const donePromise = new Promise<Completed>((a, b) => {
    resolveDone = a;
    rejectDone = b;
  });
  donePromise.catch(() => {});
  state.cache.set(rHash, donePromise);

  try {
    let result: Awaited<ReturnType<typeof runJob>>;
    try {
      result = await runJob(state, plan, abort.signal, onProgress);
    } catch (e) {
      // The ChatGPT conversation is gone (deleted, or a temporary chat whose tab moved on):
      // replay the transcript into a new conversation once.
      if (!(e instanceof BridgeError) || e.providerCode !== 'conversation_not_found' || plan.conversation.kind !== 'continue' || emitted || abort.signal.aborted)
        throw e;
      log.warn(`${e.message}; replaying the transcript into a new ChatGPT conversation`);
      state.sessions.dropConversation(plan.conversation.conversationId);
      plan = { ...plan, conversation: { kind: 'new' }, prompt: renderFullPrompt(kind === 'main' ? req : { ...req, tools: [] }, config.render).text, fromTurn: undefined };
      state.stats.replayed++;
      result = await runJob(state, plan, abort.signal, onProgress);
    }
    state.stats.chatgptTurns++;
    const parsed = parseReply(result.text, plan.tools);
    for (const w of parsed.warnings) log.warn(`parser: ${w}`);
    const done = finalize(parsed, emitted, result.finishReason);
    // Remember the turn so the next request can continue this ChatGPT conversation.
    if (plan.kind === 'main') {
      const assistantIndex = req.messages.length; // index the reply will have in the next request
      const prevTokens = plan.fromTurn?.conversationTokens ?? 0;
      state.sessions.record(assistantFingerprint(done.blocks), {
        conversationId: result.conversationId,
        assistantMessageId: result.messageId,
        workerId: result.workerId,
        messageIndex: assistantIndex,
        contextHash: contextHash(req, chatModel),
        chatModel,
        conversationTokens: prevTokens + estimateTokens(plan.prompt) + estimateTokens(result.text),
        turns: (plan.fromTurn?.turns ?? 0) + 1,
      });
      state.interrupted.delete(result.conversationId);
    }
    finished = true;
    clearOrphan(state, rHash);
    const completed: Completed = { blocks: done.blocks, stopReason: done.stopReason, outputTokens: done.outputTokens };
    resolveDone(completed);
    if (res.destroyed) return;
    log.info(
      `reply: ${done.blocks.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name).join(', ') || 'text'} (${result.text.length} chars, stop=${done.stopReason})`,
    );
    if (stream) {
      startStream();
      writeCompleted(writer!, completed, emitted, inputTokens);
    } else {
      sendJson(res, 200, buildMessageResponse(req.model, completed.blocks, completed.stopReason, usage(inputTokens, completed.outputTokens)));
    }
  } catch (e) {
    finished = true;
    clearOrphan(state, rHash);
    state.stats.errors++;
    const err = e instanceof BridgeError ? e : new BridgeError('api_error', (e as Error)?.message ?? String(e), true);
    rejectDone(err);
    state.cache.delete(rHash);
    if (plan.conversation.kind === 'continue' && (abort.signal.aborted || lastFull)) state.interrupted.add(plan.conversation.conversationId);
    if (err.type === 'rate_limit_error') {
      state.rateLimitedUntil = Date.now() + (err.retryAfterMs ?? 60_000);
      state.rateLimitMessage = err.message.replace(/^ChatGPT usage limit: /, '');
    }
    if (abort.signal.aborted) {
      log.info('turn cancelled');
      if (!res.writableEnded) res.end();
      return;
    }
    log.error(`turn failed: ${err.message}`);
    if (writer && !writer.closed) writer.error(err.type, err.message);
    else sendBridgeError(res, err);
  }
}

function armOrphan(state: BridgeState, rHash: string, conversationId: string | undefined, cancel: () => void): void {
  const graceMs = state.config.orphanGraceMs;
  state.log.info(`client disconnected; keeping the ChatGPT turn alive ${Math.round(graceMs / 1000)}s for a retry`);
  const existing = state.orphans.get(rHash);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    state.orphans.delete(rHash);
    state.log.info('no retry arrived; cancelling the abandoned ChatGPT turn');
    cancel();
  }, graceMs);
  timer.unref?.();
  state.orphans.set(rHash, { timer, conversationId, cancel });
}

function clearOrphan(state: BridgeState, rHash: string): void {
  const o = state.orphans.get(rHash);
  if (o) {
    clearTimeout(o.timer);
    state.orphans.delete(rHash);
  }
}

export function handleCountTokens(state: BridgeState, res: ServerResponse, body: unknown): void {
  try {
    const req = validateRequest({ ...(body as object), model: (body as { model?: string })?.model ?? 'unknown' });
    sendJson(res, 200, { input_tokens: estimateRequestTokens(req, state.config.render) });
  } catch (e) {
    sendBridgeError(res, e instanceof BridgeError ? e : new BridgeError('invalid_request_error', String(e), false));
  }
}

export type { MessageParam };

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
import { localBackgroundReply, localWebFetchReply, classifyRequest, webSearchPrompt, type RequestKind } from './background.ts';
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
  isTextOnlyRequest,
  estimateRequestTokens,
  estimateTokens,
  lastAssistantIndex,
  renderDeltaPrompt,
  renderFullPrompt,
  visibleTools,
} from './translate/render.ts';

interface Orphan {
  timer: NodeJS.Timeout;
  /** Session/agent scope of the abandoned request. */
  scope: string;
  conversationId?: string;
  /** Whether the abandoned turn already reached ChatGPT. */
  submitted: () => boolean;
  cancel: () => void;
}

const INTERRUPTED_NOTE =
  '[Note from the bridge: your previous reply was interrupted by the user before it was used. None of its tool calls were executed; continue from the message below.]';

const TRUNCATED_NOTE =
  '[Note from the bridge: your previous reply was cut off by ChatGPT\'s output limit inside a tool call. That incomplete call was discarded and NOT executed. Re-issue it; split large file contents across several smaller Write/Edit calls.]';

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
  /** One-off notes to prepend to the next message of a conversation. */
  notes: Map<string, string>;
  /**
   * Turns whose client went away. They keep running for a grace period so that
   * a retry of the same request (Claude Code retries after stream watchdog
   * aborts) can adopt them instead of starting a new ChatGPT turn.
   */
  orphans: Map<string, Orphan>;
  /** ChatGPT conversations with a turn in flight (a second continuation would interleave). */
  activeConversations: Set<string>;
  /** The agent-loop turn in flight per Claude Code session/agent (they are strictly sequential). */
  mainInflight: Map<string, Omit<Orphan, 'timer'> & { rHash: string }>;
  /** When ChatGPT reported a usage cap, fail fast until this time. */
  /** ChatGPT usage caps per model slug ('' = the tab's model): fail fast until they clear. */
  rateLimits: Map<string, { until: number; message: string }>;
  stats: { requests: number; chatgptTurns: number; localReplies: number; errors: number; continued: number; replayed: number };
}

export function createState(config: BridgeConfig, provider: ChatProvider, log: Logger): BridgeState {
  return {
    config,
    provider,
    sessions: new SessionStore(5000, config.sessionFile),
    cache: new ResponseCache<Completed>(),
    log,
    interrupted: new Set(),
    notes: new Map(),
    orphans: new Map(),
    activeConversations: new Set(),
    mainInflight: new Map(),
    rateLimits: new Map(),
    stats: { requests: 0, chatgptTurns: 0, localReplies: 0, errors: 0, continued: 0, replayed: 0 },
  };
}

export class BridgeError extends Error {
  readonly type: ErrorType;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Provider error code this error was mapped from, if any. */
  providerCode?: ProviderErrorCode;
  /** HTTP status to use instead of the default for `type`. */
  status?: number;
  constructor(type: ErrorType, message: string, retryable: boolean, retryAfterMs?: number, status?: number) {
    super(message);
    this.type = type;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
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
      // The provider already waited workerWaitMs for a tab; fail fast (Claude Code retries a 529 three times).
      return new BridgeError(
        'api_error',
        `${message} — open https://chatgpt.com in Chrome with the webGPT4CC extension connected (see \`webgpt4cc doctor\`).`,
        false,
        undefined,
        503,
      );
    case 'rate_limited':
      return new BridgeError('rate_limit_error', `ChatGPT usage limit: ${message}`, false, retryAfterMs);
    case 'too_long':
      // Rewritten in handleMessages into Claude Code's "prompt is too long: N tokens > M maximum",
      // which makes it compact the conversation.
      return new BridgeError('invalid_request_error', `prompt is too long: ${message}`, false);
    case 'not_logged_in':
      // 403 is not retried by Claude Code (401 would be retried for ~3 minutes).
      return new BridgeError('permission_error', `ChatGPT is not logged in (or shows a verification challenge) in the worker tab: ${message}`, false);
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
  sendJsonError(res, err.type, err.message, headers, err.status);
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

function planTurn(state: BridgeState, req: MessagesRequest, kind: RequestKind, chatModel: string, scope: string): Plan {
  const { config } = state;
  const tools = kind === 'main' ? visibleTools(req.tools, config.render) : [];
  if (kind === 'web_search') {
    return { kind, chatModel, conversation: { kind: 'new' }, prompt: webSearchPrompt(req), tools: [] };
  }
  const reqForRender: MessagesRequest = kind === 'main' ? req : { ...req, tools: [] };
  if (kind === 'main' && config.conversationMode === 'continue') {
    const i = lastAssistantIndex(req.messages);
    if (i >= 0) {
      const fp = assistantFingerprint(req.messages[i]!.content, scope);
      const turn = state.sessions.lookup(fp, i, contextHash(req, chatModel));
      // A turn already running in that conversation (another client continuing the same
      // transcript) would interleave with this one: use a fresh conversation instead.
      if (turn && state.activeConversations.has(turn.conversationId)) state.log.warn('conversation busy with another request; starting a new ChatGPT chat');
      else if (turn && turn.conversationTokens < config.maxConversationTokens) {
        let prompt = renderDeltaPrompt(reqForRender, i + 1, config.render).text;
        const note = state.notes.get(turn.conversationId);
        if (note) prompt = `${note}\n\n${prompt}`;
        if (state.interrupted.has(turn.conversationId)) prompt = `${INTERRUPTED_NOTE}\n\n${prompt}`;
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
        // The prefix was already streamed; only the remainder is new. If the final text
        // diverges from what was streamed (rare), append what follows the common prefix.
        if (b.text.startsWith(emittedText)) extraText = b.text.slice(emittedText.length);
        else if (!emittedText.startsWith(b.text)) {
          let k = 0;
          while (k < b.text.length && k < emittedText.length && b.text[k] === emittedText[k]) k++;
          extraText = `\n${b.text.slice(k)}`;
        }
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
  const header = (name: string) => {
    const v = httpReq.headers[name];
    return typeof v === 'string' ? v : '';
  };
  // With CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 (set by gptcc) Claude Code labels compaction requests.
  if (header('x-claude-code-request-class') === 'compaction' || header('x-claude-code-compaction')) {
    req = { ...req, tool_choice: { type: 'none' } };
  }
  const resolved = resolveChatModel(req.model, config.models);
  const kind = classifyRequest(req, resolved.background, config);
  const inputTokens = estimateRequestTokens(req, config.render);
  log.debug(`request model=${req.model} kind=${kind} messages=${req.messages.length} tools=${req.tools?.length ?? 0} stream=${stream}`);

  // 1. Requests we answer locally (quota probes, WebFetch digests, optional background helpers).
  let local = kind === 'probe' || (kind === 'background' && config.backgroundRequests === 'local') ? localBackgroundReply(req, kind) : null;
  if (!local && kind === 'background' && config.webFetchSummaries === 'local') {
    const page = localWebFetchReply(req);
    if (page !== null) local = { text: page, stopReason: 'end_turn' };
  }
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
  if (kind === 'classifier') {
    // Never approve actions on the classifier's behalf: refuse, and Claude Code blocks the action.
    sendBridgeError(
      res,
      new BridgeError(
        'invalid_request_error',
        'Claude Code auto mode is not supported through webGPT4CC (its safety classifier would cost two large ChatGPT messages per tool call). Restart with --permission-mode default or acceptEdits (gptcc does this for you).',
        false,
      ),
    );
    return;
  }
  if (kind === 'web_search' && config.webSearch === 'disabled') {
    sendBridgeError(res, new BridgeError('invalid_request_error', 'web search is disabled in the webGPT4CC bridge config', false));
    return;
  }

  // 2. Deduplicate client retries of an identical request.
  const chatModel = resolved.slug;
  const limit = state.rateLimits.get(chatModel);
  if (limit && limit.until > Date.now()) {
    sendBridgeError(res, new BridgeError('rate_limit_error', `ChatGPT usage limit: ${limit.message}`, false, limit.until - Date.now()));
    return;
  }
  // Subagents share the session id; x-claude-code-agent-id tells them apart.
  const scope = header('x-claude-code-session-id') ? `${header('x-claude-code-session-id')}/${header('x-claude-code-agent-id') || 'main'}` : '';
  const rHash = requestHash(req, chatModel, scope);
  const cached = state.cache.get(rHash);
  if (cached) {
    const orphan = state.orphans.get(rHash);
    if (orphan) {
      clearTimeout(orphan.timer);
      state.orphans.delete(rHash);
      log.info('retry adopted the ChatGPT turn that is still running');
      res.on('close', () => {
        if (!res.writableEnded) armOrphan(state, rHash, orphan);
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

  // 3. Agent-loop requests of one session/agent are strictly sequential, so a different one
  //    supersedes whatever turn is still running for it (typically: Esc, then a new message).
  //    Cancel that turn now instead of letting it finish or waiting out the orphan grace period.
  const superseded: Array<Omit<Orphan, 'timer'>> = [];
  const prev = scope && kind === 'main' ? state.mainInflight.get(scope) : undefined;
  if (prev && prev.rHash !== rHash) {
    log.info('a new request supersedes the turn still running for this session; cancelling it');
    clearOrphan(state, prev.rHash);
    state.mainInflight.delete(scope);
    if (prev.conversationId) state.activeConversations.delete(prev.conversationId);
    superseded.push(prev);
    prev.cancel();
  }

  // 4. Plan the ChatGPT turn (continue an existing conversation or start a new one).
  let plan = planTurn(state, req, kind, chatModel, scope);
  if (plan.conversation.kind === 'continue') {
    state.stats.continued++;
    const convId = plan.conversation.conversationId;
    // Its previous turn was abandoned after reaching ChatGPT: say so (the catch handler of the
    // abandoned turn runs too late to add the note for this request).
    if (superseded.some((o) => o.conversationId === convId && o.submitted()) && !plan.prompt.startsWith(INTERRUPTED_NOTE))
      plan = { ...plan, prompt: `${INTERRUPTED_NOTE}\n\n${plan.prompt}` };
  } else if (lastAssistantIndex(req.messages) >= 0 && kind === 'main') state.stats.replayed++;

  const abort = new AbortController();
  let finished = false;
  let submitted = false;
  const conversationId = plan.conversation.kind === 'continue' ? plan.conversation.conversationId : undefined;
  if (conversationId) state.activeConversations.add(conversationId);
  const inflight = { rHash, scope, conversationId, submitted: () => submitted, cancel: () => abort.abort() };
  if (scope && kind === 'main') state.mainInflight.set(scope, inflight);
  const settle = () => {
    finished = true;
    clearOrphan(state, rHash);
    if (conversationId) state.activeConversations.delete(conversationId);
    if (state.mainInflight.get(scope) === inflight) state.mainInflight.delete(scope);
  };
  res.on('close', () => {
    writer?.dispose();
    if (!finished) armOrphan(state, rHash, inflight);
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
  let thoughts = '';
  const onProgress = (ev: ChatEvent) => {
    if (ev.type === 'text' || (ev.type === 'status' && (ev.status === 'submitted' || ev.status === 'generating' || ev.status === 'thinking'))) submitted = true;
    if (ev.type === 'status' && (ev.status === 'submitted' || ev.status === 'generating' || ev.status === 'thinking')) startStream();
    // ChatGPT's reasoning summary (whole text so far) -> a thinking block, before any content.
    if (ev.type === 'status' && ev.status === 'thinking' && ev.detail && config.showThinking && stream && writer && !emitted) {
      if (ev.detail.startsWith(thoughts) && ev.detail.length > thoughts.length) {
        writer.thinking(ev.detail.slice(thoughts.length));
        thoughts = ev.detail;
      }
    }
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
    const textOnly = plan.tools.length === 0 || req.tool_choice?.type === 'none' || isTextOnlyRequest(req);
    const parsed = parseReply(result.text, plan.tools, { toolCalls: !textOnly });
    for (const w of parsed.warnings) log.warn(`parser: ${w}`);
    // A reply cut off by ChatGPT's output limit must not run a half-written tool call
    // (e.g. a Write with truncated content). Drop it and tell the model next turn.
    // (A call that merely lacks its final </tool_call> after a natural stop is kept.)
    const cutOff = result.finishReason === 'max_tokens' || result.finishReason === 'interrupted';
    const lastBlock = parsed.blocks[parsed.blocks.length - 1];
    let finishReason = result.finishReason;
    if (cutOff && lastBlock?.type === 'tool_use' && lastBlock.incomplete) {
      parsed.blocks.pop();
      parsed.toolCalls--;
      log.warn(`dropped an incomplete ${lastBlock.name} call (reply cut off: ${result.finishReason})`);
      if (plan.kind === 'main') state.notes.set(result.conversationId, TRUNCATED_NOTE);
      if (!parsed.blocks.length) parsed.blocks.push({ type: 'text', text: '(The ChatGPT reply was cut off by its output limit.)' });
      finishReason = 'max_tokens';
    }
    if (!parsed.blocks.some((b) => b.type === 'tool_use' || b.text.trim())) {
      // Claude Code would answer an empty reply with "[Your previous response had no visible output...]",
      // costing another ChatGPT message; surface it instead.
      throw new BridgeError('api_error', 'ChatGPT returned an empty reply (it may have been blocked by moderation, or the page changed). Check the worker tab.', false);
    }
    const done = finalize(parsed, emitted, finishReason);
    // Remember the turn so the next request can continue this ChatGPT conversation.
    if (plan.kind === 'main') {
      const assistantIndex = req.messages.length; // index the reply will have in the next request
      const prevTokens = plan.fromTurn?.conversationTokens ?? 0;
      state.sessions.record(assistantFingerprint(done.blocks, scope), {
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
      if (plan.conversation.kind === 'continue' && state.notes.get(result.conversationId) !== TRUNCATED_NOTE) state.notes.delete(result.conversationId);
    }
    settle();
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
    settle();
    state.stats.errors++;
    const err = e instanceof BridgeError ? e : new BridgeError('api_error', (e as Error)?.message ?? String(e), true);
    rejectDone(err);
    state.cache.delete(rHash);
    // The turn reached ChatGPT but its reply was never delivered: the next message must say so.
    if (plan.conversation.kind === 'continue' && submitted && (abort.signal.aborted || lastFull)) state.interrupted.add(plan.conversation.conversationId);
    if (err.type === 'rate_limit_error') {
      state.rateLimits.set(chatModel, { until: Date.now() + (err.retryAfterMs ?? 60_000), message: err.message.replace(/^ChatGPT usage limit: /, '') });
    }
    if (abort.signal.aborted) {
      log.info('turn cancelled');
      if (!res.writableEnded) res.end();
      return;
    }
    if (err.providerCode === 'too_long') {
      const limit = Math.min(config.claudeContextWindow, Math.max(1000, inputTokens - 1));
      err.message = `prompt is too long: ${inputTokens} tokens > ${limit} maximum (ChatGPT did not accept the message: ${err.message.replace(/^prompt is too long: /, '')})`;
    }
    log.error(`turn failed: ${err.message}`);
    if (writer && !writer.closed) writer.error(err.type, err.message);
    else sendBridgeError(res, err);
  }
}

function armOrphan(state: BridgeState, rHash: string, o: Omit<Orphan, 'timer'>): void {
  const graceMs = state.config.orphanGraceMs;
  state.log.info(`client disconnected; keeping the ChatGPT turn alive ${Math.round(graceMs / 1000)}s for a retry`);
  const existing = state.orphans.get(rHash);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    state.orphans.delete(rHash);
    state.log.info('no retry arrived; cancelling the abandoned ChatGPT turn');
    o.cancel();
  }, graceMs);
  timer.unref?.();
  state.orphans.set(rHash, { ...o, timer });
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

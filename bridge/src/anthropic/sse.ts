// Writers for Anthropic-style responses: streaming (SSE) and plain JSON.
import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { ErrorType, MessageResponse, ResponseBlock, StopReason, Usage } from './types.ts';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomId(prefix: string, len = 24): string {
  const bytes = randomBytes(len);
  let out = prefix;
  for (let i = 0; i < len; i++) out += B62[bytes[i]! % 62];
  return out;
}

export const newMessageId = (): string => randomId('msg_');
export const newToolUseId = (): string => randomId('toolu_');

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

export function errorBody(type: ErrorType, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

const STATUS_FOR_ERROR: Record<ErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

export function statusForError(type: ErrorType): number {
  return STATUS_FOR_ERROR[type] ?? 500;
}

export function sendJsonError(res: ServerResponse, type: ErrorType, message: string, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = errorBody(type, message);
  res.writeHead(statusForError(type), {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Incremental SSE writer that follows the event order of the real API:
 * message_start, (content_block_start, content_block_delta*, content_block_stop)*, message_delta, message_stop.
 * Text blocks may be streamed incrementally; tool_use blocks are emitted whole (one input_json_delta).
 */
export class SseMessageWriter {
  private index = -1;
  private openText = false;
  private openThinking = false;
  private thinkingClosed = false;
  private hadContent = false;
  private finished = false;
  private pingTimer: NodeJS.Timeout | undefined;
  private readonly res: ServerResponse;
  readonly messageId: string;
  private readonly model: string;

  constructor(res: ServerResponse, model: string, messageId = newMessageId()) {
    this.res = res;
    this.model = model;
    this.messageId = messageId;
  }

  get closed(): boolean {
    return this.finished || this.res.destroyed || this.res.writableEnded;
  }

  start(usage: Usage, pingIntervalMs = 10_000): void {
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.res.flushHeaders?.();
    this.event('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    });
    this.ping();
    if (pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => this.ping(), pingIntervalMs);
      this.pingTimer.unref?.();
    }
  }

  ping(): void {
    this.event('ping', { type: 'ping' });
  }

  /**
   * Append to a thinking block (ChatGPT's reasoning summary). Only allowed before
   * any text or tool block; it is closed with a placeholder signature as soon as
   * real content starts.
   */
  thinking(delta: string): void {
    if (!delta || this.thinkingClosed) return;
    if (!this.openThinking) {
      this.index++;
      this.openThinking = true;
      this.event('content_block_start', {
        type: 'content_block_start',
        index: this.index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
    }
    this.event('content_block_delta', {
      type: 'content_block_delta',
      index: this.index,
      delta: { type: 'thinking_delta', thinking: delta },
    });
  }

  private closeThinking(): void {
    this.thinkingClosed = true;
    if (!this.openThinking) return;
    this.event('content_block_delta', {
      type: 'content_block_delta',
      index: this.index,
      delta: { type: 'signature_delta', signature: 'webgpt4cc' },
    });
    this.event('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.openThinking = false;
  }

  /** Append text to the current text block, opening one if needed. */
  text(delta: string): void {
    if (!delta) return;
    this.closeThinking();
    this.hadContent = true;
    if (!this.openText) {
      this.index++;
      this.openText = true;
      this.event('content_block_start', {
        type: 'content_block_start',
        index: this.index,
        content_block: { type: 'text', text: '' },
      });
    }
    this.event('content_block_delta', {
      type: 'content_block_delta',
      index: this.index,
      delta: { type: 'text_delta', text: delta },
    });
  }

  private closeText(): void {
    if (!this.openText) return;
    this.event('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.openText = false;
  }

  block(block: ResponseBlock): void {
    if (block.type === 'text') {
      this.text(block.text);
      return;
    }
    this.closeThinking();
    this.closeText();
    this.hadContent = true;
    this.index++;
    this.event('content_block_start', {
      type: 'content_block_start',
      index: this.index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    this.event('content_block_delta', {
      type: 'content_block_delta',
      index: this.index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
    });
    this.event('content_block_stop', { type: 'content_block_stop', index: this.index });
  }

  /** Close the message. `outputTokens` is reported in message_delta.usage. */
  finish(stopReason: StopReason, usage: Usage): void {
    if (this.finished) return;
    this.closeThinking();
    this.closeText();
    if (this.index < 0 || !this.hadContent) {
      // The API never returns an empty content array for end_turn in practice; emit an empty text block.
      this.text(' ');
      this.closeText();
    }
    this.event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
    this.event('message_stop', { type: 'message_stop' });
    this.end();
  }

  /** Emit an in-stream error event (used once headers are already sent). */
  error(type: ErrorType, message: string): void {
    if (this.finished) return;
    this.event('error', { type: 'error', error: { type, message } });
    this.end();
  }

  private end(): void {
    this.finished = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (!this.res.writableEnded) this.res.end();
  }

  private event(name: string, data: unknown): void {
    if (this.res.destroyed || this.res.writableEnded) return;
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

export function buildMessageResponse(
  model: string,
  content: ResponseBlock[],
  stopReason: StopReason,
  usage: Usage,
  id = newMessageId(),
): MessageResponse {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

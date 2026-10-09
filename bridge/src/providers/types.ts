// A provider runs one chat turn on some backend (the browser extension, a mock, ...).

export type ConversationTarget =
  | { kind: 'new' }
  | {
      kind: 'continue';
      conversationId: string;
      /** ChatGPT message id of the assistant reply we are answering, when known. */
      parentMessageId?: string;
      /** Worker that last held this conversation; preferred to avoid navigation. */
      workerId?: string;
    };

export type JobPurpose = 'main' | 'background' | 'web_search';

export interface ChatJob {
  id: string;
  /** ChatGPT model slug, e.g. "gpt-5-thinking". Empty string = whatever the UI has selected. */
  model: string;
  conversation: ConversationTarget;
  /** The full text to type into the composer. */
  prompt: string;
  purpose: JobPurpose;
  timeoutMs: number;
  /** Start new conversations as ChatGPT "temporary chats" (not saved to history). */
  temporary?: boolean;
  /** Allow the model to use ChatGPT's own web search (only for web_search jobs). */
  allowWebSearch?: boolean;
}

export type ProviderErrorCode =
  | 'no_worker' // no browser tab connected
  | 'rate_limited' // ChatGPT usage cap reached
  | 'too_long' // message too long for ChatGPT
  | 'not_logged_in'
  | 'ui_error' // could not drive the page (selectors changed, etc.)
  | 'network' // ChatGPT backend/network error
  | 'conversation_not_found' // continuing a conversation that no longer exists
  | 'timeout'
  | 'aborted'
  | 'internal';

export type ChatEvent =
  /** Progress note (queued, navigating, submitted, thinking, ...). */
  | { type: 'status'; status: string; detail?: string }
  /** Full reply text so far. Providers send the whole text; the bridge diffs. */
  | { type: 'text'; text: string }
  | {
      type: 'done';
      text: string;
      conversationId: string;
      messageId?: string;
      workerId?: string;
      /** e.g. "stop", "max_tokens", "interrupted". */
      finishReason?: string;
    }
  | { type: 'error'; code: ProviderErrorCode; message: string; retryAfterMs?: number };

export interface WorkerInfo {
  id: string;
  url?: string;
  busy: boolean;
  ready: boolean;
  conversationId?: string;
  label?: string;
}

export interface ProviderStatus {
  name: string;
  connected: boolean;
  workers: WorkerInfo[];
  queued: number;
  detail?: string;
}

export interface ChatProvider {
  readonly name: string;
  run(job: ChatJob, signal: AbortSignal): AsyncIterable<ChatEvent>;
  status(): ProviderStatus;
  close?(): Promise<void>;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: ProviderErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

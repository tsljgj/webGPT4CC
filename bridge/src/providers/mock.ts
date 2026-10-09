// A provider that never touches ChatGPT: replies come from a script. Used by
// tests, by `webgpt4cc serve --provider mock`, and to debug the translation layer.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ChatEvent, ChatJob, ChatProvider, ProviderStatus } from './types.ts';

export interface MockTurn {
  /** Reply text in the bridge protocol (may contain <tool_call> blocks). */
  reply: string;
  /** Simulated reasoning summary, streamed as `status: thinking` events before the reply. */
  thinking?: string;
  /** Simulated error instead of a reply. */
  error?: { code: 'rate_limited' | 'too_long' | 'ui_error' | 'network' | 'timeout'; message: string };
}

export type MockScript = (job: ChatJob, ctx: { conversationId: string; turn: number; history: ChatJob[] }) => MockTurn | string;

export interface MockOptions {
  script?: MockScript;
  /** Path to a JSON file: an array of reply strings used in order (cycled per conversation). */
  scriptFile?: string;
  /** Characters per streamed chunk (0 = no streaming). */
  chunkSize?: number;
  chunkDelayMs?: number;
}

export function echoScript(job: ChatJob): string {
  const last = job.prompt.split('# Latest message (respond to this)').pop() ?? job.prompt;
  return `Mock reply (${job.model || 'default model'}). I received ${job.prompt.length} characters. Latest message:\n\n${last.trim().slice(0, 500)}`;
}

export class MockProvider implements ChatProvider {
  readonly name = 'mock';
  private readonly script: MockScript;
  private readonly chunkSize: number;
  private readonly chunkDelayMs: number;
  private readonly conversations = new Map<string, ChatJob[]>();
  readonly jobs: ChatJob[] = [];

  constructor(opts: MockOptions = {}) {
    if (opts.script) this.script = opts.script;
    else if (opts.scriptFile) {
      const replies = JSON.parse(readFileSync(opts.scriptFile, 'utf8')) as string[];
      let i = 0;
      this.script = () => replies[i++ % replies.length]!;
    } else this.script = echoScript;
    this.chunkSize = opts.chunkSize ?? 40;
    this.chunkDelayMs = opts.chunkDelayMs ?? 0;
  }

  status(): ProviderStatus {
    return {
      name: this.name,
      connected: true,
      workers: [{ id: 'mock', ready: true, busy: false, label: 'mock provider' }],
      queued: 0,
    };
  }

  async *run(job: ChatJob, signal: AbortSignal): AsyncIterable<ChatEvent> {
    this.jobs.push(job);
    let conversationId: string;
    if (job.conversation.kind === 'continue') {
      conversationId = job.conversation.conversationId;
      if (!this.conversations.has(conversationId)) {
        yield { type: 'error', code: 'conversation_not_found', message: `mock: unknown conversation ${conversationId}` };
        return;
      }
    } else {
      conversationId = randomUUID();
      this.conversations.set(conversationId, []);
    }
    const history = this.conversations.get(conversationId)!;
    history.push(job);
    yield { type: 'status', status: 'submitted' };
    const out = this.script(job, { conversationId, turn: history.length - 1, history });
    const turn: MockTurn = typeof out === 'string' ? { reply: out } : out;
    if (turn.error) {
      yield { type: 'error', code: turn.error.code, message: turn.error.message };
      return;
    }
    if (turn.thinking) {
      const step = Math.max(1, this.chunkSize || turn.thinking.length);
      for (let i = step; i < turn.thinking.length + step; i += step)
        yield { type: 'status', status: 'thinking', detail: turn.thinking.slice(0, Math.min(i, turn.thinking.length)) };
    }
    const text = turn.reply;
    if (this.chunkSize > 0) {
      for (let i = this.chunkSize; i < text.length; i += this.chunkSize) {
        if (signal.aborted) {
          yield { type: 'error', code: 'aborted', message: 'aborted' };
          return;
        }
        if (this.chunkDelayMs) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
        yield { type: 'text', text: text.slice(0, i) };
      }
    }
    yield { type: 'done', text, conversationId, messageId: randomUUID(), workerId: 'mock', finishReason: 'stop' };
  }
}

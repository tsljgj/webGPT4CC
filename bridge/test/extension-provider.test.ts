import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { defaultConfig, type BridgeConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { ExtensionProvider, isAllowedOrigin } from '../src/providers/extension.ts';
import type { ChatEvent, ChatJob } from '../src/providers/types.ts';
import { createBridgeServer, type BridgeServer } from '../src/server.ts';

const EXT_TOKEN = 'ext-secret';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function job(over: Partial<ChatJob> = {}): ChatJob {
  return { id: `job-${Math.random().toString(36).slice(2)}`, model: '', conversation: { kind: 'new' }, prompt: 'hello', purpose: 'main', timeoutMs: 10_000, ...over };
}

/** A fake extension: connects, announces workers, and answers jobs with a handler. */
class FakeExtension {
  ws!: WebSocket;
  readonly received: Array<Record<string, unknown>> = [];
  onJob: (job: Record<string, unknown>, send: (ev: ChatEvent) => void) => void = () => {};

  async connect(url: string, opts: { origin?: string; token?: string } = {}): Promise<number | 'open'> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(`${url.replace('http', 'ws')}/extension?token=${opts.token ?? EXT_TOKEN}`, { origin: opts.origin ?? ORIGIN });
      this.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      this.ws.on('open', () => resolve('open'));
      this.ws.on('error', () => {});
      this.ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        this.received.push(msg);
        if (msg.type === 'job') {
          const j = msg.job as Record<string, unknown>;
          this.onJob(j, (ev) => this.send({ type: 'job_event', jobId: j.id, event: ev }));
        }
      });
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  workers(list: Array<{ id: string; ready?: boolean; busy?: boolean }>): void {
    this.send({ type: 'hello', protocol: 1, extensionVersion: 'test' });
    this.send({ type: 'workers', workers: list.map((w) => ({ ready: true, busy: false, ...w })) });
  }

  close(): void {
    this.ws.close();
  }
}

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('extension provider', () => {
  let bridge: BridgeServer;
  let provider: ExtensionProvider;
  before(async () => {
    const config: BridgeConfig = { ...defaultConfig(), port: 0, extensionToken: EXT_TOKEN, workerWaitMs: 1500 };
    provider = new ExtensionProvider({
      extensionToken: EXT_TOKEN,
      allowedOrigins: [],
      newChatUrl: config.newChatUrl,
      workerWaitMs: 1500,
      bridgeVersion: 'test',
      log: silentLogger,
    });
    bridge = createBridgeServer(config, silentLogger, provider);
    await bridge.listen();
  });
  after(() => bridge.close());

  it('accepts only extension origins', () => {
    assert.equal(isAllowedOrigin(ORIGIN, []), true);
    assert.equal(isAllowedOrigin('moz-extension://1234-abcd', []), true);
    assert.equal(isAllowedOrigin('https://chatgpt.com', []), false);
    assert.equal(isAllowedOrigin('https://evil.example', ['https://evil.example']), true);
    assert.equal(isAllowedOrigin(undefined, []), false);
  });

  it('rejects web-page origins and bad tokens', async () => {
    const a = new FakeExtension();
    assert.equal(await a.connect(bridge.url(), { origin: 'https://evil.example' }), 403);
    const b = new FakeExtension();
    assert.equal(await b.connect(bridge.url(), { token: 'wrong' }), 401);
  });

  it('runs a job on a connected worker and relays events', async () => {
    const ext = new FakeExtension();
    assert.equal(await ext.connect(bridge.url()), 'open');
    ext.onJob = (j, send) => {
      assert.equal(j.url, 'https://chatgpt.com/');
      assert.equal(j.workerId, 'w1');
      send({ type: 'status', status: 'submitted' });
      send({ type: 'text', text: 'Hel' });
      send({ type: 'done', text: 'Hello', conversationId: 'conv-1', messageId: 'm1' });
    };
    ext.workers([{ id: 'w1' }]);
    await wait(50);
    const events = await collect(provider.run(job(), new AbortController().signal));
    const done = events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>;
    assert.equal(done.text, 'Hello');
    assert.equal(done.conversationId, 'conv-1');
    assert.match(done.workerId!, /:w1$/);
    assert.ok(events.some((e) => e.type === 'text'));
    assert.equal(provider.status().workers[0]!.busy, false);
    ext.close();
    await wait(50);
  });

  it('fails with no_worker when nothing connects in time', async () => {
    const events = await collect(provider.run(job(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as Extract<ChatEvent, { type: 'error' }>;
    assert.equal(err.code, 'no_worker');
  });

  it('prefers the worker that holds the conversation, and builds the /c/ URL', async () => {
    const ext = new FakeExtension();
    await ext.connect(bridge.url());
    const seen: string[] = [];
    ext.onJob = (j, send) => {
      seen.push(`${String(j.workerId)} ${String(j.url)}`);
      send({ type: 'done', text: 'ok', conversationId: 'c-9' });
    };
    ext.workers([{ id: 'a' }, { id: 'b' }]);
    await wait(50);
    const connId = provider.status().workers.find((w) => w.id.endsWith(':b'))!.id;
    await collect(provider.run(job({ conversation: { kind: 'continue', conversationId: 'c-9', workerId: connId } }), new AbortController().signal));
    assert.deepEqual(seen, ['b https://chatgpt.com/c/c-9']);
    ext.close();
    await wait(50);
  });

  it('queues jobs when all workers are busy', async () => {
    const ext = new FakeExtension();
    await ext.connect(bridge.url());
    const pending: Array<() => void> = [];
    ext.onJob = (j, send) => pending.push(() => send({ type: 'done', text: String(j.prompt), conversationId: 'c' }));
    ext.workers([{ id: 'only' }]);
    await wait(50);
    const p1 = collect(provider.run(job({ prompt: 'one' }), new AbortController().signal));
    const p2 = collect(provider.run(job({ prompt: 'two' }), new AbortController().signal));
    await wait(100);
    assert.equal(pending.length, 1, 'second job must wait for the worker');
    assert.equal(provider.status().queued, 1);
    pending.shift()!();
    await wait(100);
    assert.equal(pending.length, 1);
    pending.shift()!();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal((r1.at(-1) as { text: string }).text, 'one');
    assert.equal((r2.at(-1) as { text: string }).text, 'two');
    ext.close();
    await wait(50);
  });

  it('sends cancel when the job is aborted', async () => {
    const ext = new FakeExtension();
    await ext.connect(bridge.url());
    ext.onJob = () => {};
    ext.workers([{ id: 'x' }]);
    await wait(50);
    const ac = new AbortController();
    const p = collect(provider.run(job(), ac.signal));
    await wait(100);
    ac.abort();
    const events = await p;
    assert.equal((events.at(-1) as { code: string }).code, 'aborted');
    await wait(50);
    assert.ok(ext.received.some((m) => m.type === 'cancel'));
    assert.equal(provider.status().workers[0]!.busy, false);
    ext.close();
    await wait(50);
  });

  it('times out a job that never finishes', async () => {
    const ext = new FakeExtension();
    await ext.connect(bridge.url());
    ext.onJob = () => {};
    ext.workers([{ id: 'slow' }]);
    await wait(50);
    const events = await collect(provider.run(job({ timeoutMs: 1200 }), new AbortController().signal));
    assert.equal((events.at(-1) as { code: string }).code, 'timeout');
    ext.close();
    await wait(50);
  });

  it('fails running jobs when the extension disconnects', async () => {
    const ext = new FakeExtension();
    await ext.connect(bridge.url());
    ext.onJob = () => setTimeout(() => ext.close(), 20);
    ext.workers([{ id: 'gone' }]);
    await wait(50);
    const events = await collect(provider.run(job(), new AbortController().signal));
    const err = events.at(-1) as { type: string; code: string };
    assert.equal(err.type, 'error');
    assert.equal(err.code, 'ui_error');
  });
});

describe('extension provider readiness', () => {
  it('fails instead of waiting forever when connected tabs are never ready', async () => {
    const config: BridgeConfig = { ...defaultConfig(), port: 0, extensionToken: EXT_TOKEN };
    const provider = new ExtensionProvider({ extensionToken: EXT_TOKEN, allowedOrigins: [], newChatUrl: config.newChatUrl, workerWaitMs: 800, bridgeVersion: 't', log: silentLogger });
    const bridge = createBridgeServer(config, silentLogger, provider);
    await bridge.listen();
    try {
      const ext = new FakeExtension();
      await ext.connect(bridge.url());
      ext.workers([{ id: 'login', ready: false }]);
      await wait(50);
      const events = await collect(provider.run(job(), new AbortController().signal));
      const err = events.at(-1) as { code: string; message: string };
      assert.equal(err.code, 'no_worker');
      assert.match(err.message, /none is ready/);
      ext.close();
    } finally {
      await bridge.close();
    }
  });
});

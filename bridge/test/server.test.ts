import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { defaultConfig, type BridgeConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { MockProvider, type MockScript } from '../src/providers/mock.ts';
import { createBridgeServer, type BridgeServer } from '../src/server.ts';

const TOKEN = 'test-token';

const TOOLS = [
  {
    name: 'Read',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
  {
    name: 'Bash',
    description: 'Run a command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .filter((c) => c.trim())
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? '';
      const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? '{}') as Record<string, unknown>;
      return { event, data };
    });
}

/** Rebuild the assistant message from an SSE stream like the Anthropic SDK does. */
function assemble(events: SseEvent[]): { content: Array<Record<string, unknown>>; stop_reason: string } {
  const content: Array<Record<string, unknown>> = [];
  const partial: string[] = [];
  let stop = '';
  for (const { event, data } of events) {
    if (event === 'content_block_start') {
      content[data.index as number] = { ...(data.content_block as object) };
      partial[data.index as number] = '';
    } else if (event === 'content_block_delta') {
      const d = data.delta as Record<string, string>;
      const b = content[data.index as number]!;
      if (d.type === 'text_delta') b.text = (b.text as string) + d.text;
      else partial[data.index as number] += d.partial_json;
    } else if (event === 'content_block_stop') {
      const b = content[data.index as number]!;
      if (b.type === 'tool_use') b.input = JSON.parse(partial[data.index as number] || '{}');
    } else if (event === 'message_delta') stop = (data.delta as Record<string, string>).stop_reason!;
  }
  return { content, stop_reason: stop };
}

async function start(script: MockScript, cfg: Partial<BridgeConfig> = {}): Promise<{ bridge: BridgeServer; mock: MockProvider; url: string }> {
  const config: BridgeConfig = { ...defaultConfig(), port: 0, authToken: TOKEN, extensionToken: '', provider: 'mock', ...cfg };
  const mock = new MockProvider({ script, chunkSize: 7 });
  const bridge = createBridgeServer(config, silentLogger, mock);
  await bridge.listen();
  return { bridge, mock, url: bridge.url() };
}

function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });
}

describe('bridge HTTP server', () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  const replies: string[] = [];
  before(async () => {
    ctx = await start(() => replies.shift() ?? 'default reply');
  });
  after(() => ctx.bridge.close());

  it('serves /health without auth', async () => {
    const r = await fetch(ctx.url + '/health');
    assert.equal(r.status, 200);
    const j = (await r.json()) as { ok: boolean; provider: string };
    assert.equal(j.ok, true);
    assert.equal(j.provider, 'mock');
  });

  it('rejects missing or wrong tokens with x-should-retry: false', async () => {
    const r = await post(ctx.url, '/v1/messages', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer nope' });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('x-should-retry'), 'false');
    const j = (await r.json()) as { type: string; error: { type: string } };
    assert.equal(j.type, 'error');
    assert.equal(j.error.type, 'authentication_error');
  });

  it('accepts x-api-key auth', async () => {
    replies.push('hello');
    const r = await post(ctx.url, '/v1/messages', { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'api key' }] }, { authorization: '', 'x-api-key': TOKEN });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { content: Array<{ text: string }> };
    assert.equal(j.content[0]!.text, 'hello');
  });

  it('rejects browser requests (Origin header)', async () => {
    const r = await post(ctx.url, '/v1/messages', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(ctx.url);
      const req = request({ host: u.hostname, port: u.port, path: '/health', headers: { host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it('returns a JSON message for non-streaming requests', async () => {
    replies.push('Plain answer.');
    const r = await post(ctx.url, '/v1/messages', { model: 'claude-x', max_tokens: 100, messages: [{ role: 'user', content: 'plain' }] });
    const j = (await r.json()) as { type: string; content: Array<{ type: string; text: string }>; stop_reason: string; model: string; usage: Record<string, number> };
    assert.equal(j.type, 'message');
    assert.equal(j.model, 'claude-x');
    assert.deepEqual(j.content, [{ type: 'text', text: 'Plain answer.' }]);
    assert.equal(j.stop_reason, 'end_turn');
    assert.ok(j.usage.input_tokens > 0);
  });

  it('streams tool calls as tool_use blocks', async () => {
    replies.push('Checking.\n<tool_call name="Read">\n<param name="file_path">/etc/hosts</param>\n</tool_call>');
    const r = await post(ctx.url, '/v1/messages', {
      model: 'claude-x',
      max_tokens: 1000,
      stream: true,
      tools: TOOLS,
      messages: [{ role: 'user', content: 'read hosts' }],
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = parseSse(await r.text());
    assert.equal(events[0]!.event, 'message_start');
    assert.equal(events.at(-1)!.event, 'message_stop');
    const msg = assemble(events);
    assert.equal(msg.stop_reason, 'tool_use');
    assert.equal(msg.content[0]!.type, 'text');
    assert.equal((msg.content[0]!.text as string).trim(), 'Checking.');
    assert.equal(msg.content[1]!.type, 'tool_use');
    assert.equal(msg.content[1]!.name, 'Read');
    assert.deepEqual(msg.content[1]!.input, { file_path: '/etc/hosts' });
    assert.match(msg.content[1]!.id as string, /^toolu_[A-Za-z0-9]{24}$/);
  });

  it('accepts gzip request bodies', async () => {
    replies.push('gz ok');
    const body = gzipSync(Buffer.from(JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'gzip' }] })));
    const r = await post(ctx.url, '/v1/messages', new Uint8Array(body), { 'content-encoding': 'gzip' });
    const j = (await r.json()) as { content: Array<{ text: string }> };
    assert.equal(j.content[0]!.text, 'gz ok');
  });

  it('answers max_tokens=1 probes locally', async () => {
    const before = ctx.mock.jobs.length;
    const r = await post(ctx.url, '/v1/messages', { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] });
    assert.equal(r.status, 200);
    assert.equal(ctx.mock.jobs.length, before);
  });

  it('counts tokens', async () => {
    const r = await post(ctx.url, '/v1/messages/count_tokens', { model: 'm', messages: [{ role: 'user', content: 'hello world' }], tools: TOOLS });
    const j = (await r.json()) as { input_tokens: number };
    assert.ok(j.input_tokens > 0);
  });

  it('lists models', async () => {
    const r = await fetch(ctx.url + '/v1/models', { headers: { authorization: `Bearer ${TOKEN}` } });
    const j = (await r.json()) as { data: Array<{ id: string }> };
    assert.ok(j.data.length > 0);
  });

  it('returns 400 for invalid bodies', async () => {
    const r = await post(ctx.url, '/v1/messages', { model: 'm', messages: [] });
    assert.equal(r.status, 400);
    const bad = await post(ctx.url, '/v1/messages', '{not json');
    assert.equal(bad.status, 400);
  });
});

describe('conversation continuation', () => {
  it('continues the same ChatGPT conversation with only the new messages', async () => {
    const replies = ['<tool_call name="Bash">\n<param name="command">echo hi</param>\n</tool_call>', 'All done.'];
    const ctx = await start(() => replies.shift() ?? 'extra');
    try {
      const first = { model: 'claude-x', max_tokens: 100, stream: true, system: 'You are a coding agent.', tools: TOOLS, messages: [{ role: 'user', content: 'say hi' }] };
      const r1 = assemble(parseSse(await (await post(ctx.url, '/v1/messages', first)).text()));
      assert.equal(r1.stop_reason, 'tool_use');
      const toolUse = r1.content.find((b) => b.type === 'tool_use')!;
      // Claude Code echoes our reply and adds the tool result (moving cache_control markers around).
      const second = {
        ...first,
        system: [{ type: 'text', text: 'You are a coding agent.', cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'say hi', cache_control: { type: 'ephemeral' } }] },
          { role: 'assistant', content: r1.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'hi\n' }] },
        ],
      };
      const r2 = assemble(parseSse(await (await post(ctx.url, '/v1/messages', second)).text()));
      assert.equal(r2.stop_reason, 'end_turn');
      assert.equal(ctx.mock.jobs.length, 2);
      const [j1, j2] = ctx.mock.jobs;
      assert.equal(j1!.conversation.kind, 'new');
      assert.match(j1!.prompt, /# Bridge instructions/);
      assert.equal(j2!.conversation.kind, 'continue');
      assert.doesNotMatch(j2!.prompt, /# Bridge instructions/);
      assert.match(j2!.prompt, /<tool_result name="Bash" call="1">\nhi\n\n<\/tool_result>/);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('replays the transcript in a new conversation when the history is unknown', async () => {
    const ctx = await start(() => 'ok');
    try {
      const body = {
        model: 'claude-x',
        max_tokens: 100,
        tools: TOOLS,
        messages: [
          { role: 'user', content: 'start' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_unknown', name: 'Bash', input: { command: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown', content: 'a.txt' }] },
        ],
      };
      await (await post(ctx.url, '/v1/messages', body)).json();
      const job = ctx.mock.jobs[0]!;
      assert.equal(job.conversation.kind, 'new');
      assert.match(job.prompt, /# Conversation so far/);
      assert.match(job.prompt, /<tool_call name="Bash">\n<param name="command">ls<\/param>\n<\/tool_call>/);
      assert.match(job.prompt, /# Latest message \(respond to this\)\n\n<tool_result name="Bash" call="1">\na.txt\n<\/tool_result>/);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('deduplicates an identical retry without a second ChatGPT turn', async () => {
    const ctx = await start(() => 'only once');
    try {
      const body = { model: 'claude-x', max_tokens: 100, tools: TOOLS, messages: [{ role: 'user', content: 'once' }] };
      const a = (await (await post(ctx.url, '/v1/messages', body)).json()) as { content: Array<{ text: string }> };
      const b = (await (await post(ctx.url, '/v1/messages', body)).json()) as { content: Array<{ text: string }> };
      assert.equal(a.content[0]!.text, 'only once');
      assert.equal(b.content[0]!.text, 'only once');
      assert.equal(ctx.mock.jobs.length, 1);
    } finally {
      await ctx.bridge.close();
    }
  });
});

describe('error mapping', () => {
  it('maps a ChatGPT usage cap to a non-retryable 429 and fails fast afterwards', async () => {
    const ctx = await start(() => ({ reply: '', error: { code: 'rate_limited', message: 'You have hit your limit' } }));
    try {
      const body = { model: 'claude-x', max_tokens: 100, tools: TOOLS, messages: [{ role: 'user', content: 'x' }] };
      const r = await post(ctx.url, '/v1/messages', body);
      assert.equal(r.status, 429);
      assert.equal(r.headers.get('x-should-retry'), 'false');
      const again = await post(ctx.url, '/v1/messages', { ...body, messages: [{ role: 'user', content: 'y' }] });
      assert.equal(again.status, 429);
      assert.equal(ctx.mock.jobs.length, 1);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('maps "too long" to the prompt-is-too-long error Claude Code compacts on', async () => {
    const ctx = await start(() => ({ reply: '', error: { code: 'too_long', message: 'message too long' } }));
    try {
      const r = await post(ctx.url, '/v1/messages', { model: 'claude-x', max_tokens: 100, tools: TOOLS, messages: [{ role: 'user', content: 'x' }] });
      assert.equal(r.status, 400);
      const j = (await r.json()) as { error: { message: string } };
      assert.match(j.error.message, /^prompt is too long/);
    } finally {
      await ctx.bridge.close();
    }
  });
});

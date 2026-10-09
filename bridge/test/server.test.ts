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

describe('client disconnects', () => {
  it('lets a retry adopt a turn whose client went away', async () => {
    const config: BridgeConfig = { ...defaultConfig(), port: 0, authToken: TOKEN, provider: 'mock', orphanGraceMs: 5_000 };
    const mock = new MockProvider({ script: () => 'slow but steady reply', chunkSize: 2, chunkDelayMs: 30 });
    const bridge = createBridgeServer(config, silentLogger, mock);
    await bridge.listen();
    try {
      const body = { model: 'claude-x', max_tokens: 100, stream: true, tools: TOOLS, metadata: { user_id: 's1' }, messages: [{ role: 'user', content: 'go' }] };
      const ac = new AbortController();
      const first = post(bridge.url(), '/v1/messages', body, {}).then((r) => r.body?.getReader().read());
      void first;
      // Abort the first client shortly after it starts receiving.
      const aborted = fetch(bridge.url() + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ ...body, metadata: { user_id: 's2' } }),
        signal: ac.signal,
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 150));
      ac.abort();
      await aborted;
      // Retry of the aborted request (same session id) adopts the running turn.
      const retry = await post(bridge.url(), '/v1/messages', { ...body, metadata: { user_id: 's2' } });
      const msg = assemble(parseSse(await retry.text()));
      assert.equal(msg.content.map((b) => b.text).join(''), 'slow but steady reply');
      // Two distinct requests (s1, s2) -> exactly two ChatGPT turns; the retry added none.
      assert.equal(mock.jobs.length, 2);
    } finally {
      await bridge.close();
    }
  });
});

describe('Claude Code side requests', () => {
  it('refuses auto-mode safety classifier requests without asking ChatGPT', async () => {
    const ctx = await start(() => 'should not be used');
    try {
      const r = await post(ctx.url, '/v1/messages', {
        model: 'claude-sonnet-5',
        max_tokens: 64,
        system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' }, { type: 'text', text: 'You are a security monitor for autonomous AI coding agents.\n...' }],
        messages: [{ role: 'user', content: '<transcript>...</transcript>' }],
      });
      assert.equal(r.status, 400);
      assert.equal(r.headers.get('x-should-retry'), 'false');
      assert.equal(ctx.mock.jobs.length, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('asks for a text-only answer on compaction requests', async () => {
    const replies = ['<tool_call name="Bash">\n<param name="command">ls</param>\n</tool_call>', '<summary>all good</summary>'];
    const ctx = await start(() => replies.shift()!);
    try {
      const first = { model: 'm', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'list' }] };
      const r1 = assemble(parseSse(await (await post(ctx.url, '/v1/messages', first)).text()));
      const tu = r1.content.find((b) => b.type === 'tool_use')!;
      const compact = {
        ...first,
        messages: [
          ...first.messages,
          { role: 'assistant', content: r1.content },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: tu.id, content: 'a.txt' },
              { type: 'text', text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary...' },
            ],
          },
        ],
      };
      await (await post(ctx.url, '/v1/messages', compact)).text();
      const job = ctx.mock.jobs[1]!;
      assert.match(job.prompt, /do NOT call any tools; answer in plain text only/);
      assert.doesNotMatch(job.prompt, /bridge reminder/);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('drops <total_tokens> noise from harness messages', async () => {
    const ctx = await start(() => 'ok');
    try {
      await post(ctx.url, '/v1/messages', {
        model: 'm',
        max_tokens: 100,
        tools: TOOLS,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'system', content: '<total_tokens>14999951 tokens left</total_tokens>' },
        ],
      });
      assert.doesNotMatch(ctx.mock.jobs[0]!.prompt, /total_tokens|harness_message/);
    } finally {
      await ctx.bridge.close();
    }
  });
});

describe('session persistence', () => {
  it('continues a ChatGPT conversation after a bridge restart', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'wg-sess-')), 'sessions.json');
    const replies = ['<tool_call name="Bash">\n<param name="command">pwd</param>\n</tool_call>', 'done'];
    const mk = async () => {
      const config: BridgeConfig = { ...defaultConfig(), port: 0, authToken: TOKEN, provider: 'mock', sessionFile };
      const mock = new MockProvider({ script: () => replies.shift()!, chunkSize: 0 });
      const bridge = createBridgeServer(config, silentLogger, mock);
      await bridge.listen();
      return { bridge, mock };
    };
    const a = await mk();
    const first = { model: 'm', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'where am i' }] };
    const r1 = assemble(parseSse(await (await post(a.bridge.url(), '/v1/messages', first)).text()));
    await a.bridge.close();
    // The mock provider of the second bridge must know the conversation to continue it.
    const b = await mk();
    (b.mock as unknown as { conversations: Map<string, unknown[]> }).conversations = (a.mock as unknown as { conversations: Map<string, unknown[]> }).conversations;
    const tu = r1.content.find((x) => x.type === 'tool_use')!;
    await (
      await post(b.bridge.url(), '/v1/messages', {
        ...first,
        messages: [...first.messages, { role: 'assistant', content: r1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '/home' }] }],
      })
    ).text();
    assert.equal(b.mock.jobs[0]!.conversation.kind, 'continue');
    await b.bridge.close();
  });
});

describe('reasoning summaries', () => {
  it('streams ChatGPT reasoning as a thinking block before the answer', async () => {
    const ctx = await start(() => ({ thinking: 'Considering the options carefully.', reply: 'Answer.' }));
    try {
      const r = await post(ctx.url, '/v1/messages', { model: 'm', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'think' }] });
      const events = parseSse(await r.text());
      const starts = events.filter((e) => e.event === 'content_block_start').map((e) => (e.data.content_block as { type: string }).type);
      assert.deepEqual(starts, ['thinking', 'text']);
      const thinking = events
        .filter((e) => e.event === 'content_block_delta' && (e.data.delta as { type: string }).type === 'thinking_delta')
        .map((e) => (e.data.delta as { thinking: string }).thinking)
        .join('');
      assert.equal(thinking, 'Considering the options carefully.');
      assert.ok(events.some((e) => e.event === 'content_block_delta' && (e.data.delta as { type: string }).type === 'signature_delta'));
    } finally {
      await ctx.bridge.close();
    }
  });
});

describe('local answers and output-limit handling', () => {
  it('answers WebFetch digests locally with the page content', async () => {
    const ctx = await start(() => 'should not be used');
    try {
      const r = await post(ctx.url, '/v1/messages', {
        model: 'claude-haiku-x',
        max_tokens: 1000,
        messages: [{ role: 'user', content: '\nWeb page content:\n---\n# Title\nBody text\n---\n\nWhat is the title?\n\nProvide a concise response based only on the content above.' }],
      });
      const j = (await r.json()) as { content: Array<{ text: string }> };
      assert.match(j.content[0]!.text, /# Title\nBody text/);
      assert.match(j.content[0]!.text, /What is the title\?/);
      assert.equal(ctx.mock.jobs.length, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('answers HEAD and GET /api/hello without auth', async () => {
    const ctx = await start(() => 'x');
    try {
      assert.equal((await fetch(ctx.url + '/api/hello', { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(ctx.url + '/api/hello')).status, 200);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('drops a tool call cut off by the output limit and warns the model next turn', async () => {
    const ctx = await start((_job, c) =>
      c.turn === 0
        ? 'Writing.\n<tool_call name="Bash">\n<param name="command">echo one</param>\n</tool_call>\n<tool_call name="Bash">\n<param name="command">cat > big.txt <<EOF\nlots of'
        : 'ok',
    );
    // Make the mock report a max_tokens finish for the first turn.
    const orig = ctx.mock.run.bind(ctx.mock);
    ctx.mock.run = async function* (job, signal) {
      for await (const ev of orig(job, signal)) yield ev.type === 'done' && ctx.mock.jobs.length === 1 ? { ...ev, finishReason: 'max_tokens' } : ev;
    };
    try {
      const first = { model: 'm', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'go' }] };
      const r1 = assemble(parseSse(await (await post(ctx.url, '/v1/messages', first)).text()));
      const calls = r1.content.filter((b) => b.type === 'tool_use');
      assert.equal(calls.length, 1, 'only the complete call survives');
      assert.deepEqual(calls[0]!.input, { command: 'echo one' });
      await (
        await post(ctx.url, '/v1/messages', {
          ...first,
          messages: [...first.messages, { role: 'assistant', content: r1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls[0]!.id, content: 'one' }] }],
        })
      ).text();
      assert.match(ctx.mock.jobs[1]!.prompt, /cut off by ChatGPT's output limit/);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('refuses empty replies instead of returning nothing', async () => {
    const ctx = await start(() => '   ');
    try {
      const r = await post(ctx.url, '/v1/messages', { model: 'm', max_tokens: 100, tools: TOOLS, messages: [{ role: 'user', content: 'empty' }] });
      assert.equal(r.status, 500);
      assert.equal(r.headers.get('x-should-retry'), 'false');
    } finally {
      await ctx.bridge.close();
    }
  });
});

describe('interruptions and concurrency', () => {
  it('tells ChatGPT its reply was discarded when the user interrupts and sends a new message', async () => {
    const config: BridgeConfig = { ...defaultConfig(), port: 0, authToken: TOKEN, provider: 'mock', orphanGraceMs: 60_000 };
    let turn = 0;
    const mock = new MockProvider({
      chunkSize: 4,
      chunkDelayMs: 25,
      script: () => (turn++ === 0 ? '<tool_call name="Bash">\n<param name="command">ls</param>\n</tool_call>' : 'a long answer that the user interrupts midway'),
    });
    const bridge = createBridgeServer(config, silentLogger, mock);
    await bridge.listen();
    const hdr = { 'x-claude-code-session-id': 'S1' };
    try {
      const base = { model: 'm', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'start' }] };
      const r1 = assemble(parseSse(await (await post(bridge.url(), '/v1/messages', base, hdr)).text()));
      const tu = r1.content.find((b) => b.type === 'tool_use')!;
      const follow = { ...base, messages: [...base.messages, { role: 'assistant', content: r1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: 'a' }] }] };
      // Second turn: the client goes away mid-reply (Esc).
      const ac = new AbortController();
      const p = fetch(bridge.url() + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...hdr },
        body: JSON.stringify(follow),
        signal: ac.signal,
      }).then((r) => r.text()).catch(() => null);
      await new Promise((r) => setTimeout(r, 120));
      ac.abort();
      await p;
      // Third request: same transcript plus a new user message.
      const third = { ...follow, messages: [...follow.messages.slice(0, -1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: 'a' }, { type: 'text', text: 'actually, stop' }] }] };
      await (await post(bridge.url(), '/v1/messages', third, hdr)).text();
      const last = mock.jobs.at(-1)!;
      assert.equal(last.conversation.kind, 'continue');
      assert.match(last.prompt, /your previous reply was interrupted/);
    } finally {
      await bridge.close();
    }
  });

  it('does not extract tool calls from replies to tool-less requests', async () => {
    const ctx = await start(() => 'Summary.\n<tool_call name="Bash">\n<param name="command">ls</param>\n</tool_call>');
    try {
      const r = await post(ctx.url, '/v1/messages', { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'summarize' }] });
      const j = (await r.json()) as { stop_reason: string; content: Array<{ type: string }> };
      assert.equal(j.stop_reason, 'end_turn');
      assert.deepEqual(j.content.map((b) => b.type), ['text']);
    } finally {
      await ctx.bridge.close();
    }
  });
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { delegateArgs, summarizeStream } from '../mcp/server.mjs';

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

/** Minimal stand-in for the bridge: /health and /v1/messages. */
function startFakeBridge(health) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify(health));
      if (req.url === '/v1/messages') {
        const q = JSON.parse(body).messages[0].content;
        return res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: `answer to: ${q}` }], stop_reason: 'end_turn' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

function startMcp(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  const notifications = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else notifications.push(msg);
  });
  const state = { nextId: 1 };
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = state.nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { child, request, notifications, lastId: () => state.nextId - 1, close: () => child.kill() };
}

describe('webgpt4cc MCP server', () => {
  let bridge;
  let mcp;
  const home = mkdtempSync(join(tmpdir(), 'webgpt4cc-mcp-'));
  before(async () => {
    bridge = await startFakeBridge({ ok: true, version: '0.1.0', provider: 'extension', connected: true, workers: [{ id: 'c1:1', ready: true, busy: false }], queued: 0 });
    mcp = startMcp({
      WEBGPT4CC_HOME: home,
      WEBGPT4CC_BRIDGE_URL: bridge.url,
      WEBGPT4CC_AUTH_TOKEN: 'tok',
      WEBGPT4CC_CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: 'sk-should-not-leak',
    });
  });
  after(() => {
    mcp.close();
    bridge.server.close();
  });

  it('initializes and lists tools', async () => {
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    const list = await mcp.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['ask', 'delegate', 'status']);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
  });

  it('reports bridge status', async () => {
    const r = await mcp.request('tools/call', { name: 'status', arguments: {} });
    assert.equal(r.result.isError, undefined);
    assert.match(r.result.content[0].text, /1\/1 worker tab\(s\) ready/);
  });

  it('asks a one-off question through the bridge with the bridge token', async () => {
    const r = await mcp.request('tools/call', { name: 'ask', arguments: { question: 'why?' } });
    assert.equal(r.result.content[0].text, 'answer to: why?');
    const req = bridge.requests.find((q) => q.url === '/v1/messages');
    assert.equal(req.headers.authorization, 'Bearer tok');
  });

  it('delegates a task to a child claude pointed at the bridge', async () => {
    const r = await mcp.request('tools/call', {
      name: 'delegate',
      arguments: { task: 'do the thing', allowed_tools: ['Read', 'Edit'], max_turns: 5 },
      _meta: { progressToken: 'p1' },
    });
    assert.equal(r.result.isError, undefined, r.result.content[0].text);
    const text = r.result.content[0].text;
    assert.match(text, /^\[ChatGPT-web delegate: success, 2 turns, 1m05s, session_id sess-123\]/);
    assert.match(text, /Tools used: Write×1/);
    assert.match(text, /Files written\/edited: out\.txt/);
    const echoed = JSON.parse(text.slice(text.indexOf('{')));
    assert.equal(echoed.task, 'do the thing');
    assert.equal(echoed.base, bridge.url);
    assert.equal(echoed.token, 'tok');
    assert.equal(echoed.claudecode, null, 'CLAUDECODE must not leak into the child');
    assert.equal(echoed.apiKey, null, 'ANTHROPIC_API_KEY must not leak into the child');
    assert.deepEqual(echoed.args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
    assert.ok(echoed.args.includes('Read,Edit'));
    const settings = JSON.parse(echoed.args[echoed.args.indexOf('--settings') + 1]);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, bridge.url);
    assert.equal(settings.disableAutoMode, 'disable');
    assert.ok(mcp.notifications.some((n) => n.method === 'notifications/progress' && n.params.progressToken === 'p1'));
  });

  it('reports delegate failures with stderr', async () => {
    const r = await mcp.request('tools/call', { name: 'delegate', arguments: { task: 'please FAIL' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /error \(error_during_execution\)/);
    assert.match(r.result.content[0].text, /boom/);
  });

  it('cancels a running delegate', async () => {
    const call = mcp.request('tools/call', { name: 'delegate', arguments: { task: 'HANG' } });
    await new Promise((r) => setTimeout(r, 500));
    mcp.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: mcp.lastId() } }) + '\n');
    const r = await call;
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /stopped \(cancelled\)/);
  });

  it('rejects unknown tools', async () => {
    const r = await mcp.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(r.error.code, -32602);
  });
});

describe('delegate when the bridge is down', () => {
  it('explains how to start the bridge', async () => {
    const mcp = startMcp({ WEBGPT4CC_BRIDGE_URL: 'http://127.0.0.1:9', WEBGPT4CC_CLAUDE_BIN: FAKE_CLAUDE });
    try {
      const r = await mcp.request('tools/call', { name: 'delegate', arguments: { task: 'x' } });
      assert.equal(r.result.isError, true);
      assert.match(r.result.content[0].text, /webgpt4cc serve/);
    } finally {
      mcp.close();
    }
  });
});

describe('helpers', () => {
  it('builds claude arguments with safe defaults', () => {
    const a = delegateArgs({ task: 't' }, 'chatgpt-web');
    assert.deepEqual(a.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'chatgpt-web']);
    assert.ok(!a[a.indexOf('--allowedTools') + 1].includes('Bash'));
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(delegateArgs({ permission_mode: 'bypassPermissions' }, 'm')[delegateArgs({ permission_mode: 'bypassPermissions' }, 'm').indexOf('--permission-mode') + 1], 'acceptEdits');
  });

  it('summarizes stream-json output', () => {
    const s = summarizeStream([
      '{"type":"system","subtype":"init","session_id":"s"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/a"}},{"type":"tool_use","name":"Edit","input":{"file_path":"/b"}}]}}',
      'not json',
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":1}',
    ]);
    assert.equal(s.sessionId, 's');
    assert.equal(s.toolCounts.get('Edit'), 2);
    assert.deepEqual([...s.files], ['/a', '/b']);
    assert.equal(s.result.result, 'ok');
  });
});

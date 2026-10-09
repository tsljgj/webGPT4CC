// HTTP server: Anthropic-compatible endpoints + the extension WebSocket.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { sendJson, sendJsonError } from './anthropic/sse.ts';
import type { BridgeConfig } from './config.ts';
import { type BridgeState, createState, handleCountTokens, handleMessages } from './handler.ts';
import type { Logger } from './log.ts';
import { ExtensionProvider } from './providers/extension.ts';
import { MockProvider } from './providers/mock.ts';
import type { ChatProvider } from './providers/types.ts';
import { VERSION } from './version.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

const decoders: Record<string, (b: Buffer) => Promise<Buffer>> = {
  gzip: promisify(zlib.gunzip),
  'x-gzip': promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress),
};
const zstd = (zlib as unknown as { zstdDecompress?: (b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void }).zstdDecompress;
if (zstd) decoders.zstd = promisify(zstd);

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  let body: Buffer = Buffer.concat(chunks);
  const enc = String(req.headers['content-encoding'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'identity');
  for (const e of enc.reverse()) {
    const dec = decoders[e];
    if (!dec) throw Object.assign(new Error(`unsupported content-encoding: ${e}`), { status: 415 });
    body = await dec(body);
  }
  return body;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostName(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0]!.toLowerCase();
}

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const key = req.headers['x-api-key'];
  return typeof key === 'string' ? key.trim() : undefined;
}

export interface BridgeServer {
  server: Server;
  state: BridgeState;
  provider: ChatProvider;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  url(): string;
}

export function createProvider(config: BridgeConfig, log: Logger): ChatProvider {
  if (config.provider === 'mock') return new MockProvider();
  return new ExtensionProvider({
    extensionToken: config.extensionToken,
    allowedOrigins: config.allowedOrigins,
    newChatUrl: config.newChatUrl,
    workerWaitMs: config.workerWaitMs,
    bridgeVersion: VERSION,
    log,
  });
}

export function createBridgeServer(config: BridgeConfig, log: Logger, provider: ChatProvider = createProvider(config, log)): BridgeServer {
  const state = createState(config, provider, log);
  const loopbackOnly = isLoopback(config.host);

  const hostAllowed = (req: IncomingMessage) => !loopbackOnly || isLoopback(hostName(req.headers.host));

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      log.error(`unhandled error: ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) sendJsonError(res, 'api_error', 'internal bridge error');
      else res.end();
    });
  });
  server.requestTimeout = 0; // replies from thinking models can take many minutes
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (!hostAllowed(req)) {
      sendJsonError(res, 'permission_error', 'invalid Host header');
      return;
    }
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      const st = provider.status();
      sendJson(res, 200, {
        ok: true,
        name: 'webgpt4cc',
        version: VERSION,
        provider: st.name,
        connected: st.connected,
        workers: st.workers.map((w) => ({ id: w.id, ready: w.ready, busy: w.busy })),
        queued: st.queued,
        stats: state.stats,
      });
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200).end();
      return;
    }
    if (!path.startsWith('/v1/')) {
      sendJsonError(res, 'not_found_error', `Not found: ${req.method} ${path}`);
      return;
    }
    // Browsers always send Origin on cross-site requests; Claude Code never does.
    if (req.headers.origin) {
      sendJsonError(res, 'permission_error', 'browser requests are not allowed');
      return;
    }
    if (config.authToken && bearer(req) !== config.authToken) {
      sendJsonError(res, 'authentication_error', 'invalid x-api-key / bearer token for the webGPT4CC bridge (see ~/.webgpt4cc/config.json)', {
        'x-should-retry': 'false',
      });
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      const ids = [...new Set(['chatgpt-web', config.models.default, config.models.background, ...Object.values(config.models.map)].filter(Boolean))];
      sendJson(res, 200, {
        data: ids.map((id) => ({ type: 'model', id, display_name: id === 'chatgpt-web' ? 'ChatGPT (model selected in the tab)' : `ChatGPT ${id}`, created_at: '2026-01-01T00:00:00Z' })),
        has_more: false,
        first_id: ids[0] ?? null,
        last_id: ids[ids.length - 1] ?? null,
      });
      return;
    }
    if (req.method !== 'POST') {
      sendJsonError(res, 'not_found_error', `Not found: ${req.method} ${path}`);
      return;
    }
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      const status = (e as { status?: number }).status;
      sendJsonError(res, status === 413 ? 'request_too_large' : 'invalid_request_error', `could not read request body: ${(e as Error).message}`);
      return;
    }
    if (path === '/v1/messages') return handleMessages(state, req, res, body);
    if (path === '/v1/messages/count_tokens') return handleCountTokens(state, res, body);
    sendJsonError(res, 'not_found_error', `Not found: POST ${path}`);
  }

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/extension' || !(provider instanceof ExtensionProvider) || !hostAllowed(req)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    provider.handleUpgrade(req, socket, head);
  });

  let bound = { host: config.host, port: config.port };
  return {
    server,
    state,
    provider,
    url: () => `http://${bound.host.includes(':') ? `[${bound.host}]` : bound.host}:${bound.port}`,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const addr = server.address() as AddressInfo;
          bound = { host: config.host, port: addr.port };
          resolve(bound);
        });
      }),
    close: async () => {
      state.sessions.flush();
      await provider.close?.();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}

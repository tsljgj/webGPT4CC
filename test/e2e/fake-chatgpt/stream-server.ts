// Local HTTPS server that lets the fake deliver SSE bodies over time.
//
// Playwright's route.fulfill() hands the page a response body in one piece,
// but the real /backend-api/f/conversation response arrives as many small
// chunks over seconds, and a dropped connection breaks it midway. So the fake
// answers a conversation POST with route.continue({ url }) pointing here: the
// URL change is invisible to the page (response.url stays https://chatgpt.com/…),
// and this server writes the prepared SSE text in small, irregular byte slices
// that split lines, events and multi-byte characters, optionally destroying the
// connection partway through.
//
// Needs, on the browser context:
//  * ignoreHTTPSErrors: true (the certificate is self-signed, made with the openssl CLI);
//  * the "local-network-access" permission for https://chatgpt.com, granted by
//    FakeChatGPT.install(): Chrome's Local Network Access otherwise holds a
//    public-origin request to loopback at a permission prompt nobody answers.
// Without openssl, start() returns null and the fake falls back to fulfill().
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StreamPlan {
  /** The whole SSE body. */
  body: string;
  /** Destroy the connection after this many bytes (a broken stream). */
  cutAtByte?: number;
  /** Pause between slices. */
  sliceDelayMs: number;
  /** Seed for the deterministic slice sizes. */
  seed: number;
  /** Called with the number of slices written once the response ends (or is cut / aborted). */
  onEnd?: (info: { slices: number; bytes: number; cut: boolean; aborted: boolean }) => void;
}

let certPromise: Promise<{ key: Buffer; cert: Buffer } | null> | null = null;

/** One self-signed 127.0.0.1 certificate per process (EC P-256: fast to generate). */
function loopbackCert(): Promise<{ key: Buffer; cert: Buffer } | null> {
  certPromise ??= Promise.resolve().then(() => {
    const dir = mkdtempSync(join(tmpdir(), 'webgpt4cc-e2e-cert-'));
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-nodes', '-days', '2',
          '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
          '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
          '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore', timeout: 20_000 },
      );
      return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
    } catch {
      return null; // no openssl (or it failed): callers fall back to whole bodies
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return certPromise;
}

/** Small deterministic PRNG (mulberry32), so a failing slice pattern can be reproduced. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SseStreamServer {
  private readonly server: Server;
  private readonly plans = new Map<string, StreamPlan>();
  private readonly sockets = new Set<Socket>();
  private readonly timers = new Set<NodeJS.Timeout>();
  readonly port: number;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
  }

  /** Start on 127.0.0.1 (random port), or return null when no certificate can be made. */
  static async start(): Promise<SseStreamServer | null> {
    const tls = await loopbackCert();
    if (!tls) return null;
    const server = createServer(tls);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    // Never keep the test process alive because of this server (close() is still called).
    server.unref();
    const s = new SseStreamServer(server, (server.address() as AddressInfo).port);
    server.on('connection', (sock: Socket) => {
      s.sockets.add(sock);
      sock.on('close', () => s.sockets.delete(sock));
    });
    server.on('request', (req, res) => {
      // Drain the forwarded POST body; the fake already parsed it in the route handler.
      req.resume();
      const token = new URL(req.url ?? '/', 'https://127.0.0.1').searchParams.get('__stream') ?? '';
      const plan = s.plans.get(token);
      if (!plan) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"unknown stream"}');
        return;
      }
      s.plans.delete(token); // one use
      s.serve(plan, res);
    });
    return s;
  }

  /**
   * Register a body to stream; returns the URL to continue the routed request to.
   * It keeps the original path, so Playwright's request/response URLs still match
   * `/backend-api/f/conversation` (the page itself keeps seeing the chatgpt.com URL).
   */
  register(plan: StreamPlan, pathname: string): string {
    const token = randomUUID();
    this.plans.set(token, plan);
    return `https://127.0.0.1:${this.port}${pathname}?__stream=${token}`;
  }

  private serve(plan: StreamPlan, res: ServerResponse): void {
    const bytes = Buffer.from(plan.body, 'utf8');
    const end = plan.cutAtByte !== undefined ? Math.min(plan.cutAtByte, bytes.length) : bytes.length;
    const rand = rng(plan.seed);
    let at = 0;
    let slices = 0;
    let finished = false;
    const done = (cut: boolean, aborted: boolean) => {
      if (finished) return;
      finished = true;
      plan.onEnd?.({ slices, bytes: at, cut, aborted });
    };
    // The page aborts its read after message_stream_complete, like the real site.
    res.on('close', () => done(false, !res.writableEnded));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-oai-request-id': randomUUID(),
    });
    res.flushHeaders();
    const tick = () => {
      if (res.destroyed) return;
      if (at >= end) {
        if (end < bytes.length) {
          // A dropped connection: no terminating chunk, the page's read() rejects.
          done(true, false);
          res.socket?.destroy();
        } else {
          res.end();
          done(false, false);
        }
        return;
      }
      // 1..160 bytes, sometimes a larger burst of several events, like TCP/HTTP2 framing.
      const size = rand() < 0.15 ? 200 + Math.floor(rand() * 600) : 1 + Math.floor(rand() * 160);
      const next = Math.min(end, at + size);
      res.write(bytes.subarray(at, next));
      at = next;
      slices++;
      this.schedule(tick, plan.sliceDelayMs);
    };
    this.schedule(tick, plan.sliceDelayMs);
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.plans.clear();
    for (const sock of this.sockets) sock.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

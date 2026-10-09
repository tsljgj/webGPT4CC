// Provider backed by the webGPT4CC browser extension (see docs/PROTOCOL.md §2).
// The extension connects to us over a localhost WebSocket and exposes one or
// more chatgpt.com tabs as "workers". Each job runs in one tab.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { buildNewChatUrl } from '../config.ts';
import type { Logger } from '../log.ts';
import { AsyncQueue } from '../util/queue.ts';
import type { ChatEvent, ChatJob, ChatProvider, ProviderStatus, WorkerInfo } from './types.ts';

export const PROTOCOL_VERSION = 1;

export interface ExtensionProviderOptions {
  extensionToken: string;
  allowedOrigins: string[];
  newChatUrl: string;
  workerWaitMs: number;
  bridgeVersion: string;
  log: Logger;
}

interface Connection {
  id: string;
  ws: WebSocket;
  hello?: { extensionVersion?: string; browser?: string };
  workers: Map<string, WorkerInfo>;
  alive: boolean;
}

interface ActiveJob {
  job: ChatJob;
  conn: Connection;
  workerKey: string;
  queue: AsyncQueue<ChatEvent>;
}

interface Waiter {
  job: ChatJob;
  resolve: (w: { conn: Connection; workerKey: string }) => void;
  since: number;
}

export function isAllowedOrigin(origin: string | undefined, extra: string[]): boolean {
  if (!origin) return false;
  if (/^(chrome|moz|safari-web)-extension:\/\/[\w-]+$/.test(origin)) return true;
  return extra.includes(origin);
}

export class ExtensionProvider implements ChatProvider {
  readonly name = 'extension';
  private readonly opts: ExtensionProviderOptions;
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, Connection>();
  private readonly jobs = new Map<string, ActiveJob>();
  /** workerKey -> jobId */
  private readonly busy = new Map<string, string>();
  private readonly waiters: Waiter[] = [];
  private nextConn = 1;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(opts: ExtensionProviderOptions) {
    this.opts = opts;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.heartbeat = setInterval(() => this.sweep(), 15_000);
    this.heartbeat.unref?.();
  }

  /** Called by the HTTP server for upgrade requests on /extension. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    const reject = (code: number, msg: string) => {
      this.opts.log.warn(`rejected extension connection (${msg}) origin=${origin ?? '-'}`);
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!isAllowedOrigin(origin, this.opts.allowedOrigins)) return reject(403, 'Forbidden origin');
    if (this.opts.extensionToken && url.searchParams.get('token') !== this.opts.extensionToken) return reject(401, 'Bad token');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    const conn: Connection = { id: `c${this.nextConn++}`, ws, workers: new Map(), alive: true };
    this.conns.set(conn.id, conn);
    this.opts.log.info(`extension connected (${conn.id})`);
    this.send(conn, { type: 'welcome', protocol: PROTOCOL_VERSION, bridgeVersion: this.opts.bridgeVersion });
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.onMessage(conn, msg);
    });
    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => this.onClose(conn));
    ws.on('error', (e) => this.opts.log.warn(`extension socket error: ${e.message}`));
  }

  private onClose(conn: Connection): void {
    this.conns.delete(conn.id);
    this.opts.log.info(`extension disconnected (${conn.id})`);
    for (const [jobId, a] of this.jobs) {
      if (a.conn === conn) {
        a.queue.push({ type: 'error', code: 'ui_error', message: 'the browser extension disconnected during the job' });
        a.queue.close();
        this.jobs.delete(jobId);
        this.busy.delete(a.workerKey);
      }
    }
  }

  private onMessage(conn: Connection, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'hello':
        conn.hello = { extensionVersion: msg.extensionVersion as string, browser: msg.browser as string };
        if (msg.protocol !== PROTOCOL_VERSION)
          this.opts.log.warn(`extension speaks protocol ${String(msg.protocol)}, bridge speaks ${PROTOCOL_VERSION}; please update both`);
        break;
      case 'workers': {
        conn.workers.clear();
        for (const w of (msg.workers as WorkerInfo[]) ?? []) if (w && w.id != null) conn.workers.set(String(w.id), { ...w, id: String(w.id) });
        this.opts.log.debug(`workers: ${[...conn.workers.values()].map((w) => `${w.id}${w.ready ? '' : '(not ready)'}`).join(', ') || 'none'}`);
        this.dispatch();
        break;
      }
      case 'job_event': {
        const a = this.jobs.get(String(msg.jobId));
        if (!a || a.conn !== conn) return;
        const ev = msg.event as ChatEvent;
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'done') a.queue.push({ ...ev, workerId: a.workerKey });
        else a.queue.push(ev);
        if (ev.type === 'done' || ev.type === 'error') this.finishJob(String(msg.jobId));
        break;
      }
      case 'log': {
        const level = (['debug', 'info', 'warn', 'error'] as const).includes(msg.level as 'info') ? (msg.level as 'info') : 'info';
        this.opts.log[level](`[extension] ${String(msg.message)}`, msg.data);
        break;
      }
      case 'pong':
        conn.alive = true;
        break;
    }
  }

  private finishJob(jobId: string): void {
    const a = this.jobs.get(jobId);
    if (!a) return;
    this.jobs.delete(jobId);
    if (this.busy.get(a.workerKey) === jobId) this.busy.delete(a.workerKey);
    a.queue.close();
    this.dispatch();
  }

  private send(conn: Connection, msg: unknown): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private sweep(): void {
    for (const conn of this.conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        /* ignore */
      }
      this.send(conn, { type: 'ping', t: Date.now() });
    }
  }

  private idleWorkers(): Array<{ conn: Connection; workerKey: string; info: WorkerInfo }> {
    const out: Array<{ conn: Connection; workerKey: string; info: WorkerInfo }> = [];
    for (const conn of this.conns.values())
      for (const info of conn.workers.values()) {
        const key = `${conn.id}:${info.id}`;
        if (info.ready && !this.busy.has(key)) out.push({ conn, workerKey: key, info });
      }
    return out;
  }

  private workerCount(): number {
    let n = 0;
    for (const c of this.conns.values()) n += c.workers.size;
    return n;
  }

  private readyWorkerCount(): number {
    let n = 0;
    for (const c of this.conns.values()) for (const w of c.workers.values()) if (w.ready) n++;
    return n;
  }

  /** Assign idle workers to waiting jobs (FIFO, honouring conversation affinity for a while). */
  private dispatch(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i]!;
      const idle = this.idleWorkers();
      if (!idle.length) return;
      const affinity = w.job.conversation.kind === 'continue' ? w.job.conversation.workerId : undefined;
      let pick = affinity ? idle.find((x) => x.workerKey === affinity) : undefined;
      if (!pick) {
        const affinityAlive = affinity && this.workerExists(affinity);
        const waitedLongEnough = Date.now() - w.since > Math.min(this.opts.workerWaitMs, 30_000);
        if (affinityAlive && !waitedLongEnough) {
          i++;
          continue;
        }
        pick = idle[0];
      }
      if (!pick) return;
      this.waiters.splice(i, 1);
      this.busy.set(pick.workerKey, w.job.id);
      w.resolve({ conn: pick.conn, workerKey: pick.workerKey });
    }
  }

  private workerExists(key: string): boolean {
    const [connId, ...rest] = key.split(':');
    return !!this.conns.get(connId!)?.workers.has(rest.join(':'));
  }

  status(): ProviderStatus {
    const workers: WorkerInfo[] = [];
    for (const conn of this.conns.values())
      for (const w of conn.workers.values()) workers.push({ ...w, id: `${conn.id}:${w.id}`, busy: this.busy.has(`${conn.id}:${w.id}`) });
    return {
      name: this.name,
      connected: this.conns.size > 0,
      workers,
      queued: this.waiters.length,
      detail: [...this.conns.values()].map((c) => `${c.id} ext ${c.hello?.extensionVersion ?? '?'} ${c.hello?.browser ?? ''}`.trim()).join('; '),
    };
  }

  async *run(job: ChatJob, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const deadline = Date.now() + job.timeoutMs;
    // 1. Wait for a worker.
    if (this.workerCount() === 0) yield { type: 'status', status: 'waiting_for_worker' };
    let assigned: { conn: Connection; workerKey: string } | undefined;
    try {
      assigned = await this.acquire(job, signal);
    } catch (e) {
      yield { type: 'error', code: signal.aborted ? 'aborted' : 'no_worker', message: (e as Error).message };
      return;
    }
    const { conn, workerKey } = assigned;
    const tabId = workerKey.split(':').slice(1).join(':');
    const queue = new AsyncQueue<ChatEvent>();
    this.jobs.set(job.id, { job, conn, workerKey, queue });
    const url =
      job.conversation.kind === 'continue'
        ? `https://chatgpt.com/c/${encodeURIComponent(job.conversation.conversationId)}`
        : buildNewChatUrl(this.opts.newChatUrl, job.model, !!job.temporary);
    this.send(conn, { type: 'job', job: { ...job, workerId: tabId, url } });
    yield { type: 'status', status: 'accepted', detail: `worker ${workerKey}` };

    const onAbort = () => {
      this.send(conn, { type: 'cancel', jobId: job.id });
      queue.push({ type: 'error', code: 'aborted', message: 'request cancelled by the client' });
      this.finishJob(job.id);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      this.send(conn, { type: 'cancel', jobId: job.id });
      queue.push({ type: 'error', code: 'timeout', message: `no reply within ${Math.round(job.timeoutMs / 1000)}s` });
      this.finishJob(job.id);
    }, Math.max(1000, deadline - Date.now()));
    timer.unref?.();
    try {
      for await (const ev of queue) {
        yield ev;
        if (ev.type === 'done' || ev.type === 'error') return;
      }
      yield { type: 'error', code: 'internal', message: 'job ended without a result' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.jobs.has(job.id)) {
        this.send(conn, { type: 'cancel', jobId: job.id });
        this.finishJob(job.id);
      }
    }
  }

  private acquire(job: ChatJob, signal: AbortSignal): Promise<{ conn: Connection; workerKey: string }> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { job, resolve: (w) => cleanup(() => resolve(w)), since: Date.now() };
      let noWorkerTimer: NodeJS.Timeout | undefined;
      let affinityTimer: NodeJS.Timeout | undefined;
      const cleanup = (fn: () => void) => {
        clearTimeout(noWorkerTimer);
        clearInterval(affinityTimer);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      const remove = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      const onAbort = () => cleanup(() => (remove(), reject(new Error('aborted'))));
      signal.addEventListener('abort', onAbort, { once: true });
      // Fail if no usable worker shows up within workerWaitMs (busy workers are fine: we queue).
      const checkNoWorker = () => {
        if (this.readyWorkerCount() > 0 || !this.waiters.includes(waiter)) return;
        const total = this.workerCount();
        cleanup(() => {
          remove();
          reject(
            new Error(
              total === 0
                ? `no ChatGPT tab connected (waited ${Math.round(this.opts.workerWaitMs / 1000)}s)`
                : `${total} ChatGPT tab(s) connected but none is ready (logged out, still loading, or showing a dialog?) after ${Math.round(this.opts.workerWaitMs / 1000)}s`,
            ),
          );
        });
      };
      noWorkerTimer = setTimeout(checkNoWorker, this.opts.workerWaitMs);
      // Re-run dispatch periodically so affinity waits can expire.
      affinityTimer = setInterval(() => this.dispatch(), 2_000);
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const c of this.conns.values()) c.ws.close(1001, 'bridge shutting down');
    this.wss.close();
  }
}

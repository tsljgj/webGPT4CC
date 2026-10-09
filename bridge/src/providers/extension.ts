// Provider backed by the webGPT4CC browser extension (see docs/PROTOCOL.md §2).
// The extension connects to us over a localhost WebSocket and exposes one or
// more chatgpt.com tabs as "workers". Each job runs in one tab.
//
// Both ends prove they know the pairing token (extensionToken) with an HMAC
// challenge-response before anything else is exchanged; the token itself never
// crosses the wire, and neither side acts on messages from an unproven peer.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { buildNewChatUrl } from '../config.ts';
import type { Logger } from '../log.ts';
import { AsyncQueue } from '../util/queue.ts';
import type { ChatEvent, ChatJob, ChatProvider, ProviderStatus, WorkerInfo } from './types.ts';

export const PROTOCOL_VERSION = 2;

/** HMAC-SHA256 (hex) keyed by the pairing token, as the extension computes it (background.js pairingHmac). */
export function pairingHmac(token: string, text: string): string {
  return createHmac('sha256', `webgpt4cc/pairing/v2/${token}`).update(text).digest('hex');
}

function sameHex(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const AUTH_TIMEOUT_MS = 10_000;
/** Temporary main-session conversations remembered per worker (they live only in the tab that holds them). */
const MAX_TEMPORARY_HELD = 200;

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
  /** The extension proved it knows the pairing token. Until then only the handshake is processed. */
  authed: boolean;
  /** Nonces of the handshake: the extension's and ours. */
  nonceE?: string;
  nonceB?: string;
  authTimer?: NodeJS.Timeout;
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
    const origin = req.headers.origin;
    const reject = (code: number, msg: string) => {
      this.opts.log.warn(`rejected extension connection (${msg}) origin=${origin ?? '-'}`);
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!isAllowedOrigin(origin, this.opts.allowedOrigins)) return reject(403, 'Forbidden origin');
    // No token in the URL: the pairing handshake (hello / welcome / auth) proves it on both sides.
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    const conn: Connection = { id: `c${this.nextConn++}`, ws, workers: new Map(), alive: true, authed: false };
    this.conns.set(conn.id, conn);
    this.opts.log.debug(`extension socket opened (${conn.id}); waiting for the pairing handshake`);
    conn.authTimer = setTimeout(() => {
      if (!conn.authed) this.reject(conn, 4401, 'no pairing handshake');
    }, AUTH_TIMEOUT_MS);
    conn.authTimer.unref?.();
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

  private reject(conn: Connection, code: number, reason: string): void {
    this.opts.log.warn(`extension connection ${conn.id} rejected: ${reason}`);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  }

  /** Handshake, step 1: the extension's nonce. Answer with ours and our proof. */
  private onHello(conn: Connection, msg: Record<string, unknown>): void {
    conn.hello = { extensionVersion: msg.extensionVersion as string, browser: msg.browser as string };
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.opts.log.warn(`extension speaks protocol ${String(msg.protocol)}, bridge speaks ${PROTOCOL_VERSION}; please update both`);
      // Old extensions (protocol 1) cannot authenticate: tell them why before closing.
      this.send(conn, { type: 'welcome', protocol: PROTOCOL_VERSION, bridgeVersion: this.opts.bridgeVersion });
      this.reject(conn, 4400, `protocol ${String(msg.protocol)} is not supported (bridge speaks ${PROTOCOL_VERSION}): update the extension and the bridge`);
      return;
    }
    const nonceE = typeof msg.nonce === 'string' && /^[0-9a-f]{32,128}$/.test(msg.nonce) ? msg.nonce : '';
    if (!nonceE || conn.nonceB) return this.reject(conn, 4400, 'bad hello');
    conn.nonceE = nonceE;
    conn.nonceB = randomBytes(16).toString('hex');
    const proof = pairingHmac(this.opts.extensionToken, `bridge|${nonceE}|${conn.nonceB}`);
    this.send(conn, { type: 'welcome', protocol: PROTOCOL_VERSION, bridgeVersion: this.opts.bridgeVersion, nonce: conn.nonceB, proof });
  }

  /** Handshake, step 2: the extension's proof. */
  private onAuth(conn: Connection, msg: Record<string, unknown>): void {
    if (!conn.nonceE || !conn.nonceB) return this.reject(conn, 4400, 'auth before hello');
    const want = pairingHmac(this.opts.extensionToken, `extension|${conn.nonceB}|${conn.nonceE}`);
    if (!sameHex(msg.proof, want)) return this.reject(conn, 4401, 'bad pairing token');
    conn.authed = true;
    clearTimeout(conn.authTimer);
    this.opts.log.info(`extension connected (${conn.id}, ${conn.hello?.extensionVersion ?? '?'} ${conn.hello?.browser ?? ''})`.trim());
  }

  private onClose(conn: Connection): void {
    clearTimeout(conn.authTimer);
    this.conns.delete(conn.id);
    if (conn.authed) this.opts.log.info(`extension disconnected (${conn.id})`);
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
    if (!conn.authed) {
      // Only the handshake before the extension proved it knows the pairing token.
      if (msg.type === 'hello') this.onHello(conn, msg);
      else if (msg.type === 'auth') this.onAuth(conn, msg);
      else if (msg.type === 'pong') conn.alive = true;
      return;
    }
    switch (msg.type) {
      case 'workers': {
        conn.workers.clear();
        for (const w of (msg.workers as WorkerInfo[]) ?? []) if (w && w.id != null) conn.workers.set(String(w.id), { ...w, id: String(w.id) });
        this.opts.log.debug(`workers: ${[...conn.workers.values()].map((w) => `${w.id}${w.ready ? '' : '(not ready)'}`).join(', ') || 'none'}`);
        this.dispatch();
        break;
      }
      case 'job_event': {
        const a = this.jobs.get(String(msg.jobId));
        if (!a || a.conn !== conn) {
          // The final event of a job we cancelled: its tab is free again.
          const ev = msg.event as ChatEvent | undefined;
          if (ev && (ev.type === 'done' || ev.type === 'error')) this.releaseCancelled(String(msg.jobId));
          return;
        }
        const ev = msg.event as ChatEvent;
        if (!ev || typeof ev !== 'object') return;
        this.noteJobEvent(a, ev);
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

  /**
   * Warnings the extension attaches to a job: the text ChatGPT sent differs from
   * the prompt (status "prompt_mismatch", done.promptMismatch), or ChatGPT used
   * another model than the one asked for (status "model_mismatch", done.actualModel).
   */
  private noteJobEvent(a: ActiveJob, ev: ChatEvent): void {
    const id = a.job.id.slice(0, 8);
    if (ev.type === 'status' && ev.status === 'prompt_mismatch')
      this.opts.log.warn(`job ${id}: the text ChatGPT received differs from the prompt (${ev.detail ?? ''}); tool arguments copied from it may be altered`);
    else if (ev.type === 'status' && ev.status === 'model_mismatch') this.opts.log.warn(`job ${id}: ${ev.detail ?? 'ChatGPT used another model'}`);
    else if (ev.type === 'done') {
      const extra = ev as ChatEvent & { requestedModel?: unknown; actualModel?: unknown; modelSlug?: unknown };
      if (typeof extra.modelSlug === 'string' || typeof extra.actualModel === 'string')
        this.opts.log.debug(`job ${id}: ChatGPT model ${String(extra.modelSlug ?? extra.actualModel)} (requested ${String(extra.requestedModel ?? '(ui)')})`);
      if (a.job.temporary && a.job.purpose === 'main' && ev.conversationId) this.rememberTemporary(ev.conversationId);
    }
  }

  /** Temporary main-session chats: a new-chat job routed to the tab that holds one destroys it. */
  private readonly temporaryHeld = new Set<string>();
  private rememberTemporary(conversationId: string): void {
    this.temporaryHeld.delete(conversationId);
    this.temporaryHeld.add(conversationId);
    if (this.temporaryHeld.size > MAX_TEMPORARY_HELD) this.temporaryHeld.delete(this.temporaryHeld.values().next().value!);
  }

  private finishJob(jobId: string, opts: { cancelled?: boolean } = {}): void {
    const a = this.jobs.get(jobId);
    if (!a) return;
    this.jobs.delete(jobId);
    if (this.busy.get(a.workerKey) === jobId) {
      if (opts.cancelled) {
        // The tab is still stopping the generation: keep it reserved until the extension
        // reports the job's end (or a safety timeout), so the next job doesn't race it.
        this.busy.set(a.workerKey, `cancel:${jobId}`);
        const t = setTimeout(() => this.releaseCancelled(jobId), 20_000);
        t.unref?.();
      } else this.busy.delete(a.workerKey);
    }
    a.queue.close();
    this.dispatch();
  }

  private releaseCancelled(jobId: string): void {
    for (const [key, v] of this.busy)
      if (v === `cancel:${jobId}`) {
        this.busy.delete(key);
        this.dispatch();
      }
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
        // `info.busy`: the extension's own view (e.g. still stopping a cancelled reply).
        if (info.ready && !info.busy && !this.busy.has(key)) out.push({ conn, workerKey: key, info });
      }
    return out;
  }

  private workerCount(): number {
    let n = 0;
    for (const c of this.conns.values()) n += c.workers.size;
    return n;
  }

  private authedConnections(): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.authed) n++;
    return n;
  }

  /**
   * Workers that can take a job now or later without the user's help: ready, or
   * busy with a job (we queue behind it; the extension reports a busy tab as not
   * ready). A logged-out or broken tab is neither.
   */
  private usableWorkerCount(): number {
    let n = 0;
    for (const c of this.conns.values())
      for (const w of c.workers.values()) if (w.ready || w.busy || this.busy.has(`${c.id}:${w.id}`)) n++;
    return n;
  }

  /**
   * Assign idle workers to waiting jobs (FIFO, honouring conversation affinity for a while).
   * Affinity: the worker that announces it holds the conversation (survives extension
   * reconnects, which renumber connections), else the worker key the conversation was
   * last answered on, else the same tab id on another connection. New chats avoid tabs
   * that hold a temporary main-session chat (only that tab can continue it).
   */
  private dispatch(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i]!;
      const idle = this.idleWorkers();
      if (!idle.length) return;
      let pick: (typeof idle)[number] | undefined;
      if (w.job.conversation.kind === 'continue') {
        const conv = w.job.conversation;
        const tabOf = (key: string | undefined) => (key ? key.split(':').slice(1).join(':') : '');
        pick =
          idle.find((x) => x.info.conversationId === conv.conversationId) ??
          (conv.workerId ? idle.find((x) => x.workerKey === conv.workerId) : undefined) ??
          (conv.workerId ? idle.find((x) => x.info.id === tabOf(conv.workerId)) : undefined);
        if (!pick) {
          const affinityAlive = this.affinityAlive(conv.conversationId, conv.workerId);
          const waitedLongEnough = Date.now() - w.since > Math.min(this.opts.workerWaitMs, 30_000);
          if (affinityAlive && !waitedLongEnough) {
            i++;
            continue;
          }
          pick = idle[0];
        }
      } else {
        pick = idle.find((x) => !x.info.conversationId || !this.temporaryHeld.has(x.info.conversationId));
        if (!pick) {
          pick = idle[0];
          this.opts.log.info(
            `starting a new ChatGPT chat in the tab that holds temporary conversation ${String(pick?.info.conversationId).slice(0, 8)}; continuing that conversation later replays its transcript`,
          );
        }
      }
      if (!pick) return;
      this.waiters.splice(i, 1);
      this.busy.set(pick.workerKey, w.job.id);
      w.resolve({ conn: pick.conn, workerKey: pick.workerKey });
    }
  }

  /** Is the worker that holds this conversation (or last answered it) still connected, busy or not? */
  private affinityAlive(conversationId: string, workerKey: string | undefined): boolean {
    const tab = workerKey ? workerKey.split(':').slice(1).join(':') : '';
    for (const c of this.conns.values())
      for (const info of c.workers.values()) {
        if (info.conversationId === conversationId) return true;
        if (workerKey && (`${c.id}:${info.id}` === workerKey || info.id === tab)) return true;
      }
    return false;
  }

  status(): ProviderStatus {
    const workers: WorkerInfo[] = [];
    for (const conn of this.conns.values())
      for (const w of conn.workers.values()) workers.push({ ...w, id: `${conn.id}:${w.id}`, busy: this.busy.has(`${conn.id}:${w.id}`) });
    return {
      name: this.name,
      connected: this.authedConnections() > 0,
      workers,
      queued: this.waiters.length,
      detail: [...this.conns.values()]
        .filter((c) => c.authed)
        .map((c) => `${c.id} ext ${c.hello?.extensionVersion ?? '?'} ${c.hello?.browser ?? ''}`.trim())
        .join('; '),
    };
  }

  async *run(job: ChatJob, signal: AbortSignal): AsyncIterable<ChatEvent> {
    // 1. Wait for a worker (queue time does not count against the job timeout).
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
      this.finishJob(job.id, { cancelled: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      this.send(conn, { type: 'cancel', jobId: job.id });
      queue.push({ type: 'error', code: 'timeout', message: `no reply within ${Math.round(job.timeoutMs / 1000)}s` });
      this.finishJob(job.id, { cancelled: true });
    }, Math.max(1000, job.timeoutMs));
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
        this.finishJob(job.id, { cancelled: true });
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
      // Fail once no usable worker has been seen for workerWaitMs (re-checked until the
      // job is dispatched, so a tab that logs out while jobs queue is noticed too).
      let lastUsable = Date.now();
      const checkNoWorker = () => {
        if (!this.waiters.includes(waiter)) return;
        if (this.usableWorkerCount() > 0) lastUsable = Date.now();
        const left = lastUsable + this.opts.workerWaitMs - Date.now();
        if (left > 0) {
          noWorkerTimer = setTimeout(checkNoWorker, Math.min(left, 1_000));
          return;
        }
        const total = this.workerCount();
        const extensions = this.authedConnections();
        const waited = Math.round(this.opts.workerWaitMs / 1000);
        cleanup(() => {
          remove();
          reject(
            new Error(
              total > 0
                ? `${total} ChatGPT tab(s) connected but none is ready (logged out, still loading, or showing a dialog?) after ${waited}s`
                : extensions > 0
                  ? `the browser extension is connected but has no worker tab (open its popup and click "Open worker tab" or "Use this tab as a worker"; waited ${waited}s)`
                  : `no ChatGPT tab connected: the browser extension is not connected to the bridge (waited ${waited}s)`,
            ),
          );
        });
      };
      noWorkerTimer = setTimeout(checkNoWorker, Math.min(this.opts.workerWaitMs, 1_000));
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

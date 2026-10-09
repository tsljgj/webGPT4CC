// End-to-end harness: real `claude` CLI -> bridge (in-process) -> browser
// extension (unpacked, in Playwright's Chromium) -> fake chatgpt.com.
//
// How the pieces are wired:
//  * The bridge runs in this process (createBridgeServer, provider "extension",
//    port 0, fixed tokens). A RecordingExtensionProvider subclass records every
//    job so tests can compare what the bridge asked for with what the page sent.
//  * Chromium is launched with launchPersistentContext + --load-extension.
//    Headless works: Playwright's `channel: 'chromium'` uses the full Chromium
//    build in the new headless mode, which runs MV3 extensions (the default
//    chromium-headless-shell does NOT load extensions). Set E2E_HEADED=1 to see
//    the browser (needs a display; on a server: `xvfb-run -a npm run test:e2e`).
//  * https://chatgpt.com/** and wss://ws.chatgpt.com/** are answered by
//    FakeChatGPT through context.route / context.routeWebSocket. Playwright's
//    WebSocket mock is injected before the extension's MAIN-world document_start
//    script, so the extension's WebSocket wrapper sees the routed socket.
//  * The extension is configured and given a worker tab from its service
//    worker (chrome.storage.local {bridgeUrl, token}; the tab id is added the way
//    the popup's "Use this tab" does, or through a test hook when present).
//
// Environment knobs: E2E_VERBOSE=1 (stream bridge/browser/fake logs to stderr),
// E2E_HEADED=1, E2E_EXTENSION_DIR=/path/to/unpacked/extension, CLAUDE_BIN=/path/to/claude.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { defaultConfig, type BridgeConfig } from '../../bridge/src/config.ts';
import { claudeEnv } from '../../bridge/src/launch.ts';
import { createLogger } from '../../bridge/src/log.ts';
import { ExtensionProvider } from '../../bridge/src/providers/extension.ts';
import type { ChatEvent, ChatJob, WorkerInfo } from '../../bridge/src/providers/types.ts';
import { createBridgeServer, type BridgeServer } from '../../bridge/src/server.ts';
import { VERSION } from '../../bridge/src/version.ts';
import { FakeChatGPT, type FakeOptions } from './fake-chatgpt/backend.ts';

// `chrome` only exists inside the extension's service worker (sw.evaluate callbacks).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

export const ROOT = resolve(import.meta.dirname, '../..');
/** Unpacked extension under test (override with E2E_EXTENSION_DIR, e.g. for a build output). */
export const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR ? resolve(process.env.E2E_EXTENSION_DIR) : join(ROOT, 'extension');
export const VERBOSE = process.env.E2E_VERBOSE === '1';
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

export const AUTH_TOKEN = 'e2e-auth-token';
export const EXTENSION_TOKEN = 'e2e-extension-token';

/** Ring buffer of log lines (keeps the tail for failure reports). */
export class LogBuffer {
  readonly lines: string[] = [];
  private readonly prefix: string;
  private readonly max: number;
  constructor(prefix: string, max = 2000) {
    this.prefix = prefix;
    this.max = max;
  }
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    if (VERBOSE) process.stderr.write(`[${this.prefix}] ${line}\n`);
  }
  tail(n = 60): string {
    return this.lines.slice(-n).join('\n');
  }
}

export function extensionAvailable(): boolean {
  return existsSync(join(EXTENSION_DIR, 'manifest.json'));
}

export function claudeAvailable(): boolean {
  const r = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0;
}

/** Reason to skip the full-chain tests, or false. */
export function chainSkipReason(): string | false {
  if (!extensionAvailable()) return `no ${join(EXTENSION_DIR, 'manifest.json')} yet (the extension is not built)`;
  if (!claudeAvailable()) return `the claude CLI (${CLAUDE_BIN}) is not available`;
  return false;
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `webgpt4cc-e2e-${prefix}-`));
}

export async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 30_000, intervalMs = 100): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ------------------------------------------------------------------ bridge

/**
 * ExtensionProvider that records every job and event (instanceof still holds
 * for the WS upgrade). Field names must not collide with the base class's
 * private fields (`jobs` is one): TypeScript privacy does not exist at runtime.
 */
export class RecordingExtensionProvider extends ExtensionProvider {
  readonly recordedJobs: ChatJob[] = [];
  readonly recordedEvents: Array<{ jobId: string; event: ChatEvent }> = [];

  override async *run(job: ChatJob, signal: AbortSignal): AsyncIterable<ChatEvent> {
    this.recordedJobs.push(job);
    for await (const event of super.run(job, signal)) {
      this.recordedEvents.push({ jobId: job.id, event });
      yield event;
    }
  }
}

export interface BridgeHandle {
  bridge: BridgeServer;
  provider: RecordingExtensionProvider;
  /** Effective config (port filled in after listen). */
  config: BridgeConfig;
  url: string;
  logs: LogBuffer;
  close(): Promise<void>;
}

export async function startBridge(overrides: Partial<BridgeConfig> = {}): Promise<BridgeHandle> {
  const config: BridgeConfig = {
    ...defaultConfig(),
    port: 0,
    provider: 'extension',
    authToken: AUTH_TOKEN,
    extensionToken: EXTENSION_TOKEN,
    workerWaitMs: 30_000,
    jobTimeoutMs: 180_000,
    logLevel: 'debug',
    ...overrides,
  };
  const logs = new LogBuffer('bridge');
  const log = createLogger(config.logLevel, config.dumpDir, (line) => logs.push(line));
  const provider = new RecordingExtensionProvider({
    extensionToken: config.extensionToken,
    allowedOrigins: config.allowedOrigins,
    newChatUrl: config.newChatUrl,
    workerWaitMs: config.workerWaitMs,
    bridgeVersion: VERSION,
    log,
  });
  const bridge = createBridgeServer(config, log, provider);
  const { port } = await bridge.listen();
  config.port = port;
  return { bridge, provider, config, url: bridge.url(), logs, close: () => bridge.close() };
}

/** Wait until the bridge sees a worker matching `pred` (default: ready and idle). */
export function waitForWorker(provider: ExtensionProvider, pred: (w: WorkerInfo) => boolean = (w) => w.ready && !w.busy, timeoutMs = 45_000): Promise<WorkerInfo> {
  return waitFor('a ready ChatGPT worker tab at the bridge', () => provider.status().workers.find(pred), timeoutMs, 200);
}

// ----------------------------------------------------------------- browser

export interface BrowserHandle {
  context: BrowserContext;
  userDataDir: string;
  logs: LogBuffer;
  close(): Promise<void>;
}

export async function launchChromium(opts: { extensionDir?: string; headless?: boolean } = {}): Promise<BrowserHandle> {
  const headless = opts.headless ?? process.env.E2E_HEADED !== '1';
  if (!headless && !process.env.DISPLAY) throw new Error('E2E_HEADED=1 needs an X display; run the tests under `xvfb-run -a`');
  const userDataDir = tempDir('profile');
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'];
  if (opts.extensionDir) args.push(`--disable-extensions-except=${opts.extensionDir}`, `--load-extension=${opts.extensionDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    // 'chromium' = full Chromium in new headless mode (extensions work); the default
    // headless shell cannot load extensions.
    channel: 'chromium',
    headless,
    args,
    viewport: { width: 1280, height: 900 },
  });
  const logs = new LogBuffer('browser');
  const watchPage = (page: Page) => {
    page.on('console', (m) => logs.push(`console.${m.type()} ${page.url()}: ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`pageerror ${page.url()}: ${e.message}`));
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) logs.push(`navigated: ${f.url()}`);
    });
  };
  context.pages().forEach(watchPage);
  context.on('page', watchPage);
  return {
    context,
    userDataDir,
    logs,
    close: async () => {
      await context.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** The extension's MV3 service worker. */
export async function extensionWorker(context: BrowserContext, timeoutMs = 20_000): Promise<Worker> {
  const isExt = (w: Worker) => w.url().startsWith('chrome-extension://');
  return context.serviceWorkers().find(isExt) ?? (await context.waitForEvent('serviceworker', { predicate: isExt, timeout: timeoutMs }));
}

export const extensionIdOf = (sw: Worker): string => new URL(sw.url()).host;

/** Point the extension at the bridge (same keys the popup writes). */
export async function configureExtension(sw: Worker, settings: { bridgeUrl: string; token: string; enabled?: boolean }): Promise<void> {
  await sw.evaluate((s) => chrome.storage.local.set({ enabled: true, ...s }), settings);
}

/**
 * Make `page`'s tab a worker. Uses a test hook on the service worker when the
 * extension exposes one (`webgpt4cc.addWorkerTab(tabId)` or similar), otherwise
 * the storage contract from docs/EXTENSION.md (chrome.storage.session
 * workerTabIds), which the service worker is expected to watch.
 */
export async function registerWorkerTab(sw: Worker, page: Page): Promise<{ tabId: number; via: string }> {
  const tabId = await waitFor(
    'the chatgpt.com tab id',
    () =>
      sw.evaluate(async (url) => {
        const tabs: Array<{ id?: number; url?: string; pendingUrl?: string }> = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url === url) ?? tabs.find((x) => (x.url ?? x.pendingUrl ?? '').startsWith('https://chatgpt.com/'));
        return t?.id ?? 0;
      }, page.url()),
    10_000,
  );
  const via = await sw.evaluate(async (id) => {
    const g = globalThis as Record<string, unknown>;
    for (const name of ['webgpt4cc', '__webgpt4cc', '__webgpt4ccTest', 'webgpt4ccTest']) {
      const api = g[name] as Record<string, unknown> | undefined;
      for (const fn of ['addWorkerTab', 'useTab', 'addWorker']) {
        if (api && typeof api[fn] === 'function') {
          await (api[fn] as (id: number) => unknown)(id);
          return `${name}.${fn}`;
        }
      }
    }
    const { workerTabIds = [] } = (await chrome.storage.session.get('workerTabIds')) as { workerTabIds?: number[] };
    if (!workerTabIds.includes(id)) await chrome.storage.session.set({ workerTabIds: [...workerTabIds, id] });
    return 'chrome.storage.session.workerTabIds';
  }, tabId);
  return { tabId, via };
}

// ------------------------------------------------------------------ claude

export interface ClaudeRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Parsed `--output-format json` result, when stdout held one. */
  json?: Record<string, unknown>;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Run `claude -p` against the bridge with a clean environment (like `env -i`):
 * only PATH, a throwaway HOME / CLAUDE_CONFIG_DIR and the bridge variables from
 * launch.ts. --dangerously-skip-permissions is refused as root, so tools are
 * pre-approved with --allowedTools + acceptEdits instead.
 */
export async function runClaude(opts: { config: BridgeConfig; prompt: string; cwd: string; timeoutMs?: number; args?: string[] }): Promise<ClaudeRun> {
  const home = tempDir('home');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ...claudeEnv(opts.config),
  };
  const args = ['-p', opts.prompt, '--allowedTools', 'Bash Write Read Edit', '--permission-mode', 'acceptEdits', '--output-format', 'json', ...(opts.args ?? [])];
  const t0 = Date.now();
  const child = spawn(CLAUDE_BIN, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, opts.timeoutMs ?? 240_000);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => child.on('close', (c, s) => res([c, s])));
  clearTimeout(timer);
  rmSync(home, { recursive: true, force: true });
  let json: Record<string, unknown> | undefined;
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      json = JSON.parse(line) as Record<string, unknown>;
      break;
    } catch {
      /* not JSON */
    }
  }
  return { code, signal, stdout, stderr, json, durationMs: Date.now() - t0, timedOut };
}

// ------------------------------------------------------------- full chain

export interface Chain {
  fake: FakeChatGPT;
  bridge: BridgeHandle;
  browser: BrowserHandle;
  sw: Worker;
  extensionId: string;
  /** The worker tab. */
  page: Page;
  tabId: number;
  /** How the tab was registered (hook name or storage key). */
  registeredVia: string;
  /** Logs of every component, for failure reports. */
  diagnostics(): string;
  close(): Promise<void>;
}

export async function startChain(opts: { fake?: Partial<FakeOptions>; bridge?: Partial<BridgeConfig>; extensionDir?: string } = {}): Promise<Chain> {
  const fakeLogs = new LogBuffer('fake');
  const fake = new FakeChatGPT({ log: (l) => fakeLogs.push(l), ...opts.fake });
  const cleanups: Array<() => Promise<void>> = [];
  const closeAll = async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    cleanups.length = 0;
  };
  let bridge: BridgeHandle | undefined;
  let browser: BrowserHandle | undefined;
  const diagnostics = () =>
    [
      `--- bridge status: ${JSON.stringify(bridge?.provider.status())}`,
      `--- bridge jobs: ${JSON.stringify(bridge?.provider.recordedJobs.map((j) => ({ id: j.id.slice(0, 8), conv: j.conversation, purpose: j.purpose, prompt: j.prompt.length })))}`,
      `--- bridge log (tail)\n${bridge?.logs.tail(80) ?? ''}`,
      `--- fake chatgpt requests: ${JSON.stringify(fake.requests.map((r) => ({ conv: r.conversationId, status: r.status, prompt: r.prompt.length, transport: r.transport })))}`,
      `--- fake chatgpt log (tail)\n${fakeLogs.tail(60)}`,
      `--- browser log (tail)\n${browser?.logs.tail(60) ?? ''}`,
    ].join('\n');
  try {
    bridge = await startBridge(opts.bridge);
    cleanups.push(() => bridge!.close());
    browser = await launchChromium({ extensionDir: opts.extensionDir ?? EXTENSION_DIR });
    cleanups.push(() => browser!.close());
    await fake.install(browser.context);
    const sw = await extensionWorker(browser.context);
    await configureExtension(sw, { bridgeUrl: bridge.url, token: bridge.config.extensionToken });
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    await page.goto('https://chatgpt.com/');
    const { tabId, via } = await registerWorkerTab(sw, page);
    await waitForWorker(bridge.provider);
    return {
      fake,
      bridge,
      browser,
      sw,
      extensionId: extensionIdOf(sw),
      page,
      tabId,
      registeredVia: via,
      diagnostics,
      close: closeAll,
    };
  } catch (e) {
    const report = diagnostics();
    await closeAll();
    throw new Error(`could not start the e2e chain: ${(e as Error).message}\n${report}`);
  }
}

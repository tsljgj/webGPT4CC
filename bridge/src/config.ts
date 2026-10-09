// Bridge configuration: defaults <- ~/.webgpt4cc/config.json <- environment <- CLI flags.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from './translate/render.ts';

export interface ModelConfig {
  /**
   * ChatGPT model slug for the main agent loop when the requested model is a
   * Claude name or "chatgpt-web". Empty = whatever model is selected in the
   * ChatGPT tab (most reliable: ChatGPT's model URL parameter is not guaranteed).
   */
  default: string;
  /** Slug for Claude Code's small/fast ("haiku") requests. Empty = the tab's model. */
  background: string;
  /** Exact overrides: requested model name -> ChatGPT slug. */
  map: Record<string, string>;
}

export interface BridgeConfig {
  host: string;
  port: number;
  /** Token Claude Code must send (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY). Empty = no auth. */
  authToken: string;
  /** Token the browser extension must present when connecting. Empty = no auth. */
  extensionToken: string;
  /** Extra allowed WebSocket origins besides chrome-extension:// and moz-extension://. */
  allowedOrigins: string[];
  provider: 'extension' | 'mock';
  models: ModelConfig;
  /** Template for a new chat; {model} is replaced by the slug (omitted when empty). */
  newChatUrl: string;
  /** Open new conversations as temporary chats (not saved in ChatGPT history). */
  temporaryChats: boolean;
  /** "continue": reuse one ChatGPT conversation per Claude Code session. "stateless": new chat per request. */
  conversationMode: 'continue' | 'stateless';
  /** Start a fresh ChatGPT conversation (replaying the transcript) once one grows beyond this many tokens. */
  maxConversationTokens: number;
  /** Max time for one ChatGPT reply. */
  jobTimeoutMs: number;
  /** How long a request waits for a browser tab to become available. */
  workerWaitMs: number;
  /** When Claude Code disconnects mid-turn, keep the ChatGPT turn running this long for a retry to adopt it. */
  orphanGraceMs: number;
  /** Small/fast-model requests (titles, summaries...): send to ChatGPT, or answer locally where possible. */
  backgroundRequests: 'chatgpt' | 'local';
  /** Claude Code's WebSearch tool: answer with ChatGPT's own web search, or refuse. */
  webSearch: 'chatgpt' | 'disabled';
  /**
   * Claude Code's WebFetch tool asks a small model to digest each fetched page.
   * "local" returns the (truncated) page itself instead, saving a ChatGPT message per fetch.
   */
  webFetchSummaries: 'local' | 'chatgpt';
  /**
   * Context window Claude Code should assume (CLAUDE_CODE_MAX_CONTEXT_TOKENS in the launcher).
   * Claude Code auto-compacts before reaching it, which keeps ChatGPT conversations small.
   */
  claudeContextWindow: number;
  /** Stream text to Claude Code as it arrives (otherwise everything is sent at the end). */
  stream: boolean;
  /** Show ChatGPT's reasoning summaries as Claude Code "thinking" while the model thinks. */
  showThinking: boolean;
  render: RenderOptions;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** If set, every prompt and reply is written to this directory (for debugging). */
  dumpDir: string;
  /** Where the session map is persisted ('' = memory only). Defaults to ~/.webgpt4cc/sessions.json when a config file is used. */
  sessionFile: string;
}

export const DEFAULT_PORT = 8765;

export function defaultConfig(): BridgeConfig {
  return {
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    authToken: '',
    extensionToken: '',
    allowedOrigins: [],
    provider: 'extension',
    models: {
      default: '',
      background: '',
      map: {},
    },
    newChatUrl: 'https://chatgpt.com/?model={model}',
    temporaryChats: false,
    conversationMode: 'continue',
    maxConversationTokens: 110_000,
    jobTimeoutMs: 20 * 60_000,
    workerWaitMs: 60_000,
    orphanGraceMs: 90_000,
    backgroundRequests: 'local',
    webSearch: 'chatgpt',
    webFetchSummaries: 'local',
    claudeContextWindow: 120_000,
    stream: true,
    showThinking: true,
    render: { ...DEFAULT_RENDER_OPTIONS },
    logLevel: 'info',
    dumpDir: '',
    sessionFile: '',
  };
}

export function configDir(): string {
  return process.env.WEBGPT4CC_HOME || join(homedir(), '.webgpt4cc');
}

export function configPath(): string {
  return process.env.WEBGPT4CC_CONFIG || join(configDir(), 'config.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function readConfigFile(path = configPath()): Partial<BridgeConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeConfig>;
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${(e as Error).message}`);
  }
}

export function writeConfigFile(patch: Partial<BridgeConfig>, path = configPath()): void {
  const current = existsSync(path) ? readConfigFile(path) : {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(deepMerge(current, patch), null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort (Windows) */
  }
}

/** Make sure the config file exists and has tokens; returns the file contents. */
export function ensureConfigFile(path = configPath()): Partial<BridgeConfig> {
  const file = readConfigFile(path);
  const patch: Partial<BridgeConfig> = {};
  if (typeof file.authToken !== 'string') patch.authToken = newToken();
  if (typeof file.extensionToken !== 'string') patch.extensionToken = newToken();
  if (Object.keys(patch).length) writeConfigFile(patch, path);
  return readConfigFile(path);
}

function envOverrides(env: NodeJS.ProcessEnv): Partial<BridgeConfig> {
  const o: Partial<BridgeConfig> = {};
  if (env.WEBGPT4CC_HOST) o.host = env.WEBGPT4CC_HOST;
  if (env.WEBGPT4CC_PORT) o.port = Number(env.WEBGPT4CC_PORT);
  if (env.WEBGPT4CC_PROVIDER === 'mock' || env.WEBGPT4CC_PROVIDER === 'extension') o.provider = env.WEBGPT4CC_PROVIDER;
  if (env.WEBGPT4CC_AUTH_TOKEN !== undefined) o.authToken = env.WEBGPT4CC_AUTH_TOKEN;
  if (env.WEBGPT4CC_EXTENSION_TOKEN !== undefined) o.extensionToken = env.WEBGPT4CC_EXTENSION_TOKEN;
  if (env.WEBGPT4CC_LOG_LEVEL) o.logLevel = env.WEBGPT4CC_LOG_LEVEL as BridgeConfig['logLevel'];
  if (env.WEBGPT4CC_DUMP_DIR) o.dumpDir = env.WEBGPT4CC_DUMP_DIR;
  return o;
}

export function runtimePath(): string {
  return join(configDir(), 'runtime.json');
}

/** Address of a running `webgpt4cc serve` (it may have been started with --port/--host). */
export function readRuntime(path = runtimePath()): { host: string; port: number } | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as { host?: string; port?: number; pid?: number };
    if (typeof r.port !== 'number' || typeof r.host !== 'string' || typeof r.pid !== 'number') return null;
    process.kill(r.pid, 0); // throws if that bridge is gone
    return { host: r.host, port: r.port };
  } catch {
    return null;
  }
}

export function writeRuntime(host: string, port: number, path = runtimePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ host, port, pid: process.pid }) + '\n', { mode: 0o600 });
}

export function loadConfig(
  opts: { file?: boolean; overrides?: Partial<BridgeConfig>; env?: NodeJS.ProcessEnv; runtime?: boolean } = {},
): BridgeConfig {
  let cfg = defaultConfig();
  if (opts.file !== false) {
    cfg.sessionFile = join(configDir(), 'sessions.json');
    cfg = deepMerge(cfg, ensureConfigFile());
    // Clients (gptcc, env, pair, doctor) follow a running bridge's actual address.
    const rt = opts.runtime === false ? null : readRuntime();
    if (rt) cfg = { ...cfg, host: rt.host, port: rt.port };
  }
  cfg = deepMerge(cfg, envOverrides(opts.env ?? process.env));
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: BridgeConfig): void {
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error(`Invalid port: ${cfg.port}`);
  if (!['extension', 'mock'].includes(cfg.provider)) throw new Error(`Invalid provider: ${cfg.provider}`);
  if (!['continue', 'stateless'].includes(cfg.conversationMode)) throw new Error(`Invalid conversationMode: ${cfg.conversationMode}`);
  if (!cfg.newChatUrl.startsWith('https://')) throw new Error(`newChatUrl must be an https URL: ${cfg.newChatUrl}`);
}

/** Model name Claude Code is given when the bridge picks the model (see resolveChatModel). */
export const DEFAULT_CLAUDE_MODEL_NAME = 'chatgpt-web';

/**
 * Resolve the ChatGPT model slug for a model name requested by Claude Code:
 * exact `models.map` entry > "chatgpt/<slug>" > OpenAI-looking names (gpt-*, o3, auto)
 * > haiku names -> models.background > everything else -> models.default.
 * An empty slug means "use the model selected in the ChatGPT tab".
 */
export function resolveChatModel(requested: string, models: ModelConfig): { slug: string; background: boolean } {
  const name = (requested ?? '').trim();
  if (models.map[name] !== undefined) return { slug: models.map[name]!, background: /haiku/i.test(name) };
  if (/^chatgpt[-_ ]?web$/i.test(name) || /^chatgpt$/i.test(name)) return { slug: models.default, background: false };
  if (/^chatgpt[/:]/i.test(name)) return { slug: name.replace(/^chatgpt[/:]/i, ''), background: false };
  if (/^(gpt-|o\d|auto$)/i.test(name)) return { slug: name, background: false };
  if (/haiku/i.test(name)) return { slug: models.background || models.default, background: true };
  return { slug: models.default, background: false };
}

export function buildNewChatUrl(template: string, model: string, temporary: boolean): string {
  let url = template.includes('{model}')
    ? model
      ? template.replace('{model}', encodeURIComponent(model))
      : template.replace(/[?&]model=\{model\}/, '').replace('{model}', '')
    : template;
  if (temporary && !/[?&]temporary-chat=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'temporary-chat=true';
  return url;
}

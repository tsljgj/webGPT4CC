// Environment for running the `claude` CLI against the bridge.
import { readFileSync } from 'node:fs';
import { type BridgeConfig, DEFAULT_CLAUDE_MODEL_NAME } from './config.ts';

/** Variables that would make a child `claude` talk to Anthropic (or think it is nested) instead of the bridge. */
export const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_GZIP_REQUEST_BODIES',
];

export function bridgeUrl(config: Pick<BridgeConfig, 'host' | 'port'>): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

/** Variables that route Claude Code to a cloud provider instead of ANTHROPIC_BASE_URL. */
export const PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
];

/** Env overrides that point Claude Code at the bridge. */
export function claudeEnv(config: BridgeConfig, model?: string): Record<string, string> {
  const main = model || config.models.default || DEFAULT_CLAUDE_MODEL_NAME;
  const small = config.models.background || main;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: bridgeUrl(config),
    // Always set a credential: without one, Claude Code would send the user's
    // claude.ai OAuth token to ANTHROPIC_BASE_URL.
    ANTHROPIC_AUTH_TOKEN: config.authToken || 'webgpt4cc',
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_FABLE_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: main,
    // ChatGPT replies (especially thinking models) can take many minutes, with long
    // silent stretches while the model thinks: relax Claude Code's timeouts and
    // stream watchdogs (the bridge sends keep-alive pings every 10 s).
    API_TIMEOUT_MS: '3600000',
    CLAUDE_ENABLE_STREAM_WATCHDOG: '0',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
    CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: '3600000',
    // Failed turns are retried by the bridge's own logic; identical retries are deduplicated.
    CLAUDE_CODE_MAX_RETRIES: '3',
    // No silent stream:false re-send of the same turn after a stream hiccup.
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    // "chatgpt-web" is unknown to Claude Code; tell it the window to compact against.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(config.claudeContextWindow),
    // No telemetry/bootstrap calls to Anthropic, no extra model calls that would each
    // cost a ChatGPT message (prompt suggestions, terminal titles, auto-mode server).
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
    // Smaller requests (no billing header block, safeguards or context_management).
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    // Lets the bridge recognise main/subagent/compaction/auxiliary requests.
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    // A cloud provider enabled in the user's settings would bypass ANTHROPIC_BASE_URL.
    // Empty (not "0": the CLI tests some of these for plain truthiness).
    ...Object.fromEntries(PROVIDER_SWITCHES.map((k) => [k, ''])),
    DISABLE_PROMPT_CACHING: '1',
  };
  return env;
}

/**
 * A settings layer for `--settings`. Claude Code applies the `env` block of the
 * user's ~/.claude/settings.json over the shell environment, so a user who once
 * configured another gateway there would silently bypass the bridge; the
 * --settings flag layer wins over user and project settings.
 */
export function claudeSettings(env: Record<string, string>): string {
  return JSON.stringify({ env, disableAutoMode: 'disable' });
}

const PERMISSION_FLAGS = ['--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'];

function hasFlag(args: string[], flags: string[]): boolean {
  return args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
}

/**
 * Arguments for `claude`:
 * - unless the user chose a permission mode, start in "default" (Claude Code's
 *   "auto" mode runs a safety classifier with two very large extra model calls
 *   per tool use, which cannot work through ChatGPT);
 * - add the bridge settings layer, unless the user passes their own --settings.
 */
export function claudeArgs(args: string[], env?: Record<string, string>): string[] {
  args = expandLite(args);
  // Headless runs (-p) cannot answer permission prompts: "default" would deny every edit there.
  const headless = args.some((a) => a === '-p' || a === '--print');
  let out = hasFlag(args, PERMISSION_FLAGS) ? [...args] : ['--permission-mode', headless ? 'acceptEdits' : 'default', ...args];
  if (env) {
    // Merge the bridge layer into a --settings the user passed (Claude Code takes only one).
    const i = out.findIndex((a) => a === '--settings' || a.startsWith('--settings='));
    if (i < 0) out.unshift('--settings', claudeSettings(env));
    else {
      const inline = out[i]!.startsWith('--settings=');
      const value = inline ? out[i]!.slice('--settings='.length) : (out[i + 1] ?? '');
      const merged = mergeSettings(value, env);
      out = [...out.slice(0, i), '--settings', merged, ...out.slice(i + (inline ? 1 : 2))];
    }
  }
  return out;
}

/** User settings (JSON text or a file path) + the bridge env layer, as JSON text. */
export function mergeSettings(userValue: string, env: Record<string, string>): string {
  let user: Record<string, unknown> = {};
  try {
    user = JSON.parse(userValue.trim().startsWith('{') ? userValue : readFileSync(userValue, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`could not read --settings ${userValue}`);
  }
  const userEnv = (user.env && typeof user.env === 'object' ? user.env : {}) as Record<string, string>;
  return JSON.stringify({ ...user, env: { ...userEnv, ...env }, disableAutoMode: 'disable' });
}

/**
 * Tools for `--lite`: drops the Agent tool (no subagents, each of which would open its own
 * ChatGPT conversation) and the large niche tools. The first ChatGPT message shrinks to ~20 KB.
 */
export const LITE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'NotebookEdit', 'AskUserQuestion'];

/** Translate the launcher's own `--lite` flag into `--tools`. */
export function expandLite(args: string[]): string[] {
  const i = args.indexOf('--lite');
  if (i < 0) return args;
  const rest = [...args.slice(0, i), ...args.slice(i + 1)];
  // "--tools=a,b" form: the variadic "--tools a,b" would swallow a following prompt argument.
  return hasFlag(rest, ['--tools']) ? rest : [`--tools=${LITE_TOOLS.join(',')}`, ...rest];
}

/** `--bare` mode only reads ANTHROPIC_API_KEY (sent as x-api-key, which the bridge accepts). */
export function withBareAuth(args: string[], env: Record<string, string>): Record<string, string> {
  return args.includes('--bare') ? { ...env, ANTHROPIC_API_KEY: env.ANTHROPIC_AUTH_TOKEN ?? '' } : env;
}

export function childEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of STRIPPED_ENV) delete env[k];
  return { ...env, ...overrides };
}

export function formatEnv(env: Record<string, string>, shell: 'bash' | 'powershell' | 'cmd' | 'fish'): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return Object.entries(env)
    .map(([k, v]) => {
      switch (shell) {
        case 'powershell':
          return `$env:${k} = "${v.replace(/"/g, '`"')}"`;
        case 'cmd':
          return `set ${k}=${v}`;
        case 'fish':
          return `set -gx ${k} ${q(v)}`;
        default:
          return `export ${k}=${q(v)}`;
      }
    })
    .join('\n');
}

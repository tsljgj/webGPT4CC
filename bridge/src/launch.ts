// Environment for running the `claude` CLI against the bridge.
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

/** Env overrides that point Claude Code at the bridge. */
export function claudeEnv(config: BridgeConfig, model?: string): Record<string, string> {
  const main = model || config.models.default || DEFAULT_CLAUDE_MODEL_NAME;
  const small = config.models.background || main;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: bridgeUrl(config),
    ANTHROPIC_AUTH_TOKEN: config.authToken || 'webgpt4cc',
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: main,
    // ChatGPT replies (especially thinking models) can take many minutes, with long
    // silent stretches while the model thinks: relax Claude Code's timeouts and
    // stream watchdogs (the bridge sends keep-alive pings every 10 s).
    API_TIMEOUT_MS: '3600000',
    CLAUDE_ENABLE_STREAM_WATCHDOG: '0',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
    CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: '3600000',
    // "chatgpt-web" is unknown to Claude Code; tell it the window to compact against.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(config.claudeContextWindow),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_PROMPT_CACHING: '1',
  };
  return env;
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

#!/usr/bin/env node
// webgpt4cc command line: serve | pair | doctor | env | claude
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BridgeConfig, configPath, loadConfig, readRuntime, runtimePath, writeRuntime } from './config.ts';
import { bridgeUrl, childEnv, claudeArgs, claudeEnv, formatEnv, withBareAuth } from './launch.ts';
import { createLogger } from './log.ts';
import { MockProvider } from './providers/mock.ts';
import { createBridgeServer, createProvider } from './server.ts';
import { VERSION } from './version.ts';

const HELP = `webgpt4cc ${VERSION} — run Claude Code on your ChatGPT web subscription

Usage:
  webgpt4cc serve [options]       Start the bridge (Anthropic-compatible API on localhost)
  webgpt4cc pair                  Show the bridge URL and pairing token for the browser extension
  webgpt4cc doctor                Check the config, the bridge, the extension and the claude CLI
  webgpt4cc env [--shell bash|powershell|cmd|fish] [--model SLUG]
                                  Print environment variables that point \`claude\` at the bridge
  webgpt4cc claude [claude args]  Run Claude Code against the bridge (same as \`gptcc\`)

Serve options:
  --port N                 Port (default 8765)
  --host H                 Interface (default 127.0.0.1)
  --provider P             extension (default) | mock
  --mock-script FILE       JSON array of canned replies for --provider mock
  --model SLUG             ChatGPT model for the main loop (e.g. gpt-5-thinking)
  --background-model SLUG  ChatGPT model for small helper requests
  --temporary              Use ChatGPT temporary chats (not saved to history)
  --stateless              New ChatGPT chat for every request (replays the transcript)
  --log-level L            debug | info | warn | error
  --dump-dir DIR           Write every prompt and reply to DIR

Config file: ${configPath()}
`;

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      const next = args[i + 1];
      if (v !== undefined) flags[k!] = v;
      else if (next !== undefined && !next.startsWith('--') && !['temporary', 'stateless', 'help', 'json'].includes(k!)) {
        flags[k!] = next;
        i++;
      } else flags[k!] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function overridesFrom(flags: Record<string, string | boolean>): Partial<BridgeConfig> {
  const o: Partial<BridgeConfig> & { models?: Partial<BridgeConfig['models']> } = {};
  if (typeof flags.port === 'string') o.port = Number(flags.port);
  if (typeof flags.host === 'string') o.host = flags.host;
  if (flags.provider === 'mock' || flags.provider === 'extension') o.provider = flags.provider;
  if (typeof flags['log-level'] === 'string') o.logLevel = flags['log-level'] as BridgeConfig['logLevel'];
  if (typeof flags['dump-dir'] === 'string') o.dumpDir = flags['dump-dir'];
  if (flags.temporary) o.temporaryChats = true;
  if (flags.stateless) o.conversationMode = 'stateless';
  const models: Partial<BridgeConfig['models']> = {};
  if (typeof flags.model === 'string') models.default = flags.model;
  if (typeof flags['background-model'] === 'string') models.background = flags['background-model'];
  if (Object.keys(models).length) o.models = models as BridgeConfig['models'];
  return o;
}

async function serve(flags: Record<string, string | boolean>): Promise<void> {
  const config = loadConfig({ overrides: overridesFrom(flags), runtime: false });
  const log = createLogger(config.logLevel, config.dumpDir);
  const provider =
    config.provider === 'mock' && typeof flags['mock-script'] === 'string'
      ? new MockProvider({ scriptFile: flags['mock-script'] })
      : createProvider(config, log);
  const bridge = createBridgeServer(config, log, provider);
  const { host, port } = await bridge.listen();
  const url = bridgeUrl({ host, port });
  // Lets gptcc, env, pair, doctor and the plugin find this bridge even with --port/--host.
  try {
    writeRuntime(host, port);
  } catch {
    /* best effort */
  }
  log.info(`webGPT4CC bridge ${VERSION} listening on ${url} (provider: ${provider.name})`);
  if (config.provider === 'extension') {
    // Printed directly (not through the logger) so the token never lands in a --dump-dir log file.
    process.stderr.write(`extension pairing: bridge URL ${url}  token ${config.extensionToken || '(none)'}\n`);
    log.info('waiting for the browser extension... (open chatgpt.com in Chrome with the webGPT4CC extension)');
  }
  log.info('run Claude Code with: gptcc   (or: eval "$(webgpt4cc env)" && claude --permission-mode default)');
  const stop = async () => {
    log.info('shutting down');
    try {
      if (readRuntime()?.port === port) rmSync(runtimePath(), { force: true });
    } catch {
      /* ignore */
    }
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function fetchHealth(config: BridgeConfig): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${bridgeUrl(config)}/health`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function doctor(): Promise<number> {
  let problems = 0;
  const ok = (m: string) => console.log(`  ✔ ${m}`);
  const bad = (m: string) => {
    problems++;
    console.log(`  ✘ ${m}`);
  };
  console.log(`webgpt4cc ${VERSION} doctor`);
  let config: BridgeConfig;
  try {
    config = loadConfig();
    ok(`config ${configPath()}`);
  } catch (e) {
    bad(`config: ${(e as Error).message}`);
    return 1;
  }
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj! > 22 || (maj === 22 && min! >= 18)) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} (need >= 22.18 to run TypeScript sources directly)`);
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (claude.status === 0) ok(`claude CLI ${claude.stdout.trim()}`);
  else bad('claude CLI not found on PATH (npm i -g @anthropic-ai/claude-code)');
  const health = await fetchHealth(config);
  if (!health) {
    bad(`bridge not reachable at ${bridgeUrl(config)} — start it with \`webgpt4cc serve\``);
  } else {
    ok(`bridge ${String(health.version)} at ${bridgeUrl(config)} (provider ${String(health.provider)})`);
    const workers = (health.workers as Array<{ id: string; ready: boolean }>) ?? [];
    if (health.provider === 'extension') {
      if (!health.connected) bad('browser extension not connected — install it from extension/ and pair it (`webgpt4cc pair`)');
      else if (!workers.length) bad('extension connected but no ChatGPT worker tab — click "Open worker tab" in the extension popup');
      else ok(`${workers.length} worker tab(s): ${workers.map((w) => `${w.id}${w.ready ? '' : ' (not ready)'}`).join(', ')}`);
    }
  }
  console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
  return problems ? 1 : 0;
}

/**
 * How to start `claude`. On Windows an npm-installed `claude` is a .cmd shim that
 * only runs through cmd.exe, so prefer a real claude.exe on PATH (native installer).
 */
export function resolveClaudeCommand(
  bin = 'claude',
  platform = process.platform,
  env = process.env,
  exists: (p: string) => boolean = existsSync,
): { command: string; shell: boolean } {
  if (platform !== 'win32' || /\.exe$/i.test(bin)) return { command: bin, shell: false };
  if (/[\\/]/.test(bin)) return { command: bin, shell: /\.(cmd|bat)$/i.test(bin) };
  // Search PATH ourselves: cmd.exe would also look in the current directory first.
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const ext of ['.exe', '.cmd', '.bat'])
    for (const dir of dirs) if (exists(join(dir, `${bin}${ext}`))) return { command: join(dir, `${bin}${ext}`), shell: ext !== '.exe' };
  return { command: bin, shell: true };
}

/** Quote one argument for cmd.exe. */
function cmdQuote(a: string): string {
  return /^[A-Za-z0-9_.:/\\@=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

function runClaude(args: string[], flags: Record<string, string | boolean>): void {
  const config = loadConfig();
  const bridgeEnv = withBareAuth(args, claudeEnv(config, typeof flags.model === 'string' ? flags.model : undefined));
  const env = childEnv(process.env, bridgeEnv);
  const { command, shell } = resolveClaudeCommand(process.env.WEBGPT4CC_CLAUDE_BIN || 'claude');
  let finalArgs = claudeArgs(args, bridgeEnv);
  // The settings layer carries the bridge token: pass it as a private temp file rather than on the
  // command line (visible to other local users in `ps`, and mangled by cmd.exe on Windows).
  let tmp = '';
  const i = finalArgs.indexOf('--settings');
  if (i >= 0 && finalArgs[i + 1]?.startsWith('{')) {
    tmp = mkdtempSync(join(tmpdir(), 'webgpt4cc-'));
    writeFileSync(join(tmp, 'settings.json'), finalArgs[i + 1]!, { mode: 0o600 });
    finalArgs = [...finalArgs.slice(0, i + 1), join(tmp, 'settings.json'), ...finalArgs.slice(i + 2)];
  }
  if (shell) finalArgs = finalArgs.map(cmdQuote);
  const cleanup = () => tmp && rmSync(tmp, { recursive: true, force: true });
  const child = spawn(shell ? cmdQuote(command) : command, finalArgs, { stdio: 'inherit', env, shell });
  // Forward termination to claude (it would otherwise keep running and spending ChatGPT messages).
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
  // Ctrl+C reaches claude directly (same process group); don't let it kill the launcher first.
  process.on('SIGINT', () => {});
  child.on('exit', (code, signal) => {
    cleanup();
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on('error', (e) => {
    cleanup();
    console.error(`could not start claude: ${e.message}. Is Claude Code installed (npm i -g @anthropic-ai/claude-code)?`);
    process.exit(127);
  });
}

export async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', ...args] = argv;
  if (cmd === 'claude' || cmd === 'run') {
    // Everything after the command goes to claude, except a leading --model for the bridge.
    const flags: Record<string, string | boolean> = {};
    if (args[0] === '--gpt-model' && args[1]) {
      flags.model = args[1];
      args.splice(0, 2);
    }
    runClaude(args, flags);
    return;
  }
  const { flags } = parseFlags(args);
  switch (cmd) {
    case 'serve':
      await serve(flags);
      return;
    case 'pair': {
      const config = loadConfig();
      console.log(`Bridge URL:      ${bridgeUrl(config)}`);
      console.log(`Extension token: ${config.extensionToken || '(none — authentication disabled)'}`);
      console.log('\nPaste both into the webGPT4CC extension popup (click the extension icon in Chrome).');
      return;
    }
    case 'doctor':
      process.exit(await doctor());
      return;
    case 'env': {
      const config = loadConfig();
      const shell = (typeof flags.shell === 'string' ? flags.shell : process.platform === 'win32' ? 'powershell' : 'bash') as
        | 'bash'
        | 'powershell'
        | 'cmd'
        | 'fish';
      console.log(formatEnv(claudeEnv(config, typeof flags.model === 'string' ? flags.model : undefined), shell));
      // Plain `claude` starts in "auto" permission mode, whose safety classifier cannot run through ChatGPT.
      console.log(`${shell === 'cmd' ? 'rem' : '#'} Then run: claude --permission-mode default   (or acceptEdits; never auto)`);
      return;
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error((e as Error)?.message ?? e);
    process.exit(1);
  });
}

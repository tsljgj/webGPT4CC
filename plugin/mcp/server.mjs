#!/usr/bin/env node
// webGPT4CC MCP server (stdio, zero dependencies).
//
// Lets a normal Claude Code session hand work to a *second* Claude Code
// process that runs on the user's ChatGPT web subscription through the
// webGPT4CC bridge. The child is the regular `claude` CLI in headless SDK mode
// (`claude -p --output-format stream-json`), i.e. the same interface the Claude
// Agent SDK drives, with ANTHROPIC_BASE_URL pointing at the bridge.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'webgpt4cc', version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------
// Bridge configuration (shared with the webgpt4cc CLI: ~/.webgpt4cc/config.json)

export function loadBridgeSettings(env = process.env) {
  const dir = env.WEBGPT4CC_HOME || join(homedir(), '.webgpt4cc');
  const path = env.WEBGPT4CC_CONFIG || join(dir, 'config.json');
  let file = {};
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* no config yet: defaults below */
  }
  // A running `webgpt4cc serve` records its actual address (it may use --port/--host).
  let runtime = null;
  try {
    const r = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
    process.kill(r.pid, 0);
    runtime = r;
  } catch {
    /* no running bridge recorded */
  }
  const rawHost = env.WEBGPT4CC_HOST || runtime?.host || file.host;
  const host = !rawHost || rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  const port = Number(env.WEBGPT4CC_PORT) || runtime?.port || file.port || 8765;
  return {
    configPath: path,
    url: (env.WEBGPT4CC_BRIDGE_URL || `http://${host.includes(':') ? `[${host}]` : host}:${port}`).replace(/\/+$/, ''),
    token: env.WEBGPT4CC_AUTH_TOKEN ?? file.authToken ?? '',
    model: env.WEBGPT4CC_MODEL || file.models?.default || 'chatgpt-web',
    smallModel: file.models?.background || env.WEBGPT4CC_MODEL || file.models?.default || 'chatgpt-web',
    claudeBin: env.WEBGPT4CC_CLAUDE_BIN || 'claude',
    contextWindow: String(file.claudeContextWindow ?? 120000),
  };
}

/** Variables that would make the child talk to Anthropic, or believe it is nested in another session. */
const STRIPPED_ENV = [
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
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SDK_URL',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_GZIP_REQUEST_BODIES',
];

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
];

/** Env that points a child `claude` at the bridge (kept in sync with bridge/src/launch.ts). */
export function bridgeEnv(settings, model) {
  return {
    ANTHROPIC_BASE_URL: settings.url,
    // Always set a credential: without one, Claude Code would send the user's
    // claude.ai OAuth token to ANTHROPIC_BASE_URL.
    ANTHROPIC_AUTH_TOKEN: settings.token || 'webgpt4cc',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.smallModel,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    API_TIMEOUT_MS: '3600000',
    CLAUDE_ENABLE_STREAM_WATCHDOG: '0',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
    CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: '3600000',
    CLAUDE_CODE_MAX_RETRIES: '3',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: settings.contextWindow ?? '120000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    // A cloud provider enabled in the user's settings would bypass ANTHROPIC_BASE_URL
    // (empty, not "0": the CLI tests some of these for plain truthiness).
    ...Object.fromEntries(PROVIDER_SWITCHES.map((k) => [k, ''])),
    DISABLE_PROMPT_CACHING: '1',
    // Marks the child as a delegate so this plugin, loaded again inside it, refuses to recurse.
    WEBGPT4CC_WORKER: '1',
  };
}

export function childEnv(settings, model, base = process.env) {
  const env = { ...base };
  for (const k of STRIPPED_ENV) delete env[k];
  return { ...env, ...bridgeEnv(settings, model) };
}

/** Tools for lite delegates (no Agent tool, so no subagents opening more ChatGPT conversations). */
export const LITE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'NotebookEdit'];

/** Why this session must not delegate, if it must not. */
export function recursionProblem(env, settings) {
  if (env.WEBGPT4CC_WORKER === '1') return 'This session is itself a webGPT4CC delegate; it cannot delegate further. Do the work directly.';
  const base = (env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
  if (base && base === settings.url) return 'This Claude Code session already runs on ChatGPT through the webGPT4CC bridge; do the work directly instead of delegating.';
  return '';
}

// ---------------------------------------------------------------------------
// Tools

// Edits are NOT listed: --permission-mode acceptEdits already allows Edit/Write inside the working
// directory, while an explicit "Write"/"Edit" rule would allow writing anywhere on disk.
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite'];

export const TOOLS = [
  {
    name: 'delegate',
    description:
      'Run a task with a separate Claude Code agent that is powered by the user\'s ChatGPT web subscription (via the local webGPT4CC bridge) instead of Claude. ' +
      'Use it to offload self-contained work (bulk edits, writing tests, refactors, investigations) and save Claude usage. ' +
      'The delegate starts with NO knowledge of this conversation: write a complete, self-contained brief (goal, relevant files, constraints, how to verify). ' +
      'It works in `cwd` (default: the current project; must be inside it), may edit files inside that directory, and can additionally use `allowed_tools` (default: read/search tools; no Bash). ' +
      'Each of its steps costs one ChatGPT message. Returns the delegate\'s final report plus a summary of the tools it used and files it changed; ' +
      'pass `resume_session_id` to continue the same delegate session with a follow-up instruction.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained instructions for the delegate.' },
        cwd: { type: 'string', description: 'Working directory (absolute, or relative to the current project). Default: current project.' },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: `Extra Claude Code tool rules the delegate may use without asking, e.g. ["Bash(npm test:*)", "Bash(git diff:*)"]. Default: ${DEFAULT_ALLOWED_TOOLS.join(', ')}. File edits inside cwd are always allowed; do not add bare "Write"/"Edit" (that would allow writing anywhere).`,
        },
        permission_mode: {
          type: 'string',
          enum: ['default', 'acceptEdits', 'plan'],
          description: 'Claude Code permission mode for the delegate (default: acceptEdits). Tools outside allowed_tools are denied, since nobody can approve them.',
        },
        model: { type: 'string', description: 'ChatGPT model slug for the bridge (default: the model selected in the ChatGPT tab).' },
        max_turns: { type: 'integer', minimum: 1, description: 'Maximum agent turns (each turn is one ChatGPT message). Default 40.' },
        timeout_minutes: { type: 'number', minimum: 1, description: 'Kill the delegate after this many minutes. Default 60.' },
        resume_session_id: { type: 'string', description: 'Continue a previous delegate session (from an earlier result).' },
        append_system_prompt: { type: 'string', description: 'Extra system instructions for the delegate.' },
        lite: {
          type: 'boolean',
          description:
            'Give the delegate only the core tools (Bash, Read, Edit, Write, WebFetch, WebSearch, NotebookEdit; no subagents). Its first ChatGPT message is about 4x smaller, which suits most focused tasks and ChatGPT plans with small context windows.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'ask',
    description:
      'Ask the ChatGPT web model a single question through the webGPT4CC bridge (no tools, no file access) — e.g. for a second opinion on a design or a bug. ' +
      'Include all needed context in `question`; costs one ChatGPT message.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, with all the context it needs.' },
        model: { type: 'string', description: 'ChatGPT model slug (default: the tab\'s model).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'status',
    description: 'Check whether the webGPT4CC bridge is running and a ChatGPT browser tab is connected.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function fetchJson(url, init = {}, timeoutMs = 5000) {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, body };
}

export async function bridgeStatus(settings) {
  try {
    const { json } = await fetchJson(`${settings.url}/health`);
    if (!json?.ok) return { ok: false, text: `The webGPT4CC bridge at ${settings.url} answered unexpectedly.` };
    const workers = json.workers ?? [];
    const ready = workers.filter((w) => w.ready).length;
    if (json.provider === 'extension' && !json.connected)
      return { ok: false, text: `Bridge ${json.version} is running at ${settings.url}, but the browser extension is not connected. Open Chrome with the webGPT4CC extension and pair it (\`webgpt4cc pair\`).` };
    if (json.provider === 'extension' && ready === 0)
      return { ok: false, text: `Bridge ${json.version} is running and the extension is connected, but no ChatGPT worker tab is ready. Click "Open worker tab" in the extension popup and make sure you are logged in to chatgpt.com.` };
    return {
      ok: true,
      text: `Bridge ${json.version} at ${settings.url}: provider ${json.provider}, ${ready}/${workers.length} worker tab(s) ready, ${json.queued ?? 0} queued. Stats: ${JSON.stringify(json.stats ?? {})}`,
    };
  } catch (e) {
    return { ok: false, text: `The webGPT4CC bridge is not reachable at ${settings.url} (${e.message}). Start it with \`webgpt4cc serve\` (or \`npx webgpt4cc serve\`).` };
  }
}

async function askTool(args, settings, signal) {
  const question = String(args.question ?? '').trim();
  if (!question) return textResult('`question` is required.', true);
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (settings.token) headers.authorization = `Bearer ${settings.token}`;
  try {
    const res = await postJson(
      `${settings.url}/v1/messages`,
      { model: args.model || settings.model, max_tokens: 8192, messages: [{ role: 'user', content: question }] },
      headers,
      signal,
    );
    const json = res.json ?? {};
    if (res.status !== 200) return textResult(`Bridge error ${res.status}: ${json?.error?.message ?? 'unknown error'}`, true);
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return textResult(text || '(empty reply)');
  } catch (e) {
    return textResult(`Could not reach the webGPT4CC bridge at ${settings.url}: ${e.message}`, true);
  }
}

/**
 * POST JSON with node:http: unlike fetch, it has no headers/body timeout, and a ChatGPT
 * reply can take many minutes (the bridge answers once the reply is complete).
 */
function postJson(url, body, headers, signal) {
  return new Promise((resolvePost, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(payload) }, signal }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolvePost({ status: res.statusCode ?? 0, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// Arguments that reach the command line are restricted to safe characters, so
// nothing a model writes can become shell syntax when Windows needs cmd.exe to run
// claude.cmd. Free text (the task, extra system prompt, settings JSON) goes
// through stdin or files instead.
const TOOL_RULE_RE = /^[A-Za-z0-9_.:*()\/ @,=+-]{1,200}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:\/@+-]{1,200}$/;

export function validateDelegateArgs(args) {
  const problems = [];
  if (args.allowed_tools !== undefined) {
    if (!Array.isArray(args.allowed_tools)) problems.push('allowed_tools must be an array of strings');
    else for (const r of args.allowed_tools) if (typeof r !== 'string' || !TOOL_RULE_RE.test(r)) problems.push(`invalid tool rule: ${JSON.stringify(r)}`);
  }
  if (args.model !== undefined && (typeof args.model !== 'string' || !TOKEN_RE.test(args.model))) problems.push('invalid model');
  if (args.resume_session_id !== undefined && (typeof args.resume_session_id !== 'string' || !TOKEN_RE.test(args.resume_session_id)))
    problems.push('invalid resume_session_id');
  return problems;
}

/**
 * Build the `claude` argument list for a delegate run (the task itself goes to stdin).
 * `files.settings` / `files.appendPrompt` are paths of files holding the settings
 * JSON and the extra system prompt.
 */
export function delegateArgs(args, model, files = {}) {
  const out = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model];
  // The --settings layer beats an `env` block in the user's ~/.claude/settings.json,
  // which would otherwise silently route the delegate somewhere else.
  if (files.settings) out.push('--settings', files.settings);
  if (args.lite) out.push('--tools', LITE_TOOLS.join(','));
  const allowed = Array.isArray(args.allowed_tools) && args.allowed_tools.length ? args.allowed_tools : DEFAULT_ALLOWED_TOOLS;
  out.push('--allowedTools', allowed.map(String).join(','));
  out.push('--permission-mode', ['default', 'acceptEdits', 'plan'].includes(args.permission_mode) ? args.permission_mode : 'acceptEdits');
  out.push('--max-turns', String(Number.isInteger(args.max_turns) && args.max_turns > 0 ? args.max_turns : 40));
  if (args.resume_session_id) out.push('--resume', String(args.resume_session_id));
  if (files.appendPrompt) out.push('--append-system-prompt-file', files.appendPrompt);
  return out;
}

/**
 * How to start `claude`. On Windows an npm-installed `claude` is a .cmd shim that
 * only runs through cmd.exe, so prefer a real claude.exe on PATH (native installer).
 */
export function resolveClaudeCommand(bin, platform = process.platform, env = process.env, exists = existsSync) {
  if (platform !== 'win32' || /\.exe$/i.test(bin)) return { command: bin, shell: false };
  if (/[\\/]/.test(bin)) return { command: bin, shell: /\.(cmd|bat)$/i.test(bin) };
  // Search PATH ourselves: cmd.exe would also look in the current directory first.
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const ext of ['.exe', '.cmd', '.bat'])
    for (const dir of dirs) if (exists(join(dir, `${bin}${ext}`))) return { command: join(dir, `${bin}${ext}`), shell: ext !== '.exe' };
  return { command: bin, shell: true };
}

/** Quote one argument for cmd.exe (only used for validated, metacharacter-free arguments). */
function cmdQuote(a) {
  return /^[A-Za-z0-9_.:\/\\@=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

/** Summarise a stream-json transcript from `claude -p --output-format stream-json --verbose`. */
export function summarizeStream(lines) {
  const toolCounts = new Map();
  const files = new Set();
  let result = null;
  let sessionId = '';
  let lastText = '';
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type === 'tool_use') {
          toolCounts.set(b.name, (toolCounts.get(b.name) ?? 0) + 1);
          const p = b.input?.file_path ?? b.input?.notebook_path;
          if (p && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(b.name)) files.add(String(p));
        } else if (b.type === 'text' && b.text?.trim()) lastText = b.text.trim();
      }
    }
    if (ev.type === 'result') result = ev;
  }
  return { toolCounts, files, result, sessionId, lastText };
}

function delegateReport(summary, stderr, elapsedMs, killedReason) {
  const { toolCounts, files, result, sessionId, lastText } = summary;
  const status = killedReason ? `stopped (${killedReason})` : result ? (result.is_error ? `error (${result.subtype})` : 'success') : 'no result';
  const head = [
    `[ChatGPT-web delegate: ${status}, ${result?.num_turns ?? '?'} turns, ${fmtDuration(result?.duration_ms ?? elapsedMs)}${sessionId ? `, session_id ${sessionId}` : ''}]`,
  ];
  if (toolCounts.size) head.push(`Tools used: ${[...toolCounts].map(([n, c]) => `${n}×${c}`).join(', ')}`);
  if (files.size) head.push(`Files written/edited: ${[...files].join(', ')}`);
  if (result?.permission_denials?.length)
    head.push(`Denied tool uses (not in allowed_tools): ${result.permission_denials.map((d) => d.tool_name).join(', ')}`);
  const body = (typeof result?.result === 'string' && result.result.trim()) || lastText || '(the delegate produced no final message)';
  let text = `${head.join('\n')}\n\n${body}`;
  if ((!result || result.is_error || killedReason) && stderr.trim()) text += `\n\nstderr (tail):\n${stderr.trim().slice(-2000)}`;
  return { text, isError: !result || !!result.is_error || !!killedReason };
}

async function delegateTool(args, settings, ctx) {
  const task = String(args.task ?? '').trim();
  if (!task) return textResult('`task` is required.', true);
  const problems = validateDelegateArgs(args);
  if (problems.length) return textResult(`Invalid arguments: ${problems.join('; ')}`, true);
  const recursion = recursionProblem(process.env, settings);
  if (recursion) return textResult(recursion, true);
  const health = await bridgeStatus(settings);
  if (!health.ok) return textResult(health.text, true);
  // Claude Code passes the project root through the plugin config (WEBGPT4CC_PROJECT_DIR).
  const projectDir = realOrSelf(
    process.env.WEBGPT4CC_PROJECT_DIR && !process.env.WEBGPT4CC_PROJECT_DIR.includes('${') ? process.env.WEBGPT4CC_PROJECT_DIR : process.cwd(),
  );
  const cwd = args.cwd ? realOrSelf(resolve(projectDir, String(args.cwd))) : projectDir;
  // `claude -p` skips the workspace-trust dialog, so never start it in a directory outside the project
  // (its hooks and settings would run unreviewed).
  const rel = relative(projectDir, cwd);
  if (rel.startsWith('..') || isAbsolute(rel)) return textResult(`cwd must be inside the current project (${projectDir}).`, true);
  if (!existsSync(cwd)) return textResult(`cwd does not exist: ${cwd}`, true);
  const model = args.model || settings.model;
  const timeoutMs = Math.max(1, Number(args.timeout_minutes) || 60) * 60_000;
  const started = Date.now();
  // Settings (they contain the bridge token) and the extra prompt go through private temp files.
  const tmp = mkdtempSync(join(tmpdir(), 'webgpt4cc-'));
  const files = { settings: join(tmp, 'settings.json') };
  writeFileSync(files.settings, JSON.stringify({ env: bridgeEnv(settings, model), disableAutoMode: 'disable' }), { mode: 0o600 });
  if (args.append_system_prompt) {
    files.appendPrompt = join(tmp, 'append-system-prompt.md');
    writeFileSync(files.appendPrompt, String(args.append_system_prompt), { mode: 0o600 });
  }
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  return await new Promise((resolvePromise) => {
    const env = childEnv(settings, model, process.env);
    const { command, shell } = resolveClaudeCommand(settings.claudeBin);
    const argv = delegateArgs(args, model, files);
    const child = spawn(shell ? cmdQuote(command) : command, shell ? argv.map(cmdQuote) : argv, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
      windowsHide: true,
    });
    const lines = [];
    let stderr = '';
    let killedReason = '';
    let turns = 0;
    const kill = (reason) => {
      if (child.exitCode !== null || killedReason) return;
      killedReason = reason;
      if (process.platform === 'win32') {
        // With cmd.exe in between, killing the child would leave claude running: end the tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
        return;
      }
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => kill(`timeout after ${Math.round(timeoutMs / 60000)} min`), timeoutMs);
    ctx.onCancel(() => kill('cancelled'));
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      lines.push(line);
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant') {
          turns++;
          const tools = (ev.message?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name);
          ctx.progress(turns, tools.length ? `turn ${turns}: ${tools.join(', ')}` : `turn ${turns}`);
        }
      } catch {
        /* ignore non-JSON lines */
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      resolvePromise(textResult(`Could not start \`${settings.claudeBin}\`: ${e.message}. Is Claude Code installed and on PATH?`, true));
    });
    child.on('close', () => {
      clearTimeout(timer);
      cleanup();
      const { text, isError } = delegateReport(summarizeStream(lines), stderr, Date.now() - started, killedReason);
      resolvePromise(textResult(text, isError));
    });
    child.stdin.end(task);
  });
}

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC 2.0)

export function createServer({ write, settings = loadBridgeSettings() }) {
  const inflight = new Map(); // request id -> { cancel }
  const send = (msg) => write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function callTool(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const progressToken = params?._meta?.progressToken;
    const cancelHandlers = [];
    const controller = new AbortController();
    inflight.set(id, { cancel: () => (controller.abort(), cancelHandlers.forEach((f) => f())) });
    const ctx = {
      onCancel: (f) => cancelHandlers.push(f),
      progress: (progress, message) => {
        if (progressToken !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress, message } });
      },
    };
    try {
      let result;
      if (name === 'status') {
        const s = await bridgeStatus(settings);
        result = textResult(s.text, !s.ok);
      } else if (name === 'ask') result = await askTool(args, settings, controller.signal);
      else if (name === 'delegate') result = await delegateTool(args, settings, ctx);
      else return fail(id, -32602, `Unknown tool: ${name}`);
      reply(id, result);
    } catch (e) {
      reply(id, textResult(`webgpt4cc ${name} failed: ${e?.message ?? e}`, true));
    } finally {
      inflight.delete(id);
    }
  }

  return function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0') return;
    const { id, method, params } = msg;
    if (method === undefined) return; // a response to something we never send
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Tools to hand work to a Claude Code agent running on the user\'s ChatGPT web subscription (webGPT4CC bridge). Check `status` first if unsure the bridge is running.',
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
        return;
      case 'notifications/cancelled':
        inflight.get(params?.requestId)?.cancel();
        return;
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: TOOLS });
        return;
      case 'tools/call':
        void callTool(id, params);
        return;
      default:
        if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
    }
  };
}

function isMain() {
  try {
    return import.meta.url === new URL(`file://${resolve(process.argv[1] ?? '')}`).href || process.argv[1]?.endsWith('server.mjs');
  } catch {
    return false;
  }
}

if (isMain()) {
  const handle = createServer({ write: (s) => process.stdout.write(s) });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    handle(msg);
  });
  rl.on('close', () => process.exit(0));
}

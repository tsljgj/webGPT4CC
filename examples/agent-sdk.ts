// Drive a Claude Code agent that runs on ChatGPT web, from your own code, with the
// Claude Agent SDK. Requires the webGPT4CC bridge (`webgpt4cc serve`) and a
// connected ChatGPT worker tab.
//
//   npm i @anthropic-ai/claude-agent-sdk
//   node examples/agent-sdk.ts "Summarize what this repository does"
//
// The SDK runs the Claude Code CLI as a subprocess; pointing ANTHROPIC_BASE_URL
// at the bridge is all it takes. This is also what the gpt-web plugin's
// `delegate` tool does (via `claude -p --output-format stream-json`).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

function bridgeEnv(): Record<string, string> {
  const path = process.env.WEBGPT4CC_CONFIG ?? join(process.env.WEBGPT4CC_HOME ?? join(homedir(), '.webgpt4cc'), 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as { port?: number; authToken?: string; claudeContextWindow?: number };
  const model = 'chatgpt-web'; // = the model selected in the ChatGPT worker tab
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.port ?? 8765}`,
    ANTHROPIC_AUTH_TOKEN: cfg.authToken ?? '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(cfg.claudeContextWindow ?? 128000),
    // ChatGPT can think for minutes: relax timeouts and the stream watchdog.
    API_TIMEOUT_MS: '3600000',
    CLAUDE_ENABLE_STREAM_WATCHDOG: '0',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  };
}

const env: Record<string, string | undefined> = { ...process.env, ...bridgeEnv() };
// Make sure nothing routes the child to Anthropic instead of the bridge.
for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE']) delete env[k];

const prompt = process.argv[2] ?? 'List the top-level files in this directory and describe the project in two sentences.';

for await (const message of query({
  prompt,
  options: {
    cwd: process.cwd(),
    env,
    model: 'chatgpt-web',
    // Never "auto": its safety classifier would need two huge extra model calls per tool use.
    permissionMode: 'default',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(ls:*)'],
    maxTurns: 10,
  },
})) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') console.log(`assistant: ${block.text}`);
      if (block.type === 'tool_use') console.log(`tool: ${block.name} ${JSON.stringify(block.input)}`);
    }
  } else if (message.type === 'result') {
    console.log(`\n[${message.subtype}] turns=${message.num_turns}`);
    if (message.subtype === 'success') console.log(message.result);
  }
}

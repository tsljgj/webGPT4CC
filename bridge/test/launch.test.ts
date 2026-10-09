import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildNewChatUrl, defaultConfig, resolveChatModel } from '../src/config.ts';
import { childEnv, claudeArgs, claudeEnv, formatEnv } from '../src/launch.ts';

describe('launcher', () => {
  it('points claude at the bridge and strips conflicting credentials', () => {
    const cfg = { ...defaultConfig(), port: 9999, authToken: 'secret' };
    const env = childEnv({ ANTHROPIC_API_KEY: 'sk-ant-x', CLAUDECODE: '1', PATH: '/bin' }, claudeEnv(cfg));
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'secret');
    assert.equal(env.ANTHROPIC_MODEL, 'chatgpt-web');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '120000');
    assert.equal(env.PATH, '/bin');
  });

  it('defaults to the "default" permission mode unless one is given', () => {
    assert.deepEqual(claudeArgs(['-p', 'hi']), ['--permission-mode', 'default', '-p', 'hi']);
    assert.deepEqual(claudeArgs(['--permission-mode', 'plan']), ['--permission-mode', 'plan']);
    assert.deepEqual(claudeArgs(['--permission-mode=acceptEdits']), ['--permission-mode=acceptEdits']);
    assert.deepEqual(claudeArgs(['--dangerously-skip-permissions']), ['--dangerously-skip-permissions']);
  });

  it('formats env for several shells', () => {
    const env = { A: "it's" };
    assert.equal(formatEnv(env, 'bash'), `export A='it'\\''s'`);
    assert.equal(formatEnv(env, 'powershell'), '$env:A = "it\'s"');
    assert.equal(formatEnv(env, 'cmd'), "set A=it's");
  });
});

describe('model resolution', () => {
  const models = { default: '', background: 'gpt-5-5-instant', map: { 'my-alias': 'gpt-5-6-thinking' } };
  it('maps names to ChatGPT slugs', () => {
    assert.equal(resolveChatModel('chatgpt-web', models).slug, '');
    assert.equal(resolveChatModel('claude-opus-5-5', models).slug, '');
    assert.equal(resolveChatModel('claude-haiku-5-5', models).slug, 'gpt-5-5-instant');
    assert.equal(resolveChatModel('gpt-5-6-thinking', models).slug, 'gpt-5-6-thinking');
    assert.equal(resolveChatModel('chatgpt/o3', models).slug, 'o3');
    assert.equal(resolveChatModel('my-alias', models).slug, 'gpt-5-6-thinking');
  });

  it('builds new-chat URLs', () => {
    assert.equal(buildNewChatUrl('https://chatgpt.com/?model={model}', '', false), 'https://chatgpt.com/');
    assert.equal(buildNewChatUrl('https://chatgpt.com/?model={model}', 'gpt-5-5', false), 'https://chatgpt.com/?model=gpt-5-5');
    assert.equal(buildNewChatUrl('https://chatgpt.com/?model={model}', '', true), 'https://chatgpt.com/?temporary-chat=true');
    assert.equal(buildNewChatUrl('https://chatgpt.com/?model={model}', 'x', true), 'https://chatgpt.com/?model=x&temporary-chat=true');
  });
});

describe('lite mode', () => {
  it('expands --lite into a small --tools list', async () => {
    const { claudeArgs, LITE_TOOLS } = await import('../src/launch.ts');
    const a = claudeArgs(['--lite', '-p', 'x']);
    assert.deepEqual(a.slice(0, 4), ['--permission-mode', 'default', '--tools', LITE_TOOLS.join(',')]);
    assert.ok(!a.includes('--lite'));
    assert.ok(!LITE_TOOLS.includes('Agent'));
  });
});

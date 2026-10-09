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

  it('defaults to "default" (interactive) or "acceptEdits" (-p) unless a mode is given', () => {
    assert.deepEqual(claudeArgs(['hi']), ['--permission-mode', 'default', 'hi']);
    assert.deepEqual(claudeArgs(['-p', 'hi']), ['--permission-mode', 'acceptEdits', '-p', 'hi']);
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
    const a = claudeArgs(['--lite', 'do it']);
    // "--tools=" form, so the variadic option cannot swallow the prompt.
    assert.deepEqual(a, ['--permission-mode', 'default', `--tools=${LITE_TOOLS.join(',')}`, 'do it']);
    assert.ok(!LITE_TOOLS.includes('Agent'));
  });
});

describe('settings layer', () => {
  it('merges the bridge env into a --settings the user passed', async () => {
    const { claudeArgs } = await import('../src/launch.ts');
    const a = claudeArgs(['--settings', '{"model":"x","env":{"FOO":"1","ANTHROPIC_BASE_URL":"http://elsewhere"}}', 'hi'], { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765' });
    const merged = JSON.parse(a[a.indexOf('--settings') + 1]!);
    assert.equal(merged.model, 'x');
    assert.equal(merged.env.FOO, '1');
    assert.equal(merged.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8765');
    assert.equal(merged.disableAutoMode, 'disable');
    assert.equal(a.filter((x) => x.startsWith('--settings')).length, 1);
  });

  it('empties every cloud-provider switch', () => {
    const env = claudeEnv(defaultConfig());
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '');
    assert.equal(env.CLAUDE_CODE_USE_VERTEX, '');
  });
});

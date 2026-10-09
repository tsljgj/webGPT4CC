import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MessageParam, MessagesRequest, ToolDefinition } from '../src/anthropic/types.ts';
import { DEFAULT_RENDER_OPTIONS, estimateRequestTokens, renderDeltaPrompt, renderFullPrompt, systemText } from '../src/translate/render.ts';

const TOOLS: ToolDefinition[] = [
  { name: 'Bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'DesignSync', description: 'x'.repeat(5000), input_schema: { type: 'object', properties: {} } },
];

function transcript(turns: number, resultSize: number): MessageParam[] {
  const msgs: MessageParam[] = [{ role: 'user', content: 'THE ORIGINAL TASK' }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `step ${i}` } }] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `result ${i} ` + 'r'.repeat(resultSize) }] });
  }
  return msgs;
}

describe('renderFullPrompt', () => {
  it('contains the protocol, the system prompt, tools and the latest message', () => {
    const req: MessagesRequest = {
      model: 'm',
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
        { type: 'text', text: 'You are a helpful agent.' },
      ],
      tools: TOOLS,
      messages: [{ role: 'user', content: 'do it' }],
    };
    const { text } = renderFullPrompt(req);
    assert.match(text, /^# Bridge instructions/);
    assert.match(text, /# Harness system prompt\n\nYou are a helpful agent\./);
    assert.doesNotMatch(text, /billing-header/);
    assert.match(text, /### Bash/);
    assert.doesNotMatch(text, /### DesignSync/, 'excluded by default');
    assert.match(text, /# Latest message \(respond to this\)\n\ndo it$/);
  });

  it('keeps a long replay under maxPromptChars, preserving the task and the newest turns', () => {
    const req: MessagesRequest = { model: 'm', tools: TOOLS, messages: transcript(60, 5000) };
    const opts = { ...DEFAULT_RENDER_OPTIONS, maxPromptChars: 30_000 };
    const { text } = renderFullPrompt(req, opts);
    assert.ok(text.length <= 30_000, `length ${text.length}`);
    assert.match(text, /THE ORIGINAL TASK/);
    assert.match(text, /earlier message\(s\) omitted by the bridge/);
    assert.match(text, /result 59/, 'newest tool result is kept');
    assert.match(text, /step 58/);
  });

  it('shrinks an oversized latest tool result', () => {
    const req: MessagesRequest = { model: 'm', tools: TOOLS, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] }] };
    const { text } = renderFullPrompt(req, { ...DEFAULT_RENDER_OPTIONS, maxPromptChars: 50_000 });
    assert.ok(text.length <= 50_500, `length ${text.length}`);
    assert.match(text, /omitted by the bridge/);
  });

  it('reports the untruncated size for usage', () => {
    const req: MessagesRequest = { model: 'm', tools: TOOLS, messages: transcript(60, 5000) };
    assert.ok(estimateRequestTokens(req) > 60 * 5000 / 4);
  });
});

describe('renderDeltaPrompt', () => {
  it('sends only new messages, with call numbers and a reminder', () => {
    const msgs = transcript(1, 10);
    const { text } = renderDeltaPrompt({ model: 'm', tools: TOOLS, messages: msgs }, 2);
    assert.match(text, /^<tool_result name="Bash" call="1">\nresult 0 r{10}\n<\/tool_result>/);
    assert.match(text, /\[bridge reminder:/);
  });

  it('caps a huge tool result', () => {
    const msgs = transcript(1, 300_000);
    const { text } = renderDeltaPrompt({ model: 'm', tools: TOOLS, messages: msgs }, 2, { ...DEFAULT_RENDER_OPTIONS, maxPromptChars: 40_000 });
    assert.ok(text.length <= 40_000, `length ${text.length}`);
    assert.match(text, /truncated by the bridge/);
  });

  it('marks errors and renders images as placeholders', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
        ],
      },
    ];
    const { text } = renderDeltaPrompt({ model: 'm', tools: TOOLS, messages: msgs }, 2);
    assert.match(text, /<tool_result name="Bash" call="1" status="error">\nboom\n\[image omitted by the bridge: image\/png/);
  });
});

describe('systemText', () => {
  it('accepts strings and drops the billing header', () => {
    assert.equal(systemText('plain'), 'plain');
    assert.equal(systemText([{ type: 'text', text: 'x-anthropic-billing-header: a' }, { type: 'text', text: ' b ' }]), 'b');
  });
});

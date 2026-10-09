import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolDefinition } from '../src/anthropic/types.ts';
import { parseReply, resolveToolName, safeStreamPrefix } from '../src/translate/parser.ts';
import { renderToolCall } from '../src/translate/render.ts';

const TOOLS: ToolDefinition[] = [
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', default: false },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'number' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'TodoWrite',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'Grep',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, glob: { type: 'array', items: { type: 'string' } }, '-n': { type: 'boolean' } },
      required: ['pattern'],
    },
  },
  { name: 'mcp__github__search_code', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
];

const tools = (r: ReturnType<typeof parseReply>) => r.blocks.filter((b) => b.type === 'tool_use') as Array<{ name: string; input: Record<string, unknown> }>;
const texts = (r: ReturnType<typeof parseReply>) => r.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);

describe('parseReply', () => {
  it('returns plain text when there are no calls', () => {
    const r = parseReply('All done.\n\nThe tests pass.\n', TOOLS);
    assert.deepEqual(r.blocks, [{ type: 'text', text: 'All done.\n\nThe tests pass.' }]);
    assert.equal(r.toolCalls, 0);
  });

  it('parses a single call with raw string params', () => {
    const r = parseReply('<tool_call name="Read">\n<param name="file_path">/a/b.ts</param>\n</tool_call>', TOOLS);
    assert.deepEqual(tools(r), [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }]);
  });

  it('keeps prose before calls and drops hallucinated text after', () => {
    const r = parseReply('Let me look.\n<tool_call name="Read">\n<param name="file_path">/x</param>\n</tool_call>\n<tool_result>fake</tool_result>', TOOLS);
    assert.deepEqual(texts(r), ['Let me look.']);
    assert.equal(r.toolCalls, 1);
    assert.match(r.trailingText, /fake/);
  });

  it('parses multiple calls', () => {
    const r = parseReply(
      '<tool_call name="Read">\n<param name="file_path">/a</param>\n</tool_call>\n<tool_call name="Read">\n<param name="file_path">/b</param>\n</tool_call>',
      TOOLS,
    );
    assert.deepEqual(tools(r).map((t) => t.input.file_path), ['/a', '/b']);
  });

  it('coerces numbers, booleans and JSON arrays by schema', () => {
    const r = parseReply(
      [
        '<tool_call name="Read">',
        '<param name="file_path">/a</param>',
        '<param name="offset">10</param>',
        '<param name="limit"> 20 </param>',
        '</tool_call>',
        '<tool_call name="Edit">',
        '<param name="file_path">/a</param>',
        '<param name="old_string">x</param>',
        '<param name="new_string">y</param>',
        '<param name="replace_all">true</param>',
        '</tool_call>',
        '<tool_call name="TodoWrite">',
        '<param name="todos">[{"content": "a", "status": "pending"},]</param>',
        '</tool_call>',
      ].join('\n'),
      TOOLS,
    );
    const [read, edit, todo] = tools(r);
    assert.deepEqual(read!.input, { file_path: '/a', offset: 10, limit: 20 });
    assert.equal(edit!.input.replace_all, true);
    assert.deepEqual(todo!.input.todos, [{ content: 'a', status: 'pending' }]);
  });

  it('wraps a bare string into a one-element array for string-array params', () => {
    const r = parseReply('<tool_call name="Grep">\n<param name="pattern">foo</param>\n<param name="glob">*.ts</param>\n</tool_call>', TOOLS);
    assert.deepEqual(tools(r)[0]!.input.glob, ['*.ts']);
  });

  it('preserves multi-line raw content exactly (quotes, backslashes, tags)', () => {
    const content = 'const s = "a\\nb";\nif (a < b && c > d) {\n  return `<div class="x">${s}</div>`;\n}\n';
    const r = parseReply(`<tool_call name="Write">\n<param name="file_path">/f.ts</param>\n<param name="content">\n${content}</param>\n</tool_call>`, TOOLS);
    assert.equal(tools(r)[0]!.input.content, content);
  });

  it('keeps the final newline of block-formatted whole-file content', () => {
    const r = parseReply('<tool_call name="Write">\n<param name="file_path">/f</param>\n<param name="content">\nhello\n</param>\n</tool_call>', TOOLS);
    assert.equal(tools(r)[0]!.input.content, 'hello\n');
  });

  it('does not add a newline to inline content', () => {
    const r = parseReply('<tool_call name="Write">\n<param name="file_path">/f</param>\n<param name="content">hello</param>\n</tool_call>', TOOLS);
    assert.equal(tools(r)[0]!.input.content, 'hello');
  });

  it('strips exactly one newline on each side of edit strings', () => {
    const r = parseReply('<tool_call name="Edit">\n<param name="file_path">/f</param>\n<param name="old_string">\n\n  a\n\n</param>\n<param name="new_string">\n  b\n</param>\n</tool_call>', TOOLS);
    assert.equal(tools(r)[0]!.input.old_string, '\n  a\n');
    assert.equal(tools(r)[0]!.input.new_string, '  b');
  });

  it('handles a literal </param> inside a value when it is not followed by a param or the end', () => {
    const r = parseReply('<tool_call name="Write">\n<param name="file_path">/f.xml</param>\n<param name="content"><a></param><b/></param>\n</tool_call>', TOOLS);
    assert.equal(tools(r)[0]!.input.content, '<a></param><b/>');
  });

  it('supports CDATA values', () => {
    const v = 'x </param>\n</tool_call> y';
    const r = parseReply(`<tool_call name="Write">\n<param name="file_path">/f</param>\n<param name="content"><![CDATA[${v}]]></param>\n</tool_call>`, TOOLS);
    assert.equal(tools(r)[0]!.input.content, v);
  });

  it('round-trips values rendered by renderToolCall', () => {
    const inputs = [
      { file_path: '/a', content: 'line1\nline2 </param> tricky\n</tool_call>\n' },
      { file_path: '/b', content: 'single' },
      { file_path: '/c', content: '' },
    ];
    for (const input of inputs) {
      const r = parseReply(renderToolCall('Write', input), TOOLS);
      assert.deepEqual(tools(r)[0]!.input, input, JSON.stringify(input));
    }
  });

  it('unwraps calls inside code fences', () => {
    const r = parseReply('Sure.\n```xml\n<tool_call name="Read">\n<param name="file_path">/a</param>\n</tool_call>\n```\n', TOOLS);
    assert.deepEqual(texts(r), ['Sure.']);
    assert.equal(tools(r)[0]!.input.file_path, '/a');
    assert.equal(r.trailingText, '');
  });

  it('accepts an unterminated final call', () => {
    const r = parseReply('<tool_call name="Bash">\n<param name="command">ls -la</param>\n', TOOLS);
    assert.deepEqual(tools(r)[0]!.input, { command: 'ls -la' });
    assert.ok(r.warnings.some((w) => /not terminated/.test(w)));
  });

  it('accepts an unterminated param at the end of the reply', () => {
    const r = parseReply('<tool_call name="Bash">\n<param name="command">echo hi', TOOLS);
    assert.deepEqual(tools(r)[0]!.input, { command: 'echo hi' });
  });

  it('ignores <tool_call that is not at the start of a line', () => {
    const r = parseReply('You can use `<tool_call name="Read">` blocks to read files.', TOOLS);
    assert.equal(r.toolCalls, 0);
  });

  it('accepts JSON bodies (plain and Hermes style)', () => {
    const r = parseReply(
      '<tool_call name="Read">{"file_path": "/a", "limit": 5}</tool_call>\n<tool_call>\n{"name": "Bash", "arguments": {"command": "pwd"}}\n</tool_call>',
      TOOLS,
    );
    assert.deepEqual(
      tools(r).map((t) => [t.name, t.input]),
      [
        ['Read', { file_path: '/a', limit: 5 }],
        ['Bash', { command: 'pwd' }],
      ],
    );
  });

  it('accepts Hermes JSON with stringified arguments', () => {
    const r = parseReply('<tool_call>{"name": "Bash", "arguments": "{\\"command\\": \\"pwd\\"}"}</tool_call>', TOOLS);
    assert.deepEqual(tools(r)[0], { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } });
  });

  it('accepts <parameter> and Cline-style elements', () => {
    const r = parseReply(
      '<tool_call name="Read">\n<parameter name="file_path">/a</parameter>\n</tool_call>\n<tool_call name="Bash">\n<command>git status</command>\n<description>status</description>\n</tool_call>',
      TOOLS,
    );
    assert.deepEqual(tools(r).map((t) => t.input), [{ file_path: '/a' }, { command: 'git status', description: 'status' }]);
  });

  it('resolves tool names case-insensitively and by MCP suffix', () => {
    assert.equal(resolveToolName('read', TOOLS), 'Read');
    assert.equal(resolveToolName('search_code', TOOLS), 'mcp__github__search_code');
    assert.equal(resolveToolName('Unknown', TOOLS), 'Unknown');
    const r = parseReply("<tool_call name='bash'>\n<param name='command'>ls</param>\n</tool_call>", TOOLS);
    assert.equal(tools(r)[0]!.name, 'Bash');
  });

  it('keeps unknown tools and params (Claude Code reports the error to the model)', () => {
    const r = parseReply('<tool_call name="Frobnicate">\n<param name="x">1</param>\n<param name="y">abc</param>\n</tool_call>', TOOLS);
    assert.deepEqual(tools(r)[0], { type: 'tool_use', name: 'Frobnicate', input: { x: 1, y: 'abc' } });
  });

  it('warns about missing required params', () => {
    const r = parseReply('<tool_call name="Edit">\n<param name="file_path">/a</param>\n</tool_call>', TOOLS);
    assert.ok(r.warnings.some((w) => /missing required/.test(w)));
  });

  it('closes a call that runs into the next <tool_call>', () => {
    const r = parseReply('<tool_call name="Read">\n<param name="file_path">/a</param>\n<tool_call name="Read">\n<param name="file_path">/b</param>\n</tool_call>', TOOLS);
    assert.deepEqual(tools(r).map((t) => t.input.file_path), ['/a', '/b']);
  });

  it('keeps text between calls', () => {
    const r = parseReply('A\n<tool_call name="Read">\n<param name="file_path">/a</param>\n</tool_call>\nThen B\n<tool_call name="Read">\n<param name="file_path">/b</param>\n</tool_call>', TOOLS);
    assert.deepEqual(r.blocks.map((b) => b.type), ['text', 'tool_use', 'text', 'tool_use']);
  });

  it('normalizes CRLF line endings', () => {
    const r = parseReply('<tool_call name="Write">\r\n<param name="file_path">/f</param>\r\n<param name="content">\r\na\r\nb\r\n</param>\r\n</tool_call>', TOOLS);
    assert.equal(tools(r)[0]!.input.content, 'a\nb\n');
  });

  it('works without a tool list', () => {
    const r = parseReply('<tool_call name="X">\n<param name="n">5</param>\n<param name="s">hi</param>\n</tool_call>');
    assert.deepEqual(tools(r)[0]!.input, { n: 5, s: 'hi' });
  });
});

describe('safeStreamPrefix', () => {
  it('only releases complete lines', () => {
    assert.equal(safeStreamPrefix('Hello wor').safe, '');
    assert.equal(safeStreamPrefix('Hello world\nNext').safe, 'Hello world\n');
  });

  it('stops at the first tool call', () => {
    const r = safeStreamPrefix('Let me check.\n<tool_call name="Read">\n<param');
    assert.equal(r.safe, 'Let me check.\n');
    assert.equal(r.sawToolCall, true);
  });

  it('holds back a fence opener until the next line arrives', () => {
    assert.equal(safeStreamPrefix('Text\n```xml\n').safe, 'Text\n');
    assert.equal(safeStreamPrefix('Text\n```xml\n<tool_call name="Read">\n').safe, 'Text\n');
    assert.equal(safeStreamPrefix('Text\n```js\nconst a = 1;\n').safe, 'Text\n```js\nconst a = 1;\n');
  });

  it('is monotonic for a growing reply', () => {
    const full = 'Intro line\n\n```ts\nx\n```\nMore\n<tool_call name="Read">\n<param name="file_path">/a</param>\n</tool_call>\n';
    let prev = '';
    for (let i = 1; i <= full.length; i++) {
      const { safe } = safeStreamPrefix(full.slice(0, i));
      assert.ok(safe.startsWith(prev) || prev.startsWith(safe), `non-monotonic at ${i}`);
      if (safe.length > prev.length) prev = safe;
    }
    assert.equal(prev, 'Intro line\n\n```ts\nx\n```\nMore\n');
  });
});

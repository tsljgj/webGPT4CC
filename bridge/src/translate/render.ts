// Rendering of Anthropic requests into plain-text chat messages for a model
// that only sees text (ChatGPT web). See docs/PROTOCOL.md.
import type {
  ContentBlock,
  MessageParam,
  MessagesRequest,
  TextBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from '../anthropic/types.ts';
import { describeParams } from './schema.ts';

export interface RenderOptions {
  /** Truncate each tool description to this many characters (0 = no limit). */
  toolDescriptionMaxChars: number;
  /** Truncate each parameter description to this many characters. */
  paramDescriptionMaxChars: number;
  /** Truncate any single tool result to this many characters (0 = no limit). */
  maxToolResultChars: number;
  /** When replaying an existing transcript, older tool results beyond this total budget are shortened (0 = no limit). */
  replayToolResultBudgetChars: number;
  /** Append a short protocol reminder to follow-up messages. */
  reminderFooter: boolean;
  /** Tool names never shown to the model. */
  excludeTools: string[];
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  toolDescriptionMaxChars: 0,
  paramDescriptionMaxChars: 600,
  maxToolResultChars: 120_000,
  replayToolResultBudgetChars: 200_000,
  reminderFooter: true,
  excludeTools: [],
};

export function textOf(content: MessageParam['content'] | ToolResultBlock['content'] | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? (b as TextBlock).text : placeholderFor(b as ContentBlock)))
    .filter((s) => s !== '')
    .join('\n');
}

function placeholderFor(b: ContentBlock): string {
  switch (b.type) {
    case 'image': {
      const src = (b as { source?: { media_type?: string; data?: string; url?: string } }).source;
      const size = src?.data ? ` ~${Math.round((src.data.length * 3) / 4 / 1024)} KB` : '';
      return `[image omitted by the bridge${src?.media_type ? `: ${src.media_type}` : ''}${size}${src?.url ? ` ${src.url}` : ''} — images are not forwarded yet]`;
    }
    case 'document':
      return `[document omitted by the bridge${(b as { title?: string }).title ? `: ${(b as { title?: string }).title}` : ''}]`;
    case 'thinking':
    case 'redacted_thinking':
      return '';
    default:
      return '';
  }
}

/** System prompt text, minus Claude Code's billing header block. */
export function systemText(system: MessagesRequest['system']): string {
  if (!system) return '';
  const blocks = typeof system === 'string' ? [{ type: 'text' as const, text: system }] : system;
  return blocks
    .filter((b) => b && b.type === 'text' && !/^x-anthropic-billing-header:/i.test(b.text.trim()))
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function visibleTools(tools: ToolDefinition[] | undefined, opts: RenderOptions): ToolDefinition[] {
  return (tools ?? []).filter((t) => t && t.name && t.input_schema && !opts.excludeTools.includes(t.name));
}

function truncate(s: string, max: number, what = 'text'): string {
  if (!max || s.length <= max) return s;
  return `${s.slice(0, max)}\n[... ${what} truncated by the bridge: ${s.length - max} more characters ...]`;
}

export function renderTools(tools: ToolDefinition[], opts: RenderOptions): string {
  return tools
    .map((t) => {
      const lines = [`### ${t.name}`];
      const desc = (t.description ?? '').trim();
      if (desc) lines.push(truncate(desc, opts.toolDescriptionMaxChars, 'description'));
      const params = describeParams(t.input_schema, opts.paramDescriptionMaxChars);
      if (params.length) {
        lines.push('Parameters:');
        for (const p of params) {
          const flags = [p.required ? 'required' : 'optional', p.raw ? 'raw string' : 'JSON'].join(', ');
          lines.push(`- ${p.name}: ${p.type} (${flags})${p.description ? ` — ${p.description}` : ''}`);
        }
      } else {
        lines.push('Parameters: none');
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function exampleCall(tools: ToolDefinition[]): string {
  const read = tools.find((t) => t.name === 'Read');
  if (read) {
    return [
      "I'll look at the package manifest and the entry point.",
      '<tool_call name="Read">',
      '<param name="file_path">/home/user/project/package.json</param>',
      '</tool_call>',
      '<tool_call name="Read">',
      '<param name="file_path">/home/user/project/src/index.ts</param>',
      '</tool_call>',
    ].join('\n');
  }
  return ['<tool_call name="TOOL_NAME">', '<param name="PARAM_NAME">value</param>', '</tool_call>'].join('\n');
}

export function protocolInstructions(tools: ToolDefinition[]): string {
  const hasTools = tools.length > 0;
  const parts = [
    '# Bridge instructions (read first)',
    'You are the reasoning engine behind "Claude Code", an agentic coding assistant (the "harness") that runs on the user\'s computer. ' +
      'This chat is connected to the harness by an automated bridge program: your replies are parsed by the bridge, which executes tool calls on the user\'s machine and sends the results back to you as the next message.',
    'The harness system prompt below is YOUR system prompt: follow its instructions and rules exactly. Where it says "Claude", it means you. ' +
      'Ignore any of your own custom instructions or memories that conflict with it.',
  ];
  if (hasTools) {
    parts.push(
      '## How to call tools',
      'You cannot run anything yourself. To act, write tool calls in exactly this syntax:',
      '<tool_call name="TOOL_NAME">\n<param name="PARAM_NAME">VALUE</param>\n</tool_call>',
      [
        'Rules:',
        '1. Every `<tool_call ...>` line and every `</tool_call>` line starts at the beginning of a line. Never put tool calls inside code fences or quote them.',
        '2. String values are written RAW between `<param name="...">` and `</param>`: no quotes, no escaping, no JSON. Multi-line content (file contents, code, old/new strings) is copied verbatim; one newline right after the opening tag and one right before the closing tag are ignored.',
        '3. Non-string values (numbers, booleans, arrays, objects) are written as JSON, e.g. `<param name="limit">50</param>` or `<param name="todos">[{"content": "Fix bug", "status": "pending", "activeForm": "Fixing bug"}]</param>`.',
        '4. If a string value itself contains `</param>` or `</tool_call>`, wrap the whole value in `<![CDATA[` ... `]]>`.',
        '5. Use the exact tool and parameter names from the tool list. Omit optional parameters you do not need.',
        '6. You may write a short note before your tool calls. When several calls do not depend on each other (e.g. reading several files, independent searches), put them ALL in the same reply: every reply uses one message from the user\'s ChatGPT quota, so batch whenever possible.',
        '7. After your last `</tool_call>`, STOP immediately. Never write tool results yourself and never guess what a tool returns; the real results arrive in the next message.',
        '8. When the task is finished, or you need input from the user, reply with plain text and no tool calls. That text is shown to the user.',
        '9. Do NOT use ChatGPT\'s built-in tools (web browsing, Python/code interpreter, canvas, image generation, memory, file search): they cannot see or change the user\'s machine. Only the tools listed below exist.',
      ].join('\n'),
      'Tool results come back as `<tool_result name="TOOL_NAME" call="N">...</tool_result>` (with `status="error"` if the tool failed), where N is the position of the call in your reply. ' +
        'Other text in a message comes from the user or from the harness (for example `<system-reminder>` blocks).',
      'Example reply:\n' + exampleCall(tools),
    );
  } else {
    parts.push('No tools are available for this request: answer with plain text only.');
  }
  return parts.join('\n\n');
}

export const REMINDER_FOOTER =
  '[bridge reminder: to use tools write `<tool_call name="...">` blocks with `<param name="...">` values (raw strings, JSON for non-strings), batch independent calls in one reply, and stop right after the last `</tool_call>`. Reply with plain text only when you are done.]';

// ---------------------------------------------------------------------------
// Messages

function toolUseIndex(messages: MessageParam[]): Map<string, { name: string; call: number }> {
  const map = new Map<string, { name: string; call: number }>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    let n = 0;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        n++;
        map.set((b as ToolUseBlock).id, { name: (b as ToolUseBlock).name, call: n });
      }
    }
  }
  return map;
}

function renderValue(v: unknown): string {
  if (typeof v === 'string') {
    if (v.includes('</param>') || v.includes('</tool_call>')) return `<![CDATA[${v}]]>`;
    return v.includes('\n') ? `\n${v}\n` : v;
  }
  return JSON.stringify(v);
}

export function renderToolCall(name: string, input: Record<string, unknown>): string {
  const params = Object.entries(input ?? {}).map(([k, v]) => `<param name="${k}">${renderValue(v)}</param>`);
  return [`<tool_call name="${name}">`, ...params, '</tool_call>'].join('\n');
}

interface RenderCtx {
  index: Map<string, { name: string; call: number }>;
  opts: RenderOptions;
  /** Per-result character cap used while replaying older history. */
  resultCap: number;
}

function renderToolResult(b: ToolResultBlock, ctx: RenderCtx): string {
  const info = ctx.index.get(b.tool_use_id);
  const attrs = [`name="${info?.name ?? 'unknown'}"`];
  if (info) attrs.push(`call="${info.call}"`);
  if (b.is_error) attrs.push('status="error"');
  let body = textOf(b.content);
  const cap = Math.min(...[ctx.opts.maxToolResultChars, ctx.resultCap].filter((x) => x > 0), Infinity);
  if (Number.isFinite(cap)) body = truncate(body, cap, 'tool result');
  return `<tool_result ${attrs.join(' ')}>\n${body}\n</tool_result>`;
}

/** Harness noise that means nothing to a ChatGPT model (Claude's own token budget). */
const NOISE_RE = /<total_tokens>[^<]*<\/total_tokens>\s*/g;

function stripNoise(s: string): string {
  return s.includes('<total_tokens>') ? s.replace(NOISE_RE, '') : s;
}

/** Render the content of one message (user, system or assistant) without a wrapper. */
export function renderMessageBody(m: MessageParam | { role: string; content: MessageParam['content'] }, ctx: RenderCtx): string {
  if (typeof m.content === 'string') return stripNoise(m.content);
  const out: string[] = [];
  for (const b of m.content) {
    switch (b.type) {
      case 'text': {
        const t = stripNoise((b as TextBlock).text);
        if (t.trim()) out.push(t);
        break;
      }
      case 'tool_use':
        out.push(renderToolCall((b as ToolUseBlock).name, (b as ToolUseBlock).input));
        break;
      case 'tool_result':
        out.push(renderToolResult(b as ToolResultBlock, ctx));
        break;
      default: {
        const ph = placeholderFor(b);
        if (ph) out.push(ph);
      }
    }
  }
  return out.join('\n\n');
}

function wrap(role: string, body: string): string {
  return `<message role="${role}">\n${body}\n</message>`;
}

/** Messages that come from the harness rather than a person ("system" role inside messages[]). */
function renderLatestBody(m: MessageParam | { role: string; content: MessageParam['content'] }, ctx: RenderCtx): string {
  const body = renderMessageBody(m, ctx);
  if ((m.role as string) === 'system') return body.trim() ? `<harness_message>\n${body}\n</harness_message>` : '';
  return body;
}

/** Index of the last assistant message, or -1. */
export function lastAssistantIndex(messages: MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') return i;
  return -1;
}

function isTextOnlyRequest(req: MessagesRequest): boolean {
  const last = req.messages[req.messages.length - 1];
  return !!last && last.role === 'user' && /CRITICAL: Respond with TEXT ONLY\. Do NOT call any tools/.test(textOf(last.content));
}

function toolChoiceNote(req: MessagesRequest): string {
  if (isTextOnlyRequest(req)) return '\n\n[For this reply do NOT call any tools; answer in plain text only.]';
  const tc = req.tool_choice;
  if (!tc || !req.tools?.length) return '';
  if (tc.type === 'tool' && tc.name) return `\n\n[For this reply you MUST call the tool "${tc.name}" (exactly one call).]`;
  if (tc.type === 'any') return '\n\n[For this reply you MUST call at least one tool.]';
  if (tc.type === 'none') return '\n\n[For this reply do NOT call any tools; answer in plain text.]';
  return '';
}

export interface RenderedPrompt {
  text: string;
  /** Number of request messages the prompt covers (always all of them). */
  covered: number;
}

/**
 * First message of a new ChatGPT conversation: bridge protocol, harness system
 * prompt, tool list, replay of any earlier transcript, then the latest turn.
 */
export function renderFullPrompt(req: MessagesRequest, opts: RenderOptions = DEFAULT_RENDER_OPTIONS): RenderedPrompt {
  const tools = visibleTools(req.tools, opts);
  const index = toolUseIndex(req.messages);
  const sections: string[] = [protocolInstructions(tools)];
  const sys = systemText(req.system);
  if (sys) sections.push(`# Harness system prompt\n\n${sys}`);
  if (tools.length) sections.push(`# Available tools\n\n${renderTools(tools, opts)}`);

  const last = lastAssistantIndex(req.messages);
  const history = last >= 0 ? req.messages.slice(0, last + 1) : [];
  const latest = req.messages.slice(last + 1);

  if (history.length) {
    // Spend the tool-result budget on the most recent results first.
    const caps = historyResultCaps(history, opts);
    const replay = history.map((m, i) => wrap(m.role, renderMessageBody(m, { index, opts, resultCap: caps[i]! })));
    sections.push(
      '# Conversation so far\n\nThis conversation was started elsewhere; here is the transcript (your earlier turns are shown as role="assistant").\n\n' +
        replay.join('\n\n'),
    );
  }
  const ctx: RenderCtx = { index, opts, resultCap: 0 };
  const latestText = latest.map((m) => renderLatestBody(m, ctx)).filter((s) => s.trim()).join('\n\n');
  sections.push(`# Latest message (respond to this)\n\n${latestText || '(empty)'}${toolChoiceNote(req)}`);
  return { text: sections.join('\n\n'), covered: req.messages.length };
}

function historyResultCaps(history: MessageParam[], opts: RenderOptions): number[] {
  const caps = new Array<number>(history.length).fill(0);
  if (!opts.replayToolResultBudgetChars) return caps;
  let budget = opts.replayToolResultBudgetChars;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (typeof m.content === 'string') continue;
    let size = 0;
    for (const b of m.content) if (b.type === 'tool_result') size += textOf((b as ToolResultBlock).content).length;
    if (size === 0) continue;
    if (size <= budget) {
      budget -= size;
    } else {
      caps[i] = Math.max(400, Math.floor(budget / Math.max(1, m.content.length)));
      budget = Math.max(0, budget - size);
    }
  }
  return caps;
}

/**
 * Follow-up message in an existing ChatGPT conversation: only the messages
 * after the last assistant turn (tool results, user text, harness notes).
 */
export function renderDeltaPrompt(req: MessagesRequest, fromIndex: number, opts: RenderOptions = DEFAULT_RENDER_OPTIONS): RenderedPrompt {
  const index = toolUseIndex(req.messages);
  const ctx: RenderCtx = { index, opts, resultCap: 0 };
  const parts = req.messages
    .slice(fromIndex)
    .map((m) => renderLatestBody(m, ctx))
    .filter((s) => s.trim());
  let text = parts.join('\n\n') || '(continue)';
  text += toolChoiceNote(req);
  if (opts.reminderFooter && visibleTools(req.tools, opts).length && !isTextOnlyRequest(req)) text += `\n\n${REMINDER_FOOTER}`;
  return { text, covered: req.messages.length };
}

// ---------------------------------------------------------------------------
// Token estimate (rough; used for usage reporting and count_tokens)

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.8 + other * 0.9);
}

export function estimateRequestTokens(req: MessagesRequest, opts: RenderOptions = DEFAULT_RENDER_OPTIONS): number {
  return estimateTokens(renderFullPrompt(req, { ...opts, replayToolResultBudgetChars: 0 }).text);
}

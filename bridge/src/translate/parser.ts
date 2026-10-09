// Parser for the text tool-calling protocol (see docs/PROTOCOL.md):
//
//   <tool_call name="Edit">
//   <param name="file_path">/abs/file.ts</param>
//   <param name="old_string">
//   raw text, no escaping
//   </param>
//   </tool_call>
//
// The parser is deliberately lenient: it accepts calls wrapped in code fences,
// unterminated calls at the end of a reply, CDATA values, Cline-style
// <param_name>value</param_name> elements, and a JSON object body
// ({"name": ..., "arguments": {...}} or just the arguments).
import type { JSONSchema, ToolDefinition } from '../anthropic/types.ts';
import { coerceValue, lenientJsonParse } from './schema.ts';

export interface ParsedText {
  type: 'text';
  text: string;
}

export interface ParsedToolCall {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
  /** The reply ended inside this call (no closing tag / unterminated value). */
  incomplete?: boolean;
}

export type ParsedBlock = ParsedText | ParsedToolCall;

export interface ParseResult {
  blocks: ParsedBlock[];
  toolCalls: number;
  /** Text after the last tool call (dropped from blocks; usually hallucinated results). */
  trailingText: string;
  warnings: string[];
}

// At most 3 spaces of indentation: 4+ spaces (or a tab) is a markdown code block, i.e. an example.
const OPEN_RE = /^ {0,3}<tool_call\b([^>\n]*)>/gm;
const FENCE_LINE_RE = /^ {0,3}(```+|~~~+)[\w+-]*[ \t]*$/;
/** A made-up tool result written by the model (it must stop after its calls instead). */
const FAKE_RESULT_RE = /^ {0,3}<(tool_result|tool_results|function_results)\b/m;
const TOOL_CLOSE = '</tool_call>';

function attr(attrs: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`).exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function stripOneNewlineEachSide(v: string): string {
  let s = v;
  if (s.startsWith('\r\n')) s = s.slice(2);
  else if (s.startsWith('\n')) s = s.slice(1);
  if (s.endsWith('\r\n')) s = s.slice(0, -2);
  else if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function trimEndLinear(s: string): string {
  return s.trimEnd();
}

/** Number of fence lines (``` or ~~~) in `s`. */
function countFences(s: string): number {
  let n = 0;
  for (const line of s.split('\n')) if (FENCE_LINE_RE.test(line)) n++;
  return n;
}

/** If the last non-blank line of `s` is a fence line, return `s` without it. */
function withoutTrailingFenceLine(s: string): string | null {
  const t = trimEndLinear(s);
  const nl = t.lastIndexOf('\n');
  return FENCE_LINE_RE.test(t.slice(nl + 1)) ? t.slice(0, nl + 1) : null;
}

/** If the first non-blank line of `s` is a fence line, return `s` after it. */
function withoutLeadingFenceLine(s: string): string | null {
  const m = /^\s*?\n?( {0,3}(```+|~~~+)[ \t]*)(\n|$)/.exec(s);
  if (!m || s.slice(0, m.index).trim()) return null;
  return s.slice(m[0].length);
}

export function resolveToolName(name: string, tools: ToolDefinition[]): string {
  if (!tools.length || tools.some((t) => t.name === name)) return name;
  const lower = name.toLowerCase();
  const ci = tools.find((t) => t.name.toLowerCase() === lower);
  if (ci) return ci.name;
  const suffix = tools.filter((t) => t.name.toLowerCase().endsWith(`__${lower}`));
  if (suffix.length === 1) return suffix[0]!.name;
  return name;
}

interface CallParse {
  name: string;
  input: Record<string, unknown>;
  end: number;
  warnings: string[];
  incomplete: boolean;
}

const PARAM_OPEN_RE = /^<(param|parameter|arg)\b([^>\n]*)>/;

/** String params that hold an entire file; a block-formatted value keeps its trailing newline. */
const WHOLE_FILE_PARAMS = new Set(['content']);

function parseCall(text: string, openStart: number, openEnd: number, attrs: string, tools: ToolDefinition[]): CallParse {
  const warnings: string[] = [];
  let name = attr(attrs, 'name') ?? attr(attrs, 'tool') ?? '';
  const tool = (): ToolDefinition | undefined => tools.find((t) => t.name === resolveToolName(name, tools));
  const raw: Record<string, string> = {};
  const json: Record<string, unknown> = {};
  let p = openEnd;
  let end = -1;
  let guard = 0;
  let incomplete = false;
  while (guard++ < 10_000) {
    p = skipWs(text, p);
    if (p >= text.length) {
      warnings.push(`tool_call "${name}" was not terminated with ${TOOL_CLOSE}`);
      end = text.length;
      incomplete = true;
      break;
    }
    if (text.startsWith(TOOL_CLOSE, p)) {
      end = p + TOOL_CLOSE.length;
      break;
    }
    // A new <tool_call> before this one was closed: treat this one as finished.
    if (text.startsWith('<tool_call', p) && p > openStart) {
      warnings.push(`tool_call "${name}" was not terminated before the next tool_call`);
      end = p;
      break;
    }
    const rest = text.slice(p, p + 300);
    const pm = PARAM_OPEN_RE.exec(rest);
    const knownParams = Object.keys(tool()?.input_schema?.properties ?? {});
    const elementMatch = pm ? null : /^<([A-Za-z_][\w.-]*)>/.exec(rest);
    if (pm || (elementMatch && knownParams.includes(elementMatch[1]!))) {
      const tagName = pm ? pm[1]! : elementMatch![1]!;
      const pname = pm ? (attr(pm[2]!, 'name') ?? '') : tagName;
      const close = `</${tagName}>`;
      const vStart = p + (pm ? pm[0].length : elementMatch![0].length);
      const { value, next, warning, block } = readValue(text, vStart, close, pm ? tagName : null);
      if (warning) warnings.push(`${name}.${pname}: ${warning}`);
      if (warning?.startsWith('missing')) incomplete = true;
      // Whole-file contents written as a block keep their final newline.
      if (pname) raw[pname] = block && WHOLE_FILE_PARAMS.has(pname) && value && !value.endsWith('\n') ? value + '\n' : value;
      else warnings.push(`${name}: <${tagName}> without a name attribute ignored`);
      p = next;
      continue;
    }
    if (text[p] === '{' && Object.keys(raw).length === 0) {
      const closeAt = text.indexOf(TOOL_CLOSE, p);
      const bodyEnd = closeAt === -1 ? text.length : closeAt;
      const parsed = lenientJsonParse(text.slice(p, bodyEnd));
      if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
        const obj = parsed.value as Record<string, unknown>;
        const args = obj.arguments ?? obj.input ?? obj.parameters ?? obj.args;
        if (name && args === undefined) {
          // <tool_call name="X">{...}</tool_call>: the object is the arguments (it may have its own "name").
          Object.assign(json, obj);
        } else if (typeof obj.name === 'string' && (args === undefined || (args && typeof args === 'object'))) {
          if (!name) name = obj.name;
          Object.assign(json, (args as Record<string, unknown>) ?? {});
        } else if (typeof obj.name === 'string' && typeof args === 'string') {
          if (!name) name = obj.name;
          const inner = lenientJsonParse(args);
          if (inner.ok && inner.value && typeof inner.value === 'object') Object.assign(json, inner.value);
        } else {
          Object.assign(json, obj);
        }
      } else {
        warnings.push(`${name}: could not parse JSON tool_call body`);
      }
      end = closeAt === -1 ? text.length : closeAt + TOOL_CLOSE.length;
      if (closeAt === -1) {
        warnings.push(`tool_call "${name}" was not terminated with ${TOOL_CLOSE}`);
        incomplete = true;
      }
      break;
    }
    // Unknown content inside the call: skip to the next tag.
    const nextTag = text.indexOf('<', p + 1);
    warnings.push(`${name}: ignored unexpected text inside tool_call: ${JSON.stringify(text.slice(p, Math.min(p + 60, nextTag === -1 ? text.length : nextTag)))}`);
    if (nextTag === -1) {
      end = text.length;
      break;
    }
    p = nextTag;
  }
  if (end === -1) end = text.length;

  const resolved = resolveToolName(name, tools);
  const schema = tools.find((t) => t.name === resolved)?.input_schema;
  const input: Record<string, unknown> = { ...json };
  for (const [k, v] of Object.entries(raw)) {
    const propSchema = schema?.properties?.[k] as JSONSchema | undefined;
    input[k] = propSchema ? coerceValue(v, propSchema) : coerceUnknown(v);
  }
  if (!name) warnings.push('tool_call without a name');
  if (schema?.required) {
    const missing = schema.required.filter((r) => !(r in input));
    if (missing.length) warnings.push(`${resolved}: missing required parameter(s) ${missing.join(', ')}`);
  }
  return { name: resolved, input, end, warnings, incomplete };
}

function coerceUnknown(v: string): unknown {
  const t = v.trim();
  if (/^[[{]/.test(t) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(t)) {
    const parsed = lenientJsonParse(t);
    if (parsed.ok) return parsed.value;
  }
  return v;
}

/**
 * Read a parameter value starting at `start`. The value ends at the first
 * closing tag that is followed (after whitespace) by another parameter, the
 * end of the tool call, or the end of the text.
 */
function readValue(
  text: string,
  start: number,
  close: string,
  paramTag: string | null,
): { value: string; next: number; warning?: string; block?: boolean } {
  const block = text[start] === '\n' || (text[start] === '\r' && text[start + 1] === '\n');
  const followerOk = (i: number): boolean => {
    const j = skipWs(text, i);
    if (j >= text.length) return true;
    if (text.startsWith(TOOL_CLOSE, j)) return true;
    if (text.startsWith('<tool_call', j) && (j === 0 || text[j - 1] === '\n' || /\n[ \t]*$/.test(text.slice(Math.max(0, j - 40), j)))) return true;
    if (paramTag) return PARAM_OPEN_RE.test(text.slice(j, j + 200));
    return /^<[A-Za-z_][\w.-]*>/.test(text.slice(j, j + 200));
  };
  // CDATA form: the value ends at a "]]>" that is directly followed by the closing tag and then by
  // another parameter or the end of the call (so content that itself mentions "]]>" survives).
  const afterWs = start + (/^\r?\n?[ \t]*/.exec(text.slice(start, start + 20))?.[0].length ?? 0);
  if (text.startsWith('<![CDATA[', afterWs)) {
    let from = afterWs + 9;
    for (;;) {
      const cdEnd = text.indexOf(']]>', from);
      if (cdEnd === -1) break;
      const j = skipWs(text, cdEnd + 3);
      if (text.startsWith(close, j) && followerOk(j + close.length)) {
        return { value: stripOneNewlineEachSide(text.slice(afterWs + 9, cdEnd)), next: j + close.length };
      }
      from = cdEnd + 3;
    }
    // Not a well-formed CDATA value: fall through and read it raw.
  }
  let from = start;
  let first = -1;
  for (;;) {
    const c = text.indexOf(close, from);
    if (c === -1) break;
    if (first === -1) first = c;
    if (followerOk(c + close.length)) {
      return { value: stripOneNewlineEachSide(text.slice(start, c)), next: c + close.length, block };
    }
    from = c + close.length;
  }
  if (first !== -1) {
    return {
      value: stripOneNewlineEachSide(text.slice(start, first)),
      next: first + close.length,
      block,
      warning: `closing ${close} not followed by another parameter or </tool_call>`,
    };
  }
  // Unterminated value: runs until </tool_call> or the end of the text.
  const tc = text.indexOf(TOOL_CLOSE, start);
  const stop = tc === -1 ? text.length : tc;
  return { value: stripOneNewlineEachSide(text.slice(start, stop)), next: stop, block, warning: `missing ${close}` };
}

export interface ParseOptions {
  /** false = the request had no tools: treat the whole reply as text. */
  toolCalls?: boolean;
}

type Segment = { kind: 'text'; text: string } | { kind: 'call'; call: CallParse };

export function parseReply(rawText: string, tools: ToolDefinition[] = [], opts: ParseOptions = {}): ParseResult {
  const text = rawText.replace(/\r\n/g, '\n');
  const warnings: string[] = [];
  if (opts.toolCalls === false) {
    const t = trimEndLinear(text);
    return { blocks: t ? [{ type: 'text', text: t }] : [], toolCalls: 0, trailingText: '', warnings };
  }
  const segments: Segment[] = [];
  let cursor = 0; // end of the last consumed call
  let search = 0; // where to look for the next <tool_call
  let fenceParity = 0; // fence lines seen in plain text so far (odd = inside a code block)
  let wrapper: { start: number; segIndex: number } | null = null; // open fence that wraps calls
  let calls = 0;
  let stopped = false;
  for (;;) {
    OPEN_RE.lastIndex = search;
    const m = OPEN_RE.exec(text);
    if (!m) break;
    let before = text.slice(cursor, m.index);
    // A made-up result between calls: the model kept going on imagined output. Run nothing after it.
    if (calls > 0 && FAKE_RESULT_RE.test(before)) {
      warnings.push('the reply contains a made-up <tool_result> after a tool call; calls after it were dropped');
      stopped = true;
      break;
    }
    if (wrapper) {
      const after = withoutLeadingFenceLine(before);
      if (after !== null) {
        before = after;
        wrapper = null;
      }
    }
    const parity = (fenceParity + countFences(before)) % 2;
    if (!wrapper && parity === 1) {
      const opened = withoutTrailingFenceLine(before);
      if (opened === null) {
        // The call sits inside a code block that holds other content: it is an example, not a call.
        search = m.index + m[0].length;
        continue;
      }
      // A fence directly wrapping the call (models sometimes do this despite the rules).
      if (opened.trim()) segments.push({ kind: 'text', text: calls === 0 ? trimEndLinear(opened) : opened.trim() });
      wrapper = { start: cursor + opened.length, segIndex: segments.length };
      fenceParity = 0;
    } else {
      fenceParity = wrapper ? 0 : parity;
      if (before.trim()) segments.push({ kind: 'text', text: calls === 0 ? trimEndLinear(before) : before.trim() });
    }
    const openStart = m.index + m[0].indexOf('<');
    const openEnd = m.index + m[0].length;
    const call = parseCall(text, openStart, openEnd, m[1] ?? '', tools);
    segments.push({ kind: 'call', call });
    calls++;
    cursor = Math.max(call.end, openEnd);
    search = cursor;
  }
  let trailingText = '';
  if (calls > 0) {
    let rest = text.slice(cursor);
    if (wrapper && !stopped) {
      const after = withoutLeadingFenceLine(rest);
      if (after !== null && after.trim() && !FAKE_RESULT_RE.test(after)) {
        // Fenced calls followed by explanation: the model was showing an example, not acting.
        warnings.push('tool calls inside a code block followed by prose were treated as an example and not run');
        const exampleText = trimEndLinear(text.slice(wrapper.start));
        const kept = segments.slice(0, wrapper.segIndex);
        segments.length = 0;
        segments.push(...kept);
        const prev = segments[segments.length - 1];
        if (prev?.kind === 'text') prev.text = trimEndLinear(`${prev.text}\n${exampleText}`);
        else segments.push({ kind: 'text', text: exampleText });
        rest = '';
      } else if (after !== null) rest = after;
    }
    trailingText = rest.trim();
    if (trailingText) warnings.push(`dropped ${trailingText.length} chars of text after the last tool call`);
  } else {
    const t = trimEndLinear(text);
    if (t) segments.push({ kind: 'text', text: t });
  }
  const blocks: ParsedBlock[] = [];
  let toolCalls = 0;
  for (const seg of segments) {
    if (seg.kind === 'text') {
      blocks.push({ type: 'text', text: seg.text });
      continue;
    }
    warnings.push(...seg.call.warnings);
    toolCalls++;
    blocks.push(
      seg.call.incomplete
        ? { type: 'tool_use', name: seg.call.name, input: seg.call.input, incomplete: true }
        : { type: 'tool_use', name: seg.call.name, input: seg.call.input },
    );
  }
  return { blocks, toolCalls, trailingText, warnings };
}

/**
 * Incremental helper for streaming: given the reply text so far, returns the
 * prefix that is safe to show as plain text (complete lines before any tool
 * call, holding back a code-fence opener that might wrap a tool call).
 */
export function safeStreamPrefix(textSoFar: string): { safe: string; sawToolCall: boolean } {
  const text = textSoFar.replace(/\r\n/g, '\n');
  OPEN_RE.lastIndex = 0;
  const m = OPEN_RE.exec(text);
  let region: string;
  let sawToolCall = false;
  if (m) {
    region = text.slice(0, m.index);
    sawToolCall = true;
  } else {
    const nl = text.lastIndexOf('\n');
    region = nl === -1 ? '' : text.slice(0, nl + 1);
    // A partial "<tool_call" at the start of the current incomplete line is already excluded.
  }
  // Hold back a trailing fence opener line (and any blank lines after it).
  const trimmed = trimEndLinear(region);
  const lastNl = trimmed.lastIndexOf('\n');
  const lastLine = trimmed.slice(lastNl + 1);
  if (FENCE_LINE_RE.test(lastLine)) {
    region = trimmed.slice(0, lastNl + 1);
  }
  return { safe: region, sawToolCall };
}

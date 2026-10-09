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
}

export type ParsedBlock = ParsedText | ParsedToolCall;

export interface ParseResult {
  blocks: ParsedBlock[];
  toolCalls: number;
  /** Text after the last tool call (dropped from blocks; usually hallucinated results). */
  trailingText: string;
  warnings: string[];
}

const OPEN_RE = /^[ \t]*<tool_call\b([^>\n]*)>/gm;
const FENCE_LINE_RE = /^[ \t]*(```|~~~)[\w+-]*[ \t]*$/;
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

/** Remove a trailing code-fence opener line (it wrapped the following tool call). */
function stripTrailingFenceOpener(s: string): string {
  const lines = s.replace(/\s+$/, '').split('\n');
  if (lines.length && FENCE_LINE_RE.test(lines[lines.length - 1]!)) {
    lines.pop();
    return lines.join('\n');
  }
  return s;
}

/** Remove a leading code-fence closer line (it closed the preceding tool call's wrapper). */
function stripLeadingFenceCloser(s: string): string {
  const m = /^\s*\n?[ \t]*(```|~~~)[ \t]*(\n|$)/.exec(s);
  return m ? s.slice(m[0].length) : s;
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
}

const PARAM_OPEN_RE = /^<(param|parameter|arg)\b([^>\n]*)>/;

/** String params that hold an entire file; a block-formatted value keeps its trailing newline. */
const WHOLE_FILE_PARAMS = new Set(['content', 'new_source']);

function parseCall(text: string, openStart: number, openEnd: number, attrs: string, tools: ToolDefinition[]): CallParse {
  const warnings: string[] = [];
  let name = attr(attrs, 'name') ?? attr(attrs, 'tool') ?? '';
  const tool = (): ToolDefinition | undefined => tools.find((t) => t.name === resolveToolName(name, tools));
  const raw: Record<string, string> = {};
  const json: Record<string, unknown> = {};
  let p = openEnd;
  let end = -1;
  let guard = 0;
  while (guard++ < 10_000) {
    p = skipWs(text, p);
    if (p >= text.length) {
      warnings.push(`tool_call "${name}" was not terminated with ${TOOL_CLOSE}`);
      end = text.length;
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
        if (typeof obj.name === 'string' && (args === undefined || (args && typeof args === 'object'))) {
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
      if (closeAt === -1) warnings.push(`tool_call "${name}" was not terminated with ${TOOL_CLOSE}`);
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
  return { name: resolved, input, end, warnings };
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
  // CDATA form.
  const afterWs = start + (/^\r?\n?[ \t]*/.exec(text.slice(start, start + 20))?.[0].length ?? 0);
  if (text.startsWith('<![CDATA[', afterWs)) {
    const cdEnd = text.indexOf(']]>', afterWs + 9);
    if (cdEnd !== -1) {
      const value = text.slice(afterWs + 9, cdEnd);
      let next = skipWs(text, cdEnd + 3);
      if (text.startsWith(close, next)) next += close.length;
      return { value, next };
    }
  }
  const followerOk = (i: number): boolean => {
    const j = skipWs(text, i);
    if (j >= text.length) return true;
    if (text.startsWith(TOOL_CLOSE, j)) return true;
    if (text.startsWith('<tool_call', j) && (j === 0 || text[j - 1] === '\n' || /\n[ \t]*$/.test(text.slice(Math.max(0, j - 40), j)))) return true;
    if (paramTag) return PARAM_OPEN_RE.test(text.slice(j, j + 200));
    return /^<[A-Za-z_][\w.-]*>/.test(text.slice(j, j + 200));
  };
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

export function parseReply(rawText: string, tools: ToolDefinition[] = []): ParseResult {
  const text = rawText.replace(/\r\n/g, '\n');
  const blocks: ParsedBlock[] = [];
  const warnings: string[] = [];
  let cursor = 0;
  let calls = 0;
  let trailingText = '';
  OPEN_RE.lastIndex = 0;
  for (;;) {
    OPEN_RE.lastIndex = cursor;
    const m = OPEN_RE.exec(text);
    if (!m) break;
    const openStart = m.index + m[0].indexOf('<');
    const openEnd = m.index + m[0].length;
    let before = text.slice(cursor, m.index);
    if (calls > 0) before = stripLeadingFenceCloser(before);
    before = stripTrailingFenceOpener(before);
    if (before.trim()) blocks.push({ type: 'text', text: calls === 0 ? before.replace(/\s+$/, '') : before.trim() });
    const call = parseCall(text, openStart, openEnd, m[1] ?? '', tools);
    warnings.push(...call.warnings);
    blocks.push({ type: 'tool_use', name: call.name, input: call.input });
    calls++;
    cursor = Math.max(call.end, openEnd);
  }
  if (calls === 0) {
    const t = text.replace(/\s+$/, '');
    if (t) blocks.push({ type: 'text', text: t });
  } else {
    trailingText = stripLeadingFenceCloser(text.slice(cursor)).trim();
    if (trailingText) warnings.push(`dropped ${trailingText.length} chars of text after the last tool call`);
  }
  return { blocks, toolCalls: calls, trailingText, warnings };
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
  const trimmed = region.replace(/\s+$/, '');
  const lastNl = trimmed.lastIndexOf('\n');
  const lastLine = trimmed.slice(lastNl + 1);
  if (FENCE_LINE_RE.test(lastLine)) {
    region = trimmed.slice(0, lastNl + 1);
  }
  return { safe: region, sawToolCall };
}

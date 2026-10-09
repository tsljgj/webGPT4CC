// Classification of Claude Code requests and local answers for trivial helper calls.
import type { MessagesRequest, StopReason, TextBlock } from './anthropic/types.ts';
import type { BridgeConfig } from './config.ts';
import { systemText, textOf } from './translate/render.ts';

/**
 * - main:       an agent-loop request (has client tools) -> continued ChatGPT conversation
 * - background: a helper request without tools (titles, summaries, classifiers, WebFetch digests...)
 *               -> one-off ChatGPT chat (or a local answer for a few known trivial prompts)
 * - web_search: Claude Code's WebSearch tool calling the server-side web_search tool
 *               -> one-off ChatGPT chat that is allowed to browse
 * - probe:      max_tokens=1 quota/connectivity probes -> answered locally
 */
export type RequestKind = 'main' | 'background' | 'web_search' | 'probe' | 'classifier';

/** Claude Code's auto-mode safety classifier (two extra ~140 KB requests per tool call). */
export function isSafetyClassifierRequest(req: MessagesRequest): boolean {
  return /You are a security monitor for autonomous AI coding agents/.test(systemText(req.system).slice(0, 2000));
}

/** Claude Code's conversation-compaction request: same tools, but the model must answer in text. */
export function isCompactionRequest(req: MessagesRequest): boolean {
  const last = req.messages[req.messages.length - 1];
  return !!last && last.role === 'user' && /CRITICAL: Respond with TEXT ONLY\. Do NOT call any tools/.test(textOf(last.content));
}

export function isWebSearchRequest(req: MessagesRequest): boolean {
  return (req.tools ?? []).some((t) => typeof t.type === 'string' && /^web_search/.test(t.type));
}

export function classifyRequest(req: MessagesRequest, backgroundModel: boolean, _config: BridgeConfig): RequestKind {
  if ((req.max_tokens ?? 0) === 1) return 'probe';
  if (isSafetyClassifierRequest(req)) return 'classifier';
  if (isWebSearchRequest(req)) return 'web_search';
  const clientTools = (req.tools ?? []).filter((t) => t.input_schema && !t.type);
  if (clientTools.length === 0 || req.tool_choice?.type === 'none') return 'background';
  if (backgroundModel && clientTools.length === 0) return 'background';
  return 'main';
}

function lastUserText(req: MessagesRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') return textOf(m.content);
  }
  return '';
}

function firstWords(s: string, n: number): string {
  return s
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/[`*_#>\[\]()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, n)
    .join(' ');
}

/**
 * Local answers for helper prompts whose output is cosmetic. Returns null when
 * the request is not one we recognise; those go to ChatGPT. Security-relevant
 * helpers (e.g. permission classifiers) are never answered locally.
 */
export function localBackgroundReply(req: MessagesRequest, kind: RequestKind): { text: string; stopReason: StopReason } | null {
  if (kind === 'probe') return { text: 'ok', stopReason: 'max_tokens' };
  const sys = systemText(req.system).toLowerCase();
  const user = lastUserText(req);
  if (/security monitor|classif(y|ier)|permission|allow|deny|dangerous/.test(sys)) return null;
  // Session title / topic detection: a short title is enough.
  if (/\btitle\b/.test(sys) && /(json|isnewtopic|\btitle\b)/.test(sys) && /isnewtopic/.test(sys)) {
    const title = firstWords(user, 6) || 'Session';
    return { text: JSON.stringify({ isNewTopic: true, title }), stopReason: 'end_turn' };
  }
  if (/(generate|write|create) (a )?(short |concise )?(title|name)/.test(sys) && sys.length < 4000) {
    return { text: firstWords(user, 6) || 'Session', stopReason: 'end_turn' };
  }
  return null;
}

/** Prompt for Claude Code's WebSearch tool: let ChatGPT use its own browsing. */
export function webSearchPrompt(req: MessagesRequest): string {
  const query = textOf(req.messages[req.messages.length - 1]?.content as string | TextBlock[]).trim();
  const sys = systemText(req.system);
  const tool = (req.tools ?? []).find((t) => typeof t.type === 'string' && t.type.startsWith('web_search')) as
    | { allowed_domains?: string[]; blocked_domains?: string[] }
    | undefined;
  const lines = [
    'Search the web (use your web search / browsing capability) for the request below and report what you find.',
    'Write a concise, factual summary of the most relevant results. For every claim, include the source as a markdown link [title](url). End with a list of the URLs you used.',
  ];
  if (tool?.allowed_domains?.length) lines.push(`Only use these domains: ${tool.allowed_domains.join(', ')}.`);
  if (tool?.blocked_domains?.length) lines.push(`Never use these domains: ${tool.blocked_domains.join(', ')}.`);
  if (sys) lines.push('', 'Context from the requesting tool:', sys);
  lines.push('', 'Request:', query || '(empty)');
  return lines.join('\n');
}

// Minimal subset of the Anthropic Messages API types that Claude Code uses.
// Unknown fields are tolerated everywhere: Claude Code adds new ones regularly.

export interface CacheControl {
  type: string;
  ttl?: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
  citations?: unknown;
}

export interface ImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
    | { type: string; [k: string]: unknown };
  cache_control?: CacheControl;
}

export interface DocumentBlock {
  type: 'document';
  source: { type: string; media_type?: string; data?: string; [k: string]: unknown };
  title?: string;
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<TextBlock | ImageBlock | DocumentBlock | { type: string; [k: string]: unknown }>;
  is_error?: boolean;
  cache_control?: CacheControl;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/** Server tools (web_search etc.) and anything else we don't model explicitly. */
export interface OtherBlock {
  type: string;
  [k: string]: unknown;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | OtherBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface JSONSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  additionalProperties?: boolean | JSONSchema;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  [k: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: JSONSchema;
  /** Present on server tools such as web_search_20250305. */
  type?: string;
  cache_control?: CacheControl;
  [k: string]: unknown;
}

export interface MessagesRequest {
  model: string;
  messages: MessageParam[];
  system?: string | TextBlock[];
  tools?: ToolDefinition[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string; disable_parallel_tool_use?: boolean };
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  thinking?: { type: string; budget_tokens?: number };
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type ResponseBlock = TextBlock | ToolUseBlock;

export interface MessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ResponseBlock[];
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
}

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error';

export interface ErrorResponse {
  type: 'error';
  error: { type: ErrorType; message: string };
}

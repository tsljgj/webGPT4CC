# Protocols

webGPT4CC has two protocols:

1. **Text tool-calling protocol**: how the bridge describes tools to a ChatGPT model that only sees text, and how it parses tool calls out of the reply.
2. **Bridge ↔ extension protocol**: the JSON messages exchanged over the localhost WebSocket between the bridge and the browser extension.

---

## 1. Text tool-calling protocol

### First message of a ChatGPT conversation

```
# Bridge instructions (read first)
...how to call tools, rules...
# Harness system prompt
<Claude Code's system prompt, minus the billing header block>
# Available tools
### Read
<description>
Parameters:
- file_path: string (required, raw string) — The absolute path to the file to read
- offset: number (optional, JSON) — ...
...
# Conversation so far            (only when an existing transcript is replayed)
<message role="user">...</message>
<message role="assistant">...</message>
# Latest message (respond to this)
<the newest user turn: text, tool results, harness messages>
```

### Follow-up messages

Only what is new since the model's last reply: tool results, user text, and
messages that Claude Code puts in `messages[]` with `role: "system"` (rendered as
`<harness_message>`), followed by a one-line protocol reminder.

```
<tool_result name="Bash" call="1">
hello
</tool_result>

<tool_result name="Read" call="2" status="error">
File does not exist.
</tool_result>

<system-reminder>...</system-reminder>

[bridge reminder: ...]
```

`call="N"` is the 1-based position of the call in the model's previous reply.

### Tool calls (model → bridge)

```
Short optional note.
<tool_call name="Edit">
<param name="file_path">/abs/path/file.ts</param>
<param name="old_string">
const a = 1;
</param>
<param name="new_string">
const a = 2;
</param>
<param name="replace_all">false</param>
</tool_call>
```

* `<tool_call` must start a line (prose that mentions the tag inline is ignored).
* Parameters whose JSON-Schema type is `string` are **raw**: no quoting or escaping. One newline right after the opening tag and one right before the closing tag are stripped.
* Other parameters are JSON (`50`, `true`, `["a","b"]`, `{"k": 1}`); the bridge coerces leniently using the tool's schema (e.g. `yes` → `true`, a bare string for a string array → one-element array).
* A raw value that contains `</param>` or `</tool_call>` can be wrapped in `<![CDATA[ ... ]]>`. Without CDATA, the parser picks the first `</param>` that is followed by another `<param` or by `</tool_call>`, so most accidental occurrences still parse.
* Text after the last `</tool_call>` is dropped (it is almost always a hallucinated tool result). Text between calls is kept.

Lenient forms that are also accepted:

| Form | Example |
|---|---|
| Call wrapped in a code fence | ```` ```xml\n<tool_call ...>...</tool_call>\n``` ```` |
| Missing `</tool_call>` at the end of the reply | `<tool_call name="Read">\n<param name="file_path">/a</param>` |
| Cline-style elements for known parameter names | `<file_path>/a</file_path>` |
| `<parameter name="...">` / `<arg name="...">` | `<parameter name="file_path">/a</parameter>` |
| JSON body | `<tool_call name="Read">{"file_path": "/a"}</tool_call>` |
| Hermes-style JSON | `<tool_call>{"name": "Read", "arguments": {"file_path": "/a"}}</tool_call>` |
| Case-insensitive / MCP-suffix tool names | `read` → `Read`, `search` → `mcp__srv__search` (if unique) |

The parsed reply becomes Anthropic content blocks: a `text` block for leading
prose, then one `tool_use` block per call (`id` = `toolu_` + 24 random
base62 chars), `stop_reason: "tool_use"`. A reply without calls is a single
text block with `stop_reason: "end_turn"`.

### Streaming

When `stream: true`, the bridge streams the leading prose line by line as the
ChatGPT reply arrives (holding back a code-fence opener that might wrap a tool
call) and stops streaming text as soon as a `<tool_call` line appears. Tool
calls are emitted as complete `tool_use` blocks when the reply is finished.

---

## 2. Bridge ↔ extension protocol

Transport: WebSocket at `ws://127.0.0.1:<port>/extension?token=<extensionToken>`.

The bridge rejects the upgrade unless:

* the `Origin` header is `chrome-extension://…` or `moz-extension://…` (or listed in `allowedOrigins`) — web pages cannot connect;
* the `token` query parameter equals `extensionToken` from `~/.webgpt4cc/config.json` (unless that is empty);
* the `Host` header is a loopback name when the bridge listens on loopback (DNS-rebinding protection).

All frames are JSON objects with a `type`.

### Extension → bridge

```jsonc
{ "type": "hello", "protocol": 1, "extensionVersion": "0.1.0", "browser": "Chrome/141" }

// Full list of worker tabs, sent on connect and whenever anything changes.
{ "type": "workers", "workers": [
  { "id": "123", "url": "https://chatgpt.com/c/...", "ready": true, "busy": false, "label": "ChatGPT worker 1" }
] }

// Progress for a job. `event` is a ChatEvent (see below).
{ "type": "job_event", "jobId": "…", "event": { "type": "status", "status": "navigating" } }
{ "type": "job_event", "jobId": "…", "event": { "type": "text", "text": "full reply text so far" } }
{ "type": "job_event", "jobId": "…", "event": { "type": "done", "text": "…", "conversationId": "…", "messageId": "…", "finishReason": "stop" } }
{ "type": "job_event", "jobId": "…", "event": { "type": "error", "code": "rate_limited", "message": "…", "retryAfterMs": 3600000 } }

{ "type": "pong", "t": 1730000000000 }
{ "type": "log", "level": "warn", "message": "…", "data": {} }
```

### Bridge → extension

```jsonc
{ "type": "welcome", "protocol": 1, "bridgeVersion": "0.1.0" }

{ "type": "job", "job": {
  "id": "…",
  "workerId": "123",
  "model": "gpt-5-thinking",
  "conversation": { "kind": "new" } | { "kind": "continue", "conversationId": "…", "parentMessageId": "…" },
  "url": "https://chatgpt.com/?model=gpt-5-thinking",   // where the tab should be before typing
  "prompt": "…",
  "purpose": "main" | "background" | "web_search",
  "timeoutMs": 1200000,
  "temporary": false,
  "allowWebSearch": false
} }

{ "type": "cancel", "jobId": "…" }   // click "stop generating" and report an "aborted" error
{ "type": "ping", "t": 1730000000000 }
```

### ChatEvent

| type | fields | meaning |
|---|---|---|
| `status` | `status`, `detail?` | `accepted`, `navigating`, `ready`, `typing`, `submitted`, `generating`, `thinking`, … The bridge starts its HTTP stream at `submitted`. For `thinking`, `detail` may carry the whole reasoning summary so far; the bridge streams it to Claude Code as a thinking block. |
| `text` | `text` | Whole reply text so far (raw markdown as produced by the model, **not** rendered DOM text). |
| `done` | `text`, `conversationId`, `messageId?`, `finishReason?` | Final raw text of the assistant reply. |
| `error` | `code`, `message`, `retryAfterMs?` | `code` ∈ `no_worker`, `rate_limited`, `too_long`, `not_logged_in`, `ui_error`, `network`, `conversation_not_found`, `timeout`, `aborted`, `internal`. |

Exactly one `done` or `error` ends a job. The extension must only report raw
model text (from the page's own streaming response or from the conversation
API); rendered DOM text loses markdown and indentation, which corrupts tool
call parameters.

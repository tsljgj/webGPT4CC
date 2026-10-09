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

Transport: WebSocket at `ws://127.0.0.1:<port>/extension` (protocol version 2).

The bridge refuses the upgrade unless:

* the `Origin` header is `chrome-extension://…` or `moz-extension://…` (or listed in `allowedOrigins`) — web pages cannot connect;
* the `Host` header is a loopback name when the bridge listens on loopback (DNS-rebinding protection).

The pairing token (`extensionToken` in `~/.webgpt4cc/config.json`) never crosses
the wire. Both ends prove they know it with an HMAC challenge-response before
anything else is exchanged, so a program that squats on the port while the
bridge is down learns nothing and cannot hand the extension jobs, and a client
that only forges the `Origin` header cannot join as a worker.

```
K = "webgpt4cc/pairing/v2/" + token          (HMAC-SHA256 key; the prefix also makes an empty token a valid key)
extension → bridge  { "type": "hello", "protocol": 2, "extensionVersion": "0.1.0", "browser": "Chrome/141", "nonce": nE }
bridge → extension  { "type": "welcome", "protocol": 2, "bridgeVersion": "0.1.0", "nonce": nB, "proof": HMAC(K, "bridge|" + nE + "|" + nB) }
extension → bridge  { "type": "auth", "proof": HMAC(K, "extension|" + nB + "|" + nE) }
```

Nonces are 16 random bytes as lowercase hex; proofs are lowercase hex.

* The extension sends nothing but `hello` (and `pong`) until the bridge's proof
  verifies. In particular, the `workers` list, which carries conversation URLs,
  waits until then. It ignores `job` and `cancel` from an unproven peer, and
  closes the socket on a bad proof, or when no `welcome` arrives within 10 s.
* The bridge processes nothing but `hello`, `auth` and `pong` until the
  extension's proof verifies. It closes the socket with code 4401 on a bad proof
  or after 10 s without one, and with 4400 on a protocol mismatch (it answers an
  old `hello` with a `welcome` first, so the extension can say "update both").

All frames are JSON objects with a `type`.

### Extension → bridge

```jsonc
{ "type": "hello", "protocol": 2, "extensionVersion": "0.1.0", "browser": "Chrome/141", "nonce": "…" }
{ "type": "auth", "proof": "…" }

// Full list of worker tabs, sent once authenticated and whenever anything changes.
// `url` is always a chatgpt.com URL or "" (a worker tab that left the site has no URL).
// `conversationId`: the conversation the tab holds from its last job (also temporary chats).
{ "type": "workers", "workers": [
  { "id": "123", "url": "https://chatgpt.com/c/...", "ready": true, "busy": false, "label": "ChatGPT worker 1", "conversationId": "…" }
] }

// Progress for a job. `event` is a ChatEvent (see below).
{ "type": "job_event", "jobId": "…", "event": { "type": "status", "status": "navigating" } }
{ "type": "job_event", "jobId": "…", "event": { "type": "text", "text": "full reply text so far" } }
{ "type": "job_event", "jobId": "…", "event": { "type": "done", "text": "…", "conversationId": "…", "messageId": "…", "finishReason": "stop" } }
{ "type": "job_event", "jobId": "…", "event": { "type": "error", "code": "rate_limited", "message": "…", "retryAfterMs": 3600000 } }

{ "type": "pong", "t": 1730000000000 }
{ "type": "log", "level": "warn", "message": "…", "data": {} }
```

A worker is `ready` only while its page reported in within the last 75 s (worker
pages send a heartbeat every 10 s), Chrome has not frozen or discarded the tab,
no reply streams in it (judged from the page's network traffic first), nobody is
typing in it, and it is logged in.

### Bridge → extension

```jsonc
{ "type": "welcome", "protocol": 2, "bridgeVersion": "0.1.0", "nonce": "…", "proof": "…" }

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

{ "type": "cancel", "jobId": "…" }   // stop the reply and report an "aborted" error once the page stopped streaming (≤ 5 s)
{ "type": "ping", "t": 1730000000000 }
```

The extension opens only the URL shapes the bridge builds, and refuses every
other job URL with an `internal` error:

* `continue`: exactly `https://chatgpt.com/c/<encodeURIComponent(conversationId)>`, no query;
* `new`: path `/`, `/g/<id>` or `/g/<id>/project`, with no query parameters
  other than `model` and `temporary-chat`.

### ChatEvent

| type | fields | meaning |
|---|---|---|
| `status` | `status`, `detail?` | `accepted`, `navigating`, `ready`, `typing`, `sending`, `submitted`, `generating`, `thinking`, `recovering`, `prompt_mismatch`, `model_mismatch`, … The bridge starts its HTTP stream at `submitted`. For `thinking`, `detail` may carry the whole reasoning summary so far; the bridge streams it to Claude Code as a thinking block. `sending` comes right before the click on Send: a page reload before it re-runs the job in the new page, a reload after it fails the job. `prompt_mismatch` (detail: JSON `{offset, sentChars, wantChars, kinds}`) and `model_mismatch` (detail: text) are warnings; the bridge logs them. |
| `text` | `text` | Whole reply text so far (raw markdown as produced by the model, **not** rendered DOM text). |
| `done` | `text`, `conversationId`, `messageId?`, `finishReason?`, `requestedModel?`, `actualModel?`, `modelSlug?`, `promptMismatch?` | Final raw text of the assistant reply. `actualModel` is the `model` of the request the ChatGPT page sent, `modelSlug` the model the stream metadata reports. `promptMismatch` (`{offset, sentChars, wantChars, kinds}`) means the text ChatGPT received differs from the prompt beyond whitespace at its very start and end; `kinds` names the change (`backslash-escape`, `tabs-or-spaces`, `trailing-whitespace`, `nbsp`, `blank-lines`, `zero-width`, `unicode-normalization`, `other`). |
| `error` | `code`, `message`, `retryAfterMs?` | `code` ∈ `no_worker`, `rate_limited`, `too_long`, `not_logged_in`, `ui_error`, `network`, `conversation_not_found`, `timeout`, `aborted`, `internal`. |

Error codes the extension uses beyond their plain meaning:

* `too_long` also when the composer or the sent request kept only a prefix of a
  large prompt (ChatGPT truncates very large messages); the bridge turns it into
  Claude Code's "prompt is too long", which makes it compact.
* `aborted` (not retried) when ChatGPT is, or ran the turn, in Work mode: Work
  uses another quota and runs server-side agentic tools, so the extension stops
  such a turn at once and asks the user to switch the worker tab to Chat.
* `conversation_not_found` for a Work conversation (`/c/WEB:…`) that a job asks
  to continue: the bridge then replays the transcript into a new Chat.
* `rate_limited` also for a 429 on the send pipeline (Sentinel, conduit prepare)
  after the click, and for localized (zh/ja) limit dialogs.

Exactly one `done` or `error` ends a job. The extension must only report raw
model text (from the page's own streaming response or from the conversation
API); rendered DOM text loses markdown and indentation, which corrupts tool
call parameters.

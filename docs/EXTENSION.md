# Browser extension design

The extension (`extension/`, Chrome MV3, plain JavaScript, no build step) turns
one or more logged-in chatgpt.com tabs into **workers** for the bridge. It types
the bridge's prompt into the real ChatGPT UI, so ChatGPT's own page code handles
auth, Sentinel/proof-of-work, Turnstile and Cloudflare. The extension never
creates those tokens itself. It reads the model's **raw markdown** reply by
watching the network traffic that the page itself consumes.

Wire protocol to the bridge: [PROTOCOL.md §2](PROTOCOL.md#2-bridge--extension-protocol).

## Components

```
service worker (background.js)
 ├─ owns the WebSocket to ws://127.0.0.1:<port>/extension?token=…  (reconnect w/ backoff, ping every 20 s)
 ├─ worker-tab registry (chrome.storage.session) + "workers" announcements
 ├─ job orchestration: navigation (chrome.tabs.update), waiting for the page agent, relaying events
 └─ chrome.alarms keep-alive / reconnect
        ▲ chrome.runtime port per tab ("webgpt4cc-relay")
content/relay.js        ISOLATED world, document_start
 └─ forwards messages between the port and window.postMessage (source-tagged, same-window only)
        ▲ window.postMessage
content/page-agent.js   MAIN world, document_start
 ├─ network observer: wraps window.fetch and window.WebSocket in observe mode
 ├─ delta-v1 stream reducer → final-channel assistant text
 └─ DOM driver: find composer, chunked paste, verify, send, stop, error/limit detection
popup.html / popup.js
 └─ bridge URL + pairing token, connection state, worker list, "Open worker tab", "Use this tab"
```

The page agent runs in the MAIN world because only there can it observe the
page's own `fetch`/`WebSocket` objects (and dispatch the events ChatGPT's editor
reacts to, exactly as the maintained `steipete/oracle` project does over CDP).

## Network observation (MAIN world)

* Install at `document_start`, before ChatGPT's scripts capture `window.fetch`.
* **Observe mode, not tee/clone**: call the native fetch first; for responses whose
  pathname is `/backend-api/f/conversation` or `/backend-api/f/conversation/resume`
  (also accept legacy `/backend-api/conversation`), wrap `response.body.getReader`
  so every chunk the page reads is also fed to our SSE parser. The page's own
  consumption drives capture; we never consume the body ourselves.
* Also observe `WebSocket` connections to `ws.chatgpt.com`: a stream may continue
  there after a `{"type":"stream_handoff", "options":[{"type":"subscribe_ws_topic","topic_id":"conversation-turn-…"}]}`
  event. WebSocket frames look like
  `{"type":"message","topic_id":"conversation-turn-…","payload":{"type":"conversation-turn-stream","payload":{"type":"stream-item","stream_item_id":"…","encoded_item":"<SSE text>"}}}`
  and end with `payload.payload.type == "done"` (or `"error"`). Deduplicate by `stream_item_id`.
* An AbortError after `message_stream_complete` is normal.
* Never log `accessToken`, `resume_conversation_token`, cookies or headers.

### SSE / delta-v1 reducer

```
event: delta_encoding / data: "v1"
data: {"p":"","o":"add","v":{"message":{…},"conversation_id":"…"},"c":0}   → new current message
data: {"v":{"message":{…}}}                                                → new current message
data: {"p":"/message/content/parts/0","o":"append","v":"Hel"}
data: {"v":"lo"}                                       → implicit: reuse last p and o
data: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"!"},
                               {"p":"/message/status","o":"replace","v":"finished_successfully"},
                               {"p":"/message/end_turn","o":"replace","v":true},
                               {"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]}
data: {"type":"message_stream_complete","conversation_id":"…"}
data: [DONE]
```

Ops: `add`/`replace` set; `append` concatenates strings / pushes arrays / merges
objects; `remove`; `patch` applies children with joined paths; `truncate` (defensive).
Top-level `type` events: `server_ste_metadata` (model slug), `stream_handoff`,
`message_stream_complete` (terminal), `title_generation`, `input_message`,
`message_marker`, `conversation_detail_metadata`; a non-null top-level `error`
is an error. Non-delta full-message frames (`{"message":{…}}`) are also accepted.

**The answer** is the last message with `author.role == "assistant"`,
`recipient` empty or `"all"`, `content.content_type == "text"` (or
`multimodal_text` with string parts), not `metadata.is_visually_hidden_from_conversation`,
not `metadata.is_thinking_preamble_message`, and `channel == "final"` or
(`channel` null and it is the last such message). Thoughts, reasoning recaps,
code/execution output and tool messages (`recipient` = `web.run`, `python`, …)
are ignored. Strip private-use markers `…` blocks and stray
`-` characters.

`finishReason` comes from `metadata.finish_details.type` (`stop`, `max_tokens`, `interrupted`).
`conversationId` from the `conversation_id` fields; `messageId` = the answer message id.

## DOM driver (MAIN world)

All selectors are fallback chains (ChatGPT shipped a new DOM on 2026-09-25 and
rolls out in stages, so old and new shapes coexist). They live in one
`SELECTORS` object at the top of `page-agent.js`.

| What | Chain |
|---|---|
| composer | `form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]`, `#prompt-textarea[contenteditable="true"]`, `#prompt-textarea`, `.ProseMirror[contenteditable="true"]`, `[contenteditable="true"][role="textbox"]`, `textarea[name="prompt-textarea"]`, `#mobile-composer-prompt` |
| send | `button[data-testid="send-button"]`, `#composer-submit-button[data-testid="send-button"]`, `button[data-testid*="composer-send"]`, `[data-composer-submit]`, `form button[type="submit"]`, `button[aria-label="Send prompt"]`, `button[aria-label*="Send" i]` |
| stop | `[data-testid="stop-button"]`, `[data-testid="composer-stop-button"]`, `form button[aria-label="Stop"]`, `form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])` |
| pasted-text chip | `form button[aria-label^="Remove Pasted text"]` |
| Chat/Work switch | `[role="group"][aria-label="Composer mode"] button` (click "Chat" if "Work" is selected) |
| login CTA | `a[href*="/auth/login"]`, `button[data-testid*="login"]`, buttons whose text is "Log in"/"Sign up" |
| warnings | visible `[role=alert]`, `[role=status]`, `[role=dialog]`, `[role=alertdialog]`, `[aria-live]`, `[data-testid*=toast i]`, `[data-testid*=banner i]`, `[class*=text-error]` |

Job steps:

1. Wait (MutationObserver + bounded polling) up to 30 s for the composer. If a
   login CTA is visible and no composer → `not_logged_in`. If a throttle dialog
   ("too many requests", "temporarily limited access") or usage-cap text
   (`/limit/` + `/reset|until/`) is visible → `rate_limited`.
2. If the Chat/Work switch shows Work selected, click Chat.
3. Focus the composer (click + focus + collapse selection to end), clear it.
4. **Insert the prompt by synthetic paste in chunks of ≤ 4000 characters**
   (`ClipboardEvent('paste', {clipboardData: DataTransfer{text/plain, text/html with <br>}})`),
   never splitting a surrogate pair or CRLF. Single-line short prompts may use
   `execCommand('insertText')`. Never type `\n` keys (ProseMirror may submit).
5. Verify: read the editor text (text nodes; `<br>` → `\n` except
   `.ProseMirror-trailingBreak`; block boundaries `P/DIV/PRE/LI` → `\n`) and compare
   to the prompt after normalising line endings and trailing whitespace. If it
   differs, or the pasted-text chip count grew, clear the composer and fail with
   `too_long` (chip) or `ui_error` (mismatch). Nothing is sent in that case.
6. Arm the network observer for this job, wait ~500 ms, then click the first
   enabled send button (not `disabled`, not `aria-disabled="true"`, visible).
   Fallback: `keydown`/`keypress`/`keyup` Enter on the composer.
7. Confirm submission: the observer sees the conversation request within 20 s
   (else `ui_error: send did not start a request`). Emit `status: submitted`.
8. Stream: emit `text` events (whole answer text so far) at most every 250 ms.
   Emit `status: thinking` while only reasoning messages are arriving.
9. Done on `message_stream_complete`, `[DONE]` with a finished answer, or WS `done`.
   If the stream breaks without completion: wait for the DOM terminal state
   (stop control gone, content stable ≥ 1.5 s), then try
   `GET /backend-api/conversation/{id}` with the bearer token from
   `/api/auth/session` (best-effort; Cloudflare may answer 403 — then use the
   last streamed text if any, else `network` error).
10. HTTP status ≥ 400 on the conversation request → map: 429 → `rate_limited`
    (use `detail.clears_in` seconds when present), 401/403 → `not_logged_in`
    (or `network` if the body is a Cloudflare page), 413 or "too long" → `too_long`,
    else `network`.
11. `max_tokens` finish: report `finishReason: "max_tokens"` (the bridge tells
    Claude Code; no auto-continue in v0.1).

Cancel: click the stop control; report `error: aborted`.

## Service worker

* Settings in `chrome.storage.local`: `bridgeUrl` (default `http://127.0.0.1:8765`),
  `token`, `enabled` (default true), `maxWorkers` (default 3).
* Worker tabs in `chrome.storage.session` (`workerTabIds`), so they survive a
  service-worker restart. "Open worker tab" creates a pinned chatgpt.com tab and
  sets `autoDiscardable: false`. Closing a tab removes it.
* A worker is `ready` when its relay port is connected and the page agent
  reported `ready` (composer found, not generating, not on a login page).
* Jobs: if `job.url` differs from the tab's location in a way that matters
  (new chat: always navigate unless the tab is already on a fresh, empty chat at
  that exact URL; continue: navigate unless the tab already shows
  `/c/<conversationId>` or holds that temporary conversation), call
  `chrome.tabs.update(tabId, {url})`, wait for the relay to reconnect and the page
  agent to report ready (timeout 45 s), then send `run` to the page agent.
  Continuing a temporary chat that the tab no longer holds → `conversation_not_found`.
* Only one job per tab. Forward every event to the bridge as `job_event`.
* WebSocket: reconnect with exponential backoff (1 s → 30 s), send
  `{"type":"pong"}` for every `ping`, send its own ping every 20 s (keeps the MV3
  service worker alive). `chrome.alarms` every 30 s re-establishes the connection
  if the worker was suspended.
* Badge: green "on" when connected with ≥ 1 ready worker, yellow when connected
  without workers, red "off" when disconnected.

## Testing

`test/e2e/` contains a fake chatgpt.com (DOM in the 2026-09 layout and a
`/backend-api/f/conversation` endpoint that streams delta-v1 SSE, optionally
handing off to a WebSocket). Playwright launches Chromium with the unpacked
extension, routes `https://chatgpt.com/**` to the fake, and drives the real
`claude` CLI through the bridge. This validates the plumbing, not ChatGPT's
current DOM: when ChatGPT changes, update `SELECTORS` and the fake together.

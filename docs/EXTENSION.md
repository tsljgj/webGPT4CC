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
 ├─ owns the WebSocket to ws://127.0.0.1:<port>/extension  (pairing handshake, reconnect w/ backoff, ping every 20 s)
 ├─ worker-tab registry (chrome.storage.session; intent in chrome.storage.local) + "workers" announcements
 ├─ job orchestration: navigation (chrome.tabs.update), waiting for the page agent, relaying events
 └─ chrome.alarms keep-alive / reconnect
        ▲ chrome.runtime port per tab ("webgpt4cc-relay")
content/relay.js        ISOLATED world, document_start
 └─ forwards messages between the port and window.postMessage (source-tagged, same-window only)
        ▲ window.postMessage
content/page-agent.js   MAIN world, document_start
 ├─ network observer: wraps window.fetch and window.WebSocket in observe mode
 │   (worker tabs: every conversation stream of the page, so "generating" never depends on a label)
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

### Is ChatGPT generating? (network first)

The 2026-09 layout has no `data-testid`, and every label follows the account's
language (the primary user's UI is Simplified Chinese), so "a reply is
streaming" comes from the network. In worker tabs the agent tracks **every**
conversation stream of the page, not only its own jobs':

* an HTTP stream is open from its `POST …/f/conversation` (or `/resume`) until
  `message_stream_complete`, `[DONE]`, the end of the body or a fetch error; a
  `stream_handoff` keeps its WebSocket topics open until their `done` / `error`
  envelope (or a `message_stream_complete` inside them);
* topics seen only on the WebSocket (a page that re-subscribed after a reload)
  count too;
* nothing stays open forever: an HTTP stream without traffic for 10 min, a topic
  without traffic for 120 s, and, after we asked ChatGPT to stop, anything
  silent for 4 s counts as ended.

`isGenerating()` = open streams, else a labelled stop control (test ids, English
and zh/ja labels), else `[data-markdown-animated]` on the last answer inside a
turn (ignored once its text has not changed for 60 s, so a stuck attribute can
not block a tab). It gates readiness, `prepare()`, cancel and the read-back.

### What the request body tells us

The conversation POST body is the authoritative record of what ChatGPT got
(read from `init.body`, a `Blob`/buffer, or a `Request` cloned before the native
call):

* `conversation_mode.kind == "work"` or a `-wm` model: the turn runs in Work
  mode (another quota, server-side agentic tools): stop it, fail `aborted`.
  The stream's `server_ste_metadata` (`product_experience`,
  `requested_model_experience`, a `-wm` slug) and a `WEB:` conversation id are
  checked as well.
* `model` differs from the job's model (e.g. `?model=` was ignored): status
  `model_mismatch`, `done.actualModel`; the bridge logs a warning.
* `messages[0].content.parts` is compared with the prompt exactly (only
  whitespace at the very start and end may differ). A strict, much shorter
  prefix is a size cut: stop, fail `too_long`. Any other difference is
  classified (`backslash-escape`, `tabs-or-spaces`, `trailing-whitespace`, …)
  and reported as status `prompt_mismatch` and `done.promptMismatch`.
* `messages[0].id` pins our turn for the read-back.

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
| send (labelled) | `button[data-testid="send-button"]`, `#composer-submit-button[data-testid="send-button"]`, `button[data-testid*="composer-send"]`, `[data-composer-submit]`, `form button[type="submit"]`, `button[aria-label="Send prompt"]`, `button[aria-label*="Send" i]`, `form button[aria-label*="发送"]` (+ zh-TW, ja) |
| primary composer button (2026-09) | `form[data-chatgpt-composer] button.bg-composer-primary`, `form[data-chatgpt-composer] button.size-token-button-composer`, `#composer-submit-button`: `type="button"`, no test id, its localized label cycles Start Voice → Send → Stop |
| stop (labelled) | `[data-testid="stop-button"]`, `[data-testid="composer-stop-button"]`, `form button[aria-label="Stop"]`, `form button[aria-label*="stop" i]:not(dictation/voice/read aloud)`, `form button[aria-label^="停止"]:not(听写/语音/朗读)`, `form button[aria-label*="を停止"]` |
| streaming answer | `[data-markdown-animated]` inside a turn |
| pasted-text chip | `form button[aria-label^="Remove Pasted text"]` |
| Chat/Work switch | `[role="group"][aria-label="Composer mode"] button`, then toggles inside the composer form (`[role=group] button`, `[role=radio]`, `[role=tab]`, `button[aria-pressed]`, `[data-mode]`, `button[value]`) classified by `data-mode`/`data-value`/`value`, then by labels (work/工作/ワーク, chat/聊天/对话/チャット) |
| login CTA (secondary) | `a[href*="/auth/login"]`, `button[data-testid*="login"]`, buttons whose text is "Log in"/"Sign up"/"登录"/"免费注册"/"ログイン"/…; the session endpoint decides |
| warnings | visible `[role=alert]`, `[role=status]`, `[role=dialog]`, `[role=alertdialog]`, `[aria-live]`, `[data-testid*=toast i]`, `[data-testid*=banner i]`, `[class*=text-error]`; classified in English, zh-CN, zh-TW and ja |
| Cloudflare | widget (`#challenge-form`, `#challenge-running`, `#cf-challenge-running`, challenge iframes) or title ("Just a moment", "请稍候", …) without the app shell; the `/challenge-platform/` script alone (healthy pages load it too) only on a short page without the app shell for 12 s |

Job steps:

1. Wait (MutationObserver + bounded polling) up to 30 s for the composer, for
   no reply streaming in the tab and for nobody typing in it. If a login CTA is
   visible and no composer → `not_logged_in`. If a throttle dialog or usage-cap
   text (English, zh, ja) is visible → `rate_limited` (with the reset time when
   the text has one). Then ask `/api/auth/session` (cached 60 s): a logged-out
   page still shows a working guest composer → `not_logged_in`.
2. Chat mode: a `/c/WEB:…` (Work) conversation → `conversation_not_found` (the
   bridge replays into a new Chat). If the Chat/Work switch shows Work
   selected, click Chat and verify it; still Work → `aborted`, nothing sent.
3. Focus the composer (click + focus + collapse selection to end), clear it, and
   remember the primary composer button's label (with an empty composer it is
   the voice button).
4. **Insert the prompt by synthetic paste in chunks of ≤ 4000 characters**
   (`ClipboardEvent('paste', {clipboardData: DataTransfer{text/plain, text/html with <br>}})`),
   never splitting a surrogate pair or CRLF. Never type `\n` keys (ProseMirror may submit).
5. Verify: read the editor text (text nodes; `<br>` → `\n` except
   `.ProseMirror-trailingBreak`; block boundaries `P/DIV/PRE/LI` → `\n`) and compare
   to the prompt after normalising line endings and trailing whitespace (the
   exact check is on the request body, step 7). If it differs, or the
   pasted-text chip count grew, clear the composer and fail with `too_long`
   (chip, or a large prompt cut to a prefix) or `ui_error` (mismatch). Nothing
   is sent in that case.
6. Arm the network observer, report status `sending`, wait ~500 ms, then find
   Send: a labelled send button, else the primary composer button, but only
   while no reply streams and only if its label changed since step 3 (so voice
   mode is never started). Nothing send-like at all after 1 s: press Enter at
   once instead of waiting 5 s. Right before the click, re-check that the
   composer holds exactly the prompt (someone typing in the tab → `ui_error`,
   nothing sent).
7. Confirm submission: the observer sees the conversation request within 20 s
   (else `ui_error: send did not start a request`); a 429 on Sentinel / conduit
   prepare after the click → `rate_limited` at once. Check the request body
   (see "What the request body tells us"). Emit `status: submitted`.
8. Stream: emit `text` events (whole answer text so far) at most every 250 ms.
   Emit `status: thinking` while only reasoning messages are arriving.
9. Done on `message_stream_complete`, `[DONE]` with a finished answer, or WS `done`.
   If the stream breaks, stalls (no SSE event / WebSocket item for 180 s;
   keep-alives do not count) or was not observed: read the answer from
   `GET /backend-api/conversation/{id}` with the bearer token from
   `/api/auth/session` and the page's own `Chatgpt-Account-Id` / `oai-*`
   headers (workspace accounts need the account id; else it comes from the
   `_account` cookie via `/backend-api/accounts/check`). The answer is pinned to
   our user message (`messages[0].id`, else the prompt text), never the
   previous turn's. While the answer is `in_progress`, keep polling (every 3 s,
   backing off to 15 s after 30 s) until the job's deadline; give up after 90 s
   without our turn, at once on 403 / a challenge / 404 (then wait for the page
   to finish and use the streamed text only if ChatGPT marked it finished).
10. HTTP status ≥ 400 on the conversation request → map: 429 → `rate_limited`
    (use `detail.clears_in` seconds when present), 401/403 → `not_logged_in`
    (or `network` if the body is a Cloudflare page), 413 or "too long" → `too_long`,
    else `network`.
11. `max_tokens` finish: report `finishReason: "max_tokens"` (the bridge tells
    Claude Code; no auto-continue in v0.1).

Cancel: click the stop control (a labelled one, else the primary composer
button while a stream is open; if the request is just being sent, as soon as it
shows up), and report `error: aborted` once the page stopped streaming (at most
4 s). Until the stream really ends, the tab reports `generating` and is not ready.

Worker pages also report their state every 10 s (heartbeat) and hold a Web Lock,
which keeps Chrome from freezing them.

## Service worker

* Settings in `chrome.storage.local` (made trusted-contexts only where Chrome
  supports it): `bridgeUrl` (default `http://127.0.0.1:8765`), `token`,
  `enabled` (default true), `maxWorkers` (default 3), `allowRemoteBridge`.
  Unencrypted `ws://`/`http://` is accepted only for loopback hosts (127.0.0.0/8,
  `::1`, `localhost`) unless `allowRemoteBridge` is set; otherwise use
  `wss://`/`https://`. A refused URL keeps the previous one and never triggers a
  reconnect, so a storage write cannot redirect the connection off the machine.
* Bridge connection: the pairing handshake of PROTOCOL.md §2 before anything
  else; nothing identifying (worker list, conversation URLs) goes to a peer
  that has not proven the token, and no job from it is run.
* Worker tabs in `chrome.storage.session` (`workerTabIds`), so they survive a
  service-worker restart; their intent (`{pinned, url}` per worker) also in
  `chrome.storage.local`, so after a browser restart or an extension reload the
  restored worker tabs are adopted again (pinned: any restored pinned
  chatgpt.com tab; "Use this tab" workers: only a tab at the same URL). "Open
  worker tab" creates a pinned chatgpt.com tab and sets `autoDiscardable: false`.
  Closing a tab removes it. No `tabs` permission: the chatgpt.com host
  permission reveals the URLs needed, and only chatgpt.com URLs are ever reported.
* A worker is `ready` when its relay port is connected, the page agent reported
  `ready` (composer found, nothing streaming, logged in, nobody typing) within the
  last 75 s, and Chrome has not frozen or discarded the tab (`tabs.onUpdated`
  `frozen`/`discarded`). A running job in a frozen or silent tab fails with a
  hint instead of hanging until the job timeout.
* Jobs: if `job.url` differs from the tab's location in a way that matters
  (new chat: always navigate unless the tab is already on a fresh, empty chat at
  that exact URL; continue: navigate unless the tab already shows
  `/c/<conversationId>` or holds that temporary conversation; a navigation still
  pending in the tab always means "navigate"), call `chrome.tabs.update(tabId, {url})`
  and wait (45 s) for the new document: a new relay port and page id, at the
  job's URL (a new chat never runs on some other `/c/…`), and showing a
  composer or a login screen (or settled for 8 s without a Cloudflare check), so
  `run` never goes into an interstitial. Then send `run`. If the page reloads
  before the agent reported `sending`, wait for the new document and send `run`
  again (up to 3 times); after `sending`, a reload fails the job. A job
  cancelled while navigating keeps the tab reserved until the navigated document
  took over (or 10 s), so the next job cannot land in a document about to be
  replaced. Only URL shapes the bridge builds are opened (PROTOCOL.md §2).
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
`claude` CLI through the bridge (`chain.test.ts`) or the provider directly
(`locale.test.ts`, `lifecycle.test.ts`). The fake has a zh-CN mode with no
`data-testid`, localized labels (overridable with texts no selector knows) and
the cycling `type="button"` primary composer button, a mode that ignores
synthetic Enter, a guest composer, limit banners, Sentinel 429s, answers that
stay `in_progress`, workspace accounts and an ignored `?model=`. This validates
the plumbing and the label-independent paths, not ChatGPT's current DOM: when
ChatGPT changes, update `SELECTORS` and the fake together.

Unit tests (`extension/test/`): `stream-core.test.mjs` (pure logic, including the
localized classifiers, prompt-fidelity comparison and Cloudflare verdict) and
`background.test.mjs` (the service worker in `node:vm` with a mocked `chrome.*`
and a scripted bridge: handshake, URL policies, reloads, cancels, frozen tabs,
re-adoption).

> Research note from the initial build (2026-10-09). The raw workspace referenced as `<research-workspace>` (captures, clones, scripts) was not preserved; the findings below are.

# ChatGPT web (chatgpt.com) internals for driving it from a Chrome MV3 extension: research report, track "chatgpt"

Prepared 2026-10-09. chatgpt.com could not be reached from this machine. Everything below comes from open-source code that drives or extends ChatGPT, cloned with git and read in full; commit hashes and dates are given for each source. The proxy blocked jsdelivr, unpkg, openai.com, help.openai.com, releases.sh and the GitHub API. Open Terms Archive was used for the Terms text. WebSearch was used for plan limits and release notes.

Excerpt files, all under `<research-workspace>/chatgpt/`:
`excerpt-oracle.md`, `excerpt-chatgpt-dom-2026-09.md`, `excerpt-sse-devtools-panel.md`, `excerpt-g4f.md`, `excerpt-openweb.md`, `excerpt-chatgpt-exporter.md`, `excerpt-chatgptjs.md`, `excerpt-mcp-superassistant.md`, `excerpt-openai-terms.md`. Full clones are in `src/`.

## 0. Sources, newest first

| Source | Commit / date | Why it matters |
|---|---|---|
| **steipete/oracle** (CLI that drives chatgpt.com over CDP) | `35d8022` 2026-10-07; release 0.21.4 on 2026-10-01 | Most current selectors. Covers the new **Chat/Work layout**, the chunked-paste composer insertion, completion gates, rate-limit detection, the Cloudflare note and in-page `GET /backend-api/conversation/{id}`. |
| frontierkodiak/oracle PR #20/#19 (fork) | `2c2f6461`, `72f4a7d0` 2026-09-25 | Documents the 2026-09-25 DOM and picker change. |
| **xtekky/gpt4free** `OpenaiAccount.py`, `OpenaiChat.py`, `ChatGPT.py` | `d27404d` 2026-10-08; OpenaiAccount last changed 2026-10-05 | Current request flow, body and headers for `/backend-api/f/conversation` (reference only; we will not reimplement it). |
| **UnlastingR/sse-devtools-panel** (MV3 extension that passively captures ChatGPT SSE) | `1d5780b` 2026-10-05 | **Closest prior art to our extension.** MAIN-world fetch and WebSocket hooks, a full delta-v1 reducer, Work/WS handoff and resume. |
| pionxzh/chatgpt-exporter (userscript) | `4c8fe6e` 2026-09-27 | Conversation JSON types, temporary-chat id discovery, auth headers. |
| KudoAI/chatgpt.js (`@kudoai/chatgpt.js` 4.15.12, npm 2026-08-27) | `43f377e` 2026-08-10 | Long-maintained selectors, untrusted-event send path. |
| imoonkey/openweb `src/sites/chatgpt` | `65c55f5` 2026-04-24 | Explains why direct POST fails (Sentinel/PoW) and confirms the request sequence. |
| maxiloEmmmm/web-model (MV3 bridge extension + local server) | `11241d6` 2026-04-06 | Same architecture as ours: `execCommand` insert, offscreen keepalive, MAIN-world fetch hook, background-tab note. |
| srbhptl39/MCP-SuperAssistant | adapter dated 2025-10-27 | Inserts via innerHTML `<p>` plus an `input` event, then clicks send. |
| lanqian528/chat2api | `a63a90c` 2025-03-28 (stale) | Older 429 `detail.clears_in` format only. |
| OpenTermsArchive/genai-versions | `2bbdea9` 2026-10-08 | Verbatim OpenAI Terms text. |

## 1. DOM

### 1.0 Main point (high confidence)
**ChatGPT changed its DOM again on 2026-09-25, rolling it out in stages, so both shapes can be live at once.** From the frontierkodiak commit `72f4a7d0`:
> "ChatGPT's frontend stopped rendering `article[data-testid^="conversation-turn"]`, `data-message-author-role` and `.markdown`. Each message is now a `[data-content-search-unit-key="<turn>:<index>:<role>"]` unit inside a turn group, the answer body carries `data-chatgpt-selection-message-id`, and the assistant's action bar sits in the group after the unit."

The sanitized live recordings in `oracle/tests/fixtures/chatgpt-dom-2026-09/{streaming,completed}.html`, added 2026-09-29, contain **no `data-testid` at all and no `#prompt-textarea`**. Steipete's 0.21.4 notes describe this as the "Chat/Work composer".

**Recommendation:**
- Use **network capture as the primary channel** (section 3).
- Use the DOM only for input, send, stop and coarse state.
- Write every selector as a fallback chain that covers both shapes.

### 1.1 Composer element
- **New layout (Sept 2026):**
  `form[data-chatgpt-composer] > … <div contenteditable="true" aria-multiline="true" role="textbox" class="ProseMirror" data-composer-markdown aria-label="Ask ChatGPT" data-virtualkeyboard="true"><p data-empty-paragraph="true" data-placeholder="Ask ChatGPT" class="placeholder"><br class="ProseMirror-trailingBreak">`
  This is from the fixture. High confidence.
- **Old layout:** `#prompt-textarea`, which is a ProseMirror contenteditable div.
  - chatgpt.js `getChatBox()` returns `document.getElementById('prompt-textarea')`.
  - web-model uses `#prompt-textarea[contenteditable='true'][role='textbox']`.
- **Before hydration:** `#pending-home-input`, a plain textarea rendered before React mounts (oracle `PRE_HYDRATION_PROMPT_SELECTOR`).
- **Hidden fallback textarea:** `textarea[name="prompt-textarea"]` (oracle `PROMPT_FALLBACK_SELECTOR`).
- **Mobile layout:** `#mobile-composer-prompt`, with submit `[data-composer-submit]` (g4f `OpenaiChat.py` L1571/L1592).
- Oracle's input selector chain (`constants.ts`), recommended verbatim:
```js
['form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]','textarea[data-id="prompt-textarea"]',
 'textarea:not([disabled]):not(#pending-home-input)','textarea[name="prompt-textarea"]','#prompt-textarea','.ProseMirror',
 '[contenteditable="true"][role="textbox"]','[contenteditable="true"][data-virtualkeyboard="true"]']
```

### 1.2 Inserting text: what works in 2026
| Method | Evidence | Confidence |
|---|---|---|
| **Synthetic `ClipboardEvent('paste')` carrying a `DataTransfer` (text/plain + text/html), in chunks of 4,000 characters or less** | oracle 0.21.4 (2026-10-01) default path for multi-line prompts, verified against live ChatGPT. ChatGPT's paste handler accepts untrusted paste events, and the "Pasted text" conversion is triggered by these events too. | **High** |
| `document.execCommand('insertText', false, text)` after `focus()` and clearing `textContent` | web-model (2026-04) | Medium. Newline handling in ProseMirror is risky. |
| Replace the `<p>` (or set innerHTML to `<p>text</p>`), then `dispatchEvent(new Event('input',{bubbles:true}))` | chatgpt.js `send()` (2026-08), MCP-SuperAssistant (2025-10). ProseMirror's DOMObserver re-parses the change. | Medium. Fine for single-line text; multi-line needs one `<p>` per line. |
| Set `textContent` and dispatch `InputEvent('input',{inputType:'insertFromPaste'})` | Oracle uses this only as a last-resort fallback. | Low–medium |
| CDP `Input.insertText` or trusted keys | Oracle uses these; we could only get them through `chrome.debugger`, which shows an infobar. | High, but not practical for us |

Oracle's paste core, quoted from `promptComposer.ts` L150-190:
```js
// ChatGPT converts a single large paste (seen above ~10k chars) into a "Pasted text"
// file chip and leaves the editor empty, so paste in chunks well under that size.
const CHUNK = 4000;
const chips = () => document.querySelectorAll('form button[aria-label^="Remove Pasted text"]').length;
editor.focus();
for (let i = 0; i < text.length;) { let end = Math.min(i + CHUNK, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;   // don't split surrogate pairs
  const data = new DataTransfer(); const chunk = text.slice(i,end).replace(/\r\n?/g,'\n');
  data.setData('text/plain', chunk);
  const p = document.createElement('p'); p.style.whiteSpace='pre-wrap'; p.textContent = chunk;
  data.setData('text/html', p.outerHTML.replace(/\n/g,'<br>'));
  editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  i = end; }
// verify: walk editor DOM (BR => \n except .ProseMirror-trailingBreak; P/DIV/PRE/LI boundaries => \n),
// compare to expected; abort if mismatch or chip count increased.
```
Other notes from oracle:
- "Learned: React/ProseMirror require a real click + focus + selection for inserts to stick." Oracle collapses the selection to the end of the editor before inserting.
- "ProseMirror can treat typed newlines as submission; paste without pressing Enter." Never type `\n`.
- Very large prompts can be **silently truncated**. Oracle fails fast when the observed length is shorter than `promptLength - 2000` for prompts of 50k characters or more.
- Oracle pastes up to about **60k characters** inline and switches to file uploads above that.

**Long-paste-to-attachment threshold** (from the official ChatGPT release notes, quoted via WebSearch; medium-high confidence):
- On **2026-06-22**, pastes over **10,000 characters** started converting to an attachment for Free and Go users. Plus, Pro and Business already had this behavior, previously at **5k**, and the threshold was raised to 10k.
- On **2026-08-04**, the behavior reached Enterprise and Edu.
- **"Show in text field"** on the chip converts the attachment back to inline text.
- Chip selector: `form button[aria-label^="Remove Pasted text"]` (oracle).
- **Conclusion:** split pastes into chunks under 10k (4k is safe) and check that the chip count did not increase.

### 1.3 Send, stop and mode controls
- **Send button:**
  - Old layout: `button[data-testid="send-button"]`. Also `#composer-submit-button`, a single button whose `data-testid` switches between `send-button` and `stop-button`; when the composer is empty it becomes the voice button (`button.composer-submit-button-color:not(#composer-submit-button):not([data-testid])`) (web-model, 2026-04).
  - New layout: oracle tests use `aria-label="Send prompt"`.
  - Recommended chain (oracle `SEND_BUTTON_SELECTORS`): `button[data-testid="send-button"]`, `button[data-testid*="composer-send"]`, `form button[type="submit"]`, `button[type="submit"][data-testid*="send"]`, `button[aria-label*="Send"]`, plus `[data-composer-submit]`.
  - Treat the button as enabled only if it has no `disabled`, `aria-disabled!="true"`, `data-disabled!="true"`, and a bounding rectangle larger than 0.
  - After inserting text, wait about 500 ms before sending: oracle notes "send button can be disabled briefly".
- **Submitting with untrusted events:**
  - chatgpt.js dispatches `new KeyboardEvent('keydown',{key:'Enter',bubbles:true})` on the editor; on mobile it calls `sendBtn.click()`.
  - web-model dispatches keydown, keypress and keyup Enter (`keyCode:13`), then falls back to `button.click()`.
  - Both are maintained, so untrusted Enter and click evidently work (medium confidence). Oracle uses trusted CDP input only for robustness.
  - Always confirm the commit afterwards: the user turn appears, the composer clears, and the stop button or network request appears. Oracle: "the send button can succeed but the turn doesn't appear immediately".
- **Stop button:**
  - Old: `[data-testid="stop-button"]`.
  - Also `[data-testid="composer-stop-button"]`.
  - New: `form button[aria-label="Stop"]` (fixture).
  - Oracle warns not to match "stop" across the whole document because read-aloud and dictation controls also contain it. Its scoped fallback is `form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])`.
- **Chat/Work mode switch:**
  - Control: `[role="group"][aria-label="Composer mode"]` with buttons "Chat" and "Work" (or `button[role="radio"]`); the selected one has `aria-pressed`/`aria-checked="true"` or `data-state="on"`.
  - Work conversations show a "work" badge in the sidebar, and their ids use the prefix `WEB:` (oracle docs).
  - **Force Chat mode.** Work streams over WebSocket, uses agentic tools and `*-wm` model slugs.
- **Model picker:**
  - Old: `[data-testid="model-switcher-dropdown-button"]`.
  - New (2026-09-25): `button[data-codex-intelligence-trigger="true"]`, `aria-label="Select ChatGPT model"`; the visible text shows only the effort tier.
  - The menu has two panes under `[data-model-picker-view]`: an effort slider and a model-radio pane (radios such as "Latest" and "GPT-5.6 Sol").
  - Effort tiers: light, standard, extended, extra-high, pro. A quota-limited four-tier variant stops at Extra High.
  - Medium confidence; this changes often.

### 1.4 Assistant messages, regenerate, continue, errors
- **Turn and message selectors, written to accept both shapes** (oracle `constants.ts`):
```js
TURN = '[data-turn-key], article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"], article:is([data-message-author-role],[data-content-search-unit-key],[data-chatgpt-search-unit-key]), … article[data-turn], div[data-turn], section[data-turn]'
ASSISTANT = ':is([data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]), [data-turn="assistant"]'
```
- **Message id:**
  - Old: `data-message-id`.
  - New: `data-chatgpt-selection-message-id`, or the first entry of `data-chatgpt-search-message-ids`.
  - Turn key: `data-turn-key="<uuid>"`.
  - Role: `h4[data-conversation-role="assistant"]` ("ChatGPT said:").
  - Markdown root: `[data-markdown-text-style="assistant-message"]` (class `MarkdownRoot-*`); `data-markdown-animated` is present while streaming.
  - Turns can be virtualized and unmounted (`data-virtualized-turn-content`).
- **Raw markdown from the DOM** (oracle, medium confidence): temporarily override `navigator.clipboard.writeText` and `.write` in the MAIN world, click the turn's Copy button, capture the string, then restore the originals.
  - Copy button, old: `button[data-testid="copy-turn-action-button"]`.
  - Copy button, new: `.turn-action-controls button[aria-label="Copy"]`. Use the turn-level button, not the per-code-block Copy.
- **Finished-turn action bar** (positive evidence of completion), oracle `FINISHED_ACTIONS_SELECTOR`: `.turn-action-controls button[aria-label="Copy"|"Rate response"|"Regenerate response"]`, `button[data-testid="copy-turn-action-button"|"good-response-turn-action-button"|"bad-response-turn-action-button"]`, `button[aria-label="Share"]`. Labels are localized; for ja-JP they are コピーする and 回答を再生成.
- **Regenerate:**
  - New: `aria-label="Regenerate response"`.
  - Old: `button[data-testid*=regenerate]` (the oval "Try again" button that replaces the chat bar on errors) and `button:has(use[href$=".svg#ec66f0"])` (chatgpt.js).
- **Continue generating:** chatgpt.js uses `button:has(svg > use[href$="#ee0f3c"])`, which depends on a sprite id and is fragile (low confidence). A better signal is the stream: `finish_details.type == "max_tokens"`; g4f then re-posts with `action:"continue"`.
- **Errors and rate limits** (oracle `uiWarnings.ts` and `chatgptThrottle.ts`; high confidence for the patterns):
  - Scan visible `[role=alert]`, `[role=status]`, `[role=dialog]`, `[aria-live]`, `[data-testid*=toast i]`, `[data-testid*=banner i]`, `[data-testid*=error i]`, `[class*=toast i]` and `[class*=banner i]`, plus chatgpt.js `div.toast-root` and `div[class*=text-error]`.
  - Classify by regex:
    - `rate_limit`: "too many requests", "sending too many requests", "too quickly", "temporarily limited access", "please wait a few minutes", "rate limit(ed)", "slow down".
    - `temporary_unavailable`: "temporarily unavailable", "something went wrong", "failed to generate", "try again later".
    - `auth_or_challenge`: "verify you are human", "unusual activity", "cloudflare", "challenge", "login required", "sign in".
  - The **throttle modal** reads "Too many requests … We've temporarily limited access to your conversations … Please wait a few minutes" and has a single "Got it" button. Oracle observed: "six ChatGPT conversations opened at once triggered it repeatedly, while five did not". **Keep concurrent tabs at 3 or fewer** (oracle's default).
  - Usage-cap wording varies by plan and model. The pattern is roughly "You've hit the … limit … responses will use … until your limit resets …" (low confidence on exact text). Match on `/limit/i` together with `/reset|until/i`.
- **Completion announcement** in the new layout: `[role="status"][aria-live="polite"]` text becomes **"Response complete"** (ja: 回答が完了しました). Accept it only after it was observed changing from incomplete to complete while the new assistant turn exists (oracle `completionAnnouncement.ts`).

### 1.5 Detecting that generation finished (recommended order)
1. **Network (best):** any of the following:
   - `{"type":"message_stream_complete"}`;
   - `data: [DONE]`;
   - a delta patch on the final-channel assistant message setting `/message/status = "finished_successfully"` together with `/message/end_turn = true`;
   - for a WebSocket handoff, the topic payload `{type:"done"}`.
   - Note that **the page may abort the fetch after `message_stream_complete`, so an AbortError afterwards is normal** (sse-devtools-panel `stream-close.ts`).
2. **DOM (fallback):** stop control is absent, AND the finished-action bar has been present for at least 3 consecutive polls, AND the content has not changed for at least 1.2 s (oracle `classifyTurnTerminal`). Do not finalize on "stop gone and text stable" alone; oracle saw GPT-5.5 Pro preambles settle and then continue.
3. **Server truth:** `GET /backend-api/conversation/{id}` (section 3.5).
4. Simple pattern (chatgpt.js): wait for the stop button to appear, then for it to disappear, using a MutationObserver. It is unreliable for thinking models.

## 2. URLs and models
- **New chat:** `https://chatgpt.com/`. **Conversation:** `/c/<uuid>`; the SPA navigates there once the id exists (openweb parses `/\/c\/([0-9a-f-]{36})/`). **Project:** landing at `/g/g-p-<id>-<slug>/project`, conversations at `/g/<project>/c/<id>`. High confidence.
- **Temporary chat:** `https://chatgpt.com/?temporary-chat=true`. **Works in 2026** (oracle, chatgpt-exporter `isTemporaryChat()` 2026-09, chatgpt.js 2026-08). High confidence.
  - **The temporary chat id never appears in the URL.** Read `conversation_id` from the stream.
  - Pro models were rejected in Temporary Chat (oracle 0.7.2, 2025-12) but are allowed since oracle 0.11.1 (2026-05-10).
  - Temporary chats skip memory but **still apply Custom Instructions** (2024–25 sources, medium confidence). Warn users.
- **`?model=<slug>`: not confirmed for 2026** (low confidence that it still selects the model).
  - Oracle never uses it. It drives the picker, and its test data shows `https://chatgpt.com/?model=gpt-5.6-sol` being rewritten to drop the query.
  - Recommendation: try `?model=`, then verify the model from the stream (`server_ste_metadata.metadata.model_slug` or `resolved_model_slug`, or the message `metadata.model_slug`); if it differs, drive the picker.
- **`?q=<prompt>`:** auto-submits a prompt (g4f uses `/?q=Hello` and `/#q=Hello` for the guest UI). URL length makes it unusable for our prompt sizes.
- **Model slugs actually observed** (stream metadata and fixtures, Sept–Oct 2026):
  - `auto`, `gpt-5-6-thinking`, `gpt-5-6-pro`, `gpt-5-5-thinking`, `gpt-5-4-thinking`, `gpt-5-4-auto-thinking`, `gpt-6-luna-wm` (Work-only; `*-wm` means Work model).
  - Picker test ids: `model-switcher-gpt-5-5`, `-gpt-5-5-thinking`, `-gpt-5-5-instant`, `-gpt-5-4`, `-gpt-5-3(-instant|-thinking)`, `-gpt-5-2(-instant|-thinking)`, `-gpt-5-pro`, `-gpt-5-6`.
- **Picker labels mapping** (oracle `browserConfig.ts`, 2026-09):
  - `gpt-6-pro`/`gpt-6-astra` map to the "Latest" radio (Pro tier pill "6 Pro").
  - `gpt-5.6(-sol)` maps to "GPT-5.6 Sol".
  - `gpt-5.5` maps to "Thinking 5.5"; `gpt-5.5-instant` maps to "GPT-5.5 Instant".
  - The GPT-5.2 base, Instant and Thinking entries are retired from the picker.
- **Release-note context** (WebSearch; medium confidence):
  - Model selection moved into the composer in May 2026; the picker was simplified in June 2026.
  - **2026-09-14:** automatic Instant-to-Thinking switching retired for Plus and Pro.
  - **2026-09-22:** GPT-6 Sol and Luna released in **Work and Codex only, not Chat**.
  - 2026-09-29: GPT-6.1 Sol.
  - The **list endpoint** `GET /backend-api/models` returns `models[].slug,title` (openweb `getModels`) and is the reliable way to enumerate slugs at runtime.

## 3. Backend

### 3.1 Auth and session
- `GET /api/auth/session` uses cookie auth and returns `{accessToken, expires, user:{id,email,name,image,picture,idp,iat,mfa,groups,intercom_hash}, authProvider}`. High confidence.
- Read endpoints take `Authorization: Bearer <accessToken>`.
- Team and workspace accounts also need `Chatgpt-Account-Id: <account_id>`. The id comes from the `_account` cookie mapped through `GET /backend-api/accounts/check/v4-2023-04-27` (chatgpt-exporter).
- Other endpoints:
  - `/backend-api/me`
  - `/backend-api/conversations?offset&limit&order=updated&is_archived`
  - `/backend-api/conversation/{id}` (GET; PATCH `{is_visible:false}` deletes)
  - `/backend-api/files/download/{id}`
  - `/backend-api/gizmos/snorlax/sidebar` (projects)
- Relevant cookies:
  - `__Secure-next-auth.session-token(.0/.1)`
  - `_account` (workspace)
  - `oai-did` (device id, equal to the `oai-device-id` header)
  - `_puid`
  - `cf_clearance`
  - **`conv_key_<conversationId>`**: these accumulate. Oracle 2026-07-06 notes that stale ones cause "header-size failures". Prune them with `chrome.cookies`.
- **Cloudflare** (oracle `navigation.ts`, "Learned 2026-05-16"):
  > "/backend-api/* endpoints now sit behind Cloudflare bot mitigation. Programmatic fetch from the page can return 403 with cf-mitigated:challenge even when the user is logged in."

  Treat in-page backend fetches as best-effort. Detect an HTML or `cf-mitigated` body.

### 3.2 Sending a message: the page's request sequence (reference only; the page does all of this)
g4f `OpenaiAccount.py` 2026-10-05; openweb DOC 2026-04. High confidence.
1. `POST /backend-api/sentinel/chat-requirements/prepare`, body `{p:<requirements token>}`, returns `{prepare_token, proofofwork:{required,seed,difficulty}, turnstile:{required}}`.
2. `POST /backend-api/sentinel/chat-requirements/finalize`, body `{prepare_token, proofofwork?, turnstile?}`, returns `{token}`. The older single call `/backend-api/sentinel/chat-requirements` still exists in g4f's "classic" mode.
3. `POST /backend-api/f/conversation/prepare` (same body shape, `client_prepare_state:"none"`, `client_prepare_dispatch:"immediate"`, `client_prepare_source:"context_change"`) returns `{conduit_token}`.
4. `POST /backend-api/f/conversation` with `accept: text/event-stream` returns the SSE stream.
   - Also `/backend-api/f/conversation/resume` to resume an interrupted stream.
   - The legacy `/backend-api/conversation` POST is gone for sending.
   - The anonymous guest flow moved to `/unauth-mweb/…`, which returns HTML partials.

**Headers the page adds** (for awareness):
- `authorization`
- `oai-device-id`, `oai-session-id`, `oai-language`, `oai-client-version`, `oai-client-build-number`, `oai-telemetry`
- `openai-sentinel-chat-requirements-token`, `openai-sentinel-proof-token`, `openai-sentinel-turnstile-token`
- `x-conduit-token`
- `x-openai-target-path`, `x-openai-target-route`, `x-openai-web-frontend: core_web`
- `x-oai-turn-trace-id`, `x-oai-is-client-observation`
- Optional `x-openai-web-sse-compression`
- Direct replays return `403 {"detail":"Unusual activity has been detected from your device. Try again later."}` (openweb).

**Request body** (g4f 2026-10-05):
```json
{"action":"next","messages":[{"id":"<uuid>","author":{"role":"user"},"create_time":1.7e9,
  "content":{"content_type":"text","parts":["..."]},
  "metadata":{"serialization_metadata":{"custom_symbol_offsets":[]},"submission_mode":"manual_send"}}],
 "parent_message_id":"<last msg id | client-created-root>","conversation_id":"<omit for new/temporary>",
 "model":"auto","client_prepare_state":"success","timezone_offset_min":-120,"timezone":"Europe/Berlin",
 "conversation_mode":{"kind":"primary_assistant"},"enable_message_followups":true,"system_hints":[],
 "supports_buffering":true,"supported_encodings":["v1"],"client_contextual_info":{...},
 "paragen_cot_summary_display_override":"allow","force_parallel_switch":"auto",
 "local_function_names":["local.continue_in_work"],"history_and_training_disabled":true /* temporary */}
```
Use `action:"continue"` to continue after `max_tokens`. The extension can read this body in the MAIN-world fetch hook (`init.body`) to correlate our prompt with the stream.

### 3.3 Stream format: delta_encoding v1
Sources: the sse-devtools-panel reducer and tests (2026-10), g4f, and openweb. High confidence unless marked otherwise.

**Framing:**
```
event: delta_encoding
data: "v1"                                  <- JSON string (quoted)

event: delta
data: {"p":"","o":"add","v":{"message":{...full message...},"conversation_id":"…","error":null},"c":0}
event: delta
data: {"v":{"message":{...}}, ...}          <- message snapshot; becomes "current message"
event: delta
data: {"p":"/message/content/parts/0","o":"append","v":"Hel"}
event: delta
data: {"v":"lo"}                            <- implicit: reuse last p AND last o
event: delta
data: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":" world"},
                                {"p":"/message/status","o":"replace","v":"finished_successfully"},
                                {"p":"/message/end_turn","o":"replace","v":true},
                                {"p":"/message/metadata","o":"append","v":{"is_complete":true,"finish_details":{"type":"stop"}}}]}
data: {"type":"message_stream_complete","conversation_id":"…"}
data: {"type":"title_generation","title":"…","conversation_id":"…"}
data: [DONE]
```
The `"c"` counter field is low confidence.

**Operations** (the `o` field):
- `add` / `replace`: set the value.
- `append`: string concatenation, array push, or object merge (for `/message/metadata`).
- `remove`.
- `patch`: a list of child operations whose paths are joined onto the parent path.
- `truncate`: believed to exist (truncate to length `v`); low confidence. Implement it defensively.

**Implicit inheritance:** a frame without `p` or `o` reuses the previous ones. A frame `{v:{message}}` resets the current message and clears the last `p`/`o`.

**Top-level `type` values** seen (sse-devtools-panel `CHATGPT_WEB_TYPES`):
- `resume_conversation_token` (contains a JWT; never log it)
- `input_message` (echo of the user message)
- `message_marker` (not terminal)
- `server_ste_metadata`: `metadata.{model_slug, resolved_model_slug, requested_model_experience:"thinking"|"work", product_experience:"chat"|"work", turn_mode, resume_with_websockets:true, thinking_effort, …}`
- `message_stream_complete` (terminal)
- `conversation_detail_metadata`
- `safety_review_update`
- `url_moderation`
- **`stream_handoff`**, e.g. `{type:"stream_handoff", conversation_id, turn_exchange_id, options:[{type:"subscribe_ws_topic", topic_id:"conversation-turn-…"}]}`
- `title_generation` (g4f)
- **Errors:** a top-level `"error"` key that is non-null (g4f raises on `event.error`). An HTTP 429 JSON body `{"detail":{…,"clears_in":<sec>}}` was the older cap format (chat2api 2025; medium confidence).

**WebSocket handoff and resume:**
- The rest of a turn can arrive over `wss://ws.chatgpt.com/<…>/ws/user/<id>` as `{type:"message", topic_id:"conversation-turn-…", payload:{type:"conversation-turn-stream", payload:{type:"stream-item", stream_item_id, encoded_item:"<same SSE text>"}}}`, ending with `payload:{type:"done"}` or `{type:"error",message}`.
- Subscribe replies include `reply.catchups[]`; deduplicate by `stream_item_id`.
- Interrupted HTTP streams can be resumed with `POST /backend-api/f/conversation/resume`.
- **Our MAIN-world hook must patch `WebSocket` as well as `fetch`**, or fall back to the GET in section 3.5.

**Which message is the answer** (sse-devtools-panel `finalAssistantText`, matching exporter and oracle):
```ts
msg.role==='assistant' && (!msg.recipient || msg.recipient==='all') && msg.contentType==='text'
 && msg.metadata.is_visually_hidden_from_conversation!==true
 && (msg.channel==='final' || (msg.channel==null && msg.endTurn===true))
// also skip metadata.is_thinking_preamble_message===true (channel "commentary")
```
Everything else is not the answer:
- `content_type`: `thoughts` (`content.thoughts[].{summary,content,chunks,finished}`; streamed at `/message/content/thoughts/N/summary` and `/content`), `reasoning_recap` (`content.content` = "Thought for 12s"; `metadata.finished_duration_sec`), `code`/`execution_output` (`content.text`), `multimodal_text`, `tether_*`, `user_editable_context`, `model_editable_context`.
- Tool calls: `recipient` is `web.run`, `python`, `functions.exec`, `api_tool.call_tool`, `dalle.text2im`, or `canmore`.
- `channel: "commentary"` (progress and preambles).

**Sanitizing text:**
- Remove the private-use rich-UI markers `\uE200 … \uE202 … \uE201` (citations, `navlist`, `genui`, `products`), and stray `\uE203/\uE204/\uE206` (g4f, sse-devtools-panel).
- **Parse only the final-channel text for the tool protocol**, and instruct the model not to use web, Python, canvas or image tools.

### 3.4 Capturing the stream from the extension: recommended pattern
This mirrors sse-devtools-panel 1.2.6 (2026-10-05). High confidence.
- **Manifest:** MAIN-world content script at `document_start` (`"world":"MAIN"`), plus an ISOLATED bridge script that relays via `window.postMessage`.
- **Fetch hook:** wrap `window.fetch` with a Proxy. **Dispatch the native request first**, then observe it.
- **Do not `response.clone()` or `tee()` the ChatGPT conversation stream.** The commit "avoid cloning ChatGPT conversation streams" switched to *observe mode*: replace `response.body.getReader` with a wrapper that records each chunk the page itself reads. With this approach the page's own consumption drives our capture.
- **Match pathname** `=== '/backend-api/f/conversation' || === '/backend-api/f/conversation/resume'`.
- **Also wrap `WebSocket`** with a Proxy for `ws.chatgpt.com` (`patch-websocket.ts`).
- Decode with `TextDecoder({stream:true})` and use a standard SSE line parser that buffers partial lines.
- Excerpts are in `excerpt-sse-devtools-panel.md`.
- A simpler alternative, chatgpt-exporter's `temporaryChat.ts`, clones the response just to read `conversation_id`, then cancels its branch.

### 3.5 GET /backend-api/conversation/{id}
- **Shape:**
  - Top level: `{conversation_id, title, create_time, update_time, current_node, mapping, moderation_results[], is_archived, safe_urls?, default_model_slug?}`.
  - `mapping[nodeId] = {id, parent, children[], message|null}`.
  - `message = {id, author:{role:'system'|'user'|'assistant'|'tool', name?, metadata}, create_time, update_time, content, status:'finished_successfully'|'in_progress'…, end_turn, weight, recipient, channel, metadata:{model_slug, resolved_model_slug?, finish_details:{type:'stop'|'interrupted'|'max_tokens'}, is_complete, parent_id, is_visually_hidden_from_conversation, is_thinking_preamble_message, reasoning_title, finished_duration_sec, attachments[], content_references[], citations[]…}}`.
- **To get the answer:** walk from `current_node` up through `parent`, then apply the same answer filter as in 3.3.
- Oracle fetches this in-page (2026-09-14, `chatgptConversation.ts`): `fetch('/api/auth/session')` → `fetch('/backend-api/conversation/'+id,{credentials:'include',headers:{Authorization:'Bearer '+t, Accept:'application/json'}})`. A 403 or `text/html` response means challenged.
- **Temporary chats:** chatgpt-exporter (2026-09) says they "are served by the regular conversation endpoint once the id is known". The id must come from the stream. Medium-high confidence.

## 4. Background tabs
Medium confidence; there is little primary documentation.
- **Network reads keep working in a hidden tab** because promises resolve on network data, not on timers.
- **DOM updates lag.** web-model page-hook comment, translated from Chinese: "in background tabs DOM updates often lag", which is why they hook fetch. **Use network capture for completion.**
- **Timer throttling:**
  - Hidden tabs run timers about once per second.
  - "Intensive" throttling after 5 minutes hidden reduces chained timers to about once per minute (Chrome 88+).
  - Avoid `setTimeout` polling in the page; use MutationObserver or stream events.
- **Tab freezing:** Chrome 133+ with Energy Saver on freezes CPU-intensive tabs that have been hidden and silent for more than 5 minutes. Timers and promise resolvers pause. Exemptions are media capture, WebRTC with open channels, WebUSB/HID/Serial/Bluetooth and Web Locks; **plain WebSockets are not exempt** (developer.chrome.com blog, 2025-01-20).
- **Discarding:** Memory Saver can discard the tab. Call `chrome.tabs.update(tabId,{autoDiscardable:false})`, and tell users to add chatgpt.com to chrome://settings/performance "Always keep these sites active" or keep the tab in its own visible window.
- **Generation survives disconnects on the server.** ChatGPT resumes over `/resume` or WebSocket, and oracle recovers long Pro answers later by reopening the conversation. If the stream is lost, poll `GET /conversation/{id}` until `status=="finished_successfully"`.
- **Untrusted `focus()`, paste and `execCommand` in a background tab** are unverified (low confidence). Test early. The synthetic `paste` path relies on ProseMirror's selection rather than OS focus, so it is the best candidate.
- **MV3 service worker keepalive:**
  - Chrome 116+ keeps the worker alive while a WebSocket exchanges messages within 30 s (send a ping every 20 s).
  - web-model also uses an offscreen document (`reasons:["WORKERS"]`) that pings over a runtime port.
  - **Open the localhost WebSocket in the service worker, not in the chatgpt.com content script.** Chrome 142+ Local Network Access shows a permission prompt for public-origin to loopback requests, and extension origins with host permissions reportedly aren't affected. Medium-low confidence.

## 5. Plan limits
Only third-party sources and release-note quotes were reachable; help.openai.com was not.
| Item | Value | Confidence |
|---|---|---|
| Plus default model | about 160 messages per 3 h (rolling), then falls back to a mini model | Medium (many 2026 guides) |
| Plus Thinking (manually selected) | about 3,000 per week (rolling 7 days); at the cap a pop-up appears and Thinking becomes unselectable | Medium |
| Pro | effectively unlimited, with abuse guardrails. A new **$500/mo Pro tier** (2026-09-29) adds an "Ultrafast" GPT-6 Astra tier | Medium |
| Context window | 2025 (GPT-5 launch help article): Free 16k, Plus/Business 32k (Instant), Pro/Enterprise 128k, **Thinking 196k** on paid tiers. 2026 guides report Thinking about 256k for Plus (one says 400k for Pro); Instant figures vary (32k–54k) | Medium for 2025, low for 2026 |
| Per-message input | no published limit. More than 10k characters per paste becomes an attachment (official, 2026-06-22). Oracle inlines about 60k characters through chunked paste; community reports rejections around 14–17k characters in older versions | Medium |
| One guide claims caps were removed on 2026-08-06 | conflicts with other sources | Low |

**Implications:**
- The Claude Code system prompt plus tool definitions is large, likely 15–25k tokens or more (this belongs to another research track).
- **Default to a Thinking model** for context headroom. Instant on Plus may be 32k.
- Send only the new turns when continuing a conversation, to save context and quota.
- Concurrency: 5 or fewer conversations, 3 by default.
- Detect caps from UI banners or modals and from `server_ste_metadata`/`model_slug` changing to a mini model.

## 6. OpenAI Terms (for the README disclaimer)
Verbatim. Europe Terms "Updated: 16 January 2026" and ROW Terms (the archived snapshot is the 2024 version; openai.com shows ROW Terms dated 2026-01-01) both contain:
> "**What You Cannot Do** … you may not: … Attempt to or assist anyone to reverse engineer … our Services … ; **Automatically or programmatically extract data or Output** … ; **Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations** we put on our Services ; **Use Output to develop models that compete with OpenAI.**"

> "**Registration** … You may not share your account credentials or make your account available to anyone else…"

> Termination: "We reserve the right to suspend or terminate your access to our Services or delete your account if we determine…" (the Usage Policies say violations "may mean you lose access").

Suggested README disclaimer: this tool automates the consumer ChatGPT UI, which very likely conflicts with the clause on "automatically or programmatically extract … Output". Users accept the risk of account suspension. The tool doesn't bypass rate limits, Sentinel or Cloudflare, and runs only through the user's own logged-in browser. It is not affiliated with OpenAI. Do not share accounts, and do not use outputs to train models.

## 7. Recommendations for the extension design
1. **Inject:**
   - MAIN world at `document_start`: fetch and WebSocket observers in observe mode, and the delta-v1 reducer.
   - ISOLATED world: DOM driver.
   - Service worker: owns the localhost WebSocket.
2. **Per request:**
   - Make sure the tab is in Chat mode, not Work.
   - Choose the model, verifying it from the stream.
   - Paste the prompt in 4k chunks and verify the composer contents and the chip count.
   - Wait about 500 ms, then click send using the selector chain (fallback: Enter keydown).
   - Correlate the request through the MAIN-world hook: the POST body's `messages[].content.parts` should match our prompt.
3. **Read the stream:**
   - Assemble final-channel text, following any `stream_handoff` to its WebSocket topic.
   - Finish on `message_stream_complete` or the finished patch.
   - Fallback: DOM terminal gate, then `GET /conversation/{id}`.
4. **Error handling:**
   - Surface UI warnings with the classification in 1.4.
   - Map them to Anthropic-style errors: 429 `rate_limit_error`, 529 `overloaded_error`, 401/403 for auth or challenge.
5. **Hygiene:**
   - Prune `conv_key_*` cookies.
   - Set `autoDiscardable:false`.
   - Keep at most 3 tabs.
   - Never log `accessToken` or `resume_conversation_token`.
6. **Expect UI drift:** a large redesign happened 2026-09-25, and rollouts are staged. Keep selectors in one remotely updatable config. MCP-SuperAssistant does this with Firebase Remote Config.
> Research note from the initial build (2026-10-09). The raw workspace referenced as `<research-workspace>` (captures, clones, scripts) was not preserved; the findings below are.

# Prior art and lessons for webGPT4CC

**Track:** priorart · **Date:** 2026-10-09 · **Research workspace (untrusted, read-only):** `<research-workspace>/priorart/` (`clones/` holds about 27 shallow clones, `raw/` holds fetched READMEs and docs). Nothing in it was executed, and `/home/user/webGPT4CC` was not modified.

**Method.** I shallow-cloned and read the source of each project. "Last commit" means the HEAD date of that clone. Star counts come from GitHub search on 2026-10-09. Official Claude Code behaviour comes from `code.claude.com/docs/en/*.md`, fetched today.

**Confidence tags:** **[H]** I read it in code or official docs. **[M]** One credible source, or an inference from code. **[L]** Third-party blog or aggregator, or my own extrapolation.

---

## 0. Twelve takeaways

1. **No project yet runs the full Claude Code harness on ChatGPT web quota with tool calling.** [M]
   - Every "Claude Code on ChatGPT subscription" proxy uses the **Codex OAuth backend** (`chatgpt.com/backend-api/codex`), which is a different quota. Examples: raine/claude-code-proxy, insightflo/chatgpt-codex-proxy, CLIProxyAPI, AIClient-2-API, gpt-proxy.
   - The closest analogue is **ds2api**: DeepSeek *web* exposed as an Anthropic or OpenAI API, with prompt-based tool calling and Claude Code support.
   - The closest *transport* analogue is **maxiloEmmmm/web-model**: an MV3 extension plus a local WebSocket server, with a main-world fetch hook on `/backend-api/f/conversation`.
2. **The binding constraint is ChatGPT's per-account message quota, not tokens.** [M]
   - Every Claude Code `/v1/messages` call (each tool round trip, title generation, compaction, subagent turns, retries) would become one ChatGPT message.
   - The bridge must answer what it can locally, and must de-duplicate Claude Code's automatic retries.
3. **Prompt size is the second constraint.** [H] (oracle)
   - ChatGPT turns a single large paste (seen above about 10k characters) into a **"Pasted text" file chip** and leaves the editor empty.
   - Oracle pastes in chunks of at most 4,000 characters and verifies the result. It inlines up to about 60k characters, then switches to file uploads.
   - The Claude Code system prompt plus tool schemas is tens of thousands of characters, so we need either a **stateful conversation that sends only deltas** or a **context-as-file** fallback (ds2api's `DS2API_HISTORY.txt` / `DS2API_TOOLS.txt` pattern).
4. **Read raw markdown from the network, not the DOM.** [H]
   - web-model, apibeam, chat-relay and WebAI2API all parse the SSE stream of `POST /backend-api/f/conversation` (delta encoding `"v1"`).
   - Projects that scrape `innerText` (guberm, older bridges) lose code fences and markdown.
   - Oracle reads markdown through the copy-turn button and treats `GET /backend-api/conversation/{id}` as evidence only.
5. **Tee the stream with a MAIN-world hook injected at document_start.**
   - Pages have strict CSP, so inline `<script>` injection is blocked. Use extension resources or MAIN-world scripts. [H] (web-model AGENTS.md)
   - Read from `response.clone()` so the page's own consumption is untouched. [H]
6. **Drive the ProseMirror composer through synthetic paste events in chunks, then verify.**
   - Composer selector: `#prompt-textarea` / `form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]`. [H] (oracle, Oct 2026)
   - Never trust that text landed; compare it. Watch for the `Remove Pasted text` chip.
   - Some controls ignore synthetic clicks. Oracle uses trusted CDP clicks for the "+" and Deep Research controls. [H]
7. **ChatGPT's UI churns roughly monthly.** [H]
   - Oracle's changelog shows breaking DOM changes in Dec 2025 (`data-turn`, attachments), Jan–Mar 2026 (`__composer-pill` model button), Jul 2026 (unified "Intelligence" picker, stop-button false positives) and Sep–Oct 2026 (Chat/Work layout, `data-turn-key`, `data-content-search-unit-key`).
   - Keep every selector in one versioned table with fallbacks, plus a self-check command.
8. **Rate-limit and challenge states must be detected explicitly.** [H] (oracle)
   - A "Too many requests … temporarily limited access to your conversations" modal appeared with **6 concurrent conversations, but not with 5**.
   - Cloudflare shows "Just a moment…" (headless Chromium gets it). Map these to proper Anthropic 429 or 529 responses with `retry-after`.
9. **Claude Code's own client behaviour shapes the bridge.** [H] (official docs)
   - Send SSE `ping`s while waiting: the event watchdog is 300 s, the body idle timeout 5 min.
   - Return integer `retry-after`.
   - Use Anthropic-shaped errors. Context-limit errors in the exact form `input length and \`max_tokens\` exceed context limit: A + B > C` trigger an automatic retry with smaller `max_tokens`, and `Prompt is too long` triggers compaction (the CCR #1799 issue body shows the first; the errors doc lists the second).
   - Report usage so auto-compact fires. `input_tokens` excludes cache reads; CCR 3.x got this wrong (#1655).
   - Set `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`, otherwise tools can run twice.
10. **Prompt-based tool-calling patterns that work** (Toolify, ds2api, gpt4free, webchat2api, CCR). [H]
    - A unique wrapper with a random per-session trigger or nonce, so mentions are not mistaken for calls.
    - JSON args wrapped in CDATA or a fence.
    - Ignore wrappers inside markdown fences or inline code.
    - A tolerant parser (JSON, then JSON5, then jsonrepair).
    - Schema-aware type coercion.
    - Re-prompt once with a precise parse error.
    - Put the format reminder at the **end of the latest user message**.
    - Render past tool calls in history in the same format.
    - Tell the model explicitly that it *can* read files and run commands.
11. **Watch for Claude Code's "Read: file unchanged" stubs and history rewrites.**
    - When context is replayed, results like "file unchanged, see earlier read" reference content the web model never saw. ds2api injects a "Read-tool cache guard". [H]
    - Claude Code also clears old tool results, compacts, and moves `cache_control` markers. Detecting a diverged conversation must normalise these. [M]
12. **Terms of service and account risk are real.** [H]
    - BrowserHarness (Oct 2026) explicitly declined to drive chatgpt.com because "it is fragile and sits in a terms-of-service grey area".
    - apibeam sends traffic through a hosted relay by default; avoid that.
    - Bind to 127.0.0.1 and authenticate the extension-to-bridge link.

---

## 1. Projects that expose ChatGPT *web* as an API

Only projects whose transport is relevant to us are listed.

| Project | Last commit / ★ / license | Transport | Input injection | Output capture | Tool calling | Notes |
|---|---|---|---|---|---|---|
| [steipete/oracle](https://github.com/steipete/oracle) `@steipete/oracle` v0.21.4 | 2026-10-07 · 4.0k · **MIT** | CDP. Launches Chrome or attaches to the running Chrome. CLI, MCP server and skill. | Chunked synthetic paste: `ClipboardEvent('paste')` with `DataTransfer` `text/plain` and `text/html`, `CHUNK = 4000` (`src/browser/actions/promptComposer.ts` L144–192), verifies landed text and chip count. Falls back to `Input.insertText`. Submits with CDP Enter or trusted click. | Copy-turn button with `navigator.clipboard.writeText`/`write` monkey-patched (`assistantResponse.ts` ~L1691). DOM MutationObserver plus poller with a "terminal-completion gate". Optional `GET /backend-api/conversation/{id}` (`chatgptConversation.ts` L82–120). | None. One-shot "consult" model. | Best live reference for selectors and failure modes (§3). Node ≥24. Concurrency cap 3 tabs. Detached worker plus `wait` MCP pattern for long runs. [H] |
| [maxiloEmmmm/web-model](https://github.com/maxiloEmmmm/web-model) | 2026-04-06 · 4 · **no LICENSE file** | MV3 extension ↔ Go server over `ws://127.0.0.1:18080/ws`. **Offscreen document keepalive** pings the service worker every 15 s (`extension/offscreen.js`). | `execCommand('insertText')` on the ProseMirror node, verifies value, synthetic Enter (`providers/chatgpt.js`). Selectors: `#prompt-textarea[contenteditable='true'][role='textbox']`, `#composer-submit-button`, `a[data-testid='create-new-chat-button']`. | **MAIN-world fetch and XHR hook** (`page-hook.js`) matching path `/backend-api/f/conversation`. Parses the `clone()`d SSE and posts to the content script through `window.postMessage`. | None. OpenAI `/v1/chat/completions` subset. | Closest to our architecture. Notes that DOM updates lag in background tabs, so it captures from the stream. Starts a new chat after N messages per tab; 1-minute "penalty" for a tab after an error. [H] |
| [BinaryBeastMaster/chat-relay](https://github.com/BinaryBeastMaster/chat-relay) | 2025-07-24 · 147 · **AGPL-3.0** | MV3 extension (service-worker WebSocket) ↔ Node relay on `:3003`, OpenAI-compatible, aimed at Cline and Roo. | `inputField.innerText = text`, dispatches `input`, clicks `button[data-testid="send-button"]` with retries. | **`chrome.debugger` Fetch interception** at Response stage for `*chatgpt.com/backend-api/conversation*` and `*/backend-api/f/conversation*` (`providers/chatgpt.js` L24, L734–738). Also a WebSocket-proxy mode and a DOM fallback. | Pass-through only. Cline's own XML tools travel as text. | **Sends only the last message** (`server.ts` L627) and drops system and history. Streaming not implemented. The debugger approach shows Chrome's "is debugging this browser" bar. [H] |
| [NiteshSingh17/apibeam](https://github.com/NiteshSingh17/apibeam) | 2026-09-20 · 73 · MIT | Chrome and Firefox MV3 extension ↔ server over WebSocket. **Default API URL is a hosted relay** (`apibeam.bitsmall.in`). | Sets `#prompt-textarea.innerHTML` and the hidden `[name="prompt-textarea"]` value, then clicks `#composer-submit-button`. | MAIN-world `window.fetch` patch on any `text/event-stream` response. Rebuilds the message with JSON-patch ops. A comment lists the observed delta shapes (`src/pages/content/loader.ts` ~L62). Also handles Responses-style `response.output_text.delta` events as a fallback. | Prompt asks for a JSON "payload" answer. No agentic tools. | Privacy anti-pattern: hosted relay. Loader injected late from a React `useEffect`. [H] |
| [guberm/chatgpt-web-provider](https://github.com/guberm/chatgpt-web-provider) | 2026-07-28 · 9 · MIT | Python with a Playwright persistent profile. | `locator.fill()` then `keyboard.press("Enter")`. | `innerText` of `[data-message-author-role='assistant']`. Fake streaming (waits, then emits). | None ("no shell/filesystem/MCP tool loop yet"). | **Headless gets Cloudflare "Just a moment..."; headed mode works.** Serialized queue with concurrency 1. Lists model ids such as `GPT-5.6 Sol/Terra/Luna`. [H] |
| [foxhui/WebAI2API](https://github.com/foxhui/WebAI2API) | 2026-07-10 · 1.4k · MIT | Camoufox (Playwright Firefox fork), Xvfb/VNC, multiple windows. | `humanType` (human-like typing, which is far too slow for 50k-character prompts). | `page.waitForResponse(url.includes('backend-api/f/conversation'))`, then SSE parse with `p`/`o`/`v` patches, with DOM fallback (`src/backend/adapter/chatgpt_text.js`). | None. | Anti-detection framing. [H] |
| [zqbxdev/webchat2api](https://github.com/zqbxdev/webchat2api) | 2026-06-05 · 392 · MIT | **Reverse-engineered HTTP.** Access tokens, TLS impersonation, sentinel PoW and Turnstile solver, account pools. | n/a | n/a | **Yes, via prompt.** `/v1/messages` adds an XML rule `<tool_calls><tool_call><tool_name>…<parameters><PARAM><![CDATA[…]]>` and "Do not say you cannot access files" (`services/protocol/anthropic_v1_messages.py` L17–56). Uses a shorter rule when it detects "You are Claude Code". | The approach we reject: it reimplements anti-abuse. Useful only for its prompt. [H] |
| [xtekky/gpt4free](https://github.com/xtekky/gpt4free) `OpenaiChat` | 2026-10-08 · 66.8k · **GPL-3.0** | HTTP reimplementation plus **nodriver** to harvest tokens. | n/a | Full `v1` delta parser (content references, images, `finish_details`). | `ToolSupportProvider` with a prompt-based tool parser (§5). | Documents the anti-abuse chain we avoid: `/backend-api/f/conversation/prepare` returns `conduit_token`, then `/backend-api/sentinel/chat-requirements` (PoW, turnstile, arkose), with headers `openai-sentinel-chat-requirements-token`, `openai-sentinel-proof-token`, `openai-sentinel-turnstile-token`, `x-conduit-token`. Notes that guest `backend-anon/f/conversation` was retired in favour of `unauth-mweb/*` (L95–104). **Auto-continue** on `finish_reason == "max_tokens"` with `action:"continue"` (L1054). [H] |
| [lanqian528/chat2api](https://github.com/lanqian528/chat2api) | **2025-03-28** · 3.8k · MIT | Reverse HTTP, AccessToken/RefreshToken, `POW_DIFFICULTY`. | n/a | n/a | No. | Stale. An example of arms-race decay. [H] |
| [acheong08/ChatGPT-to-API](https://github.com/acheong08/ChatGPT-to-API) | 2023-08 · 1.1k · **archived** | Go reverse API. | n/a | n/a | No. | Needed a HAR file to pass Arkose for GPT-4 (2023). [H] |
| `chatgpt` npm ([transitive-bullshit/chatgpt-api](https://www.npmjs.com/package/chatgpt)) | 5.2.5 (2023-05) · MIT | v0.x Playwright (Dec 2022), v3 `ChatGPTAPIBrowser` (Puppeteer plus nopecha/2captcha), v4 `ChatGPTUnofficialProxyAPI` (third-party reverse proxies), v5 official API only. | | | | History lesson (§2). [H] (README in npm tarballs 3.5.0 and 4.7.0) |
| [Zetaphor/chatgpt-api-bridge](https://github.com/Zetaphor/chatgpt-api-bridge), [tylercode362/Chrome-extension-ChatGPT-API](https://github.com/tylercode362/Chrome-extension-ChatGPT-API) | 2023 · MIT | Content-script `new WebSocket("ws://localhost:…")`. | `form textarea.value = …; form button.click()` | DOM scraping. | No. | Died when the composer moved from `<textarea>` to ProseMirror. [H] |
| [CJackHwang/ds2api](https://github.com/CJackHwang/ds2api) (DeepSeek web, not ChatGPT) | 2026-05-10 · **AGPL-3.0** | Reverse HTTP to DeepSeek web. Serves OpenAI, **Claude `/v1/messages`** and Gemini APIs. | n/a | n/a | **Yes, the most mature prompt protocol** (§5). | The best design reference for web-chat-plus-Claude-Code prompt compatibility (`docs/prompt-compatibility.md`, `docs/toolcall-semantics.md`). Read for ideas only (AGPL). [H] |
| Inverse architecture: [Mieruko/MCP_Plugins_With_ChatGPTWeb](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb) v2.0.0 | 2026-09 · MIT | ChatGPT web *is* the agent. Local MCP server reached through a Cloudflare tunnel or the "OpenAI Secure MCP Tunnel", using ChatGPT Developer Mode connectors. | n/a | n/a | Native MCP tool calls from ChatGPT. | Sanctioned surface with native tool calling, but **not** the Claude Code harness. Worth naming in our README as an alternative. [M] |
| [syedazharmbnr1/claude-chatgpt-mcp](https://github.com/syedazharmbnr1/claude-chatgpt-mcp) (793★), xncbf/chatgpt-mcp | 2025–26 | MCP server that drives the macOS ChatGPT desktop app through AppleScript. | | | | "Ask ChatGPT" from Claude Code. macOS only. [M] |
| [BrowserHarness PR #6](https://github.com/BrowserHarness/BrowserHarness/pull/6) | 2026-10 | Subscription adapters run the vendor CLIs (Claude Code, Codex) as subprocesses. | | | | `docs/architecture/SUBSCRIPTION-ADAPTERS.md`: "Not built (deliberately): driving the user's logged-in chatgpt.com … tab … fragile and … terms-of-service grey area." [H] |

**Codex-quota projects (not our target, but useful for Claude Code quirks):** raine/claude-code-proxy (Rust, MIT, 641★, 2026-10-07), insightflo/chatgpt-codex-proxy, luiapidev/gpt-proxy, aryan877/claude-proxy, router-for-me/CLIProxyAPI (54k★), justlovemaki/AIClient-2-API (GPL-3.0), raybytes/ChatMock, evanzhoudev/openai-oauth.

---

## 2. What broke historically

Dates come from changelogs and READMEs. Reverse-engineering items are marked [M] or [L].

| When | Change | Who broke | Source |
|---|---|---|---|
| Dec 2022 | Cloudflare protections added (Dec 11). `cf_clearance` expired after about 2 h. UA and IP had to match the real browser. "Only one `sendMessage` at a time per account." Using the account in a browser at the same time invalidated the bot's tokens. | All HTTP clients, which moved to Puppeteer plus CAPTCHA solvers | `chatgpt@3.5.0` README [H] |
| Feb–Mar 2023 | Browser automation called "very flaky, heavyweight, and error prone". Moved to third-party reverse proxies with leaked access tokens (~8 h TTL), then the official API only. | transitive-bullshit | `chatgpt@4.7.0` README [H] |
| 2023 | Arkose (FunCaptcha) required for GPT-4. Workaround: user-exported HAR file. | ChatGPT-to-API, gpt4free | acheong08 README [H] |
| 2024 (approx.) | Sentinel `chat-requirements` with **proof-of-work**, then a Turnstile token. Reverse proxies added PoW solvers. | chat2api, ninja (went closed source), pandora | chat2api README (`POW_DIFFICULTY`) [M] |
| 2024 (approx.) | Domain `chat.openai.com` → `chatgpt.com`. Composer `<textarea>` → **ProseMirror contenteditable**. | textarea-based extensions (Zetaphor, tylercode) | oracle keeps both selector families [M] |
| 2024–2025 | SSE moved to **delta encoding `"v1"`** (`p`/`o`/`v` JSON-patch frames). Endpoint `/backend-api/f/conversation`, with `/f/conversation/prepare` returning `conduit_token`. | DOM scrapers, naive SSE parsers | chat-relay, web-model, gpt4free `har_file.py` L22–27 [H] |
| 2025-12 | Assistant turns marked `data-turn="assistant\|user"`. Pro "Answer now" placeholder turns. Attachment chip UI changed. | oracle | CHANGELOG 0.7.x–0.8.x [H] |
| 2026-01 → 03 | Composer rewrite: `button.__composer-pill` model button, effort per row. | oracle | CHANGELOG 0.10.0 [H] |
| 2026-05 → 07 | Rate-limit and "temporarily unavailable" warnings must be surfaced. GPT-5.6 unified "Intelligence" picker (`composer-intelligence-picker-content`). A document-wide stop-button `aria-label` fallback matched read-aloud and dictation controls and **held completed answers open until timeout**. Cloudflare false positives from bot-management scripts. | oracle | CHANGELOG 0.14–0.16 [H] |
| 2026-09 | **Throttle modal** ("Too many requests"): six simultaneous conversations triggered it, five did not, and it cleared after a pause. Guest `backend-anon/f/conversation` retired in favour of `unauth-mweb/*`. | oracle, gpt4free | `chatgptThrottle.ts`, gpt4free L95 [H] |
| 2026-09 → 10 | **Chat/Work layout**: new turn markup (`[data-turn-key]`, `[data-content-search-unit-key$=":assistant"]`, `[data-chatgpt-search-unit-key]`), `.turn-action-controls` with localized aria-labels (`Copy`, `コピーする`), live region "Response complete". | oracle 0.21.4 | CHANGELOG plus `constants.ts` [H] |
| Chrome 144+ | "Allow remote debugging?" prompt for each CDP WebSocket. | All CDP attach tools. An extension avoids it. | oracle `docs/browser-mode.md` [H] |
| Chrome 142+ (LNA) | Local Network Access prompt when a public site (chatgpt.com) reaches localhost. One vendor says WebSockets are gated from about Chrome 147. | Content-script or page-world WebSockets to `ws://localhost` | Chrome blog (Jun 2025) and Visualware [L]. **Open the WebSocket from the extension service worker or offscreen document, not from the page.** |

---

## 3. ChatGPT web details observed in prior art (Sep–Oct 2026)

These are for cross-checking against the internals track. Verify them live.

**Selectors** (oracle `src/browser/constants.ts`, Oct 2026) [H]
- Composer: `form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]`, `#prompt-textarea`, `.ProseMirror`, `textarea[name="prompt-textarea"]` (hidden fallback). Pre-hydration placeholder: `#pending-home-input` (do not type into it).
- Send: `button[data-testid="send-button"]`, `button[data-testid*="composer-send"]`, `#composer-submit-button` (web-model). `form button[type="submit"]`.
- Stop: `[data-testid="stop-button"]`, `[data-testid="composer-stop-button"]`. The aria-label fallback must stay scoped to the form and exclude dictation, voice and read-aloud controls.
- Turns: `article[data-testid^="conversation-turn"]`, `[data-message-author-role="assistant"]`, `[data-turn="assistant"]`, `[data-turn-key]`, `[data-content-search-unit-key$=":assistant"]`.
- Finished signals: `button[data-testid="copy-turn-action-button"]`, `good-response-turn-action-button`, `.turn-action-controls button[aria-label="Copy"]`, `[role="status"][aria-live="polite"]` = "Response complete".
- Model picker: `button[aria-label="Select ChatGPT model"]`, `[data-testid="model-switcher-dropdown-button"]`, `button.__composer-pill[aria-haspopup="menu"]`.
- New chat: `a[data-testid='create-new-chat-button']` (web-model; needs the sidebar visible).
- Cloudflare: `script[src*="/challenge-platform/"]`, title "just a moment".
- Paste chip: `form button[aria-label^="Remove Pasted text"]`.

**Endpoints seen in prior-art code** [H unless marked]
- `POST /backend-api/f/conversation`: SSE with `accept: text/event-stream`. The body includes `supported_encodings:["v1"]`, `supports_buffering`, `system_hints` (`"search"`, `"reason"`), `history_and_training_disabled` (temporary chat) and `action:"next"|"continue"`.
- `POST /backend-api/f/conversation/prepare` returns `conduit_token`.
- `POST /backend-api/sentinel/chat-requirements` (we never call it).
- `GET /api/auth/session` returns `{accessToken, user}`. Oracle uses it to check login.
- `GET /backend-api/conversation/{id}` with `Authorization: Bearer <accessToken>`.
  - Returns `{mapping, current_node, conversation_id}`; walk `parent` from `current_node`.
  - `403` or `text/html` means challenged.
  - **Not available for temporary chats** (oracle lists this as a capture-failure reason).
- `GET /backend-api/me`, `GET /backend-api/conversations` (429 observed), `GET /backend-api/celsius/ws/user` (returns `websocket_url` for async image or task updates), `/backend-api/estuary/content?id=file_…`, `/backend-api/files`, `/backend-api/sandbox/download`.

**SSE `v1` shapes** (apibeam comment, chat-relay and gpt4f parsers) [H]

```
{p:"", o:"add", v:{message:{...}, conversation_id:...}, c:0}   // base document
{v:{...}, c:N}                                                  // full replace
{p:"/message/content/parts/0", o:"append", v:"text"}            // append
{v:"text"}                                                      // bare continuation of last path
{o:"patch", v:[{p,o,v},...]}  or  {v:[{p,o,v},...]}             // batch
{p:"/message/status", o:"replace", v:"finished_successfully"}
{type:"title_generation", title:"..."}                          // typed side events
{"safe":true,"blocked":false}                                   // non-SSE moderation JSON
data: [DONE]
```

- Content types: `text`, `multimodal_text`, `code`, `execution_output`, `thoughts`, `reasoning_recap`. [H]
- Finality: `message.status == "finished_successfully" && end_turn`, or `metadata.finish_details.type` in `stop` or `max_tokens`. [H]
- Only `author.role=="assistant"` messages with `recipient=="all"` are user-visible final text. Other recipients are internal tool calls such as python or web. [M] (gpt4free)
- Strip citation markers. Oracle removes `:chatgpt-content-reference{index="N"}` from copied markdown; gpt4free rebuilds `content_references`. [H]

---

## 4. Proxies that run Claude Code on non-Anthropic models

| Project | Last commit · ★ · license | Upstream | Notable handling |
|---|---|---|---|
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) v3.1.2 | 2026-10-08 · 37.6k · MIT | Many providers | Strips Claude Code's `x-anthropic-billing-header` system block and parses `cc_is_subagent` (`gateway/claude-code-router-plugin.ts` L760, L1063–1100). `<CCR-SUBAGENT-MODEL>` tag routing. Local `count_tokens`. Hosted web-search emulation emitting `server_tool_use` and `web_search_tool_result` with `srvtoolu_…` ids (`hosted-web-search/evidence.ts` L556–590). |
| [@musistudio/llms](https://github.com/musistudio/llms) 1.0.53 | 2026-01-07 · MIT | CCR v1/v2 transformer library | `cleancache` (drops `cache_control`). `maxtoken` (caps `max_tokens`). **`tooluse`** (`tool_choice:"required"` plus an `ExitTool` whose `response` argument becomes the final text). **`enhancetool`** (JSON → JSON5 → `jsonrepair` → `{}`). Anthropic SSE emitter: `thinking_delta`, `signature_delta`, `input_json_delta`, usage mapping. |
| [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) 0.1.44 | 2026-10-07 · 641 · MIT | Codex, Kimi, Grok, Cursor | Docs list the client env contract (below). `count_tokens` is a local `o200k_base` estimate. Uses `x-claude-code-session-id` for affinity. `[1m]` suffix is stripped. Background requests need `ANTHROPIC_SMALL_FAST_MODEL`. Upstream 429 is surfaced with `retry-after`. "Automatic transport fallback only before an upstream request is sent" (no replay). |
| [1rgs/claude-code-proxy](https://github.com/1rgs/claude-code-proxy) | 2026-06-22 · 3.8k · **no license file** | LiteLLM | Maps haiku and sonnet substrings to SMALL or BIG model. Caps `max_tokens` at 16384 for OpenAI (`server.py` L634–641). Cleans Gemini schemas (`additionalProperties`, `format`). |
| [fuergaosi233/claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy) | 2026-03-12 · 2.8k · MIT | OpenAI-compatible | BIG, MIDDLE and SMALL model mapping. **Cancels upstream on client disconnect** (`response_converter.py` L245). |
| [maxnowack/anthropic-proxy](https://github.com/maxnowack/anthropic-proxy) | archived · 413 · MIT | OpenRouter | Drops `BatchTool` (an old Claude Code tool). Strips `format:'uri'` (L104–140). |
| [luohy15/y-router](https://github.com/luohy15/y-router) | archived · 383 · MIT | OpenRouter (Cloudflare Worker) | `validateOpenAIToolCalls` drops orphan `tool_use` and `tool_result` pairs (`formatRequest.ts` L12–98). |
| LiteLLM `/v1/messages` | active · 60k · MIT | 100+ | `count_tokens` falls back to tiktoken for non-native providers (estimates). `litellm.add_function_to_prompt` is prompt-based function calling. [M] |
| Kimi, DeepSeek, GLM native Anthropic endpoints | n/a | | Show that Claude Code works against a non-Claude model behind a faithful Messages endpoint. [M] |

### 4.1 Claude Code quirks and what we should do

1. **`count_tokens`.** [H]
   - The endpoint is optional; without it Claude Code falls back to a character estimate (`llm-gateway-protocol`).
   - Proxies answer locally (raine with `o200k_base`). **Do not spend a ChatGPT message on it.**
2. **Background and haiku requests.** [H]
   - Title generation and small tasks use `ANTHROPIC_DEFAULT_HAIKU_MODEL` (`ANTHROPIC_SMALL_FAST_MODEL` is deprecated). Subagents use `CLAUDE_CODE_SUBAGENT_MODEL`.
   - The billing block carries `cc_is_subagent=true` (CCR).
   - **For us:** a "cheap" model id the bridge can answer locally or with a degraded path, such as a fixed-string title. Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the launcher.
3. **Attribution block.**
   - The first `system` block starts with `x-anthropic-billing-header:` (`cc_version`, `cc_entrypoint`, `cc_is_subagent`). [H] (CCR)
   - It is stable per conversation through a custom base URL since v2.1.181. [H] (docs)
   - Strip it before building the ChatGPT prompt, or set `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.
4. **Thinking.**
   - For unrecognized model ids Claude Code sends `thinking:{type:"adaptive"}` and `output_config.effort`. [H] Ignore them.
   - Do not emit `thinking` blocks. They need a `signature`, and if the user later switches to a real Claude model, Anthropic rejects them. Claude Code recovers by stripping them, but it is noise. If we want to show progress, stream ChatGPT's reasoning summary as plain text, or not at all. [M]
5. **`cache_control`.** Present on system and message blocks, and the markers move every turn. Ignore them, and **exclude them from any history hashing**. [H]
6. **`tool_use` ids.**
   - Use `toolu_` plus base62 characters matching `^[a-zA-Z0-9_-]+$`, so a later `/model` switch to a real Claude model still validates. [M]
   - Use `srvtoolu_` for server tools.
   - CCR #1643 shows the cost of confusing `fc_` and `call_` id families: keep exactly one id per call.
7. **`max_tokens`.**
   - Claude Code defaults to 32000 for unknown models (cap 128000) [H] (env-vars). ChatGPT web ignores it.
   - ChatGPT can stop with `finish_details.type == "max_tokens"` mid-answer. **Auto-continue** (`action:"continue"`, or click "Continue generating") before parsing tool calls, because a large `Write` content gets truncated. [H] (gpt4free)
8. **Streaming `input_json_delta`.**
   - Emit `content_block_start` with `{type:"tool_use", id, name, input:{}}`, then one or more `input_json_delta` (`partial_json`), then `content_block_stop`, then `message_delta` with `stop_reason:"tool_use"`, then `message_stop`. [H] (llms anthropic transformer)
   - Since we parse after a sentinel, emitting the full JSON in one delta is fine.
9. **`web_search` server tool.**
   - Claude Code's WebSearch sends a sub-request with `tools:[{type:"web_search_20250305", name:"web_search", max_uses}]`.
   - Proxies emulate it with `server_tool_use` and `web_search_tool_result` blocks, where each `content` item is `{type:"web_search_result", url, title, encrypted_content:"", …}` (CCR). [H]
   - **Opportunity:** ChatGPT web can search natively (`system_hints:["search"]`). A v1 can also just return text.
10. **Images.** Base64 image blocks in user messages and tool results (screenshots, Read on PNG). Proxies often break here (CCR #1409, #372). v1: replace with a placeholder; later, upload through the composer's file input. [H]
11. **Errors and retries.** [H] (docs and CCR #1799)
    - Return `{"type":"error","error":{"type":…,"message":…}}`.
    - Use 429 with **integer** `retry-after` (a value above 60 stops retries).
    - Use 529 `overloaded_error` for transient "tab busy" states.
    - Context overflow: return 400 with `input length and \`max_tokens\` exceed context limit: A + B > C` (Claude Code retries with lower `max_tokens`) or `Prompt is too long` (triggers compaction).
    - Never return a generic "All providers failed" wrapper.
12. **Duplicate tool execution.** Set `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`, which "prevents Claude Code from retrying a partially completed stream as non-streaming". [H] (env-vars, raine)
13. **Idle watchdogs.** [H] (`network-config`)
    - Event watchdog 300 s; body idle timeout 5 min through a gateway; `API_TIMEOUT_MS` default 600 s.
    - Send `message_start` immediately and `event: ping` about every 15 s.
    - The launcher should set `API_TIMEOUT_MS` (for example 1800000) and `CLAUDE_STREAM_IDLE_TIMEOUT_MS` (5–30 min clamp) for long Thinking or Pro runs.
14. **Usage.**
    - `input_tokens` excludes `cache_read_input_tokens`. CCR 3.x double-counted and compaction fired at half the real context (#1655). [H]
    - Report the full logical prompt size even when we only sent a delta to ChatGPT (ds2api does this). Otherwise auto-compact never fires.
15. **Startup traffic.** [H] (docs)
    - Expect `HEAD /api/hello` and `GET /v1/models?limit=1000` (3 s timeout; a redirect fails silently).
    - Inference arrives at `/v1/messages?beta=true`.
    - Use `x-claude-code-session-id` for session-to-tab affinity.
16. **Context window and compaction.**
    - `[1m]` only changes Claude Code's local policy. [H]
    - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` takes an integer from 100000 to 1000000. [H]
    - Aggregators report ChatGPT Plus at roughly 256K total (about 128K input) for Thinking and roughly 32–54K for Instant. [L] Instant is too small for Claude Code, so default to a Thinking model and an auto-compact window around 100000–120000.
17. **Tool search.** With a non-first-party `ANTHROPIC_BASE_URL`, MCP tools load upfront by default (`ENABLE_TOOL_SEARCH`, env-vars). [H] Expect large `tools` arrays. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` removes `defer_loading`, `strict` and `context_management`.
18. **Cancellation.** Detect client disconnect (Esc in Claude Code), then click stop and free the tab (fuergaosi233 pattern). [H]

**Launcher environment, consolidated from raine docs and official env-vars [H]:**

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>  ANTHROPIC_AUTH_TOKEN=<bridge-token>
ANTHROPIC_MODEL=<chatgpt-thinking-id>  ANTHROPIC_DEFAULT_HAIKU_MODEL=<local-cheap-id>
CLAUDE_CODE_SUBAGENT_MODEL=<chatgpt-thinking-id>
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000  API_TIMEOUT_MS=1800000  CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000
CLAUDE_CODE_MAX_RETRIES=3   # each retry may cost a ChatGPT message
```

---

## 5. Prompt-based tool calling

| Project | Format the model must emit | Parsing and robustness | License |
|---|---|---|---|
| [funnycups/Toolify](https://github.com/funnycups/Toolify) (2026-04, 344★) | A **random per-process trigger** `<Function_XXXX_Start/>` on its own line, then `<function_calls><function_call><tool>NAME</tool><args_json><![CDATA[{json}]]></args_json></function_call>…</function_calls>`, with no text after it (`main.py` L155–159, L919–1000). | Trigger must appear outside `<think>`. Classifies failures as no call, truncated or malformed. **Automatic retry with a diagnostic** (max 1–10). Truncation continuation. Rewrites past assistant `tool_calls` in the same format. Tool results come back as `<tool_result>` with the tool name and args. "Keys must match exactly, keep the leading hyphen in `-i`." | GPL-3.0 |
| [CJackHwang/ds2api](https://github.com/CJackHwang/ds2api) (Claude Code over DeepSeek web) | `<|DSML\|tool_calls><|DSML\|invoke name="X"><|DSML\|parameter name="p"><![CDATA[v]]></\|DSML\|parameter>…` (uses the model's own trained markup). Arrays use `<item>`, numbers and booleans are bare, no fences, the block comes last. | **Ignores wrappers inside fenced or inline code.** Narrow repair when the opening wrapper is missing. Streaming "tool sieve" holds back candidate text. JSON-literal parameter coercion and schema-driven string coercion. **Read-tool cache guard** (`internal/promptcompat/tool_prompt.go` L94). An empty visible answer triggers parsing calls out of reasoning, then one internal retry. "Output integrity guard" prefix. **Control instructions appended to the end of the latest user message.** **Context-as-file:** `DS2API_HISTORY.txt` plus `DS2API_TOOLS.txt` uploaded, with a continuation-style live prompt, and token usage still counted on the full prompt. A new remote chat for every request. | AGPL-3.0 (ideas only) |
| [zqbxdev/webchat2api](https://github.com/zqbxdev/webchat2api) | `<tool_calls><tool_call><tool_name>…</tool_name><parameters><PARAM><![CDATA[v]]></PARAM></parameters></tool_call></tool_calls>`, "output ONLY this XML". | Past `tool_use` rendered back in the same XML. `tool_result` rendered as `Tool result {id}: …`. Filters calls to declared names. | MIT |
| gpt4free `tools/tool_support.py` | Accepts `[Tool call: NAME] (id=…)\nArguments: {json}`, `<tool_call>{json}</tool_call>`, ReAct `Action:`/`Action Input:`, or bare JSON. | Balanced-brace extraction, fence stripping, trailing-comma fix, name allow-list. Merges history into one user message and renders tool calls and results as text. | GPL-3.0 |
| CCR `tooluse` / `enhancetool` | Native function calling plus a forced `ExitTool`. | jsonrepair chain. The ExitTool trick forces a structured choice every turn. | MIT |
| Cline (XML, before v3.35, Oct 2025) and Roo (XML or native toggle) | `<read_file><path>…</path></read_file>`, one tool per message. | Moved to native tool calling: fewer "invalid API response" errors, about 15% smaller prompts, parallel calls. XML kept for models without native support. Roo bugs came from switching protocol mid-task. [M] (Cline blog, Roo release notes) | Apache-2.0 |

**Design implications for a GPT web model:**
- GPT-5.x is strong at JSON. Recommended: a nonce'd wrapper on its own lines, for example `<<<CALL nonce=…>>>` … `<<<END nonce=…>>>`, containing one JSON object `{"name":…,"input":{…}}` per call. Accept it inside a fence only if the fence holds nothing but the wrapper. Require a final terminator line so truncation is detectable. This is my synthesis of Toolify and ds2api. [L]
- Tell the model it **has** local file and shell access through these tools; ChatGPT otherwise refuses with "I can't access your files" (webchat2api). It must **not** use its built-in python, web, canvas or image tools. [M]
- Validate names and required fields against `input_schema`. On failure, send one corrective follow-up in the same conversation (costs one message) rather than returning garbage to Claude Code.

---

## 6. Prioritized lessons for our design

### P0: design for these from day 1

1. **Quota economy.** [M]
   - Every forwarded request costs a ChatGPT message. Answer `count_tokens`, `HEAD /api/hello`, `/v1/models` and haiku-class background calls (title generation, quota probes) **locally**.
   - Make in-flight requests **idempotent**: hash the normalized request; a Claude Code retry should reattach to the running generation, never re-submit. Oracle: "without replaying a dispatched action".
   - Keep `CLAUDE_CODE_MAX_RETRIES` low.
2. **Stateful conversation with delta prompts, plus a replay fallback.**
   - Keep one ChatGPT conversation per Claude Code session (`x-claude-code-session-id`) and send only new turns (tool results and user text).
   - When the normalized history no longer matches (compaction, `/rewind`, cleared old tool results, edits), start a fresh chat and replay the full context, as a file if it exceeds about 50k characters (ds2api pattern).
   - Normalize away `cache_control`, `<system-reminder>` blocks, the attribution header, and cleared-result placeholders before comparing. [M]
3. **Injection.** [H] (oracle)
   - Paste into the ProseMirror composer in chunks of at most 4,000 characters using `ClipboardEvent('paste')` with `DataTransfer`.
   - **Verify** the landed text exactly and check that no `Remove Pasted text` chip appeared.
   - Clear stale drafts first. Wait for an enabled send button, then submit. Confirm the user turn committed (URL `/c/{id}` and the SSE `conversation_id`).
4. **Capture.**
   - MAIN-world fetch hook (`content_scripts[].world:"MAIN"`, `run_at:"document_start"`) on `POST /backend-api/f/conversation`, reading from `response.clone()`. [H] (web-model, apibeam)
   - Full v1 delta reducer, including bare `{v:"…"}` continuations and batches.
   - Keep only `author.role=="assistant"`, `recipient=="all"` text.
   - Fallback: `GET /backend-api/conversation/{id}` with the page's own token (not for temporary chats).
   - Last resort: the copy button.
   - Strip citation and content-reference markers.
5. **Anthropic stream contract.**
   - Send `message_start` and pings immediately and keep them flowing.
   - Always end with `message_delta` and `message_stop`.
   - Use proper error shapes, `retry-after` and context-limit wording (§4.1 items 11 and 13).
   - Report usage so auto-compact works.
6. **Tool protocol** (§5): nonce'd wrapper, JSON args, fence and inline-code awareness, schema validation, one corrective retry, a reminder at the end of the latest user message, past calls rendered in the same format, the Read-unchanged guard, and no built-in ChatGPT tools.
7. **Concurrency and health.** [H] (oracle)
   - Serialize per tab, cap the pool at 3 tabs, use session affinity.
   - Detect the throttle modal phrases ("too many requests", "making requests too quickly", "temporarily limited access to your conversations") and Cloudflare (`/challenge-platform/`, "just a moment"), and map them to 429 or 529.
   - Check login through `/api/auth/session`.
8. **Cancellation.** On client disconnect, click `[data-testid="stop-button"]` and release the tab. Never re-send a prompt after it was dispatched.

### P1

9. **MV3 plumbing.** [M]
   - Hold the localhost WebSocket in the **service worker or offscreen document** (keepalive about every 15–20 s), not in the content script. This avoids page CSP and the Local Network Access prompt.
   - Use the MAIN world only for the fetch tee, and talk to it through `window.postMessage` with a nonce.
   - Set `chrome.tabs.update(id,{autoDiscardable:false})` and expect background-tab DOM lag (web-model). Rely on the stream, not rendering.
10. **Truncation.** Detect `finish_details.type=="max_tokens"` and auto-continue before parsing. Large `Write` and `Edit` payloads are the usual victims. [H] (gpt4free)
11. **Model and effort selection.** This is oracle's most frequently fixed area. Default to "use the currently selected model" and let the user choose in the UI. Read the actual model from the SSE metadata. [H]
12. **Context limits.** Use a Thinking model (Instant is too small). Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` around 100000 (the minimum allowed). Compaction requests are themselves ChatGPT messages. [L]/[H]
13. **Interference from the user's ChatGPT setup.** Memory and custom instructions leak into our protocol. Consider a dedicated ChatGPT Project or a temporary chat (trade-off: no conversation-API fallback), and archive bridge conversations after use (oracle has `archiveConversation`). [M]
14. **WebSearch.** Return text first. Optionally emulate `server_tool_use` and `web_search_tool_result` using ChatGPT's own search (CCR shape). [H]/[L]
15. **Images.** v1 uses placeholders; later, upload through `form input[type="file"]` and wait for the chip (oracle's attachment-readiness logic). [H]

### P2

16. **Security and terms of service.**
    - Bind 127.0.0.1 only. Use a shared secret between bridge and extension, and check the WebSocket `Origin` (`chrome-extension://<id>`).
    - No hosted relay.
    - README warning: OpenAI's Terms of Use bar programmatic extraction of output; BrowserHarness declined this approach for that reason.
    - Do not bypass challenges; surface them to the user.
17. **Selector maintenance.** One selector table with dated comments, a `doctor` or self-check command, and fixture-based tests against saved DOM and SSE samples (oracle's approach).
18. **Delegation plugin.** Long ChatGPT Thinking or Pro runs exceed MCP or tool timeouts. Use oracle's detached worker plus `wait(id, timeoutMs)` pattern. The CCR `<CCR-SUBAGENT-MODEL>` tag shows how to route subagents per request. [H]

---

## 7. Licenses: what we may borrow

- **MIT, ideas and patterns may be adapted with attribution:**
  - oracle: selector table, chunked paste and verify, throttle phrases, conversation-fetch flow.
  - apibeam: JSON-patch reducer idea.
  - webchat2api, guberm, WebAI2API.
  - CCR and @musistudio/llms: SSE emitter, transformers, web-search block shapes.
  - raine (Rust), fuergaosi233, y-router.
  - maxnowack (package.json says MIT).
- **No license, do not copy:** web-model (but its design is our closest match), 1rgs/claude-code-proxy, insightflo.
- **Copyleft, do not copy code into our MIT repo; design notes only:** ds2api and chat-relay (AGPL-3.0); gpt4free, Toolify and AIClient-2-API (GPL-3.0).

---

## 8. Open questions to verify on live chatgpt.com

1. Current per-message size limit, and the exact paste-to-file threshold (oracle saw it above about 10k characters in a single paste).
2. Whether ChatGPT's stream consumer still uses `fetch` (patchable) or has moved to WebSocket or `celsius` for text. chat-relay and apibeam include WS and Responses-style fallbacks, which hints at experiments. [L]
3. Whether synthetic paste and Enter remain accepted for send (oracle needed trusted clicks for some controls).
4. Whether temporary chat disables custom instructions and memory, and whether its SSE is identical.
5. Plus and Pro message caps for Thinking models in Oct 2026; aggregators disagree. [L]
6. Exact Claude Code wording of the Read "file unchanged" stub and the microcompact placeholder, so history normalization can match them. [M]

---

### Sources

- **ChatGPT-web projects:** [oracle](https://github.com/steipete/oracle) (`src/browser/constants.ts`, `actions/promptComposer.ts`, `actions/assistantResponse.ts`, `chatgptThrottle.ts`, `chatgptConversation.ts`, `CHANGELOG.md`, `docs/browser-mode.md`), [web-model](https://github.com/maxiloEmmmm/web-model) (`extension/page-hook.js`, `offscreen.js`, `AGENTS.md`), [chat-relay](https://github.com/BinaryBeastMaster/chat-relay), [apibeam](https://github.com/NiteshSingh17/apibeam), [chatgpt-web-provider](https://github.com/guberm/chatgpt-web-provider), [WebAI2API](https://github.com/foxhui/WebAI2API), [webchat2api](https://github.com/zqbxdev/webchat2api), [gpt4free](https://github.com/xtekky/gpt4free) (`g4f/Provider/needs_auth/OpenaiChat.py`, `g4f/Provider/openai/har_file.py`, `g4f/tools/tool_support.py`), [chat2api](https://github.com/lanqian528/chat2api), [ChatGPT-to-API](https://github.com/acheong08/ChatGPT-to-API), [chatgpt npm](https://www.npmjs.com/package/chatgpt), [Zetaphor bridge](https://github.com/Zetaphor/chatgpt-api-bridge), [MCP_Plugins_With_ChatGPTWeb](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb), [claude-chatgpt-mcp](https://github.com/syedazharmbnr1/claude-chatgpt-mcp), [BrowserHarness PR #6](https://github.com/BrowserHarness/BrowserHarness/pull/6).
- **Claude Code proxies:** [claude-code-router](https://github.com/musistudio/claude-code-router) (issues [#1799](https://github.com/musistudio/claude-code-router/issues/1799), [#1655](https://github.com/musistudio/claude-code-router/issues/1655), [#1643](https://github.com/musistudio/claude-code-router/issues/1643), [#1066](https://github.com/musistudio/claude-code-router/issues/1066)), [@musistudio/llms](https://github.com/musistudio/llms), [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) (docs: compatibility-and-limitations, configure-claude-code, troubleshooting), [1rgs](https://github.com/1rgs/claude-code-proxy), [fuergaosi233](https://github.com/fuergaosi233/claude-code-proxy), [anthropic-proxy](https://github.com/maxnowack/anthropic-proxy), [y-router](https://github.com/luohy15/y-router), [insightflo](https://github.com/insightflo/chatgpt-codex-proxy), [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API), [LiteLLM count_tokens](https://docs.litellm.ai/docs/anthropic_count_tokens).
- **Tool-calling prior art:** [Toolify](https://github.com/funnycups/Toolify), [ds2api](https://github.com/CJackHwang/ds2api) (`docs/prompt-compatibility.md`, `docs/toolcall-semantics.md`), [Cline v3.35 native tools](https://cline.bot/blog/cline-v3-35), [Roo v3.33 notes](https://docs.roocode.com/update-notes/v3.33).
- **Official Claude Code docs (fetched 2026-10-09):** [llm-gateway-protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [llm-gateway](https://code.claude.com/docs/en/llm-gateway), [env-vars](https://code.claude.com/docs/en/env-vars), [network-config](https://code.claude.com/docs/en/network-config), [errors](https://code.claude.com/docs/en/errors).
- **Other:** [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access), [Visualware LNA/WebSocket note](https://myconnectionserver.visualware.com/support/v11/userguide/chrome-lna-websocket), [ChatGPT context-window aggregator (L)](https://www.ai-toolbox.co/chatgpt-models/chatgpt-context-window-token-limits-2026), [OpenAI community thread on message length](https://community.openai.com/t/warning-the-message-you-submitted-was-too-long-please-reload-the-conversation-and-submit-something-shorter/657194).
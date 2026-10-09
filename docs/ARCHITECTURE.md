# Architecture

```
┌────────────────────┐  Anthropic Messages API   ┌──────────────────────────┐  WebSocket (localhost)  ┌───────────────────────────┐
│ Claude Code        │  POST /v1/messages (SSE)  │ webGPT4CC bridge         │  jobs / events          │ Chrome extension          │
│ (claude CLI, Agent │ ─────────────────────────▶│ bridge/src               │ ───────────────────────▶│ service worker            │
│  SDK, gptcc, or    │ ◀───────────────────────── │  • request → text prompt │ ◀─────────────────────── │  └ chatgpt.com tab(s):    │
│  the gpt-web       │  text + tool_use blocks   │  • reply → tool_use      │                         │    page agent types the   │
│  plugin's delegate)│                           │  • session continuation  │                         │    prompt, reads the raw  │
└────────────────────┘                           └──────────────────────────┘                         │    streamed reply         │
                                                                                                      └───────────────────────────┘
```

## Request flow

1. Claude Code sends `POST /v1/messages` (system prompt, ~20 tool schemas, the full
   transcript, `stream: true`) to `ANTHROPIC_BASE_URL` = the bridge.
2. **Classify** (`background.ts`):
   - `probe` (`max_tokens: 1`) → answered locally;
   - `classifier` (auto-mode safety monitor) → refused (`invalid_request_error`, no retry), so Claude Code blocks the action instead of anything approving it;
   - `web_search` (server tool `web_search_*`) → a one-off ChatGPT chat that may browse;
   - `background` (no client tools: helpers) → a one-off temporary chat. WebFetch page digests are
     answered locally with the page itself (`webFetchSummaries: local`), saving a message per fetch;
   - `main` → the agent loop.
3. **Deduplicate**: an identical request (same Claude Code session id + canonical
   transcript) attaches to the in-flight or recently finished turn. This absorbs
   Claude Code's retries and stream-watchdog aborts (the launcher also disables the
   non-streaming fallback, which would re-send the same turn with `stream: false`)
   (an abandoned turn keeps running for `orphanGraceMs` so a retry can adopt it).
4. **Plan** (`handler.ts` + `session/store.ts`): if the last assistant message of
   the transcript is a reply the bridge produced and it is still the newest turn
   of its ChatGPT conversation, continue that conversation and send only what is
   new (tool results, user text, harness messages). Otherwise open a new ChatGPT
   chat with the protocol preamble, system prompt, tool list and a replay of the
   transcript. A conversation that grows past `maxConversationTokens` is
   replaced the same way.
5. **Render** (`translate/render.ts`) per [PROTOCOL.md §1](PROTOCOL.md#1-text-tool-calling-protocol).
6. **Run** the job on a provider (`providers/`): the extension provider picks an
   idle worker tab (preferring the tab that holds the conversation), sends the job
   over the WebSocket and relays progress. The mock provider replies from a script.
7. **Stream back**: once ChatGPT accepted the message, the bridge opens the SSE
   response (`message_start`, pings every 10 s), streams safe leading prose line by
   line, and when the reply is complete parses it (`translate/parser.ts`) into
   `text` + `tool_use` blocks (`stop_reason: tool_use`).
8. **Record** the fingerprint of the reply (its `tool_use` ids, or its normalized
   text) → ChatGPT conversation id, so step 4 can continue it next time.

## Why these choices

* **Drive the real UI instead of calling ChatGPT's backend.** Sending messages
  requires Sentinel chat-requirements, proof-of-work and Turnstile tokens and
  sits behind Cloudflare. The page computes all of that itself; the extension only
  types and clicks. It never creates or forges those tokens.
* **Read the raw reply from the page's own network stream** (delta-encoded SSE,
  sometimes handed off to a WebSocket) instead of the DOM: rendered markdown loses
  indentation, asterisks, underscores and HTML-looking text, which would corrupt
  file contents in tool calls.
* **Text tool protocol with raw string parameters**: models produce verbatim code
  far more reliably without JSON escaping. Non-string parameters are JSON and
  coerced by schema; the parser is lenient (fences, CDATA, Hermes JSON, missing
  closing tags).
* **Continuation instead of replaying every turn**: Claude Code resends ~20k tokens
  of system prompt and tools on every request. Typing that into ChatGPT every step
  would be slow and would hit the composer's paste limits; continuing the same
  chat sends only the delta (usually a few hundred characters).
* **One ChatGPT message per agent step.** That is the unit of ChatGPT quota, so
  the protocol tells the model to batch independent tool calls.

## Security model

* The bridge listens on `127.0.0.1` by default. `/v1/*` requires the bridge
  `authToken` (as `x-api-key` or `Authorization: Bearer`), rejects requests that
  carry an `Origin` header (browsers), and checks the `Host` header (DNS rebinding).
* The extension WebSocket requires an extension origin (`chrome-extension://…`)
  and the `extensionToken`, so a web page cannot connect and feed tool calls to
  Claude Code.
* Tokens live in `~/.webgpt4cc/config.json` (mode 0600).
* Prompts contain your code. They go to ChatGPT, exactly as if you pasted them.
* The page agent never reads or logs cookies, access tokens or resume tokens.

## Known limitations (v0.1)

* Images and documents in the transcript are replaced by placeholders.
* ChatGPT's own custom instructions / memory still apply to non-temporary chats.
* `?model=` may not select a model; by default the bridge uses whatever model is
  selected in the worker tab.
* Very long tool results inflate the ChatGPT conversation quickly; Claude Code's
  compaction (driven by the usage the bridge reports and `CLAUDE_CODE_MAX_CONTEXT_TOKENS`)
  keeps it in check.
* The extension is tested against a faithful fake of chatgpt.com (2026-09 DOM and
  stream format), not against the live site in CI. ChatGPT changes its UI often;
  selectors live in one place (`extension/content/page-agent.js`).

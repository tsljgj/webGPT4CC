# End-to-end tests

```
claude -p ...  ->  bridge (in-process, port 0)  ->  extension (unpacked, Chromium)  ->  fake chatgpt.com (Playwright routing)
```

chatgpt.com is never contacted. The browsers start with `HERMETIC_ARGS`
(`harness.ts`), which send every non-loopback connection to a dead local proxy.
Traffic that escapes Playwright routing, such as Chromium preconnects or
component updates, therefore fails instead of reaching the internet. These tests
check the plumbing, not ChatGPT's live DOM. When ChatGPT changes, update the extension's `SELECTORS` and this fake
together.

```sh
npm run test:e2e                                              # all files, ~2.5 min
node --test --test-reporter=spec test/e2e/fake.test.ts        # the fake alone, ~13 s
node --test --test-reporter=spec test/e2e/chain.test.ts       # full chain with claude, ~45 s
node --test --test-reporter=spec test/e2e/locale.test.ts      # zh-CN UI, 2026-09 composer, ~55 s
node --test --test-reporter=spec test/e2e/lifecycle.test.ts   # reloads, typing, cancels, ~35 s
E2E_VERBOSE=1 node --test test/e2e/chain.test.ts              # stream bridge, browser and fake logs
```

All files **skip** (they do not fail) when Playwright's Chromium is not
installed (`PLAYWRIGHT_BROWSERS_PATH`; nothing here runs `playwright install`).
The extension tests also skip without `extension/manifest.json`, and the chain
test without a working `claude` CLI (`locale` and `lifecycle` drive the
bridge's provider directly). The skip reason is printed next to the suite name.

| Variable | Effect |
|---|---|
| `E2E_VERBOSE=1` | Print bridge, browser console and fake-backend logs as they happen. On a failure, the chain test prints them anyway. |
| `E2E_HEADED=1` | Show the browser. Needs a display; on a server use `xvfb-run -a npm run test:e2e`. |
| `E2E_EXTENSION_DIR=…` | Test another unpacked extension directory, for example a build output. |
| `E2E_SSE_DELIVERY=whole` | Deliver SSE bodies in one piece (the fallback without `openssl`) instead of streaming them. |
| `CLAUDE_BIN=…` | Path to the `claude` CLI (default: `claude` on `PATH`). |

The tests run headless. Playwright's `channel: 'chromium'` starts the full
Chromium build in the new headless mode, which loads MV3 extensions. The default
`chromium-headless-shell` cannot load extensions. Browsers come from
`PLAYWRIGHT_BROWSERS_PATH`.

## Files

- `fake-chatgpt/app.js` and `index.html`: the fake front end, built on the
  2026-09 layout.
  - `form[data-chatgpt-composer]` holds a ProseMirror-like
    `[contenteditable][role=textbox].ProseMirror` with a placeholder paragraph
    and `br.ProseMirror-trailingBreak`.
  - A synthetic `paste` is parsed the way ProseMirror does by default. HTML is
    preferred. Whitespace collapses unless the block has
    `white-space: pre`/`pre-wrap`. A paste with only `text/plain` becomes one
    paragraph per line, and blank lines are dropped.
  - A single paste of more than 10,000 characters becomes a `Remove Pasted text`
    chip.
  - Other controls: `Send prompt` (disabled while empty), `Stop` (shown while
    generating), the Chat/Work switch, and the Enter key.
  - Assistant units use `[data-content-search-unit-key="turn-N:i:assistant"]`.
    The rendered markdown is lossy on purpose, so DOM text is not the raw reply.
  - Routes: `/`, `/c/<id>` (loaded through `GET /backend-api/conversation/<id>`),
    `?temporary-chat=true`, and `?model=` (consumed, then dropped from the URL).
  - The SSE body is read through `response.body.getReader()`, and the page
    aborts the read after `message_stream_complete`, like the real site.
- `fake-chatgpt/backend.ts`: `FakeChatGPT`, the Playwright route handlers. All
  state stays in the Node process. Create browser contexts with
  `FAKE_CONTEXT_OPTIONS` and call `fake.close()` when done.
  - `/api/auth/session`, the Sentinel and prepare calls, and
    `POST /backend-api/f/conversation`, which streams delta-v1 SSE.
  - An optional `stream_handoff` sends the rest of the turn over
    `wss://ws.chatgpt.com/…` through `context.routeWebSocket`. That stream has
    catch-ups, a repeated item, an array frame and a `done` envelope.
  - `GET /backend-api/conversation/<id>`, which returns `mapping` and
    `current_node`.
  - Options: `rateLimit` (HTTP 429 with `detail.clears_in`, on the
    conversation POST or, with `rateLimitAt: 'sentinel'`, on Sentinel's
    prepare), `conversationApi: 'cloudflare'` (403 HTML), `loggedIn: false`
    (with `guestComposer: true`: a working guest composer that posts to
    `/backend-anon/…`, recorded in `anonRequests`), `composerMode: 'work'`,
    `thoughts`, `sseDelivery` (`'stream'`, the default, or `'whole'`),
    `uiBanner` (a blocking limit banner), `answerInProgressForMs` (the
    conversation API reports the answer as `in_progress` for that long),
    `accountId` (a workspace account: the page sends `Chatgpt-Account-Id`, and
    the conversation API answers 404 without it), `ignoreModelParam` and
    `sendTransform` (`'escape-markdown'` or `'truncate-half'`: what a composer
    serializer could do to the text it sends).
  - The real-site shape the primary user sees: `locale: 'zh-CN'` (every label
    localized, no `data-testid`), `composerButton: 'cycle'` (one
    `type="button"` primary composer button without id whose label cycles voice
    → send → stop; clicking it while idle starts "voice mode", counted in
    `__fakeChatGPT.state.voiceStarts`), `labels` (overrides, e.g. texts no
    selector can know) and `trustedEnterOnly` (synthetic Enter is ignored).
  - Healthy pages load Cloudflare's `/cdn-cgi/challenge-platform/` script, as
    the real site does.
  - The scripted LLM has the signature
    `(prompt, { history, turn, conversationId, ... }) => string | FakeReply`.
    A `FakeReply` can add reasoning, a commentary preamble, a transport,
    `finishReason`, `delayMs`, `httpError` and `cutStream` (drop the connection
    after N events or `'mid-answer'`; the stored conversation stays complete, so
    `GET /backend-api/conversation/<id>` returns the whole answer).
  - Every conversation POST is kept in `fake.requests`.
- `fake-chatgpt/stream-server.ts`: a loopback HTTPS server that streams SSE
  bodies (see "SSE delivery" below).
- `fake-chatgpt/stream.ts`: builds the delta-v1 event sequence for one turn.
  - It sends a resume token, a hidden system message, `input_message` and
    `server_ste_metadata`.
  - Before the answer it can send `thoughts` and `reasoning_recap` messages and a
    commentary preamble.
  - The answer starts with an `add` of the final message, then small appends
    using the implicit path, an occasional mid-stream patch, and a final patch.
  - It ends with `message_stream_complete`, `conversation_detail_metadata`,
    `title_generation` and `[DONE]`.
- `fake-chatgpt/delta.ts`: a reference delta-v1 reducer that the fake's
  self-test uses.
- `harness.ts`: helper functions.
  - `startBridge`, which includes a `RecordingExtensionProvider`.
  - `launchChromium`, `extensionWorker`, `configureExtension` (writes
    `chrome.storage.local {bridgeUrl, token}`), and `registerWorkerTab`. It calls
    the service worker's `globalThis.webgpt4cc.addWorker(tabId)`, the same
    operation as the popup's "Use this tab".
  - `runClaude`, which runs `claude -p` with a clean environment, a throwaway
    `HOME`/`CLAUDE_CONFIG_DIR`, `--allowedTools "Bash Write Read Edit"` and
    `--permission-mode acceptEdits`. Pass `home` to keep Claude Code's
    sessions between runs (for `--continue`).
  - `startChain`, which wires all of the above together; `chain.close()` also
    kills `claude` runs that are still going (after a test timeout).
  - `chromiumSkipReason` and `chainSkipReason`.
- `locale.test.ts`: the extension against the zh-CN fake with the cycling
  primary button, unknown send/stop labels and synthetic Enter ignored. Send
  must use the structural button without starting voice mode; a localized Work
  switch is set to Chat; a Work turn (unrecognizable switch) is stopped and
  refused from its request body; cancel stops the reply without knowing the
  stop label and the next job runs at once; a dropped stream is read back
  while the answer stays `in_progress` for 17 s; a localized usage-limit banner
  and a Sentinel 429 become `rate_limited`; a logged-out guest composer never
  gets the prompt. Also: the bot-management script does not flag the tab as a
  Cloudflare check.
- `lifecycle.test.ts`: a navigation that first lands on a self-reloading
  Cloudflare check; text typed into the worker tab while a job sends; a
  workspace account's read-back (`Chatgpt-Account-Id`); an ignored `?model=`
  reported as `model_mismatch`; an escaping composer reported as
  `prompt_mismatch` (`backslash-escape`); a large prompt sent cut short stopped
  as `too_long`; a job cancelled while its navigation loads.
- `fake.test.ts`: tests the fake alone, without the extension.
- `chain.test.ts`: runs the real `claude` CLI against the bridge, the extension
  and the fake.
  1. A `Write` round trip over SSE, with reasoning and a preamble. The second
     ChatGPT turn must continue the same conversation, using `conversation_id`
     and `parent_message_id`, and carry `<tool_result`. The typed prompt must
     equal the bridge's prompt exactly.
     The reasoning summary must stream as `status: thinking` and the reply as
     growing `text` prefixes.
  2. The WebSocket handoff, with streamed `text` events that are prefixes of the
     final reply.
  3. The SSE connection drops in the middle of the tool call. The extension
     must report `recovering`, read the full reply back from
     `GET /backend-api/conversation/<id>`, and the next turn must continue the
     same conversation. Nothing is re-sent to ChatGPT.
  4. Session A says hi, session B starts its own chat, then
     `claude --continue` resumes session A. The bridge must continue ChatGPT
     conversation A with only the new turn, and the extension must navigate
     the tab from `/c/<B>` back to `/c/<A>` (the page loads it through
     `GET /backend-api/conversation/<A>`) and answer the current node.
  5. The worker tab is logged out. The bridge must fail the request with
     `no_worker` ("none is ready") after `workerWaitMs` (8 s here) instead of
     waiting for the 20-minute job timeout. Nothing reaches ChatGPT.
  6. HTTP 429 must become `rate_limited` with `retryAfterMs` taken from
     `clears_in`, and `claude` must fail fast with `api_error_status: 429`.
     Keep this scenario last: after it, the bridge fails fast for an hour.

## SSE delivery

Playwright's `route.fulfill()` cannot stream: a body reaches the page in one
piece. So the fake answers `POST /backend-api/f/conversation` with
`route.continue({ url })` to a loopback HTTPS server (`stream-server.ts`). The
server writes the SSE text in small, irregular byte slices a few milliseconds
apart, so lines, events and multi-byte characters are split across reads, as
on the real site. It can also drop the connection partway. The page keeps
seeing the `https://chatgpt.com/...` URL. Three details make this work:

- The certificate is self-signed (generated once per run with the `openssl`
  CLI), so contexts need `ignoreHTTPSErrors` (`FAKE_CONTEXT_OPTIONS`).
- Chrome's Local Network Access holds a request from a public origin to
  loopback at a permission prompt. `install()` grants `local-network-access`
  to `https://chatgpt.com`.
- Chromium re-checks the referrer against the new cross-origin URL and blocks a
  full-path referrer with `ERR_BLOCKED_BY_CLIENT`. The fake sends the origin
  only.

Without `openssl`, the fake falls back to whole bodies (`delivery: 'whole'` on
the request record). A cut body then just ends early. The WebSocket handoff
mode delivers its frames one at a time with real delays in both cases.

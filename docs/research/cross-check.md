> Research note from the initial build (2026-10-09). The raw workspace referenced as `<research-workspace>` (captures, clones, scripts) was not preserved; the findings below are.

# Completeness critic: cross-track review of capture, chatgpt, plugin, priorart and toolproto (2026-10-09)

I checked the claims that were cheap to test: 14 new mock runs against `claude` 2.1.295, plus reads of the CLI binary strings and of the cloned prior-art sources. Five reports disagreed on twelve points; all but one are resolved below (the GPT-6-in-Chat question stays open). The two biggest corrections:
- **Headless worker permissions.** The plugin track's `--permission-mode acceptEdits` alone lets Write and `touch` through but denies `npm`, `git` and `python3` in `-p`.
- **Subagent detection.** The billing-header method stops working once the recommended `CLAUDE_CODE_ATTRIBUTION_HEADER=0` is set; request headers work instead.

Paths used below:
- `$CAP` = `<research-workspace>/capture`
- `$CRIT` = `<research-workspace>/critic`

My new fixtures are `$CAP/fixtures/x_critic_*`. My responders are `$CRIT/responders/{too_long,perm,perm2}.mjs`, and `$CRIT/summ.sh` summarises a fixture directory.

---

## 0. What must change in the design

1. **Headless worker permissions (plugin §3.4 is wrong as written).** Verified in `x_critic_perm_*`, `x_critic_perm2_*` and `x_critic_perm3_allowed`.
   - Under `claude -p --permission-mode acceptEdits`, Write and `touch` succeed.
   - `npm --version`, `git init` and `python3 -c` are denied with "This command requires approval"; headless mode cannot prompt.
   - `default` denies Write as well, and `dontAsk` denies everything.
   - **Fix:** `--permission-mode acceptEdits --allowedTools Bash` (or Bash patterns) ran everything with no classifier calls. The alternatives are `bypassPermissions` (plus `IS_SANDBOX=1` when running as root) or `--permission-prompt-tool` relaying approvals to the parent. Which one to use is a product decision.
2. **Subagent detection: use headers, not the billing block.** Verified in `i2_subagent_bypass` and `x_critic_hints_subagent`.
   - Subagents **share the parent's `x-claude-code-session-id`**.
   - `x-claude-code-agent-id` and `x-claude-code-parent-agent-id` are always present on subagent requests.
   - With `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, `x-claude-code-request-class` takes the values `main`, `subagent`, `auxiliary` and `compaction`. Reactive compaction also sends `x-claude-code-compaction: reactive`.
   - Both still work with `DISABLE_EXPERIMENTAL_BETAS=1` and `ATTRIBUTION_HEADER=0`.
   - **The ChatGPT conversation key must be `(session_id, agent_id ?? "main")`.**
3. **Reactive compaction works and is the escape hatch for every "too big" condition.** Verified in `x_critic_too_long` and `x_critic_hints_compact`.
   - Returning 400 `invalid_request_error` with message `prompt is too long: 250000 tokens > 200000 maximum` makes the CLI send one compaction request, then a "continued" request, and the run succeeds.
   - Map these to that 400: ChatGPT "maximum length for this conversation", "message too long", and the composer refusing input.
4. **Shrink the request with `--tools`.** Verified in `x_critic_tools_core`.
   - Flags: `--tools "Bash,Read,Edit,Write,WebFetch,WebSearch,NotebookEdit"` with `DISABLE_EXPERIMENTAL_BETAS=1` and `ATTRIBUTION_HEADER=0`.
   - Body drops from 74,955 to **18,363 chars**: tools 10,282, system 6,008, messages 1,710. The roughly 9K "# Environment" message shrinks because the agent and skill lists disappear.
   - This also removes the Agent tool, so no subagent can start a fresh ChatGPT conversation with its own bootstrap.
5. **Always set `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`, and still implement `stream:false`** (details in C1).
6. **Do not depend on aria-labels.** The 2026-09 layout has no `data-testid`, and its labels are localized. The user is Chinese-speaking; oracle only handles English and Japanese labels (details in R3).

---

## 1. Contradictions between reports

| # | Topic | Report A | Report B | Resolution (confidence, evidence) |
|---|---|---|---|---|
| C1 | Non-stream fallback | capture: must support it and coalesce | priorart: disable with `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` ("tools run twice") | **Do both. (H)** See the notes below the table. |
| C2 | `HEAD /api/hello` | capture: only `POST /v1/messages` is ever hit | plugin: HEAD is the first request | **Both are right. (H for existence, M for cause)** Plugin runs had no `HTTPS_PROXY` and show `HEAD /api/hello` (UA `Bun/1.4.3`, no auth header) before *every* POST; `plugin/capture/run10` has 8 of them. Capture runs set `HTTPS_PROXY` plus `NO_PROXY` and never sent it. The bridge must answer `HEAD`/`GET /api/hello` with 200, without auth, and fast. |
| C3 | Stream capture | priorart: read from `response.clone()` | chatgpt: observe mode, never clone | **Prefer observe mode, keep clone as fallback. (M)** sse-devtools-panel commit `cdfeefd` (2026-10-04) gives a precautionary reason ("can change buffering/backpressure behavior"), not an observed break. chatgpt-exporter (2026-09-25) and web-model still clone. Observe mode has its own failure mode: if the page stops reading (WebSocket handoff or cancel), we stop seeing bytes. So the WebSocket hook and the `GET /conversation/{id}` fallback are mandatory. The repo is MIT (`LICENSE` "Copyright (c) 2026 FatMii"), so its reducer and tests can be adapted. |
| C4 | `GET /backend-api/conversation/{id}` for Temporary Chat | priorart: "not available" | chatgpt: works once the id is known | **It works if the id is captured from the stream. (M)** `chatgpt-exporter/src/temporaryChat.ts`: temporary chats "are served by the regular conversation endpoint once the id is known" (release 2.36.0, 2026-09-25). I found no oracle source for "not available"; oracle only detects temporary chat from the URL. The real limitation: a temporary chat **cannot be reopened after the tab reloads or navigates** (no URL), so the session-to-tab binding is fragile, and custom instructions still apply. |
| C5 | Subagent detection | capture: billing block `cc_is_subagent=true` | plugin: set `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, which deletes that block | **Use headers (§0.2). (H)** |
| C6 | Worker permission mode | plugin: `acceptEdits` | capture: `acceptEdits` avoids the classifier | **Both true, but `acceptEdits` alone cripples the worker (§0.1). (H)** |
| C7 | Error mapping | chatgpt: auth or challenge → 401/403; capture: never a bare 401; `x-should-retry:false` stops retries "on any status" | | **Verified. (H)** 403 is **not retried** (1 request; output `Failed to authenticate. API Error: 403 <msg>`; `x_critic_403`). 529 **with `x-should-retry:false` still makes 3 attempts** (`x_critic_529_noretry`), so capture's claim does not cover 529. Mapping: tab or extension missing → 503 + `x-should-retry:false` (fail fast, as capture's f19 verified). Login or Cloudflare challenge → 403 `permission_error`. Quota → 429 + `retry-after` ≥ 61. Transient → 429 with `retry-after` ≤ 60, or 529. |
| C8 | Context-window variable | capture and plugin: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | priorart: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` | **Use `MAX_CONTEXT_TOKENS`. (H)** With 120000, compaction fired at a reported 105k and not at 90k (`x_critic_ctx120k_*`). It can also go below the 100k floor of `AUTO_COMPACT_WINDOW`. **Thrash risk:** with a constant reported 105k the CLI compacted in a loop. After compaction the bridge must open a fresh ChatGPT conversation and report the new, small usage. |
| C9 | Context-overflow wording | plugin: "Prompt is too long" | priorart: also `input length and max_tokens exceed context limit: A + B > C` | "prompt is too long: …" **verified (H)**. The second form is unverified (L). |
| C10 | GPT-6 in Chat | chatgpt: GPT-6 Sol/Luna are "Work and Codex only, not Chat" (2026-09-22) | same report: oracle maps `gpt-6-pro`/`astra` to the Chat "Latest" radio | **Open.** Enumerate with `GET /backend-api/models` and verify each turn from `server_ste_metadata.metadata.model_slug`. |
| C11 | Thinking context window | 196K / ~256K / ~128K input | | Not resolvable offline. All tracks converge on 100–120K usable. Instant on Plus (~32K) is unusable. |
| C12 | Tool set | capture: 21 tools; my runs on the same binary: 20; toolproto: 31–37 | | **Environment-dependent; never hardcode. (H)** Glob, Grep and TodoWrite **do not exist** in 2.1.295, but toolproto's "core" list and example (§3.2) use TodoWrite. Build examples from the tools actually present. |
| C13 | Auxiliary requests | capture: none locally | toolproto: four-state status classifier | That classifier is **cloud-only**: `cc_entrypoint=remote`, `x-claude-remote-*` headers, `model: claude-sonnet-5-5` (`toolproto/cap/req_002`). The generic rule still holds: answer `request-class=auxiliary` or tool-less non-compaction requests cheaply. **Auxiliary requests can carry Claude model IDs** (`claude-sonnet-5-5`) unless `ANTHROPIC_DEFAULT_*_MODEL` remaps them, so the bridge must accept any model string. |
| C14 | Billing-header suffix | capture: "changes per request" | | Stable within a session across turns and retries (`c_tool_roundtrip` `.818` ×3; `f1` `.f0b` ×3); main and subagent differ. Moot once the block is stripped. |

**C1 detail.**
- The env var exists in 2.1.295: `…||a.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK||k("tengu_disable_streaming_to_non_streaming_fallback")`.
- With it set (`x_critic_trunc_nofallback`): 2 identical stream attempts, no `stream:false`, exit 1 with `API Error: Connection to the API was lost (StreamTruncated)`.
- `stream:false` must still be implemented: classifier requests are non-stream (`i_subagent` requests 2–8), and SDK users may not set the env var.
- **Retried bodies are byte-identical** (`f1`, `f8`, `f9`). The fallback body differs only in `stream` and `max_tokens`. So **idempotency key = sha256(canonical body without `stream`/`max_tokens`) + session + agent**.
- The "tools run twice" claim was not reproduced (L).

---

## 2. Open questions that change the design (live chatgpt.com tests, P0)

1. **Text fidelity from the composer to the POST body.** The new composer is `data-composer-markdown`. Oracle 0.20.3 (2026-09-13) had to "recognize prompt echoes across whitespace changes, preserve literal backslashes".
   - Risk: tabs (Read output is `1\tline`), trailing spaces, blank-line runs, `\`, `*`, `_`, `#` and `<tags>` get altered. The model then copies altered text into Edit `old_string`, and edits fail.
   - Test: in the MAIN-world hook, diff `messages[0].content.parts[0]` of the outgoing POST byte-for-byte against the intended prompt.
   - Possible alternative (decision for the lead): rewrite `parts[0]` in the page's own outgoing request. g4f's `_prepare_conversation` body (`OpenaiAccount.py` L380–405) carries **no message content**, so content does not seem bound at prepare (L). This has ToS and detection risk.
2. **Maximum inline message size.** Reports range from 14–25K chars (forum and vendor posts, L) to oracle inlining about 60K via chunked paste. This sets the bootstrap budget. The core-tools bootstrap is about 18K chars of body (§0.4) plus protocol rules, so it is likely feasible.
3. **Behaviour of long conversations.** 2026 guides (M-L) describe two behaviours: **silently dropping the oldest messages**, or a hard "You've reached the maximum length for this conversation" block.
   - Silent drop would erase the bootstrap (protocol and tools) in delta mode.
   - Mitigations: a short protocol reminder plus a list of tool names in each delta footer; rotate the conversation at an estimated threshold; map the hard block to the 400 from §0.3.
4. **Clicking Stop on `</P:tool_calls>`** (toolproto). Unknowns:
   - Is the partial message kept as `parent_message_id` for the next turn?
   - Does `finish_details: interrupted` cause UI side effects?
   - Is there any gain with Thinking models, where final text arrives last?
   - The stream scanner must watch final-channel text only, not reasoning summaries.
5. **Synthetic paste and Enter in a background or unfocused tab** (L everywhere).
6. **Local Network Access** for an extension service worker connecting to `ws://127.0.0.1`.
   - Chrome's June 2025 post says WebSockets were not yet gated.
   - A third-party write-up says localhost works for extensions (L).
   - Test on Chrome stable 142 or later, and keep an offscreen-document fallback.
7. **Quota pools.** Does Work mode draw on the Chat pool or the Codex pool? The user explicitly wants the chatbot quota, so force Chat mode and verify `product_experience:"chat"` in `server_ste_metadata`.
8. **`x-openai-web-sse-compression`.** If the page opts in, the observed bytes may not be plain SSE (L). Check the content type and the first frame; otherwise fall back to the GET endpoint.
9. **A/B "which response do you prefer"** dual replies, and moderation (`safety_review_update`, blocked content) producing an empty final message.
   - An empty reply makes the CLI auto-send `[Your previous response had no visible output. Please continue and produce a user-visible response.]`, which costs another message.
   - The bridge should cap this and surface an error instead.

---

## 3. Risky assumptions

- **R1. "One ChatGPT conversation per `session_id`."** Wrong for subagents (C5). Background agents run concurrently; at most 3 tabs (oracle) means a queue, with pings keeping waiting streams alive.
- **R2. Naive prefix hashing for delta mode.** Normalization the bridge must do (verified unless marked):
  - string ≡ `[{type:"text"}]`. Earlier `system` messages collapse to plain strings on the next turn (`c_tool_roundtrip` 002/003).
  - Strip `cache_control`.
  - `<total_tokens>` system messages stay in history and are stable once emitted.
  - Strip the billing block.
  - The echo reorders tool_use-then-text into text-then-tool_use.
  - Thinking blocks.
  - Exact CLI stub strings from the binary:
    - `[Old tool result content cleared]` (treat as unchanged, not divergent)
    - `<persisted-output>…</persisted-output>` and `<truncated-output>`
    - `File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.`
    - `[Request interrupted by user]` and `[Request interrupted by user for tool use]`
    - `Output token limit hit. Resume directly — no apology, no recap…`
  - **Esc / interrupt** leaves an orphaned partial ChatGPT reply that Claude Code's history lacks. Send a delta saying "previous reply discarded" rather than a full replay.
- **R3. Selectors.** In the 2026-09 fixtures (`oracle/tests/fixtures/chatgpt-dom-2026-09/*.html`):
  - The primary composer button is `<button type="button" class="… size-token-button-composer … bg-composer-primary …" aria-label="Stop">`. It is **not** `type="submit"`, so oracle's `form button[type="submit"]` misses it. Its label cycles through Stop, Start Voice and send, and is localized.
  - Use `form[data-chatgpt-composer] button.size-token-button-composer` together with **network state** for "generating", and an Enter keydown as the primary submit.
  - Or require an English UI in a `doctor` check.
  - "Response complete" and Copy labels will be Chinese for this user.
- **R4. Delegate recursion.**
  - The worker loads the user's plugins, including ours, so it can call `delegate_task` itself. Guard with an env var such as `GPTWEB_WORKER=1` that the MCP server checks and refuses on, or disable the plugin in the worker's `--settings` (exact key unverified).
  - Also refuse delegation when the parent's `ANTHROPIC_BASE_URL` already points at the bridge.
- **R5. Latency and quota.**
  - Each agent turn is one Thinking message taking seconds to minutes, and a task is 30–100 turns.
  - Plus Thinking allows about 3,000 messages a week (M).
  - Batching and the `--tools` reduction matter more than parser polish.
- **R6. WebSearch policy conflict.** toolproto forbids ChatGPT browsing; capture and priorart want ChatGPT search for `web_search` side requests.
  - Route side requests to a separate (temporary) chat where browsing is allowed.
  - The WebFetch summarizer (tool-less, haiku/small model) can be answered **locally** with truncated page markdown, which saves a message per fetch.
  - WebFetch works with `NONESSENTIAL_TRAFFIC=1` (`n3`, `n4`).
- **R7. Usage reporting** drives compaction: C8 thrash, and priorart's warning that `input_tokens` must exclude cache reads.

---

## 4. Things no report covered

1. **Bridge security.**
   - Require the token on every route except `/api/hello`.
   - Reject any `Host` header that is not loopback, to stop DNS rebinding.
   - Send no permissive CORS headers.
   - The extension WebSocket needs a pairing secret and an `Origin: chrome-extension://<id>` check.
   - Prompts contain user source code, so do not log them by default.
2. **Persist the conversation map** (session/agent → `{conversation_id, last_message_id, nonce, toolsetHash}`) to disk, so a bridge restart or `--resume` does not force full replays.
3. **Ownership of the user's tab.** Use a dedicated window or tab group. Never type into a tab the user is using. The user's own ChatGPT use shares the quota and the "≤5 concurrent" throttle. Add pacing with jitter between sends (M).
4. **Parent and worker editing the same tree at once.** Offer `--worktree` or isolation for the delegate.
5. **SDK versus CLI.** The user literally asked for "plugin calls the Claude Code SDK".
   - The TS SDK is proprietary ("All rights reserved") and needs about 256 MB per platform.
   - The Python SDK is MIT.
   - Recommended: spawn `claude -p --input-format/--output-format stream-json`, which is the same protocol the SDK wraps, and offer the SDK as a normal npm dependency of the bridge package. State this decision in the README.
6. **Tests without chatgpt.com.**
   - Oracle's DOM fixtures (MIT).
   - sse-devtools-panel's ChatGPT reducer tests (`src/shared/ai-merge/__tests__/index.test.ts`, `chatgpt-timing.test.ts`, `src/shared/__tests__/chatgpt-logical-turn.test.ts`, `src/content/inject/__tests__/patch-websocket.test.ts`; MIT).
   - Port `$CAP/mock-server.mjs` into a CI contract test against the installed `claude`; 2.1.295 shipped 2026-10-08 and versions move almost daily.
7. **Data hygiene.**
   - `toolproto/cap/*` contains a real `account_uuid` and `device_id`.
   - `$CAP/mitm/` holds a CA private key.
   - My `$CRIT/claude-strings.txt` is a 58 MB string dump of the CLI binary.
   - None of these may enter the public repo.

---

## 5. Corrected launcher and worker environment

```
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>   ANTHROPIC_AUTH_TOKEN=<bridge secret>
ANTHROPIC_MODEL=<id without "claude-" prefix>   ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL=<same or cheap id>
CLAUDE_CODE_MAX_CONTEXT_TOKENS=120000         # verified: compaction fires between 90k and 105k reported
CLAUDE_CODE_GATEWAY_HINT_HEADERS=1            # verified request-class / compaction headers
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1   # verified: no stream:false retry
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1  CLAUDE_CODE_ATTRIBUTION_HEADER=0
CLAUDE_CODE_AUTO_MODE_SERVER=0  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false  CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
CLAUDE_CODE_MAX_RETRIES=2  API_TIMEOUT_MS=1800000  CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000
flags: --settings '{"env":{…},"disableAutoMode":"disable"}'
       --tools "Bash,Read,Edit,Write,WebFetch,WebSearch,NotebookEdit"   # optional lite mode (18K-char body)
       --permission-mode acceptEdits --allowedTools Bash   # worker; or bypassPermissions + IS_SANDBOX=1 when root
```

Sources: local CLI 2.1.295 runs (fixtures above); `oracle@35d8022` (CHANGELOG 0.20.3 and 0.21.4, `constants.ts`, DOM fixtures); `sse-devtools-panel@cdfeefd`; `chatgpt-exporter` `temporaryChat.ts` (2.36.0); g4f `OpenaiAccount.py` L374–420; [Chrome LNA blog](https://developer.chrome.com/blog/local-network-access); [teampasswordmanager Chrome 142 note](https://teampasswordmanager.com/blog/chrome-142-update/); [OpenAI forum, message too long](https://community.openai.com/t/warning-the-message-you-submitted-was-too-long-please-reload-the-conversation-and-submit-something-shorter/657194); [fast.io character limit (vendor)](https://fast.io/resources/chatgpt-character-limit/); [ai-toolbox max-length guide (vendor)](https://ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-maximum-length-conversation-fix-2026); [OpenAI forum, false max-length](https://community.openai.com/t/gpt-falsely-throws-youve-reached-the-maximum-length-for-this-conversation/1271634).
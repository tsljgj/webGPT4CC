> Research note from the initial build (2026-10-09). The raw workspace referenced as `<research-workspace>` (captures, clones, scripts) was not preserved; the findings below are.

# Claude Code CLI v2.1.295 against a custom ANTHROPIC_BASE_URL: what it sends and what it accepts (captured 2026-10-09)

All findings come from running the real CLI (`/opt/node22/bin/claude`, `2.1.295 (Claude Code)`, a Bun single-file executable, SDK `x-stainless-package-version: 0.128.0`) against a local logging mock, in about 90 isolated scenarios. Confidence is **high** wherever a fixture path is cited. Anything marked "(code)" comes from reading the minified strings in the binary and is **medium** confidence. All work is under:

`<research-workspace>/capture/` (`$CAP` below)

---

## 0. Key facts for the bridge design

1. **Endpoints on the base URL.** Only `POST /v1/messages?beta=true` was hit (plus `POST /v1/messages/count_tokens?beta=true` when `/context` runs). The CLI never called `/v1/models`, OAuth or metrics endpoints on the base URL. Routing must tolerate the `?beta=true` query string.
2. **`role:"system"` messages appear inside `messages[]`** (beta `mid-conversation-system-2026-04-07`). Their content is sometimes an array of blocks and sometimes a plain string. This stays on even with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, so the bridge must handle it.
3. **Unknown model names like `gpt-5-thinking` are accepted.**
   - The CLI prints a stderr warning, assumes a **200k context window**, and uses `max_tokens: 32000` and `effort: "high"`.
   - Override the window with `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<n>` or a `[1m]` suffix on the model name.
   - Subagents inherit the main model.
   - `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` map the aliases (`--model haiku` sends `gpt-haiku-mapped`).
   - Small/fast model: `ANTHROPIC_SMALL_FAST_MODEL`, else `ANTHROPIC_DEFAULT_HAIKU_MODEL`, else the main model. It was only used by the WebFetch summarizer.
4. **Streaming contract** (§7 for full results):
   - `event:` lines are required; data-only SSE is treated as a failed stream.
   - `content_block_stop` is required; without it the content is dropped.
   - Tool input must arrive through `input_json_delta`. An input placed in `content_block_start` is **ignored**, so the tool runs with `{}`.
   - Optional: `usage`, `ping`, `message_stop`, `message_delta`, `stop_sequence`, `type`/`model` in `message_start`.
   - IDs are free-form; `chatcmpl-…` and `call_abc123` are echoed back verbatim.
   - The CLI runs any `tool_use` block whatever the `stop_reason`.
5. **Non-streaming fallback is real and must be supported.** If a stream ends with no events, is truncated, fails three times, or goes idle, the CLI re-sends the same body with `stream:false`, `max_tokens 64000` and `x-stainless-timeout: 300`.
   - The JSON reply must be a complete Message **including `usage`**.
   - The bridge should de-duplicate this against an in-flight streaming job instead of sending ChatGPT the same prompt twice.
6. **Timeouts and keepalive:**
   - Stream byte-idle watchdog defaults to **300 s** (`g6`). Any bytes reset it; both `event: ping` and SSE `: comment` lines kept a stream alive for 330 s (`g11`, `g12`).
   - Time-to-headers limit is `API_TIMEOUT_MS`, default 600 s (`x-stainless-timeout: 600`).
   - **Recommendation:** send headers and `message_start` immediately, then a ping every 10–15 s while ChatGPT thinks.
7. **Retries:**
   - 5xx, 429 and **401** are retried 10 times with backoff of 0.5→1→2→4→8→16→32 s (with jitter), about 3 minutes total.
   - 529 and SSE `overloaded_error` get only 3 attempts.
   - `x-should-retry: false` stops retries immediately, on any status.
   - `retry-after` (seconds) is honored up to **60 s**. At 61 s or more the CLI fails immediately with `API Error: Request rejected (429) · <message>`, so "ChatGPT quota exhausted" should be a 429 with `retry-after` above 60 and a readable `error.message`.
   - `retry-after-ms` was not honored on the main loop.
8. **The default permission mode is `auto`, in both `-p` and the TUI.**
   - When a tool call is not on the fast-path allowlist (the Agent tool was), the CLI makes **two-stage security-classifier `/v1/messages` calls**. Each has a roughly 140 KB system prompt, uses the Sonnet-tier model, and is retried up to 5 times. If the reply is not in the expected format, the action is denied.
   - Auto mode also adds a `safeguards` body field and the `dangerous-tool-use-2026-09-03` beta.
   - **The launcher should pass `--permission-mode acceptEdits` (or `default` / `bypassPermissions`).** None of these produced classifier calls or `safeguards`.
9. **Third-party traffic ignores ANTHROPIC_BASE_URL.**
   - The CLI contacts `api.anthropic.com` directly: `/api/claude_cli/bootstrap`, `/api/claude_code_penguin_mode`, `/mcp-registry/v0/servers`, `/api/event_logging/v2/batch`, `/api/web/domain_info`. The TUI also contacts `downloads.claude.ai` and `raw.githubusercontent.com`.
   - In this container the bootstrap and penguin calls carried **a Bearer OAuth token the CLI found on the host** (not our test token). On a user's machine that would be their real claude.ai token.
   - **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` removed all of it** (`h1`, `h3`). The launcher should always set it.
10. **Main-loop size (`-p`, 21 tools):** body 74,955 chars (about 21k tokens), of which tools are 55,295, system 6,207, and messages 10,048 (the first `system` message alone is 9,354). The interactive TUI request (24 tools) is 87,602 chars. Every turn resends everything.

---

## 1. Harness, isolation, reproduction

| File | Purpose |
|---|---|
| `$CAP/mock-server.mjs` | No-dependency logging and scriptable Anthropic mock. Decodes gzip, deflate, br and zstd request bodies. Writes `NNN-<METHOD>-<path>.json` with the full request (headers, raw headers, body, classification) and the exact SSE it sent. Supports kinds `message`, `error`, `sse_error`, `slow` (ping, comment, silent or delayed headers), `raw`, `hang`, plus `omit*` and `toolInputInStart` knobs. |
| `$CAP/blackhole-proxy.mjs` | Used as `HTTPS_PROXY`. Logs every CONNECT and never forwards anything. With `--mitm`, it terminates TLS locally using a throwaway CA (`$CAP/mitm/`), logs method, host, path and body (credentials redacted at source), and answers 404, or a fake page for `/capture-test/*`. |
| `$CAP/run.sh` | Isolated scenario runner using `env -i`, a fresh HOME and CLAUDE_CONFIG_DIR, the proxy, the mock, and `timeout`. `$CAP/run-scenario.sh` is the earlier version without MITM. |
| `$CAP/run-interactive.sh` + `interactive.py` | TUI capture in a PTY with a pre-seeded `.claude.json`. |
| `$CAP/responders/*.mjs` | Per-scenario scripts: `tool_roundtrip`, `errors`, `slow`, `variants`, `nonstream`, `subagent`, `classifier`, `compaction`, `webtools`. |
| `$CAP/timing.sh <scenario>` | Prints request timestamps and deltas. |

What the nested launch amounts to:

```bash
env -i PATH=/opt/node22/bin:/usr/bin:/bin HOME=$TMPHOME USER=capture LANG=C.UTF-8 TERM=dumb SHELL=/bin/bash \
  CLAUDE_CONFIG_DIR=$TMPHOME/.claude ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT \
  HTTPS_PROXY=http://127.0.0.1:$PPORT HTTP_PROXY=... NO_PROXY=127.0.0.1,localhost NODE_EXTRA_CA_CERTS=$CAP/mitm/ca.crt \
  ANTHROPIC_AUTH_TOKEN=test-token  <scenario env>  timeout 120 claude -p "..." < /dev/null
```

Example commands (all run from `$CAP`):

```bash
./run.sh a_say_hi - 120 -- ANTHROPIC_AUTH_TOKEN=test-token -- -p "say hi"
./run.sh c_tool_roundtrip responders/tool_roundtrip.mjs 120 -- ANTHROPIC_AUTH_TOKEN=test-token -- -p "run echo then write a file"
MOCK_ERR_STATUS=429 MOCK_ERR_TYPE=rate_limit_error MOCK_ERR_COUNT=2 MOCK_ERR_HEADERS='{"retry-after":"3"}' \
  ./run.sh f1_429_retry_after responders/errors.mjs 120 -- ANTHROPIC_AUTH_TOKEN=test-token -- -p "say hi"
MOCK_SLOW_HEARTBEAT=silent MOCK_SLOW_TOTAL_MS=40000 ./run.sh g2b_silent_byteidle15s responders/slow.mjs 200 -- \
  ANTHROPIC_AUTH_TOKEN=test-token CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=15000 -- -p "say hi" --output-format stream-json --verbose
MITM=0 MOCK_VARIANT=tool_input_in_start ./run.sh v_tool_input_in_start responders/variants.mjs 120 -- ANTHROPIC_AUTH_TOKEN=test-token \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -- -p "do the thing" --output-format stream-json --verbose
./run.sh i3_subagent_bypass_custommodel responders/subagent.mjs 180 -- ANTHROPIC_AUTH_TOKEN=test-token IS_SANDBOX=1 \
  ANTHROPIC_MODEL=gpt-5-thinking -- -p "delegate an echo to a subagent" --permission-mode bypassPermissions --output-format stream-json --verbose
TTY_INPUT="/context" ./run-interactive.sh m2_interactive_context - -- ANTHROPIC_AUTH_TOKEN=test-token --
```

`meta.txt` in each fixture directory records the exact environment and arguments for that run.

**What was needed to run without prompts:**
- **`-p` mode:** nothing extra. There was no onboarding, trust dialog or API-key approval prompt, including with `ANTHROPIC_API_KEY`.
- **`--permission-mode bypassPermissions` as root:** refused with `--dangerously-skip-permissions cannot be used with root/sudo privileges`. Setting `IS_SANDBOX=1` fixed it.
- **Interactive TUI:** pre-seed `$CLAUDE_CONFIG_DIR/.claude.json` with:
  ```json
  {"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.295","theme":"dark","numStartups":5,
   "projects":{"<cwd>":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}
  ```
  The TUI then shows "auto mode on".

**Every `-p` run printed this on stderr** (and it appears as a `system/informational` stream-json event):
> We're changing auto mode to no longer charge for classifier requests... your requests go through 127.0.0.1:PORT, which isn't compatible... https://code.claude.com/docs/en/auto-mode-classifier-billing

**Credential note:** the throwaway CA private key is in `$CAP/mitm/`. A host OAuth token captured once in `h0` was scrubbed, and a final scan found no `sk-ant-…` strings anywhere under `$CAP`.

---

## 2. Endpoints

| Destination | Path | When | Confidence |
|---|---|---|---|
| base URL | `POST /v1/messages?beta=true` | every model call | high (all fixtures) |
| base URL | `POST /v1/messages/count_tokens?beta=true` | `/context` in the TUI: 15 calls, body `{model, messages, tools?}`; system sections are sent as user messages, and the probe message is `"foo"` | high (`m2_interactive_context`) |
| base URL | `/v1/models` | never observed; present in code for a "gateway" provider | low |
| api.anthropic.com | `GET /api/claude_cli/bootstrap?entrypoint=sdk-cli&model=…` | startup; `Authorization: Bearer <host OAuth token>`, `anthropic-beta: oauth-2025-04-20` | high (`h0`, `h4`) |
| api.anthropic.com | `GET /api/claude_code_penguin_mode` | startup (fast mode), Bearer | high |
| api.anthropic.com | `GET /mcp-registry/v0/servers?version=latest&limit=100&visibility=…` | startup | high |
| api.anthropic.com | `POST /api/event_logging/v2/batch` | telemetry, 200–400 KB | high |
| api.anthropic.com | `GET /api/web/domain_info?domain=…` | WebFetch preflight; disable with setting `skipWebFetchPreflight: true` | high (`n_webtools_explore`) |
| downloads.claude.ai | `/claude-code-releases/latest`, `/claude-code-releases/plugins/claude-plugins-official/latest` | TUI only | high (`m_interactive_default`) |
| raw.githubusercontent.com | `/anthropics/claude-code/refs/heads/main/CHANGELOG.md` | TUI only | high |

Effect of the traffic switches:
- `DISABLE_TELEMETRY=1` removed only `event_logging` (`h2`).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` removed **all** third-party calls; no CONNECT was even attempted (`h1`, `h3`).
- Model traffic was identical in every case.

---

## 3. Request headers (main loop)

```
POST /v1/messages?beta=true   HTTP/1.1, keep-alive, request body NOT compressed
accept: application/json
authorization: Bearer test-token          <- ANTHROPIC_AUTH_TOKEN
x-api-key: sk-ant-test-key-123            <- instead, when ANTHROPIC_API_KEY is used (no Authorization header)
content-type: application/json
user-agent: claude-cli/2.1.295 (external, sdk-cli)     # TUI: (external, cli)
x-app: cli
x-claude-code-session-id: <uuid>          # same value as metadata.user_id.session_id
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
anthropic-beta: <see below>
x-stainless-arch/lang(js)/os(Linux)/package-version(0.128.0)/runtime(node)/runtime-version(v26.3.0)
x-stainless-retry-count: 0                # always 0; the CLI retries in its own loop
x-stainless-timeout: 600                  # 300 on non-stream fallback; API_TIMEOUT_MS/1000 if set
accept-encoding: gzip, deflate, br, zstd
```

`CLAUDE_CODE_GZIP_REQUEST_BODIES=1` had **no effect** on a custom base URL; no `content-encoding` header was sent (`j_gzip`, high confidence).

**`anthropic-beta` values observed:**

| Context | Value |
|---|---|
| `-p`, auto mode, `claude-opus-5-5` | `claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31` |
| stream-json output or TUI | adds `thinking-display-updates-2026-08-18` |
| unknown model | drops `per-turn-control-2026-07-01` |
| `default` / `acceptEdits` / `bypassPermissions` | drops `dangerous-tool-use-…` and `afk-mode-…` |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | `claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,effort-2025-11-24` (and the `context_management` and `safeguards` body fields disappear) |
| classifier side requests | `claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05` |
| count_tokens | `claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01` |

---

## 4. Main-loop body

Reference fixtures: `$CAP/fixtures/main_loop_request.json` (`-p`) and `main_loop_request_interactive.json` (TUI).

Top-level keys, in order: `model, messages, system, tools, metadata, max_tokens, thinking, context_management, safeguards*, output_config, stream`.
- **Never sent:** `temperature`, `top_p`, `top_k`, `tool_choice` (except in the web-search side request), `stop_sequences` (except in the classifier).
- **`safeguards`:** only in auto mode, and only on the request that starts a user turn; it is absent on tool-result follow-ups.

| Field | Value |
|---|---|
| `model` | `claude-opus-5-5` by default, or `ANTHROPIC_MODEL` / `--model` |
| `max_tokens` | 128000 for opus-5-5; 32000 for unknown models; 64000 on the non-stream fallback |
| `thinking` | `{"type":"adaptive","display":"omitted"}` (`"updates"` in TUI/stream-json). Removed entirely by `MAX_THINKING_TOKENS=0`. |
| `output_config` | `{"effort":"medium"}` for opus-5-5, `{"effort":"high"}` for unknown models |
| `context_management` | `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` |
| `metadata` | `{"user_id":"{\"device_id\":\"<64 hex>\",\"account_uuid\":\"\",\"session_id\":\"<uuid>\"}"}` (a JSON **string**) |
| `safeguards` | `[{"type":"dangerous_tool_use","classifier_context":{"v":1,"permission_mode":"auto","platform":"linux","live_cwd":…,"home_dir":…,"rule_roots":{…},"trusted_directories":{…},"rules":{"allow":[],"deny":[],"ask":[]},"auto_mode":{…},"git_state":{…},…}}]` |
| `stream` | `true` |

**`system` array, three text blocks:**
1. `x-anthropic-billing-header: cc_version=2.1.295.<3-hex>; cc_entrypoint=sdk-cli;` (or `cli` in the TUI). No `cache_control`. The 3-hex suffix changes per request, and subagents add ` cc_is_subagent=true;`. **The bridge should strip this block.**
2. The identity line, with `cache_control:{type:"ephemeral"}`:
   - `-p`: `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
   - TUI: `You are Claude Code, Anthropic's official CLI for Claude.`
3. The main prompt, about 5.9–6.1k chars, with `cache_control`, beginning `\nYou are an agent working with the user toward their goals…`.

**`messages` on turn 1:**
- `user`: `[ {text:"<system-reminder>\nAttribution for git commits…</system-reminder>\n"}, {text:"<prompt>"} ]`
- `system`: `[ {text:"# Environment\n… cwd, platform, model line, agent types, skills list, auto-mode note, <total_tokens>15000000 tokens left</total_tokens>\n\nToday's date is …", cache_control} ]`, about 9–10k chars

**Follow-up turns** (`fixtures/followup_request_with_tool_result.json`):
- Our assistant content is echoed back exactly (text, tool_use with the same `id`/`name`/`input`). The message id is not sent.
- `user: [{tool_use_id, type:"tool_result", content:"<string>", is_error:false}]`
- `system: [{type:"text", text:"<total_tokens>N tokens left</total_tokens>"}]`

**`cache_control` placement:**
- Always on `system[1]` and `system[2]`.
- In `messages`, the marker is only on the **last** message. Earlier `system` messages lose it and their content collapses to a plain string.
- `DISABLE_PROMPT_CACHING=1` removes every `cache_control` (`p_no_prompt_caching`).

**`tools`:**
- `-p` sends 21 tools: Agent, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, WebFetch, WebSearch, Workflow, Write.
- The TUI adds AskUserQuestion, EnterPlanMode and ExitPlanMode (24 total).
- Every tool is `{name, description, input_schema}` with a draft-2020-12 schema and `additionalProperties:false`. There are no server tools, no `cache_control` on tools, and no Grep, Glob or TodoWrite in this build.
- Stream-json `init` lists the Agent tool as `"Task"`.

**Sizes** (chars, total / description / schema), sorted:

| Tool | Total | Desc | Schema |
|---|---|---|---|
| DesignSync | 8948 | 3742 | 5124 |
| SendMessage | 5677 | 4259 | 1291 |
| Workflow | 5355 | 3480 | 1775 |
| ScheduleWakeup | 4886 | 3396 | 1392 |
| CronCreate | 4029 | 2924 | 958 |
| EnterWorktree | 4013 | 3220 | 687 |
| Agent | 3606 | 1668 | 1873 |
| Bash | 2875 | 1096 | 1720 |
| ExitWorktree | 2505 | 1923 | 481 |
| ReportFindings | 2177 | 574 | 1545 |
| Skill | 1803 | 1417 | 327 |
| NotebookEdit | 1623 | 619 | 940 |
| Read | 1588 | 790 | 740 |
| ListAgents | 1151 | 777 | 316 |
| WebFetch | 1080 | 469 | 554 |
| Edit | 964 | 360 | 552 |
| WebSearch | 861 | 334 | 468 |
| TaskStop | 789 | 364 | 366 |
| Write | 639 | 240 | 348 |
| CronDelete | 427 | 167 | 206 |
| CronList | 277 | 106 | 119 |

TUI-only tools: AskUserQuestion 4897 total, EnterPlanMode 4312 (description 4011), ExitPlanMode 2443.

Totals:
- `-p`: body 74,955; system 6,207; tools 55,295; messages 10,048.
- TUI: 87,602; system 6,468; tools 66,542; messages 11,107.

The full prompt text is in `fixtures/main_loop_prompt_text.txt`.

---

## 5. Request classes and how to detect them (all high confidence)

| Class | How to detect | Model | Notes |
|---|---|---|---|
| Main loop | `system[2]` starts `\nYou are an agent working with the user…`; tools include `Agent` | main | see §4 |
| Subagent | billing block contains `cc_is_subagent=true`; `system[2]` is the agent prompt (`You are an agent for Claude Code…`, Explore: `You are a file search specialist…`) | **inherits main model** | general-purpose gets 18 tools *including Agent*, so nesting happens; depth 2 gets 17 tools without Agent. Same streaming shape. Hand-back reaches the parent as `tool_result.content: [{type:"text", text:"[Subagent hand-back] … agentId: …<usage>…"}]`, i.e. an **array** (`subagent_request.json`) |
| Compaction | Same system and tools as the main loop. The last user message has an extra text block `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.…<analysis>…<summary>`. The next request starts `This session is being continued from a previous conversation…<summary text>` | main | Triggered by the **`usage.input_tokens` we report**: 195k against an assumed 200k window. With a constant 195k it thrashes and ends with `Autocompact is thrashing` (`l_compaction_195k`, `compaction_request.json`). `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` prevented it. |
| WebSearch execution | `tools:[{"type":"web_search_20250305","name":"web_search","max_uses":8}]`, `tool_choice:{type:"auto"}`, system `You are an assistant for performing a web search tool use`, user `Perform a web search for the query: …` | main | A plain-text reply was accepted and wrapped as `Web search results for query: "…"\n\n<text>\n\nREMINDER: You MUST include the sources…` (`websearch_side_request.json`) |
| WebFetch summarizer | `tools: []`, system has only blocks 0–1, user text `\nWeb page content:\n---\n<markdown>\n---\n\n<prompt>\n\nProvide a concise response…` | **small/fast** | `webfetch_summarizer_request.json` |
| Auto-mode classifier | `system[1]` starts `You are a security monitor for autonomous AI coding agents.` (about 140 KB); no tools; `thinking:{type:"disabled"}`; stage 1 uses `stop_sequences ["</severity>"]` (max_tokens 64) or `["</block>"]` (2112); stage 2 uses max_tokens 8192 / 10240 | `claude-sonnet-5`, or `ANTHROPIC_DEFAULT_SONNET_MODEL` | 5 attempts per stage. Expected formats: `<severity>N</severity>` (allow below 50), or `<block>no</block>` / `<block>yes</block><category>…</category><reason>…</reason>`. If it fails: `Auto mode could not evaluate this action and is blocking it for safety` (`i_subagent`, `o_classifier_allow`) |
| count_tokens | path ends in `/count_tokens` | main | `{"input_tokens": n}` estimates were accepted and `/context` rendered |

**Not observed in 2.1.295:** title generation, topic detection, quota probes, bash-prefix calls. None appeared in `-p` or in a TUI "say hi" session within 15 s.

---

## 6. Tool round-trip behaviour

| Case | Result |
|---|---|
| Arbitrary IDs (`call_abc123`) | Echoed back verbatim |
| `stop_reason` `end_turn` or `null` on a tool_use message | Tool still executes |
| Thinking block with fake signature | Echoed back unchanged |
| Parallel tool_use blocks | Both run; results returned in completion order (B, A) |
| tool_use followed by text | The echo **reorders** to text then tool_use (`v_tool_then_text`) |
| Malformed partial JSON | Echoed as `input:{"__unparsedToolInput":{"raw":"…","len":24}}`; tool_result `is_error:true` with `<tool_use_error>InputValidationError: Bash was called with input that could not be parsed as JSON…</tool_use_error>` |
| Unknown tool name | `<tool_use_error>Error: No such tool available: NoSuchTool</tool_use_error>` |
| Wrong parameter | `InputValidationError: … The required parameter \`command\` is missing / An unexpected parameter \`cmd\`…` |
| `stop_reason: "max_tokens"` | The CLI auto-continues 3 times with user text `Output token limit hit. Resume directly…`, then fails with `API Error: Claude's response exceeded the 128000 output token maximum…`. **Never emit `max_tokens` unless the output really was cut off.** |
| Message with no visible output (blocks never closed) | CLI re-asks with `[Your previous response had no visible output. Please continue and produce a user-visible response.]` |

`tool_result.content` comes in three shapes: a string, an array of text blocks, or with `is_error:true`. User and system message content can each be a string or an array.

---

## 7. Minimal response the CLI accepts

**Streaming, required:**
- `event:` lines.
- `content_block_start`, then deltas, then `content_block_stop`.
- Tool input via `input_json_delta`, with `content_block_start.input` set to `{}`.

**Streaming, optional** (each tested by omitting it; the CLI still succeeded):
- `ping`
- `usage` (in both `message_start` and `message_delta`)
- `message_stop`
- `message_delta` (without it the result has `stop_reason:null`)
- `stop_sequence`
- in `message_start`: `type`, `model`, `stop_reason`, `usage`. `{"id":…,"role":"assistant","content":[]}` alone worked.
- message-id format (`chatcmpl-…` accepted).

**Non-streaming (fallback):**
- A full Message (`id, type:"message", role, model, content, stop_reason, usage`) works.
- `{content:[…]}` alone, or a Message without `usage`, fails with `API returned an empty or malformed response (HTTP 200)… body is JSON but not a Message` (`q_json_*`).
- Answering a `stream:false` request with SSE also fails (`f4`).

A known-good SSE sample is in `fixtures/sample_sse_text_plus_tool_use.txt`:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_…","type":"message","role":"assistant","model":"…","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":42,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_…","name":"Bash","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\""}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":7}}

event: message_stop
data: {"type":"message_stop"}
```

---

## 8. Errors and retries

| Server response | CLI behaviour | Fixture |
|---|---|---|
| 429 + `retry-after: 3` (×2) | waits exactly 3 s each time, then succeeds | f1 |
| 429 `retry-after` 45 / 55 / 60 | waits, then retries | f13, f17 |
| 429 `retry-after` ≥ 61 (61, 120, 299, 301, 600) | **fails immediately**: `API Error: Request rejected (429) · <msg>` | f12, f17 |
| 429 `retry-after-ms: 1500` | ignored; default backoff of about 0.6 s used | f14 |
| 429 / 500 with no headers, every time | 11 attempts, backoff ~0.6, 1.2, 2.3, 4.2, 9, 17, 33, then about 33–40 s; about 180 s total; exit 1 | f2, f10 |
| 401 every time | **also retried 10 times** (about 3 min), then `Failed to authenticate. API Error: 401 …` | f7 |
| 400 `invalid_request_error` | one immediate retry **without `safeguards` and the `dangerous-tool-use` beta**, then fails: `API Error: 400 <msg>` | f6 |
| `x-should-retry: false` (401, 429, 500, 503) | no retry; fails immediately | f5, f18–f20 |
| 503 once | retried after about 0.6 s | f16 |
| 529 every time | 3 attempts, then `Repeated 529 Overloaded errors…` | f3 |
| SSE `event: error` overloaded, at start or after `message_start` | retried as a stream; after 3 failures, one non-stream attempt | f4, f8 |
| Stream ends without `message_stop` or deltas (truncated) | 2 stream attempts, then non-stream fallback | f9 |
| Empty or data-only SSE | immediate non-stream fallback | `v_no_event_lines`, q |

Other notes:
- `CLAUDE_CODE_MAX_RETRIES=2` gives 3 attempts (f21). Code clamps the value to 15 (code).
- Stream-json emits `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":2000,"error_status":429,"error":"rate_limit"}` (f11).
- Error bodies are shown verbatim: `error.message` is surfaced to the user.

---

## 9. Timeouts and watchdogs

| Test | Result |
|---|---|
| `message_start` then a ping every 10 s for 90 s (default settings) | OK, no retry (g1) |
| Ping every 10 s for 330 s / SSE `: keepalive` comment every 10 s for 330 s | **both OK** (g11, g12) |
| Silent after `message_start`, default settings | aborted at **300.2 s**, then non-stream fallback (g6) |
| Silent, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=15000` | aborted at 15.0 s, then non-stream fallback. If that also stalls: `API Error: stream idle: no bytes for 15000ms`, exit 1 (g2b, g10) |
| Ping or comment every 5 s, byte-idle limit 15 s | OK, so any bytes reset the watchdog (g3, g4) |
| Headers withheld 330 s, default settings | no abort; `API_TIMEOUT_MS` defaults to 600 s (g7) |
| Headers withheld, `API_TIMEOUT_MS=15000` | aborted at 15 s, then a **streaming** retry (`api_retry error_status:null`) (g9) |
| `API_TIMEOUT_MS=20000` while pings keep flowing for 60 s | OK. The limit applies only until headers arrive (g8) |
| `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS=10000`, headers withheld 40 s | **no effect**; the CLI waited (g5). Probably feature-flag gated (low confidence). |

Code reading (medium confidence): `CLAUDE_ENABLE_STREAM_WATCHDOG` defaults on; the stream idle timeout is `max(CLAUDE_STREAM_IDLE_TIMEOUT_MS, 300000)`; the byte idle timeout is 180 s for first-party and otherwise follows the stream timeout, overridable by `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` within [10 s, 30 min].

---

## 10. What the parent process sees (`--output-format stream-json --verbose`)

Sample in `fixtures/e_stream_json/stream.jsonl`:

- Starts with `system/init` (`tools` lists Agent as `"Task"`, plus `model`, `permissionMode:"auto"`, `slash_commands`, `mcp_servers`).
- One `assistant` event **per content block**, with the same `message.id` across them, `stop_reason:null`, and `request_id` taken from our `request-id` header.
- `user` events with `tool_result` plus `tool_use_result` (structured stdout/stderr) and `tool_result_meta.permission_decision`.
- `system/informational`, `system/api_retry`, `system/permission_denied`.
- Subagents emit `system/task_started`, `task_progress`, `task_updated`, `task_notification`, and their events carry `parent_tool_use_id` and `agent_id`.
- Ends with `result/success` containing `is_error, result, num_turns, stop_reason, usage, modelUsage, total_cost_usd` (cost is computed even for GPT model names), `api_error_status`, `terminal_reason`.

`--output-format json` produces a single object with the same `result` fields (`s_output_json`). `--input-format stream-json` (the SDK mode) worked with stdin line `{"type":"user","message":{"role":"user","content":[…]},"parent_tool_use_id":null,"session_id":""}` (`s_input_stream_json`).

---

## 11. Recommendations for the bridge and launcher

1. **Environment for the launcher and plugin:**
   ```
   ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
   ANTHROPIC_AUTH_TOKEN=<local secret>
   ANTHROPIC_MODEL=<gpt name>
   ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL=…
   ANTHROPIC_SMALL_FAST_MODEL=…
   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
   CLAUDE_CODE_MAX_CONTEXT_TOKENS=<real GPT window>
   ```
   Optional: `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (smaller body, no `safeguards`, no `context_management`), `DISABLE_PROMPT_CACHING=1`, `MAX_THINKING_TOKENS=0`.
   Flags: `--permission-mode acceptEdits` (or `bypassPermissions` with `IS_SANDBOX=1` when running as root) so the auto-mode classifier never fires.
2. **Parse input defensively:**
   - `role:"system"` messages (string or array content).
   - String or array content in user messages.
   - `tool_result` content as a string or an array.
   - The `?beta=true` query string.
   - Strip the billing-header block and the `<total_tokens>` noise.
   - Ignore unknown fields: `safeguards`, `context_management`, `output_config`, `thinking`, `metadata`.
3. **Stream correctly:**
   - Send headers and `message_start` immediately, then a ping every ≤15 s.
   - Always send `content_block_stop`.
   - Send tool input as `input_json_delta`.
   - End with `message_delta` (`stop_reason`: `tool_use` or `end_turn`) and `message_stop`.
4. **Report realistic usage.** `usage.input_tokens` drives auto-compaction. Report about chars/4 of the full request; reporting near the window size causes compaction thrash.
5. **Support `stream:false`** with a full Message including `usage`. Coalesce it with any in-flight identical streaming request.
6. **Handle side requests:**
   - Answer web_search requests with plain text from ChatGPT browsing.
   - Answer WebFetch summarizer requests (no tools) normally.
   - Detect compaction requests and answer with `<summary>`.
   - Implement `/v1/messages/count_tokens` with an estimate.
   - Optionally add `GET /v1/models`.
7. **Error mapping:**
   - Quota exhausted: 429, `retry-after` above 60 (or `x-should-retry: false`), and a readable `error.message`.
   - Extension or tab not connected: 503 or 529. Use `x-should-retry: false` if the CLI should fail fast.
   - Never return a bare 401 unless you want about 3 minutes of retries.
8. **Concurrency.** Foreground subagents were sequential, but the Agent tool's schema says agents run in the background by default, so expect concurrent requests and queue them per ChatGPT tab.
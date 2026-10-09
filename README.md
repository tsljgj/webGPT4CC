# webGPT4CC

**Run the Claude Code harness on your ChatGPT web subscription.**

[中文说明 / Chinese README](README.zh-CN.md)

webGPT4CC lets [Claude Code](https://code.claude.com) (the `claude` CLI, the Claude
Agent SDK, or a plugin inside a normal Claude Code session) use the model in your
logged-in **chatgpt.com** tab as its brain. Usage counts against your ChatGPT
**web chat** quota. That is separate from the Codex quota and from OpenAI API billing.

> **Status: early alpha (v0.1).** The bridge, protocol, plugin and launcher are tested
> end-to-end against the real `claude` CLI. The browser extension is tested against a
> faithful fake of chatgpt.com, because ChatGPT itself can't be reached from CI.
> Expect to adjust selectors when ChatGPT changes its UI.

```
claude / gptcc / Agent SDK / gpt-web plugin
        │  Anthropic Messages API (ANTHROPIC_BASE_URL=http://127.0.0.1:8765)
        ▼
webGPT4CC bridge  ── turns tools + transcript into a text prompt, parses GPT's
        │            <tool_call> replies back into tool_use blocks
        │  localhost WebSocket
        ▼
Chrome extension  ── types into your real chatgpt.com tab, reads the raw reply
```

## How it works

* **Bridge** (`bridge/`, Node ≥ 22.18): a local server that looks like the Anthropic API.
  It writes Claude Code's system prompt, tool list and conversation into a ChatGPT
  message. Each tool call that GPT writes in a simple XML-ish format becomes a real
  `tool_use` block, so Claude Code executes it. The bridge keeps one ChatGPT
  conversation per Claude Code session and sends only the new part each turn
  (tool results, your messages). See [docs/PROTOCOL.md](docs/PROTOCOL.md).
* **Extension** (`extension/`, Chrome/Edge/Brave, MV3): turns one or more chatgpt.com
  tabs into "workers". It pastes the prompt into the composer and clicks send, then
  reads the model's raw markdown from the page's own network stream. ChatGPT's page
  handles login, Cloudflare and anti-abuse tokens itself; the extension never fakes them.
  See [docs/EXTENSION.md](docs/EXTENSION.md).
* **Claude Code plugin** (`plugin/`): adds a `delegate` tool to your normal Claude
  Code. Claude (on your Anthropic plan) can hand a self-contained task to a second
  Claude Code agent that runs on ChatGPT, then review the result. Also `ask` (a
  second opinion from GPT) and `status`.
* **Launcher** `gptcc`: runs the whole Claude Code UI on ChatGPT.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

### 1. Install

```bash
git clone https://github.com/tsljgj/webGPT4CC.git
cd webGPT4CC
npm install
npm link            # puts `webgpt4cc` and `gptcc` on your PATH
```

You also need Claude Code (`npm i -g @anthropic-ai/claude-code`). You do **not**
need to log in to Claude for `gptcc`.

### 2. Start the bridge

```bash
webgpt4cc serve
```

On first run this creates `~/.webgpt4cc/config.json` with two random tokens.
`webgpt4cc pair` prints the bridge URL and the extension token.

### 3. Load the extension

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and
   choose the `extension/` folder.
2. Click the webGPT4CC toolbar icon. Paste the **Bridge URL** and **Token** from
   `webgpt4cc pair`, then save.
3. Click **Open worker tab**. Log in to ChatGPT in that tab if needed, and pick the
   model you want, for example a *Thinking* model. Keep the tab open; a separate
   window works best.

`webgpt4cc doctor` checks the whole chain.

### 4. Use it

**Full Claude Code on ChatGPT:**

```bash
cd your-project
gptcc                      # interactive
gptcc -p "add input validation to src/api.ts and run the tests"
```

`gptcc` is `claude` with the bridge environment. Any `claude` flags work.
It starts in the `default` permission mode, because Claude Code's `auto` mode makes
two very large extra model calls per tool use. To use another client, run
`eval "$(webgpt4cc env)"` (or `webgpt4cc env --shell powershell`) and then `claude`.

**Delegate from your normal Claude Code (plugin):**

```text
/plugin marketplace add tsljgj/webGPT4CC
/plugin install gpt-web@webgpt4cc
```

Then ask Claude to "delegate this to GPT", or use `/gpt-web:delegate <task>`,
`/gpt-web:ask <question>` or `/gpt-web:status`. The delegate gets read, search and edit
tools by default. Claude can grant `Bash(...)` rules per task.

**From your own code (Claude Agent SDK):** see [examples/agent-sdk.ts](examples/agent-sdk.ts).

## Configuration

`~/.webgpt4cc/config.json` (all keys optional):

| Key | Default | Meaning |
|---|---|---|
| `port` / `host` | `8765` / `127.0.0.1` | Where the bridge listens |
| `authToken` | random | Token Claude Code must send (`ANTHROPIC_AUTH_TOKEN`) |
| `extensionToken` | random | Token the extension must present |
| `models.default` | `""` | ChatGPT model slug for the agent loop. Empty means use the model selected in the worker tab (most reliable) |
| `models.background` | `""` | Slug for Claude Code's small helper requests |
| `models.map` | `{}` | Map a requested model name to a slug, e.g. `{"opus": "gpt-5-6-thinking"}` |
| `newChatUrl` | `https://chatgpt.com/?model={model}` | URL for new chats. Use a project URL to keep bridge chats in one ChatGPT project |
| `temporaryChats` | `false` | Open new chats as temporary chats (not saved to history, no memory) |
| `conversationMode` | `continue` | `stateless` starts a new chat for every request |
| `maxConversationTokens` | `150000` | Start a fresh chat (replaying the transcript) beyond this size |
| `claudeContextWindow` | `128000` | Context window Claude Code compacts against (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`) |
| `jobTimeoutMs` | `1200000` | Max time for one ChatGPT reply |
| `webSearch` | `chatgpt` | Claude Code's WebSearch tool uses ChatGPT's own browsing; `disabled` refuses it |
| `render.toolDescriptionMaxChars` | `0` | Truncate tool descriptions to shrink the first message (0 = full) |
| `render.excludeTools` | `[]` | Tool names never shown to the model |
| `dumpDir` | `""` | Write every prompt and reply here (debugging) |

Environment overrides: `WEBGPT4CC_PORT`, `WEBGPT4CC_HOST`, `WEBGPT4CC_PROVIDER`,
`WEBGPT4CC_LOG_LEVEL`, `WEBGPT4CC_DUMP_DIR`, `WEBGPT4CC_HOME`.

## Costs, limits and tips

* **Every agent step uses one ChatGPT message** from your plan's limits. The prompt
  tells the model to batch independent tool calls into one reply.
* Prefer a **Thinking** model. They have much larger context windows than Instant
  models on most plans.
* The first message of a session is large (Claude Code's system prompt and tools,
  about 60 KB). It is pasted in chunks. Later turns are small.
* Turn off ChatGPT **memory** and **custom instructions**, or set `temporaryChats: true`,
  so your personal settings don't steer the agent.
* Keep the worker tab in its own window. Chrome throttles hidden tabs and may discard
  them under memory pressure.
* Images (screenshots, pasted images) are not forwarded yet.

## Security

The bridge only listens on localhost and requires a token. It rejects browser-origin
requests and checks the Host header. The extension socket only accepts extension
origins plus the pairing token. Your prompts, which include your code, are sent to
ChatGPT, just as if you had pasted them yourself. Details: [ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

## Troubleshooting

* `webgpt4cc doctor` checks Node, the `claude` CLI, the bridge, the extension and the worker tabs.
* `webgpt4cc serve --log-level debug --dump-dir /tmp/wg` logs every job, and saves
  every prompt and reply.
* If parsing goes wrong, look at the `parser:` warnings in the bridge log and the
  dumped reply.
* If the extension can't find the composer, ChatGPT probably changed its DOM.
  Update `SELECTORS` in `extension/content/page-agent.js` and please open an issue.

## Development

```bash
npm test            # unit tests (bridge, plugin MCP server, extension stream parser)
npm run typecheck
npm run test:e2e    # Playwright + extension + fake chatgpt.com + real claude CLI (needs Chromium)
webgpt4cc serve --provider mock --mock-script replies.json   # bridge without ChatGPT
```

## Disclaimer

This is an unofficial community project. It is not affiliated with, endorsed by, or
supported by OpenAI or Anthropic. It automates the consumer ChatGPT web interface in
your own logged-in browser. OpenAI's Terms of Use restrict automated or programmatic
extraction of output, so **using this tool may violate them and could get your
ChatGPT account limited or suspended. Use at your own risk.** The tool doesn't bypass
rate limits, Cloudflare or anti-abuse checks, doesn't share accounts, and only works
through your own browser session. Don't use outputs to train models.

MIT License.

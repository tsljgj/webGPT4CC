# webGPT4CC

**用你的 ChatGPT 网页版订阅额度来驱动 Claude Code。**

[English README](README.md)

webGPT4CC 让 [Claude Code](https://code.claude.com)（`claude` 命令行、Claude Agent SDK，
或者普通 Claude Code 会话里的插件）把你浏览器里**已登录的 chatgpt.com 标签页**当作“大脑”。
消耗的是 ChatGPT **网页聊天**额度，不是 Codex 额度，也不走 OpenAI API 计费。

> **状态：早期 alpha（v0.1）。** bridge、协议、插件和启动器都已经用真实的 `claude` CLI 做过端到端测试；
> 浏览器扩展是在一个高度仿真的 chatgpt.com 假页面上测试的（CI 环境访问不了 ChatGPT 本身）。
> ChatGPT 改版后，可能需要调整选择器。

```
claude / gptcc / Agent SDK / gpt-web 插件
        │  Anthropic Messages API（ANTHROPIC_BASE_URL=http://127.0.0.1:8765）
        ▼
webGPT4CC bridge  ── 把工具定义和对话记录转成文本 prompt，
        │            再把 GPT 回复里的 <tool_call> 解析回 tool_use
        │  本机 WebSocket
        ▼
Chrome 扩展       ── 在你真实的 chatgpt.com 标签页里输入、发送，读取原始回复
```

## 工作原理

* **Bridge**（`bridge/`，Node ≥ 22.18）：本地的“假 Anthropic API”。它把 Claude Code 的
  system prompt、工具列表和对话写成一条 ChatGPT 消息。GPT 用一种简单的类 XML 格式写出工具调用，
  bridge 把每个调用解析成真正的 `tool_use` 块，交给 Claude Code 执行。每个 Claude Code
  会话对应一个 ChatGPT 对话，之后每一轮只发送新增内容（工具结果、你的新消息）。
  协议见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。
* **扩展**（`extension/`，Chrome/Edge/Brave，MV3）：把一个或多个 chatgpt.com 标签页变成“worker”。
  它把 prompt 粘贴进输入框并点击发送，再从页面自己的网络流里读取模型的原始 markdown。
  登录、Cloudflare 和反滥用 token 都由 ChatGPT 页面自己处理，扩展从不伪造这些 token。
  设计见 [docs/EXTENSION.md](docs/EXTENSION.md)。
* **Claude Code 插件**（`plugin/`）：给普通 Claude Code 加一个 `delegate` 工具。Claude
  （用你的 Anthropic 额度）可以把一个独立任务交给**另一个跑在 ChatGPT 上的 Claude Code agent**
  （内部就是 Claude Code SDK / headless 模式），然后审查它的结果。另外还有 `ask`（让 GPT 给第二意见）
  和 `status`。
* **启动器** `gptcc`：让整个 Claude Code 界面都跑在 ChatGPT 上。

更多细节：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 1. 安装

```bash
git clone https://github.com/tsljgj/webGPT4CC.git
cd webGPT4CC
npm install
npm link            # 把 `webgpt4cc` 和 `gptcc` 加到 PATH
```

还需要安装 Claude Code（`npm i -g @anthropic-ai/claude-code`）。使用 `gptcc` **不需要**登录 Claude。

### 2. 启动 bridge

```bash
webgpt4cc serve
```

第一次运行会创建 `~/.webgpt4cc/config.json`，里面有两个随机 token。
`webgpt4cc pair` 会打印 bridge 地址和扩展用的 token。

### 3. 加载扩展

1. 打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `extension/` 目录。
2. 点击工具栏里的 webGPT4CC 图标，填入 `webgpt4cc pair` 显示的 **Bridge URL** 和 **Token**，然后保存。
3. 点击 **Open worker tab**。如果需要，在这个标签页里登录 ChatGPT，并选好想用的模型
   （比如某个 *Thinking* 模型）。保持这个标签页打开，最好放在单独的窗口里。

可以用 `webgpt4cc doctor` 检查整条链路。

### 4. 使用

**整个 Claude Code 跑在 ChatGPT 上：**

```bash
cd your-project
gptcc                      # 交互模式
gptcc -p "给 src/api.ts 加上输入校验，并跑一下测试" --allowedTools "Bash(npm test:*)"
```

`gptcc` 就是带上 bridge 环境变量的 `claude`，`claude` 的所有参数都能用。

* **权限模式。** Claude Code 的 `auto` 模式每次调用工具都会让安全分类器额外发两个很大的模型请求，
  走 ChatGPT 不现实。所以如果你没有自己指定，`gptcc` 在交互模式下使用 `default`（执行操作前会询问），
  在 `-p` 无人值守模式下使用 `acceptEdits`。`acceptEdits` 模式允许编辑项目内的文件，
  其他操作需要用 `--allowedTools` 规则放行（见上面的例子）。
* **`--lite`** 让 Claude Code 只保留核心工具（Bash、Read、Edit、Write、WebFetch、WebSearch、
  NotebookEdit、AskUserQuestion，不启用子 agent）。第一条 ChatGPT 消息会从约 45 KB 缩小到约 20 KB，
  适合上下文窗口较小的套餐。
* **其他客户端：** 执行 `eval "$(webgpt4cc env)"`（PowerShell 用 `webgpt4cc env --shell powershell`），
  然后运行 `claude --permission-mode default`（不要用 `auto`）。
* `gptcc`、`webgpt4cc env`、`pair`、`doctor` 和插件会先通过 `~/.webgpt4cc/runtime.json`
  （由 `serve` 写入，包含 `--port`/`--host`）找到正在运行的 bridge，其次读取 `~/.webgpt4cc/config.json`。
  环境变量 `WEBGPT4CC_PORT` / `WEBGPT4CC_HOST` 优先级最高。

**在普通 Claude Code 里委派任务（插件）：**

```text
/plugin marketplace add tsljgj/webGPT4CC
/plugin install gpt-web@webgpt4cc
```

然后直接对 Claude 说“把这个交给 GPT 做”，或者使用 `/gpt-web:delegate <任务>`、
`/gpt-web:ask <问题>`、`/gpt-web:status`。被委派的 agent 默认可以读取、搜索，并编辑项目目录内的文件
（它以 `acceptEdits` 模式无人值守运行，其他操作都会被拒绝）。Claude 可以按任务授予 `Bash(...)` 规则，
也可以传 `lite: true` 得到更轻量的 delegate。被委派的 agent 不能再继续委派。

**在你自己的代码里（Claude Agent SDK）：** 见 [examples/agent-sdk.ts](examples/agent-sdk.ts)。

## 配置

`~/.webgpt4cc/config.json`（所有字段都可选）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `port` / `host` | `8765` / `127.0.0.1` | bridge 监听地址 |
| `authToken` | 随机 | Claude Code 必须携带的 token（`ANTHROPIC_AUTH_TOKEN`） |
| `extensionToken` | 随机 | 扩展连接时必须携带的 token |
| `models.default` | `""` | 主循环用的 ChatGPT 模型 slug。留空表示使用 worker 标签页里当前选中的模型（最可靠） |
| `models.background` | `""` | Claude Code 小型辅助请求用的模型 |
| `models.map` | `{}` | 把模型名映射到 ChatGPT slug，例如 `{"gpt-fast": "gpt-5-5-instant"}`，然后用 `gptcc --model gpt-fast`（或 `/model gpt-fast`）。以 `gpt-`、`o3` 等开头的名字会直接作为 slug 使用 |
| `newChatUrl` | `https://chatgpt.com/?model={model}` | 新对话的 URL。可以填某个 ChatGPT 项目（Project）的地址，把 bridge 的对话集中放在一起 |
| `temporaryChats` | `false` | 新对话用“临时聊天”（不进历史记录，不用记忆） |
| `conversationMode` | `continue` | 设为 `stateless` 时，每个请求都开一个新对话 |
| `maxConversationTokens` | `110000` | ChatGPT 对话超过这个大小时，开新对话并重放记录 |
| `claudeContextWindow` | `120000` | Claude Code 做自动压缩时参照的上下文窗口（`CLAUDE_CODE_MAX_CONTEXT_TOKENS`） |
| `jobTimeoutMs` | `1200000` | 单次 ChatGPT 回复的最长等待时间 |
| `webSearch` | `chatgpt` | Claude Code 的 WebSearch 工具交给 ChatGPT 自带的联网搜索；`disabled` 表示拒绝 |
| `webFetchSummaries` | `local` | WebFetch 本来会让小模型总结每个网页。`local` 直接返回网页内容（截断到 2 万字符），每次抓取省一条 ChatGPT 消息；`chatgpt` 则交给 ChatGPT 处理 |
| `render.toolDescriptionMaxChars` | `2000` | 截断过长的工具描述，缩小第一条消息（0 表示不截断） |
| `render.excludeTools` | `DesignSync`、`ScheduleWakeup`、`Cron*`、`Workflow`、`ReportFindings` | 不展示给模型的工具名（通过 ChatGPT 很少用得上，约 20 KB）。设为 `[]` 则全部展示 |
| `render.maxPromptChars` | `100000` | 单条 ChatGPT 消息的长度上限；超出时会缩短较早的历史和过大的工具结果 |
| `dumpDir` | `""` | 把每个 prompt 和回复写到这个目录（调试用） |

也可以用环境变量覆盖：`WEBGPT4CC_PORT`、`WEBGPT4CC_HOST`、`WEBGPT4CC_PROVIDER`、
`WEBGPT4CC_LOG_LEVEL`、`WEBGPT4CC_DUMP_DIR`、`WEBGPT4CC_HOME`。

## 额度、限制和建议

* **agent 的每一步都会消耗一条 ChatGPT 消息额度。** prompt 会要求模型把互不依赖的工具调用合并到同一条回复里。
* 建议使用 **Thinking** 模型：大多数套餐下它的上下文窗口比 Instant 大得多。
* 每个会话的第一条消息比较大（Claude Code 的 system prompt 和工具定义，约 60 KB），会分块粘贴；之后每轮都很小。
* 建议关闭 ChatGPT 的**记忆**和**自定义指令**，或者设置 `temporaryChats: true`，避免个人设置干扰 agent。
* 把 worker 标签页放在单独的窗口里。Chrome 会限制隐藏标签页，内存紧张时还可能把它丢弃。
* 暂时还不会转发图片（截图、粘贴的图片）。

## 安全

bridge 只监听本机并要求 token；它拒绝来自浏览器网页的请求，并检查 Host 头。扩展的 WebSocket
只接受扩展来源的连接和配对 token。你的 prompt（包括代码）会发给 ChatGPT，和你手动粘贴过去是一样的。
详见 [ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model)。

## 排错

* `webgpt4cc doctor`：检查 Node、`claude` CLI、bridge、扩展和 worker 标签页。
* `webgpt4cc serve --log-level debug --dump-dir /tmp/wg`：记录每个任务，并保存每个 prompt 和回复。
* 工具调用解析出问题时，看 bridge 日志里的 `parser:` 警告和保存下来的回复。
* 如果扩展找不到输入框，多半是 ChatGPT 又改版了：更新 `extension/content/page-agent.js`
  里的 `SELECTORS`，也欢迎提 issue。

## 开发

```bash
npm test            # 单元测试（bridge、插件 MCP server、扩展的流解析）
npm run typecheck
npm run test:e2e    # Playwright + 扩展 + 假 chatgpt.com + 真实 claude CLI（需要 Chromium）
webgpt4cc serve --provider mock --mock-script replies.json   # 不连 ChatGPT 调试 bridge
```

## 免责声明

这是非官方的社区项目，与 OpenAI、Anthropic 没有任何关联，也没有得到它们的认可或支持。
它是在你自己已登录的浏览器里自动化操作 ChatGPT 网页版。OpenAI 的使用条款限制以自动化或程序化方式提取输出，
因此**使用本工具可能违反条款，你的 ChatGPT 账号可能因此被限制或封禁，风险自负**。
本工具不绕过限速、Cloudflare 或反滥用检查，不共享账号，只通过你自己的浏览器会话工作。
请不要用输出内容训练模型。

MIT License.

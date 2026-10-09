# 交接文档（给下一个 agent）

> 写于 2026-10-09，首轮构建结束时。分支：`claude/chatgpt-web-claude-harness-gy4pxg`。
> 读完这一页，再读 [ARCHITECTURE.md](ARCHITECTURE.md)、[PROTOCOL.md](PROTOCOL.md)、
> [EXTENSION.md](EXTENSION.md)，就能接手。

## 1. 项目目标

让 Claude Code 的 harness（`claude` CLI、Claude Agent SDK、或普通 Claude Code 里的插件）
用**已登录的 chatgpt.com 网页版**当模型，消耗的是 ChatGPT **网页聊天额度**。
这和 Codex 额度不同，和 OpenAI API 计费也不同，所以不能走 Codex/API，必须驱动网页。

三种用法：

| 用法 | 入口 | 说明 |
|---|---|---|
| 整个 Claude Code 跑在 ChatGPT 上 | `gptcc`（= 带 bridge 环境的 `claude`） | `bridge/src/launch.ts`、`cli.ts` |
| 普通 Claude Code 里把子任务委托给 GPT | 插件 `gpt-web` 的 `delegate` / `ask` / `status` 工具 | `plugin/`，MCP server 再起一个 `claude -p` 子进程 |
| 自己的代码 | Agent SDK + `ANTHROPIC_BASE_URL` | `examples/agent-sdk.ts` |

## 2. 当前状态（一句话）

**v0.1 alpha：整条链路在一个高仿的假 chatgpt.com 上端到端测通（真 `claude` CLI 2.1.295 +
真 Chromium + 真扩展），但从没在真正的 chatgpt.com 上跑过。** 下一步最重要的事就是
拿一个真账号实测（见 §8 第 1 条）。

交接时的测试状态（全部通过）：

| 检查 | 结果 |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | 干净 |
| `npm test`（bridge + plugin + extension 单测） | 186/186 |
| `npm run test:e2e`（4 个文件） | 38/38，约 2.5 分钟 |

## 3. 架构

```
claude / gptcc / Agent SDK / gpt-web 插件的 delegate
   │  Anthropic Messages API（ANTHROPIC_BASE_URL=http://127.0.0.1:8765，SSE）
   ▼
bridge（Node ≥ 22.18，bridge/src）
   │  · 把 system prompt + 工具 schema + 对话渲染成一条文本消息
   │  · 把 GPT 回复里的 <tool_call> 解析回 tool_use 块
   │  · 一个 Claude Code 会话 ↔ 一个 ChatGPT 对话，之后只发增量
   │  localhost WebSocket（/extension，需扩展 origin + extensionToken）
   ▼
Chrome MV3 扩展（extension/）
   · service worker 管理 worker 标签页、派发任务
   · page agent（MAIN world）粘贴 prompt、点发送，
     从页面自己的 fetch/WebSocket 流里读原始 markdown（不读 DOM：DOM 会丢缩进和符号）
   · 从不伪造 Sentinel / PoW / Turnstile token，全由页面自己算
```

请求流程（详见 ARCHITECTURE.md）：分类（probe / 安全分类器 / web_search / background / main）
→ 去重（重试合并）→ 规划（续写已有对话还是新开对话并回放）→ 渲染 → 交给 provider →
流式回传 → 记录指纹以便下次续写。

## 4. 代码地图

| 路径 | 内容 |
|---|---|
| `bridge/src/server.ts` | HTTP 服务：Host 校验（防 DNS rebinding）、拒绝带 Origin 的 `/v1/*`、token 鉴权、`HEAD /` 与 `/api/hello`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/models`、`/health`、扩展 WebSocket 升级 |
| `bridge/src/handler.ts` | 核心：`BridgeState`、错误映射（no_worker→503 不重试；not_logged_in→403；rate_limited→429 不重试；too_long→改写成 `prompt is too long: N tokens > M maximum` 触发 Claude Code 压缩）、去重/孤儿接管、同 scope 新请求顶替旧请求、续写/回放、流式输出、空回复报错 |
| `bridge/src/background.ts` | 请求分类；安全分类器请求直接拒绝；WebFetch 摘要本地返回页面本身；WebSearch 走 ChatGPT 自带搜索 |
| `bridge/src/translate/render.ts` | 文本工具协议的提示词：首条消息（协议说明 + system + 工具 + 历史回放，有长度预算）、增量消息（新内容 + 提醒尾注） |
| `bridge/src/translate/parser.ts` | 宽松解析 `<tool_call>`/`<param>`：代码围栏、CDATA、Hermes JSON、缺闭合标签；`safeStreamPrefix` 决定哪些前缀可以边收边推 |
| `bridge/src/translate/schema.ts` | 按 JSON Schema 把原始字符串参数转成数字/布尔/数组/对象 |
| `bridge/src/session/store.ts` | 助手消息指纹 → ChatGPT 对话 id；请求哈希（按 Claude Code 会话 id + agent id 分 scope）；`~/.webgpt4cc/sessions.json` 持久化；响应缓存 |
| `bridge/src/providers/extension.ts` | 扩展 provider：worker 选择（对话亲和）、取消、超时（拿到 worker 之后才开始计时）、忙碌/就绪重检 |
| `bridge/src/providers/mock.ts` | 脚本化的假 provider（单元测试、离线调试用） |
| `bridge/src/launch.ts` / `cli.ts` | `serve`、`pair`、`doctor`、`env`、`claude`（= `gptcc`）。launcher 用 `--settings` 层注入环境（能压过用户 `~/.claude/settings.json` 里的 `env`） |
| `bridge/src/config.ts` | 默认值 ← `~/.webgpt4cc/config.json` ← `WEBGPT4CC_*` 环境变量 ← CLI 参数；`runtime.json` 记录正在运行的 bridge 地址 |
| `plugin/` | Claude Code 插件 `gpt-web`（marketplace 在仓库根 `.claude-plugin/marketplace.json`），`plugin/mcp/server.mjs` 是 MCP server |
| `extension/background.js` | service worker：连 bridge、worker 注册、派发、取消、popup 状态 |
| `extension/content/relay.js` | ISOLATED world 中转 |
| `extension/content/page-agent.js` | MAIN world：`SELECTORS` 表、粘贴（≤4000 字符一块的合成 ClipboardEvent，逐块校验）、发送、停止、登录/限流/Cloudflare 检测、恢复 |
| `extension/content/stream-core.js` | SSE / delta-v1 归约器，WebSocket handoff（ws.chatgpt.com），纯函数，可单测 |
| `test/e2e/` | `fake.test.ts`（假站自测）、`chain.test.ts`（真 `claude` 全链路）、`locale.test.ts`（zh-CN 界面）、`lifecycle.test.ts`（取消、重载、冻结标签页等）。`fake-chatgpt/` 按 2026-09 DOM 和流格式仿制，可切 zh-CN、无 data-testid、限流横幅、Sentinel 429、workspace 账号等模式 |
| `docs/research/` | 首轮调研报告（Claude Code 抓包、ChatGPT 网页内部、插件/SDK、已有项目、工具协议、交叉核对） |

## 5. 怎么跑、怎么测

```bash
npm install
npm run typecheck                 # tsc，必须干净
npm test                          # bridge + plugin + extension 单测（node --test）
npm run test:e2e                  # Playwright + 扩展 + 假 chatgpt.com + 真 claude CLI
webgpt4cc serve --provider mock --mock-script replies.json   # 不连 ChatGPT 调 bridge
webgpt4cc serve --log-level debug --dump-dir /tmp/wg         # 保存每条 prompt/回复
```

* e2e 需要 Playwright 的 Chromium（本容器在 `/opt/pw-browsers`，**不要**跑 `playwright install`）
  和 `PATH` 上的 `claude`。缺了会 skip 而不是失败，所以看到 skip 要留意。
* CI（`.github/workflows/ci.yml`）只跑 typecheck、单测、build 和 `claude plugin validate`，**不跑 e2e**。
* 在 root 下 `claude --dangerously-skip-permissions` 会被拒绝；测试里用的是
  `--permission-mode acceptEdits/default` + `--allowedTools`。

## 6. 关键设计决策（以及为什么）

1. **驱动真实网页 UI，不直接调 ChatGPT 后端。** 发消息需要 Sentinel chat-requirements、PoW、
   Turnstile，还在 Cloudflare 后面；伪造这些既脆弱又更明显地违反 ToS。页面自己算，扩展只负责打字和点击。
2. **从页面的网络流读原始回复，不读 DOM。** 渲染后的 markdown 会丢缩进、星号、下划线和像 HTML 的文本，
   写文件的工具调用会被破坏。
3. **文本工具协议**：`<tool_call name="X">` + `<param name="p">原样字符串</param>`，
   非字符串参数写 JSON，含 `]]>`/闭合标签风险时用 CDATA。模型写原样代码比写 JSON 转义可靠得多。
   工具结果回给模型时是 `<tool_result name="X" call="N" [status="error"]>`。规范见 PROTOCOL.md §1。
4. **续写而不是每轮回放。** Claude Code 每次请求都带 ~20k token 的 system + 工具。
   bridge 用“最后一条助手消息的指纹”（tool_use id，或规范化文本）找到对应的 ChatGPT 对话，
   只发增量（实测每轮 ~400–700 字符，首条 ~41–59k 字符）。指纹不是该对话的最新一轮、对话忙、
   或超过 `maxConversationTokens` 时，新开对话并回放（有预算，保留任务开头和最新内容）。
5. **一个 agent 步骤 = 一条 ChatGPT 消息**（这就是额度单位），所以提示词要求批量调用独立工具。
6. **不支持 Claude Code 的 `auto` 权限模式。** 它的安全分类器每次用工具要额外发两个 ~140KB 的请求；
   bridge 直接拒绝分类器请求（400，不重试），launcher 默认交互 `default`、`-p` 时 `acceptEdits`，
   并在 settings 里 `disableAutoMode`。
7. **重试去重。** Claude Code 会重试、会被 stream watchdog 中断；同 scope 同内容的请求合并到正在跑
   或刚跑完的那一轮；客户端断开后该轮继续跑 `orphanGraceMs`，等重试来接管，避免重复花额度。
8. **插件的 delegate 默认只给 Read/Glob/Grep/TodoWrite**，编辑来自 `acceptEdits`（只限 cwd 内），
   不给 Edit/Write 规则（实测 `acceptEdits` + `allowedTools Write` 能写项目外的文件）。cwd 限定在项目内；
   delegate 不能再 delegate（`WEBGPT4CC_WORKER=1` 防递归）。
9. **安全**：bridge 只听 127.0.0.1，`/v1/*` 要 token、拒绝浏览器 Origin、校验 Host；
   扩展 socket 只收扩展 origin，并用配对 token 做 **HMAC 双向挑战应答**（协议 v2：`hello`/`welcome`/`auth`，
   token 不再出现在 URL 里，双方证明身份前不交换任何数据）；扩展只接受 bridge 自己会构造的任务 URL；
   非 loopback 的明文 `ws://` bridge 默认拒绝；token 文件 0600；dump 目录 0700、文件 O_NOFOLLOW。
   `serve --host` 非 loopback 时会打印警告。
10. **“正在生成”以网络为准，不以按钮文字为准。** 中文界面下按钮 aria-label 是中文、新布局又没有
    data-testid，所以 page agent 统计页面上所有打开的对话流（含 `/resume` 和 WebSocket topic）；
    发送按钮按结构找（`button.bg-composer-primary` 等），且只有在没有流、不像语音按钮、
    并且标签与空输入框时不同的情况下才当作“发送”，避免误开语音模式。

## 7. 已经验证过的事实（别再重新摸索）

完整报告在 `docs/research/`。最常用的：

**Claude Code 侧（CLI 2.1.295 抓包）**
* 请求路径带 `?beta=true`；启动时有 `HEAD /` 或 `/api/hello` 探活；`messages[]` 里会出现 `role:"system"`。
* 重试：`retry-after` > 60 秒直接失败；`x-should-retry: false` 不重试；401 重试 10 次；529 重试 3 次。
* 报错文本 `prompt is too long: N tokens > M maximum` 会触发自动压缩。
* 用户 `~/.claude/settings.json` 的 `env` **会覆盖** shell 环境变量 → 必须用 `--settings` 层（SDK 用 `settings` 选项）。
* `CLAUDE_CODE_USE_BEDROCK='0'` 在 CLI 代码里是 truthy，要关掉必须设成空字符串 `''`。
* `--tools a,b` 是 variadic，会吞掉后面的 prompt → 用 `--tools=a,b`。
* 假的 thinking 签名会被接受（bridge 用 `signature_delta: "webgpt4cc"`）。
* `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` 会带 `x-claude-code-request-class` 等提示头。

**ChatGPT 网页侧（2026 年）**
* 2026-09-25 起新 DOM：`form[data-chatgpt-composer]` 里的 ProseMirror，几乎没有 `data-testid`，
  aria-label 跟随界面语言（中文界面下是中文）。
* 发送走 `/backend-api/f/conversation`，delta-v1 SSE，有时 `stream_handoff` 到 `ws.chatgpt.com`。
* 单次粘贴 >10k 字符会变成 “Pasted text” 附件 chip → 扩展按 ≤4000 字符分块粘贴并校验。
* 页内 backend fetch 也会撞 Cloudflare；同时开超过 ~3 个标签页容易触发限流弹窗。
* 临时聊天：`?temporary-chat=true`；`?model=` 不可靠（默认用标签页里选中的模型）。

## 8. 已知缺口 / TODO（按优先级）

1. **真站实测（最高优先级）。** 用真账号加载扩展，跑 `webgpt4cc doctor`，然后 `gptcc -p "..."`。
   预计要修 `extension/content/page-agent.js` 的 `SELECTORS`，同步更新 `test/e2e/fake-chatgpt/`。
   用 `--dump-dir` 存 prompt/回复，看 bridge 日志里的 `parser:` 警告。
2. **扩展审查里没做的三项**（见 §9 末尾）：驱动模型选择器；单 worker 时 web_search 会顶掉临时对话；
   以及所有修复都只在假站上验证过，真站的结构选择器（`bg-composer-primary` 等）、中文文案、
   Web Lock 防冻结、`_account` cookie 映射都需要实测确认。
3. **模型选择没有驱动模型选择器**，只靠 `?model=`；现在会从 POST body 和流元数据里读出实际模型，
   不一致时 bridge 记 warning（`model_mismatch`），但不会纠正。
4. **Team/Business 账号**：对话回读现在会带上从页面请求里抄来的 `chatgpt-account-id` 和 `oai-*` 头，
   但没在真 workspace 账号上验证过。
5. **图片/文档不转发**，transcript 里换成占位符。
6. **后台标签页节流**：Chrome 会节流隐藏标签页、内存紧张时丢弃；建议 worker 放独立窗口。
7. **WebSocket handoff 的细节**是根据调研推测的，只在假站上验证过。
8. **CI 不跑 e2e**（需要 Chromium + claude CLI）；可以加一个带缓存浏览器的 job。
9. `gptcc` 判断 `-p` 时不识别合并短参数（如 `-cp`）；Windows 路径（`.cmd`/`taskkill`）写了但没实测。
10. TS 版 Agent SDK 是专有许可，没有 vendored，示例只是 `npm i` 后用。
11. **ToS 风险**：自动化网页版可能违反 OpenAI 条款，README 里有免责声明；不要加任何伪造 token 或绕过风控的代码。

## 9. 扩展审查（首轮最后一步）

三个审查者（真站兼容性 / MV3 生命周期 / 安全）各自找问题，每条再由独立验证者对抗复核
（能复现的就用假站跑实验），最后一个修复 agent 统一修复并补测试。共 29 条发现，5 条被验证者驳回，
其余 24 条（含 2 条重复）全部修复（详细结论保存在本次会话的 workflow journal 里，没有入库；要点如下）：

| # | 问题 | 修复 |
|---|---|---|
| 1 | 中文界面认不出“停止”按钮：取消不生效、标签页忙时报告就绪 | 网络层统计打开的对话流；停止时按结构点主按钮（仅在有流时） |
| 2 | 中文新布局找不到发送按钮（`type="button"`，无 data-testid），每次等 5 秒再按不可信的 Enter | 按结构找主按钮 + 防语音模式的判定；找不到时 1 秒后才按 Enter |
| 3 | Chat/Work 切换只认英文 | 按 `data-mode`/`value` 和中日英标签识别；网络层检测 Work 模式，发现就停止并报 `aborted` |
| 4 | 发出的文本只比对前 200 字符 | 与 `messages[0].content.parts` 全文比对；差异分类上报 `prompt_mismatch`；被截断的大 prompt 报 `too_long` |
| 5 | 断流恢复 15 秒就放弃，导致 bridge 重发同一 prompt | 轮询回读直到 job 截止；答案必须对应我们自己那条消息 |
| 6–7 | 登出、限流、额度用尽的识别只认英文 | 总是查 `/api/auth/session`；限流文案和重置时间支持简繁中文和日文 |
| 8 | 截断报 `ui_error`（会被重试） | 报 `too_long`，触发 Claude Code 压缩 |
| 9 | workspace 账号回读缺 `Chatgpt-Account-Id` | 复用页面请求里的头（从不复制 authorization） |
| 10 | 正常页面也加载 Cloudflare bot 脚本，被误判为验证页 | 参照 oracle：只认挑战组件/标题/文案，且无应用外壳 |
| 11 | 模型选错无感知 | 上报 `model_mismatch`、`actualModel` |
| 13 | `run` 之后页面重载（如 Cloudflare 自动刷新）直接判失败 | 点击发送前重载会重新 `run`（最多 3 次） |
| 14 | 冻结/丢弃的标签页一直“就绪”，任务挂 20 分钟 | 心跳 + `frozen`/`discarded` 监听 + Web Lock |
| 15 | 导航中取消，下一个任务可能投递到错误页面 | 等新页面上报后才释放；URL 必须与任务匹配 |
| 17 | 发送前不再校验输入框、会清掉用户草稿 | 点击前同步复查；用户 8 秒内输入过则标签页不就绪 |
| 18 | 首字节后卡住的流没有看门狗 | 180 秒无事件就回读 |
| 19 | 扩展重连后临时对话丢失 | 按 worker 公告的 conversationId 做亲和；新对话避开持有临时对话的标签页 |
| 20 | 浏览器重启后 worker 列表丢失 | 存到 `chrome.storage.local`，启动时重新认领 |
| 21 | 扩展从不验证 bridge 身份 | HMAC 双向挑战应答（协议 v2），任务 URL 白名单 |
| 22–23 | 远程明文 bridge、token 存储可被内容脚本读写 | 非 loopback 明文需在 popup 显式允许；`setAccessLevel('TRUSTED_CONTEXTS')` |
| 24 | 多余的 `tabs` 权限会把 worker 标签页的站外 URL 发给 bridge | 删除 `tabs` 权限；只上报 chatgpt.com URL |

**两处不兼容变化**：bridge 与扩展必须同时升级到协议 2；`extensionToken` 为空的 bridge
现在只接受同样没有 token 的扩展。

**没做的**：驱动模型选择器（真站属性未验证，只加了上报）；单 worker 时 web_search 顶掉临时对话
（接受回放成本，bridge 会记日志）。`serve --host` 的警告已在 `bridge/src/cli.ts` 补上。

## 10. 给下一个 agent 的注意事项

* 只在分支 `claude/chatgpt-web-claude-harness-gy4pxg` 上开发、提交、推送；没被要求就不要开 PR。
* 提交前：`npm run typecheck && npm test`，动了扩展或 bridge↔扩展协议就再跑 `npm run test:e2e`。
* **不要提交原始抓包**（里面有 device_id、mitm CA 私钥等）；`docs/research/` 里的是清洗过的版本。
* 杀进程别用 `pkill -f`（会匹配到自己的 shell），按 PID 杀。
* 改 ChatGPT 相关选择器时同时改假站，否则 e2e 测的就不是同一套 DOM。
* 文档风格：README 中英双语（`README.md` / `README.zh-CN.md`），改一个要同步另一个。

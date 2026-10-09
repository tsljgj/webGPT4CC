> Research note from the initial build (2026-10-09). The raw workspace referenced as `<research-workspace>` (captures, clones, scripts) was not preserved; the findings below are.

# Research report: Claude Code plugins, Agent SDK, headless CLI and gateway configuration

**Track:** plugin / SDK / headless / gateway env. **Date:** 2026-10-09.
**Versions checked:** Claude Code CLI **2.1.295** (installed binary, changelog dated Oct 8 2026). `@anthropic-ai/claude-agent-sdk` **0.3.295** (npm `latest`, published 2026-10-08). Python `claude-agent-sdk` **0.2.165**.

**Sources:**
- Official docs, fetched as `https://code.claude.com/docs/en/<page>.md`, saved under `.../research/plugin/docs/`.
- The local CLI, run with `env -i` and a fake HOME.
- The SDK tarball from registry.npmjs.org. jsdelivr and unpkg now return 403 from the egress proxy.
- **Empirical wire captures:** I pointed the real `claude` 2.1.295 at a local fake Anthropic endpoint that logs every request. No real model requests were made.

Confidence labels: **[H]** = docs say so and/or I verified it locally. **[M]** = docs plus inference. **[L]** = inference only.

---

## 0. Findings that change the design

1. **A plugin cannot reroute its host session to the bridge.** [H]
   - Plugin `settings.json` / manifest `settings` only honors `agent` and `subagentStatusLine`; every other key is dropped. ([manifest-reference#settings](https://code.claude.com/docs/en/plugins/manifest-reference))
   - So "run Claude Code fully on GPT web" has to be a launcher that sets env and `--settings`.
   - "Delegate from a normal session" has to be a plugin MCP tool (or `bin/` script) that spawns a separate `claude -p` process.
2. **The user's settings `env` block overrides the shell environment.** [H, verified]
   - Test: `~/.claude/settings.json` had `env.ANTHROPIC_BASE_URL=X`, and the child was spawned with `ANTHROPIC_BASE_URL=bridge` in its process env. Requests went to X and failed with ECONNREFUSED.
   - Fix: pass the env inside `--settings '{"env":{...}}'` (the flag layer beats user/project/local), or run with `--setting-sources ""`. Both verified working.
   - Managed settings still win over both.
   - Doc: "When both a shell export and a settings-file `env` block set the same variable, the settings-file value applies." ([llm-gateway-connect](https://code.claude.com/docs/en/llm-gateway-connect))
3. **The default permission mode is `auto` in many cases, and auto mode adds model calls.** [H, verified]
   - Through `ANTHROPIC_BASE_URL`, Claude Code sends a `safeguards` body field plus the `dangerous-tool-use-2026-09-03,afk-mode-2026-01-31` betas.
   - When no `safeguard_results` come back, it falls back to **its own classifier requests through the gateway**, which would spend ChatGPT messages.
   - Observed: interactive mode with `--model gpt-5-thinking` started in auto, and `claude -p` with no `--permission-mode` also ran in auto.
   - **Launcher and delegate must pass `--permission-mode default|acceptEdits|bypassPermissions` and set `CLAUDE_CODE_AUTO_MODE_SERVER=0`.** Alternatively set `"disableAutoMode":"disable"` in `--settings`.
   - Sources: [permission-modes](https://code.claude.com/docs/en/permission-modes), [auto-mode-classifier-billing](https://code.claude.com/docs/en/auto-mode-classifier-billing).
4. **Nested `claude -p` inside a Claude Code session works on 2.1.295.** [H, verified]
   - Run with `CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=1`: success.
   - Changelog history: v2.1.41 (2026-02-13) "Added guard against launching Claude Code inside another Claude Code session". v2.1.47 fixed non-interactive subcommands being blocked. The 2.1.295 binary contains no such guard string.
   - Still strip `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` and similar from the child env, for robustness across versions.
5. **A plugin's stdio MCP server inherits the parent session's env.** [H, verified]
   - Observed: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=sdk-cli`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, plus the substituted `${user_config.*}`.
   - `CLAUDE_CODE_EXECPATH` is **not** passed to MCP servers (it is passed to Bash-tool subprocesses).
   - A worker spawned from the MCP server must build a clean env.
6. **Do not vendor the TS Agent SDK, and do not let the plugin depend on it via auto-install.** [H]
   - `@anthropic-ai/claude-agent-sdk` LICENSE.md: "© Anthropic PBC. All rights reserved." The Python SDK is MIT.
   - Its platform binary optional dependency is about 256 MB unpacked (`claude-agent-sdk-linux-x64@0.3.295`: 256,114,437 bytes).
   - The plugin dependency auto-install has a 60 s timeout and runs with `--ignore-scripts`.
   - **Recommendation:** a zero-dependency plugin MCP server that spawns the user's installed `claude -p --output-format stream-json`. The SDK is a wrapper over that same protocol.
   - If the standalone bridge npm package wants the SDK, list it as a normal npm dependency and pass `pathToClaudeCodeExecutable`.
7. **Every request resends the whole conversation.**
   - Example (`claude -p "say hi"` in a clean HOME): a 75–87 KB request body with 21–24 tools, about 57–69 KB of tool JSON and about 6 KB of system text. [H, verified]
   - `--bare` cuts this to 3.7 KB (3 tools: Bash, Edit, Read; a 2-block system prompt of about 190 chars). [H, verified]
   - Each request carries the full history. The bridge must key a ChatGPT conversation on `x-claude-code-session-id` and send only the new part of the history.
8. **Anthropic's docs say this setup is unsupported.** [H] "Anthropic … doesn't support routing Claude Code to non-Claude models through any gateway." ([llm-gateway](https://code.claude.com/docs/en/llm-gateway), [gateways](https://code.claude.com/docs/en/gateways))

---

## 1. Plugin layout

Main docs: [plugins/manifest-reference](https://code.claude.com/docs/en/plugins/manifest-reference), [plugins/components](https://code.claude.com/docs/en/plugins/components).

### 1.1 Standard layout [H]

| Component | Default location | Notes |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | Optional. **Only** the manifest goes in `.claude-plugin/`. |
| Skills | `skills/<name>/SKILL.md` | Recommended over `commands/` for new work. |
| Commands | `commands/*.md` | "older format"; same frontmatter as skills. |
| Agents | `agents/*.md` | Loaded recursively; subfolders become name segments. |
| Hooks | `hooks/hooks.json` | Top-level `"hooks"` wrapper is required in the file. |
| MCP servers | `.mcp.json` | `mcpServers` wrapper optional. |
| LSP | `.lsp.json` | |
| Output styles, workflows, themes, monitors | `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json` | |
| **Executables** | `bin/` | "Files here are on the Bash tool's `PATH` while the plugin is enabled." They come after the user's own PATH entries, so they cannot shadow system commands. claude.ai and Cowork **don't install** a plugin with a top-level `bin/`. |
| Settings | `settings.json` | Only `agent` and `subagentStatusLine` take effect. |

A `CLAUDE.md` at the plugin root is **not** loaded (validate warns about it).

### 1.2 `plugin.json` fields [H]

`name` is the only required field. Fields:
- Identity and metadata: `$schema`, `name` (kebab-case), `displayName`, `version`, `description`, `author{name,email?,url?}`, `homepage` (must parse as a URL), `repository`, `license`, `keywords[]`, `metadata{}` (not read by Claude Code).
- Directory-listing only (ignored at load): `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`.
- Behavior: `defaultEnabled` (default true), `dependencies[]`, `settings{}`, `userConfig{}`, `types`, `channels[]`.
- Components: `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, `workflows`, `experimental{themes,monitors,evals}`.

Path and merge rules:
- Every component path must start with `./` and stay inside the plugin root. `..` and backslashes are rejected.
- `commands`, `agents`, `outputStyles`, `workflows` **replace** the default scan.
- `skills` **adds** to the default scan.
- `hooks`, `mcpServers`, `lspServers` **merge** with the default file.
- An unknown top-level key is stripped with a validate warning. An unknown key inside `userConfig`, `channels`, `lspServers` or `monitors` is a hard error.

`version`: "Setting it keeps users on that version until you change it." If omitted, a GitHub or relative-in-git source is versioned by commit SHA (12 characters). [H] ([plugins/loading](https://code.claude.com/docs/en/plugins/loading))

**Name restrictions** [H] (enforced by `claude plugin validate`, `init` and `tag`):
- Error if the name starts with `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-`.
- Error if it equals `claude`, `anthropic`, `claude-code` and similar.
- Warning if it contains `claude` or `anthropic` as a whole word, e.g. `mcp-for-claude`.
- Also, from legal-and-compliance: "you can't use the Claude Code or Anthropic names … as part of your own product … name".
- **Use something like `gptweb` / `webgpt4cc`.** Validated OK.

### 1.3 `userConfig` [H]

Each option is a strict object with:
- Required: `type` (`string|number|boolean|directory|file`), `title`, `description`.
- Optional: `required`, `default`, `options` (CC ≥ 2.1.271), `multiple`, `sensitive`, `min`, `max`.

Storage: non-sensitive values go to `pluginConfigs["<plugin>@<mkt>"].options` in the user's `settings.json`. Sensitive values go to the OS secure store.

How the plugin reads them:
- `${user_config.KEY}` is substituted in MCP/LSP config (`command`, `args`, `env`, `url`, `headers`), in exec-form hook `args`, and in skill/agent content. Sensitive values become a placeholder in skill/agent content.
- `CLAUDE_PLUGIN_OPTION_<KEY>` is exported to hook processes.
- Shell-form hooks, monitors and `headersHelper` **reject** `${user_config.*}`.
- Verified: an unset sensitive option substitutes as an **empty string** into MCP `env`.
- CLI: `claude plugin install x@m --config key=value`, or `claude plugin configure`.

### 1.4 Substitution variables [H]

| Variable | Value | Where it resolves |
|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Installed version dir (`~/.claude/plugins/cache/<mkt>/<plugin>/<version>/`); changes on every update | Hook `command`/`args`; MCP stdio `command`/`args`/`env`; MCP http `url`/`headers`; LSP; skill/command/agent body; skill `allowed-tools` |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/`; survives updates; deleted on uninstall unless `--keep-data` | Same as above |
| `${CLAUDE_PROJECT_DIR}` | Project root | Same as above |
| Skill-only | `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name` (from `arguments:`), `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}` | Skill/command body |

Processes that get the variables in their environment:
- Hook processes: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_OPTION_*`.
- MCP stdio processes: `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (verified; plus `CLAUDE_PROJECT_DIR`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`).
- Bash-tool commands do **not** get them.

### 1.5 Skills and commands frontmatter [H] ([skills](https://code.claude.com/docs/en/skills))

- Fields: `name`, `description` (description + `when_to_use` is truncated at 1,536 chars), `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility`.
- `allowed-tools` takes a space/comma-separated string or a YAML list. It pre-approves tools only for the invoking turn.
- Command files under `commands/` use the same fields except `name` and `paths`.
- Naming: `skills/delegate/SKILL.md` becomes `/gptweb:delegate`; `commands/db/migrate.md` becomes `/gptweb:db:migrate`.
- Dynamic context: `` !`cmd` `` lines, or ```` ```! ```` blocks, run before the prompt is sent.

### 1.6 Agents frontmatter [H] ([sub-agents](https://code.claude.com/docs/en/sub-agents))

- Required: `name`, `description`.
- Optional: `tools`, `disallowedTools`, `model` (`sonnet|opus|haiku|fable|<full id>|inherit`), `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `effort`, `isolation: worktree`, `color`, `initialPrompt`, `experimental.cacheTtl`.
- **In plugin agents, `permissionMode`, `hooks`, `mcpServers` and `initialPrompt` are ignored.**
- Plugin agent IDs are `<plugin>:<name>`. Verified: `gptweb:gpt-worker` appeared in `system/init.agents`.

### 1.7 Plugin MCP servers [H, verified]

- `.mcp.json` at the plugin root, or `mcpServers` inline in `plugin.json`, or a `.json` path, or a `.mcpb`/`.dxt` bundle.
- **Server name:** `plugin:<plugin>:<server>`. Observed `{"name":"plugin:gptweb:bridge","status":"connected","source":"plugin"}` in `system/init.mcp_servers`.
- **Tool name:** `mcp__plugin_<plugin>_<server>__<tool>`. Characters outside `[A-Za-z0-9_-]` become `_`. Verified the request carried `"name":"mcp__plugin_gptweb_bridge__delegate_task"`.
- Use this full name in `allowed-tools`, agent `tools`, permission rules and hook matchers.
- Through a non-first-party `ANTHROPIC_BASE_URL`, MCP tool search is off by default, so MCP tools are sent upfront (verified).
- **Timeouts for long delegate calls** ([mcp](https://code.claude.com/docs/en/mcp)):
  - `MCP_TOOL_TIMEOUT` defaults to about 28 h.
  - The stdio **idle** timeout is 30 min: no response and no `notifications/progress`. Configure with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`.
  - A per-server `"timeout"` field also sets the idle floor.
  - A main-conversation MCP call still running after 2 min **auto-moves to a background task** (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`).
  - So the delegate server should emit `notifications/progress` when the request includes `_meta.progressToken`.
- Output is capped at `MAX_MCP_OUTPUT_TOKENS` (default 25k). Text over 50k chars is saved to a file.

### 1.8 Hooks file [H]

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/bin/gptweb-check" } ] } ] } }
```

- Events (SDK `HookEvent`): PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, … (full list in [agent-sdk/typescript#hookevent](https://code.claude.com/docs/en/agent-sdk/typescript)).
- Plugin hooks fire whenever the plugin is enabled.
- `CLAUDE_ENV_FILE` from SessionStart only affects later Bash commands, not Claude Code's own env.

### 1.9 Validated sample (all checks pass on 2.1.295) [H, verified]

Location: `<research-workspace>/plugin/sample-repo/`.
- `claude plugin validate .` and `./plugins/gptweb` both print "✔ Validation passed".
- `marketplace add` + `plugin install --config` + a `claude -p` run all worked: plugin, skill, agent, hook and MCP server all loaded.

`.claude-plugin/marketplace.json`:
```json
{ "name": "webgpt4cc",
  "owner": { "name": "webGPT4CC maintainers", "url": "https://github.com/OWNER/webGPT4CC" },
  "description": "Run Claude Code tasks on a ChatGPT web subscription via a local bridge",
  "plugins": [ { "name": "gptweb", "source": "./plugins/gptweb", "description": "…", "category": "productivity", "tags": ["bridge","delegation"] } ] }
```

`plugins/gptweb/.claude-plugin/plugin.json`:
```json
{ "name": "gptweb", "displayName": "GPT Web Bridge", "version": "0.1.0", "description": "…",
  "author": { "name": "webGPT4CC maintainers" }, "license": "MIT",
  "userConfig": {
    "bridge_url":   { "type": "string", "title": "Bridge URL", "description": "Base URL of the local bridge", "default": "http://127.0.0.1:8765" },
    "bridge_token": { "type": "string", "title": "Bridge token", "description": "Shared secret printed by the bridge", "sensitive": true } } }
```

`plugins/gptweb/.mcp.json`:
```json
{ "mcpServers": { "bridge": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.mjs"],
  "env": { "GPTWEB_BRIDGE_URL": "${user_config.bridge_url}", "GPTWEB_BRIDGE_TOKEN": "${user_config.bridge_token}" } } } }
```

The skill has `allowed-tools: mcp__plugin_gptweb_bridge__delegate_task`. The agent has `tools: mcp__plugin_gptweb_bridge__delegate_task`. A zero-dependency newline-delimited JSON-RPC MCP server is at `server/index.mjs`. Claude Code sent `server/discover`, `initialize`, `notifications/initialized`, `tools/list`.

---

## 2. Marketplaces

Docs: [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference), [install](https://code.claude.com/docs/en/plugins/install), [publish](https://code.claude.com/docs/en/plugins/publish), [loading](https://code.claude.com/docs/en/plugins/loading).

### 2.1 `marketplace.json` [H]

- Location: `.claude-plugin/marketplace.json` at the repo root. Relative plugin sources resolve from the repo root.
- Required: `name`, `owner{name,email?,url?}`, `plugins[]`.
- Optional: `$schema`, `description`, `version`, `metadata.{description,version,pluginRoot}`, `forceRemoveDeletedPlugins`, `allowCrossMarketplaceDependenciesOn`, `renames`.
- Name rules: `[A-Za-z0-9._-]`, starting alphanumeric. Reserved names include `claude-code-plugins`, `anthropic-*`, `npm`, `github`, `claudeai-*`, and anything that impersonates an official name.
- Plugin entry: `name`, `source` + every `plugin.json` field + `category`, `tags`, `strict` (default true), `relevance`, `headers`, `headersHelper`.

Plugin `source` types:

| Type | Form |
|---|---|
| Relative path | `"./plugins/x"`; `"./"` means the repo root |
| `github` | `{source:"github", repo:"o/r", ref?, sha?}` |
| `url` | `{source:"url", url:"<git url>", ref?, sha?}` |
| `git-subdir` | `{source:"git-subdir", url, path, ref?, sha?}` |
| `npm` | `{source:"npm", package, version?, registry?}` |
| `archive` | `{source:"archive", url, sha256}` (zip) |
| `command` | `{source:"command", command, timeout?, mode?}` |

- Single-repo pattern: `.claude-plugin/marketplace.json` next to `plugin.json` with `{"name":"<same>","source":"./"}`. ([publish](https://code.claude.com/docs/en/plugins/publish))

### 2.2 User commands [H, verified locally with a directory source]

- Add the marketplace:
  - In-session: `/plugin marketplace add owner/repo` (or `owner/repo#ref`, `owner/repo@ref`).
  - Shell: `claude plugin marketplace add owner/repo`.
- Install:
  - In-session: `/plugin install gptweb@webgpt4cc`.
  - Shell: `claude plugin install gptweb@webgpt4cc [--scope user|project|local] [--config k=v] [--json] [-y]`.
- One step:
  - In-session: `/plugin install gptweb --marketplace owner/webGPT4CC` (≥ 2.1.275).
  - Shell: `claude plugin install gptweb --marketplace owner/webGPT4CC` (≥ 2.1.292).
- Other commands: `claude plugin update`, `list [--json]`, `details`, `configure`, `enable`, `disable`, `uninstall [--keep-data]`, `validate <path> [--strict] [--json]`, `tag`, `marketplace list|update|remove`, `/reload-plugins`.
- Dev loop: `claude --plugin-dir ./plugins/gptweb` (repeatable), `--plugin-url <zip>`, or `CLAUDE_CODE_PLUGIN_DIRS` (≥ 2.1.280; absolute paths only).
- Auto-update is **off by default** for third-party marketplaces.

### 2.3 What gets copied, and npm dependencies [H]

- GitHub marketplaces are cloned to `~/.claude/plugins/marketplaces/<name>/`.
  - Sparse checkout: `--sparse` on `marketplace add`, or `sparsePaths` in `extraKnownMarketplaces`.
- An installed plugin is **copied** to `cache/<mkt>/<plugin>/<version>/`.
  - "Files outside the plugin directory aren't copied." The plugin cannot reach `../../bridge`.
  - Ship anything the plugin runs inside its own directory, or call a separately installed CLI (e.g. `npx -y webgpt4cc` or a global npm bin).
- **Node dependencies are auto-installed** at install/update time, into the copied directory. This only happens when the plugin root has `package.json` **plus** a lockfile: `bun.lock`, `npm-shrinkwrap.json` or `package-lock.json` (v2/v3). Constraints:
  - Registry packages pinned exactly.
  - Separate install folder.
  - `--ignore-scripts`.
  - No overrides.
  - **60 s timeout.**
  - Cannot be disabled.
  - Not run for plugins loaded in place (local-path marketplace, `--plugin-dir`).
- For anything else (native builds, Python, very large packages), docs recommend a SessionStart hook that installs into `${CLAUDE_PLUGIN_DATA}`:

```json
"command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
```

Then set `NODE_PATH=${CLAUDE_PLUGIN_DATA}/node_modules` in the MCP `env`. ([components#install-dependencies-into-the-data-directory](https://code.claude.com/docs/en/plugins/components))

**Recommendation** [M]:
- Make the MCP server a **single self-contained `.mjs`**: hand-rolled JSON-RPC, or `@modelcontextprotocol/sdk` bundled with esbuild and committed.
- It spawns the system `claude` directly. Resolve it from `PATH`, or let a `userConfig` `claude_path` (type `file`) override it.
- No `package.json` means no install step and no 256 MB SDK binary.

---

## 3. Headless CLI and Agent SDK

Docs: [cli-reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless), [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript), [agent-sdk/python](https://code.claude.com/docs/en/agent-sdk/python).

### 3.1 `claude -p` flags [H]

All of the following exist in 2.1.295. `--max-turns` is hidden from `--help` but documented and verified working.

| Flag | Notes |
|---|---|
| `-p/--print` | Skips the trust dialog. Invalid settings files are silently ignored in this mode. Exit 0 on success, non-zero on failure. Verified: `error_max_turns` → exit 1. SIGTERM → exit 143. |
| `--output-format text\|json\|stream-json` | `stream-json` requires `--verbose`. |
| `--input-format text\|stream-json` | Verified: multiple JSONL user messages each produce a separate turn and `result`. |
| `--include-partial-messages` | Adds `stream_event` lines (raw Anthropic SSE events). |
| `--model`, `--fallback-model a,b` | |
| `--permission-mode default\|manual\|acceptEdits\|plan\|auto\|dontAsk\|bypassPermissions` | |
| `--dangerously-skip-permissions` | Same as `--permission-mode bypassPermissions`. |
| `--permission-prompts host\|none` | ≥ 2.1.259. |
| `--permission-prompt-tool <mcp tool>` | |
| `--allowedTools/--allowed-tools`, `--disallowedTools` | Permission rules. `--tools "Bash,Edit,Read"` or `""` restricts the built-in set instead. |
| `--max-turns N` | Result `subtype:"error_max_turns"`, `terminal_reason:"max_turns"`. |
| `--max-budget-usd` | Uses the client-side estimate; meaningless for the bridge. |
| `--system-prompt[-file]`, `--append-system-prompt[-file]` | Verified: `--system-prompt` still keeps the "You are a Claude agent, built on Anthropic's Claude Agent SDK." identity block plus the attribution block. |
| `--settings <file\|json>` | Flag layer; overrides user/project/local. |
| `--setting-sources user,project,local` | `""` means none. |
| `--mcp-config <files\|json...>`, `--strict-mcp-config` | With `-p`, waits up to `MCP_TIMEOUT` (30 s) for servers to connect. |
| `--add-dir`, `--plugin-dir`, `--agents <json\|file>` | |
| `--session-id <uuid>`, `--resume <id\|name\|path.jsonl>`, `--continue`, `--fork-session`, `--no-session-persistence` | |
| `--bare` | Skips hooks, plugins, MCP, CLAUDE.md, auto-memory and keychain; tools are Bash/Read/Edit. Docs: auth must be `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`. Verified on 2.1.295 that `ANTHROPIC_AUTH_TOKEN` also works. |
| `--autocompact <auto\|100k–1M>`, `--effort`, `--json-schema`, `--forward-subagent-text`, `--include-hook-events` | |

### 3.2 stream-json output [H, verified captures]

Captured samples: `capture/run5-out.txt` (tool round trip), `run9-out.txt` (with plugin), `run14-out.txt` (stream-json input).

- **Events seen before `init`:**
  - `{"type":"system","subtype":"hook_started"|"hook_response",…}` for SessionStart hooks.
  - `system/ui_invalidate`.
  - `system/plugin_install` when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` is set.
- **`system/init` fields:**
  - Session and environment: `cwd`, `session_id`, `model`, `permissionMode`, `apiKeySource`, `claude_code_version`, `output_style`.
  - Capabilities lists: `tools[]`, `slash_commands[]`, `agents[]`, `skills[]`, `capabilities[]` (e.g. `interrupt_receipt_v1`).
  - MCP and plugins: `mcp_servers[{name,status,source}]`, `mcp_server_errors?`, `plugins[{name,path,source,version}]`, `plugin_errors?`.
  - Other: `memory_paths`, `fast_mode_state`, `uuid`.
- **`assistant`:**
  - Shape: `{type,message:BetaMessage,parent_tool_use_id,session_id,uuid,timestamp}`.
  - **One `assistant` line per content block.** A text block and a tool_use block from the same API response arrive as two lines with the same `message.id`.
- **`user`:** carries the `tool_result` blocks, e.g. `{"tool_use_id":"toolu_…","type":"tool_result","content":"hello-from-tool","is_error":false}`.
- **`system/informational`:** e.g. the auto-mode classifier billing warning (`level:"warning"`).
- **Others:** `system/api_retry` {attempt, max_retries, retry_delay_ms, error_status, error}, `system/permission_denied`, `stream_event`, `system/compact_boundary`.
- **`result`:**
  - Status: `subtype` (`success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`), `is_error`, `api_error_status`, `result` (final text, success only), `errors[]` (error subtypes), `stop_reason`, `terminal_reason`.
  - Accounting: `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage{input_tokens,cache_*,output_tokens,…}`, `modelUsage{<model>:{inputTokens,outputTokens,costUSD,contextWindow,maxOutputTokens,canonicalModel,costBasis}}`.
  - Other: `permission_denials[]`, `session_id`, `uuid`.

stream-json **input** line (verified):

```json
{"type":"user","message":{"role":"user","content":"first prompt"},"parent_tool_use_id":null}
```

Optional fields: `priority:"now"|"next"|"later"`, `shouldQuery:false`, `client_composed:true`, `origin`.

### 3.3 TS SDK `query()` options [H]

From [docs](https://code.claude.com/docs/en/agent-sdk/typescript) and `sdk.d.ts` 0.3.295:
- **Runtime and process:** `env`, `cwd`, `model`, `fallbackModel`, `pathToClaudeCodeExecutable`, `executable:'bun'|'deno'|'node'`, `executableArgs`, `extraArgs`, `spawnClaudeCodeProcess`, `abortController`, `stderr(data)`.
- **Permissions and tools:** `allowedTools`, `disallowedTools`, `tools`, `permissionMode`, `allowDangerouslySkipPermissions` (required for bypass), `canUseTool(toolName, input, {signal,…}) → PermissionResult`, `permissionPrompts`, `maxTurns`.
- **Configuration sources:** `settingSources` (default: all sources; `[]` = none), `settings`, `managedSettings`, `mcpServers`, `strictMcpConfig`, `agents: Record<string, AgentDefinition>`, `plugins: [{type:'local', path}]`, `hooks`.
- **Prompt and output:** `systemPrompt: string | {type:'preset', preset:'claude_code', append?, excludeDynamicSections?, snapshot?} | {type:'custom', prompt, snapshot?}`, `includePartialMessages`, `outputFormat`.
- **Sessions:** `resume`, `sessionId`, `forkSession`, `persistSession`.

**How `env` reaches the spawned CLI:** [H, verified in `sdk.mjs`]
- The source has `env: c = {...process.env}` as the default. A provided `env` **replaces** the whole environment.
- Docs: "When set, this replaces the subprocess environment instead of merging with `process.env`, so pass `{ ...process.env, … }`."
- The SDK also sets `CLAUDE_CODE_ENTRYPOINT="sdk-ts"` only if unset, and deletes `NODE_OPTIONS`.
- **Python** `ClaudeAgentOptions(env=…)` **merges** on top of the inherited env. Also `cli_path`, `setting_sources`.

The TS SDK bundles the native CLI as a platform optional dependency, e.g. `@anthropic-ai/claude-agent-sdk-linux-x64`. The root `sdk.mjs` imports only Node builtins. The package is proprietary-licensed; see §0.6.

### 3.4 Recommended worker spawn (plugin MCP server → nested worker) [M]

Combines the verified behaviors above.

```js
import { spawn } from 'node:child_process';
const KEEP = ['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','TERM','TMPDIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SystemRoot','APPDATA','LOCALAPPDATA','USERPROFILE'];
const env = Object.fromEntries(KEEP.filter(k => process.env[k]).map(k => [k, process.env[k]]));
const bridgeEnv = {
  ANTHROPIC_BASE_URL: bridgeUrl, ANTHROPIC_AUTH_TOKEN: bridgeToken,
  ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_FABLE_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
  CLAUDE_CODE_AUTO_MODE_SERVER: '0', CLAUDE_CODE_ATTRIBUTION_HEADER: '0', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1', CLAUDE_CODE_MAX_RETRIES: '2', CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000', API_TIMEOUT_MS: '1800000',
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '120000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
const args = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  '--model', model, '--permission-mode', 'acceptEdits',          // never leave this unset (auto mode)
  '--settings', JSON.stringify({ env: bridgeEnv, disableAutoMode: 'disable' }), // flag layer beats ~/.claude/settings.json env
  '--max-turns', '50'];
const child = spawn(process.env.GPTWEB_CLAUDE_PATH || 'claude', args, { cwd: projectDir, env: { ...env, ...bridgeEnv }, stdio: ['pipe','pipe','pipe'] });
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: task }, parent_tool_use_id: null }) + '\n');
child.stdin.end();
// read JSONL from stdout; the final {"type":"result"} line carries .result / .is_error / .num_turns / .session_id
```

Notes on this recipe:
- Pass `--setting-sources ""` only if you do not want the user's own permissions, hooks and CLAUDE.md in the worker.
- Default `cwd` = `CLAUDE_PROJECT_DIR` from the MCP env.
- `CLAUDECODE` and the other `CLAUDE_CODE_*` parent vars are deliberately dropped by the allowlist.

---

## 4. Env vars and settings for the gateway

Sources: [env-vars](https://code.claude.com/docs/en/env-vars), [model-config](https://code.claude.com/docs/en/model-config), [llm-gateway-connect](https://code.claude.com/docs/en/llm-gateway-connect), [llm-gateway-protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [settings-reference](https://code.claude.com/docs/en/settings-reference).

### 4.1 Credentials [H, verified]

- **`ANTHROPIC_AUTH_TOKEN`** is sent as `Authorization: Bearer <v>`. It takes precedence immediately, with **no approval prompt**. Precedence order: provider vars > AUTH_TOKEN > API_KEY > apiKeyHelper > `CLAUDE_CODE_OAUTH_TOKEN` > /login.
- **`ANTHROPIC_API_KEY`** is sent as `x-api-key`.
  - With `-p` it is always used.
  - In interactive mode it needs a one-time approval, stored in `~/.claude.json` as `"customApiKeyResponses":{"approved":[…],"rejected":[…]}`. The stored value is the **last 20 chars of the trimmed key**; verified in the binary: `wde(e){return e.trim().slice(-20)}`.
  - A previously declined key is silently ignored; re-enable it under `/config` → "Use custom API key".
- **`apiKeyHelper`** (settings): a shell command whose output is sent in **both** headers. TTL 5 min (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). Re-run on 401/403.
- **Security note:** if `ANTHROPIC_BASE_URL` is set **without** a gateway credential, the user's claude.ai OAuth token is sent to the base URL. The launcher should **always set `ANTHROPIC_AUTH_TOKEN`**. [H]
- Auth-conflict warning: a saved /login plus a credential variable triggers a startup warning ("auth may not work as expected"). It is only a warning; the variable wins.

### 4.2 Model selection [H, verified]

- Precedence: `/model` > `--model` > `ANTHROPIC_MODEL` > settings `model` > `ANTHROPIC_DEFAULT_MODEL` (≥ 2.1.236).
- Alias targets: `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`. HAIKU also drives "background functionality".
- `ANTHROPIC_SMALL_FAST_MODEL` is **deprecated** in favor of `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
- `CLAUDE_CODE_SUBAGENT_MODEL`: an agent's own `model:` field and a per-invocation model take precedence, unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`.
- With AUTH_TOKEN through a gateway, background tasks use "the main model".
- Picker entries: `ANTHROPIC_CUSTOM_MODEL_OPTION[_NAME|_DESCRIPTION]` adds one row.
- Gateway discovery: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` calls `GET /v1/models?limit=1000` (3 s timeout, no redirects) and reads `data[].id/display_name/description`.
  - **It keeps only IDs containing `claude` or `anthropic`.**
  - Results are cached in `~/.claude/cache/gateway-models.json`.
- An unknown model ID is passed through verbatim. stderr prints `[claude-code:unrecognized_model] {"model":"gpt-5-thinking",…}`. Harmless.

### 4.3 Context window and auto-compact for custom model IDs [H, verified]

Rule: "an ID … that doesn't start with `claude-` … can't resolve → `CLAUDE_CODE_MAX_CONTEXT_TOKENS` applies directly". Default assumption for an unknown ID is 200K (1M if the ID contains `[1m]`), with max output 32000 (cap 128000).

Measured on 2.1.295 (`modelUsage.contextWindow`):

| `--model` | Unset | `CLAUDE_CODE_MAX_CONTEXT_TOKENS=128000` |
|---|---|---|
| `gpt-5-thinking` | 200000 / max_out 32000 | **128000** |
| `chatgpt-web/claude-bridge` | 200000 | **128000** (contains "claude", so it passes discovery) |
| `claude-gptweb` | 200000 | 200000 (ignored: bare `claude-` name; would need `DISABLE_COMPACT`) |
| `claude-opus-4-8-gptweb` | **1000000 / 64000** (resolves to Opus 4.8) | 1000000 |

**Model IDs:**
- Do not start them with `claude-`.
- Do not embed a known Claude model name.
- If gateway discovery is wanted, include `claude` or `anthropic` mid-string, e.g. `chatgpt-web/claude-bridge-gpt5`.

Other context controls:
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: plain integer, 100000–1000000, capped at the model window.
- `--autocompact`, setting `autoCompactWindow`.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: can only lower the threshold.
- `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`.
- `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`: compact only after a recognized too-long error.

The bridge must report realistic usage. [M] Claude Code tracks context from the `usage` the API returns, so the bridge should return `usage.input_tokens` close to the real prompt size (e.g. chars/4). Tiny numbers would mean compaction never triggers.

### 4.4 Other variables (all [H] from env-vars)

| Variable | Meaning / default | Recommendation for bridge use |
|---|---|---|
| `API_TIMEOUT_MS` | Per-request timeout, default 600000, max 2147483647 | Raise to ≥ 1800000 |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | Event- and byte-level watchdogs; minimum 300000 (clamped); byte watchdog capped at 30 min | Raise to 1800000, and **emit SSE `ping` every ≤ 15 s** |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | Byte watchdog only; 10 s–30 min | |
| `CLAUDE_CODE_MAX_RETRIES` | Default 10, cap 15 | **Lower it (1–2)**: every retry is another ChatGPT message |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Unknown model: default 32000, cap 128000; a larger value shrinks the effective window | Optional |
| `MAX_THINKING_TOKENS` | `0` disables thinking; on third-party it omits the param | `0` |
| `CLAUDE_CODE_DISABLE_THINKING=1` | Omits the `thinking` param | Verified: removes `thinking` from the body |
| `DISABLE_PROMPT_CACHING=1` | Disables cache_control | Optional (the bridge ignores it anyway) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Any value disables updates, telemetry, error reporting, feedback, release notes, availability checks and feature-flag fetch. **`0` and `false` also disable it** | Set |
| `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` | Any value opts out (`0` too) | Optional |
| `DISABLE_AUTOUPDATER=1` (`DISABLE_UPDATES` is stricter) | | Optional |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | Strips pre-release betas, `context_management`, beta tool fields, `output_config.format`/`task_budget`, MCP tool search | Set. Verified the betas shrink to `claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,effort-2025-11-24` |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` | **Not listed** in the current env-vars page [H: absent] | Don't rely on it |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0` | Removes the first system block `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…;` | Set, or have the bridge drop that block |
| `CLAUDE_CODE_AUTO_MODE_SERVER=0` | No `safeguards` field; classifier requests stay local (still model calls) | Set **and** avoid auto mode |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` | Interactive mode otherwise sends a follow-up request after every reply | **Set** |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` | Skips the title-generation request | Set |
| `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` | Sends `x-claude-code-request-class: main\|subagent\|workflow\|compaction\|auxiliary`, `x-claude-code-compaction`, `x-claude-code-prompt-id`, `x-claude-code-prev-tool-durations` | **Set**. Verified `request-class: main`, `prompt-id`, `prev-tool-durations: Bash=47` |
| `CLAUDE_CODE_DISABLE_FAST_MODE=1` | Avoids the fast-mode check to `api.anthropic.com` | Set |
| `ANTHROPIC_CUSTOM_HEADERS` | `Name: Value` lines (`\n` in JSON) | Optional |
| `ENABLE_TOOL_SEARCH` | Off by default for a non-first-party base URL | Leave as is |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` | Avoids `advisor_*` tool entries (2.1.275 issue) | Harmless; set |
| `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` | Set in Claude Code's subprocesses; the latter excludes nested TUI sessions from `--resume` | Strip in children |

**settings.json `env` block** [H]:
- It is applied at startup from user settings, `--settings` and managed settings.
- From project/local settings it applies after trust, or at startup under `-p`.
- Project/local files cannot set `CLAUDE_CONFIG_DIR`, `HOME`, `TMPDIR`, OTEL exporters, `CLAUDE_CODE_PROCESS_WRAPPER`, the plugin cache vars, and similar.
- **Do not put the token in a committed `.claude/settings.json`.**

### 4.5 What the gateway (bridge) must implement [H] ([llm-gateway-protocol](https://code.claude.com/docs/en/llm-gateway-protocol))

**Endpoints:**
- `POST /v1/messages`. The path arrives as `/v1/messages?beta=true`, so match on the path, not the full URL.
- Optional: `POST /v1/messages/count_tokens`. Without it, Claude Code falls back to a character estimate.
- Optional: `GET /v1/models` (discovery).
- `HEAD /api/hello` (connection warming; any response is fine). Verified as the first request.
- Support both `stream:true` (all main-loop requests in captures) and non-stream JSON.

**SSE requirements:**
- `content-type: text/event-stream`.
- No buffering.
- The full sequence `message_start` … `content_block_*` … **`message_delta` then `message_stop`**. A body ending after a block starts but before `message_delta` is treated as a dropped connection.
- `ping` events keep the watchdogs alive.
- The first-byte deadline does **not** apply through a custom `ANTHROPIC_BASE_URL`.
- The byte watchdog does apply: 180 s with feature flags fetched, 300 s otherwise. ([network-config#streaming-idle-watchdogs](https://code.claude.com/docs/en/network-config))

**Response headers:**
- `retry-after` as integer seconds. A value above 60 stops retries immediately.
- `x-should-retry: true|false`.

**Errors:**
- Use the Anthropic error envelope.
- Too-long recovery is triggered by the wording "Prompt is too long" (or the token `capability_rejected: prompt_too_long`). If the bridge rewrites it, reactive compaction won't happen.
- Upstream rejections of `thinking`, mid-conversation system messages, or `output_config.effort` are retried by Claude Code with that capability disabled. Rejections of `context_management` or tool fields are **not** retried.

**Request headers seen (2.1.295, verified):**
- Credentials: `authorization` or `x-api-key`.
- `anthropic-version: 2023-06-01`.
- `anthropic-beta`: the full list in default mode is `claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24,dangerous-tool-use-2026-09-03,thinking-display-updates-2026-08-18,afk-mode-2026-01-31`.
- `anthropic-dangerous-direct-browser-access: true`, `user-agent: claude-cli/2.1.295 (external, sdk-cli|cli)`, `x-app: cli`, `x-stainless-*`.
- **`x-claude-code-session-id`** is always present. `x-claude-code-agent-id` / `x-claude-code-parent-agent-id` appear on subagent requests.

**Body keys (default):** `model, messages, system[], tools[], metadata{user_id: JSON string with device_id/session_id}, max_tokens, thinking{type:"adaptive",display}, context_management, safeguards (auto mode), output_config{effort}, stream`.

Body details the bridge translator must handle (verified):
- `system[0]` is the attribution block unless `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.
- **`messages` can contain `{"role":"system", content:[…]}` entries mid-conversation.** The "# Environment" block arrives this way.
- User content arrives as both string and block arrays.
- `cache_control` appears on blocks.
- `<system-reminder>` text blocks are included.
- Tool results look like `{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"…"|[blocks],"is_error":false}]}`.
- Assistant `tool_use` blocks come back as `{"type":"tool_use","id","name","input"}`.

The bridge's own SSE must emit:
- `content_block_start` with `{type:"tool_use", id:"toolu_…", name, input:{}}`.
- Then `input_json_delta` `partial_json` chunks.
- Then `message_delta` with `stop_reason:"tool_use"`.

Verified: Claude Code executes the tool and sends a correctly formed follow-up request.

**Example sizes in this clean environment:**
- `claude -p`: 21 tools, 74.8 KB body.
- Interactive: 24 tools (adds AskUserQuestion, EnterPlanMode, ExitPlanMode), 87.1 KB.
- `--bare`: 3.7 KB.

The tool set varies by version and feature flags; this build exposed `Agent, Bash, Cron*, Edit, EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, WebFetch, WebSearch, Workflow, Write, DesignSync`. [H for this build; M for other machines]

---

## 5. Launcher ("run Claude Code fully on GPT web") [M; each piece H]

```bash
#!/usr/bin/env bash
# webgpt4cc-claude: start Claude Code against the local bridge
BRIDGE="${WEBGPT4CC_URL:-http://127.0.0.1:8765}"; TOKEN="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/webgpt4cc/token")"
MODEL="${WEBGPT4CC_MODEL:-chatgpt-web/claude-bridge}"
SETTINGS=$(cat <<JSON
{"env":{"ANTHROPIC_BASE_URL":"$BRIDGE","ANTHROPIC_AUTH_TOKEN":"$TOKEN","ANTHROPIC_MODEL":"$MODEL",
 "ANTHROPIC_DEFAULT_OPUS_MODEL":"$MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL":"$MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL":"$MODEL",
 "ANTHROPIC_DEFAULT_FABLE_MODEL":"$MODEL","CLAUDE_CODE_SUBAGENT_MODEL":"$MODEL","CLAUDE_CODE_MAX_CONTEXT_TOKENS":"120000",
 "CLAUDE_CODE_AUTO_MODE_SERVER":"0","CLAUDE_CODE_ATTRIBUTION_HEADER":"0","CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS":"1",
 "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION":"false","CLAUDE_CODE_DISABLE_TERMINAL_TITLE":"1","CLAUDE_CODE_GATEWAY_HINT_HEADERS":"1",
 "CLAUDE_CODE_DISABLE_FAST_MODE":"1","CLAUDE_CODE_MAX_RETRIES":"2","API_TIMEOUT_MS":"1800000","CLAUDE_STREAM_IDLE_TIMEOUT_MS":"1800000",
 "MAX_THINKING_TOKENS":"0","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"},
 "disableAutoMode":"disable"}
JSON
)
export ANTHROPIC_BASE_URL="$BRIDGE" ANTHROPIC_AUTH_TOKEN="$TOKEN"   # also in env so pre-settings code paths see it
exec claude --model "$MODEL" --settings "$SETTINGS" "$@"
```

Notes on this launcher:
- `--settings` env beats a conflicting `~/.claude/settings.json` `env` (verified). Managed settings can still override it.
- Remote Control and voice dictation are disabled while the base URL points at a non-Anthropic host. That is expected and documented.

---

## 6. Policy and terms (Anthropic side) [H]

- Gateways: "doesn't support routing Claude Code to non-Claude models through any gateway". It is unsupported, not prohibited in the text quoted.
- [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance):
  - "The Claude Code binary must not be modified." We don't modify it; `ANTHROPIC_BASE_URL` is a documented setting.
  - "can't use the Claude Code or Anthropic names or logos as part of your own product … name". This affects naming.
- The TS Agent SDK is "All rights reserved". Depend on it via npm; do not vendor it into the public repo.
- The ChatGPT-side terms of service belong to the other track.

---

## 7. Files produced (all under `<research-workspace>/plugin/`)

- `docs/*.md` — raw official doc pages, plus `docs/changelog.md` covering 2.1.x through 2.1.295.
- `cli-help.txt`, `plugin-help.txt`, `mcp-help.txt`, `mkt-help.txt`, `validate-help.txt`, `install-help.txt` — `--help` output from the local 2.1.295 CLI.
- `capture/server.mjs` — fake Anthropic endpoint (SSE text and tool_use modes). `capture/run.sh` and `capture/summarize.py` are helpers.
- Captured request and response files:
  - `capture/run1/002.json` — default `-p` request.
  - `capture/run6/002.json` — interactive request.
  - `capture/run3/001.json` — minimal `--bare` request with betas disabled.
  - `capture/run5/003.json` — tool_result follow-up.
  - `capture/run11/*.json` — gateway hint headers.
  - `capture/run9-out.txt` — stream-json with the plugin loaded.
  - `capture/run14-out.txt` — stream-json input.
- `sample-repo/` — validated marketplace and plugin skeleton (`.claude-plugin/marketplace.json`, `plugins/gptweb/{.claude-plugin/plugin.json,.mcp.json,server/index.mjs,skills/delegate/SKILL.md,agents/gpt-worker.md,commands/bridge-status.md,hooks/hooks.json,bin/gptweb-check}`).
- `sdkpkg/x/package/` — extracted `@anthropic-ai/claude-agent-sdk@0.3.295` (`sdk.d.ts`, `sdk.mjs`, README, LICENSE).
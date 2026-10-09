---
name: delegate
description: Hand a self-contained coding task to a separate Claude Code agent that runs on the user's ChatGPT web subscription (webGPT4CC bridge) instead of Claude. Use when the user asks to "use GPT/ChatGPT for this", to save Claude usage, or to offload bulk or mechanical work (mass edits, writing tests, boilerplate, refactors, investigations).
argument-hint: "[task description]"
---

# Delegate to the ChatGPT-web agent

The `webgpt4cc` MCP server of this plugin provides a `delegate` tool
(`mcp__plugin_gpt-web_webgpt4cc__delegate`). It starts a **separate** Claude Code
process whose model is the user's ChatGPT (through the local webGPT4CC bridge and
browser extension). That agent:

- starts with **no knowledge of this conversation** — everything it needs must be in the brief;
- works in the current project by default (or a `cwd` inside it). It may edit files inside
  that directory; beyond that it can only use the tools in `allowed_tools` (default: Read,
  Glob, Grep, TodoWrite — **no Bash** unless you add rules such as `"Bash(npm test:*)"`).
  Nobody can approve other tools while it runs, so they are denied. Don't add bare
  `"Write"`/`"Edit"` rules: they would let it write anywhere on disk;
- spends one ChatGPT message per step, and is slower than you.

## How to delegate

1. If you are not sure the bridge is up, call the `status` tool first. If it reports a
   problem, tell the user how to fix it (start `webgpt4cc serve`, open the extension
   popup → "Open worker tab", log in to chatgpt.com) instead of delegating.
2. Write a brief that a capable engineer with zero context could execute:
   goal, relevant files and directories, constraints (style, APIs to keep), what
   "done" means, and how to verify (commands to run, if Bash is allowed).
3. Call `delegate` with `task` = the brief. Pick `allowed_tools` deliberately; add
   `Bash(...)` rules only for the commands the task needs. Use `max_turns` to bound
   cost for small tasks (e.g. 15). Pass `lite: true` for focused tasks: the delegate then gets
   only the core tools (no subagents) and its first ChatGPT message is about 4x smaller.
4. Long runs move to the background automatically; you'll get the result as a task
   notification. Keep working on other things meanwhile if useful.
5. **Review the result**: read the files it changed (listed in the result) and check
   the work before reporting success. Use `resume_session_id` from the result to send a
   follow-up instruction to the same delegate session.

If the user passed a task with the command, delegate this: $ARGUMENTS

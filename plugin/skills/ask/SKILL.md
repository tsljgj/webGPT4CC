---
name: ask
description: Ask the user's ChatGPT (via the webGPT4CC bridge) a one-off question for a second opinion — no tools, no file access. Use when the user wants GPT's view on a design, bug or explanation.
argument-hint: "[question]"
---

Use the `ask` tool of the plugin's `webgpt4cc` MCP server
(`mcp__plugin_gpt-web_webgpt4cc__ask`). ChatGPT sees **only** the text you send, so
include all relevant context (code excerpts, error messages, constraints) in
`question`. Report ChatGPT's answer to the user, clearly attributed, and add your own
assessment where you disagree.

Question from the user: $ARGUMENTS

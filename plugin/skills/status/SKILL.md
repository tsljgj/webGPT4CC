---
name: status
description: Check whether the webGPT4CC bridge is running and a ChatGPT browser tab is connected and ready.
disable-model-invocation: true
---

Call the `status` tool of the plugin's `webgpt4cc` MCP server
(`mcp__plugin_gpt-web_webgpt4cc__status`) and report the result. If something is not
ready, explain the fix:

- bridge not reachable → run `webgpt4cc serve` (or `npx webgpt4cc serve`) in a terminal;
- extension not connected → install the unpacked extension from the repo's `extension/`
  folder in Chrome and paste the bridge URL and token from `webgpt4cc pair` into its popup;
- no worker tab → open the extension popup and click "Open worker tab", then make sure
  that tab is logged in to chatgpt.com.

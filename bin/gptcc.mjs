#!/usr/bin/env node
// gptcc: run Claude Code against the webGPT4CC bridge (ChatGPT web).
// Usage: gptcc [--gpt-model SLUG] [any claude arguments]
import { loadCli } from './load-cli.mjs';

const cli = await loadCli();
await cli.main(['claude', ...process.argv.slice(2)]);

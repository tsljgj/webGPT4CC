#!/usr/bin/env node
// gptcc: run Claude Code against the webGPT4CC bridge (ChatGPT web).
// Usage: gptcc [--gpt-model SLUG] [any claude arguments]
import { existsSync } from 'node:fs';

const dist = new URL('../dist/cli.js', import.meta.url);
const src = new URL('../bridge/src/cli.ts', import.meta.url);
const mod = await import(existsSync(dist) ? dist.href : src.href);
await mod.main(['claude', ...process.argv.slice(2)]);

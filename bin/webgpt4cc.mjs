#!/usr/bin/env node
// Entry point: prefer the compiled build (dist/), fall back to the TypeScript
// sources (Node >= 22.18 strips types natively outside node_modules).
import { existsSync } from 'node:fs';

const dist = new URL('../dist/cli.js', import.meta.url);
const src = new URL('../bridge/src/cli.ts', import.meta.url);
const mod = await import(existsSync(dist) ? dist.href : src.href);
await mod.main(process.argv.slice(2));

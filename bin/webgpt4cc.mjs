#!/usr/bin/env node
import { loadCli } from './load-cli.mjs';

const cli = await loadCli();
await cli.main(process.argv.slice(2));

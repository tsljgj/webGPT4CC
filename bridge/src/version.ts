import { readFileSync } from 'node:fs';

function readVersion(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      return (JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { version: string }).version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();

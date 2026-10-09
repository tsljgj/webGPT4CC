// Tiny leveled logger (stderr) with optional prompt/reply dumps.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  dump(name: string, content: string): void;
}

export function createLogger(level: Level = 'info', dumpDir = '', sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const min = ORDER[level] ?? 20;
  if (dumpDir) mkdirSync(dumpDir, { recursive: true });
  const emit = (lvl: Level, msg: string, data?: unknown) => {
    if (ORDER[lvl] < min) return;
    const ts = new Date().toISOString().slice(11, 23);
    let line = `${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (data !== undefined) line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data));
    sink(line);
    if (dumpDir) {
      try {
        appendFileSync(join(dumpDir, 'bridge.log'), line + '\n');
      } catch {
        /* ignore */
      }
    }
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    dump: (name, content) => {
      if (!dumpDir) return;
      try {
        writeFileSync(join(dumpDir, name.replace(/[^\w.-]/g, '_')), content);
      } catch {
        /* ignore */
      }
    },
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, dump() {} };

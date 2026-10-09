// Tiny leveled logger (stderr) with optional prompt/reply dumps.
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Prompts contain the user's code: dump files are private and never follow planted symlinks. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW;
const appendFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW;

function writePrivate(path: string, data: string, flags: number): void {
  const fd = openSync(path, flags, 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function prepareDumpDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`dump dir ${dir} is not a plain directory`);
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort (Windows) */
  }
}

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
  if (dumpDir) prepareDumpDir(dumpDir);
  const emit = (lvl: Level, msg: string, data?: unknown) => {
    if (ORDER[lvl] < min) return;
    const ts = new Date().toISOString().slice(11, 23);
    let line = `${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (data !== undefined) line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data));
    sink(line);
    if (dumpDir) {
      try {
        writePrivate(join(dumpDir, 'bridge.log'), line + '\n', appendFlags);
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
        writePrivate(join(dumpDir, name.replace(/[^\w.-]/g, '_')), content, writeFlags);
      } catch {
        /* ignore */
      }
    },
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, dump() {} };

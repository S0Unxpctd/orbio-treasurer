/**
 * log() — the Treasurer's one structured logger (ARCHITECTURE.md §8).
 * Prints exactly one redacted JSON line per call to stderr (console.error; Biome
 * forbids console.log in core). No third-party logging SDK.
 */
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function currentThreshold(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return isLogLevel(raw) ? raw : 'info';
}

/**
 * Logs one JSON line: `{ ts, level, msg, ...redact(ctx) }`. Dropped entirely if
 * `level` is below the `LOG_LEVEL` env threshold (default `info`).
 */
export function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentThreshold()]) return;

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (ctx !== undefined) {
    Object.assign(line, redact(ctx) as Record<string, unknown>);
  }

  console.error(JSON.stringify(line));
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** Returns a Logger that merges `baseCtx` into every call's context. */
export function createLogger(baseCtx: Record<string, unknown>): Logger {
  const call =
    (level: LogLevel) =>
    (msg: string, ctx?: Record<string, unknown>): void =>
      log(level, msg, { ...baseCtx, ...ctx });

  return {
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
  };
}

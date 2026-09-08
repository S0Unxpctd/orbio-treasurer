/**
 * log() — the Treasurer's one structured logger (ARCHITECTURE.md §8).
 * Prints exactly one redacted JSON line per call to stderr (console.error; Biome
 * forbids console.log in core). No third-party logging SDK. Never throws — a failure
 * to serialize degrades to a safe fallback line instead of crashing the caller (this is
 * the code a failed tick relies on to explain itself; see ARCHITECTURE.md §9,
 * "a failed tick logs a decision TICK_FAILED with a redacted reason").
 */
import { DEFAULT_ALLOW_TX_HASH_KEYS, type RedactOptions, redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// `msg`/`ctx` may legitimately carry a tx hash (0x+64-hex) that would otherwise be
// masked identically to a private key — see the ambiguity note in redact.ts. log()
// opts values keyed by these names out of masking by default.
const REDACT_OPTIONS: RedactOptions = { allowTxHashKeys: DEFAULT_ALLOW_TX_HASH_KEYS };

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function currentThreshold(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return isLogLevel(raw) ? raw : 'info';
}

function writeFallbackLine(reason: string): void {
  try {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'log-serialization-failed',
        reason,
      }),
    );
  } catch {
    // Absolute last resort — a hand-written literal cannot itself fail to stringify.
    console.error('{"level":"error","msg":"log-serialization-failed"}');
  }
}

/**
 * Logs one JSON line: `{ ts, level, msg, ...redact(ctx) }`. `msg` is redacted too — a
 * secret interpolated straight into the message string is just as much a leak as one in
 * `ctx`. Dropped entirely if `level` is below the `LOG_LEVEL` env threshold (default
 * `info`). Never throws: a circular `ctx`, a stray `BigInt`, or any other serialization
 * failure degrades to a `log-serialization-failed` line instead of crashing the caller.
 */
export function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentThreshold()]) return;

  try {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: redact(msg, REDACT_OPTIONS) as string,
    };
    if (ctx !== undefined) {
      Object.assign(line, redact(ctx, REDACT_OPTIONS) as Record<string, unknown>);
    }
    console.error(JSON.stringify(line));
  } catch (err) {
    writeFallbackLine(err instanceof Error ? err.message : String(err));
  }
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, log } from './log.js';

const FIXTURE_SECRET = 'sk-or-v1-TESTONLYabcdef1234';

describe('log()', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it('writes to stderr via console.error, not console.log', () => {
    delete process.env.LOG_LEVEL;
    log('info', 'hello');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('prints exactly one line that parses as JSON', () => {
    delete process.env.LOG_LEVEL;
    log('info', 'tick complete', { agent: 'a1' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.split('\n')).toHaveLength(1);
  });

  it('the JSON line has ts (ISO UTC), level and msg', () => {
    delete process.env.LOG_LEVEL;
    log('warn', 'careful');
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.level).toBe('warn');
    expect(parsed.msg).toBe('careful');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('redacts ctx before printing — never contains a fixture secret', () => {
    delete process.env.LOG_LEVEL;
    log('info', 'created key', { key: FIXTURE_SECRET });
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(FIXTURE_SECRET);
    const parsed = JSON.parse(raw);
    expect(parsed.key).toBe('sk-or-…1234');
  });

  it('redacts a value under a _KEY-suffixed ctx field regardless of shape', () => {
    delete process.env.LOG_LEVEL;
    log('error', 'boom', { ORBIO_API_KEY: FIXTURE_SECRET });
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(FIXTURE_SECRET);
  });

  it('defaults the level threshold to info: debug is dropped', () => {
    delete process.env.LOG_LEVEL;
    log('debug', 'noisy');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('default threshold still allows info/warn/error', () => {
    delete process.env.LOG_LEVEL;
    log('info', 'a');
    log('warn', 'b');
    log('error', 'c');
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it('LOG_LEVEL=error suppresses info and warn', () => {
    process.env.LOG_LEVEL = 'error';
    log('info', 'suppressed');
    log('warn', 'suppressed too');
    expect(errorSpy).not.toHaveBeenCalled();
    log('error', 'shown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('LOG_LEVEL=debug allows debug through', () => {
    process.env.LOG_LEVEL = 'debug';
    log('debug', 'now visible');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('an unrecognized LOG_LEVEL falls back to the info default', () => {
    process.env.LOG_LEVEL = 'not-a-real-level';
    log('debug', 'still dropped');
    expect(errorSpy).not.toHaveBeenCalled();
    log('info', 'still shown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

// --- Adversarial inputs from tasks/reports/T-003-audit-1.md (pass 1) ---
describe('log() — adversarial cases from audit pass 1', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('redacts a secret interpolated straight into msg (Blocker: msg was never redacted)', () => {
    log('info', `created key ${FIXTURE_SECRET} for agent a1`);
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(FIXTURE_SECRET);
    const parsed = JSON.parse(raw);
    expect(parsed.msg).toBe('created key sk-or-…1234 for agent a1');
  });

  it('never throws on a circular ctx — degrades to a <circular> marker, not a crash', () => {
    const circular: Record<string, unknown> = { agent: 'a1' };
    circular.self = circular;
    expect(() => log('error', 'circular test', circular)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.self).toBe('<circular>');
  });

  it('never throws on a BigInt in ctx — stringifies it instead', () => {
    expect(() =>
      log('info', 'balance check', { balanceWei: 123456789012345678901234567890n }),
    ).not.toThrow();
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.balanceWei).toBe('123456789012345678901234567890');
  });

  it('falls back to a safe log-serialization-failed line if redact()+stringify still fails', () => {
    // A getter that throws defeats redact()'s own property walk; log() must still not throw
    // and must still emit exactly one valid JSON line to stderr.
    const poison: Record<string, unknown> = {};
    Object.defineProperty(poison, 'boom', {
      enumerable: true,
      get(): never {
        throw new Error('getter exploded');
      },
    });
    expect(() => log('error', 'poisoned ctx', poison)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.msg).toBe('log-serialization-failed');
    expect(parsed.level).toBe('error');
  });

  it('a fixture secret in a class-instance ctx value does not survive a real log() call', () => {
    class WalletKeyHolder {
      constructor(public privateKey: string) {}
    }
    log('error', 'signing failed', { wallet: new WalletKeyHolder(FIXTURE_SECRET) });
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(FIXTURE_SECRET);
  });

  it('a Buffer holding a fixture secret in ctx never emits raw bytes via log()', () => {
    const buf = Buffer.from(FIXTURE_SECRET);
    log('error', 'wallet op', { keyBytes: buf });
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(FIXTURE_SECRET.slice(6, -4));
    expect(raw).toContain(`<bytes:${buf.byteLength}>`);
  });

  it('a mixed-case key in ctx is still masked (Blocker: case-sensitive patterns)', () => {
    log('info', 'upstream response', { rawHeader: 'SK-OR-V1-TESTONLYabcdef1234' });
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain('TESTONLYabcdef1234');
  });

  it('a camelCase apiKey field in ctx is masked', () => {
    log('info', 'client created', { apiKey: 'short-secret-value-1234' });
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain('short-secret-value-1234');
  });

  it('a txHash-keyed value is left intact by default (log.ts uses the allow-list)', () => {
    const hash = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    log('info', 'stake tx confirmed', { txHash: hash });
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.txHash).toBe(hash);
  });
});

describe('createLogger()', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('merges base context into every call, call ctx winning on conflict', () => {
    const logger = createLogger({ agent: 'a1', tier: 'standard' });
    logger.info('tick', { tier: 'economy' });
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.agent).toBe('a1');
    expect(parsed.tier).toBe('economy');
  });

  it('exposes debug/info/warn/error and respects the level threshold', () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = createLogger({ agent: 'a1' });
    logger.info('dropped');
    logger.debug('dropped too');
    expect(errorSpy).not.toHaveBeenCalled();
    logger.warn('shown');
    logger.error('shown too');
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('redacts merged context containing a fixture secret', () => {
    const logger = createLogger({ WALLET_SECRET: FIXTURE_SECRET });
    logger.error('boom');
    const raw = errorSpy.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(FIXTURE_SECRET);
  });
});

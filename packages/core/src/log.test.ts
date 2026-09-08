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

/**
 * decimal.ts — exact decimal-string arithmetic (T-011, ADR-002 audit focus: "Float drift").
 * Not itself a "Tests required" file for T-011, but computeSnapshotMetrics and both LedgerStore
 * implementations depend on this module never touching a float, so it gets direct coverage too.
 */
import { describe, expect, it } from 'vitest';
import {
  divideDecimal,
  formatDecimal,
  maxDecimal,
  normalizeMoney,
  normalizeTokenAmount,
  parseDecimal,
  subDecimal,
} from './decimal.js';

describe('parseDecimal / formatDecimal', () => {
  it('round-trips a value that is lossy in IEEE-754 (0.1 + 0.2 drift)', () => {
    expect(formatDecimal(parseDecimal('123456789012.100200'))).toBe('123456789012.100200');
  });

  it('pads a bare integer to 6 dp', () => {
    expect(formatDecimal(parseDecimal('10'))).toBe('10.000000');
  });

  it('round-trips zero, including "-0" as plain zero', () => {
    expect(formatDecimal(parseDecimal('0'))).toBe('0.000000');
    expect(formatDecimal(parseDecimal('-0'))).toBe('0.000000');
  });

  it('preserves the sign of a negative value', () => {
    expect(formatDecimal(parseDecimal('-3.5'))).toBe('-3.500000');
  });

  it('rejects more than 6 fractional digits rather than silently truncating', () => {
    expect(() => parseDecimal('1.1234567')).toThrow(/invalid decimal string/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => parseDecimal('abc')).toThrow(/invalid decimal string/);
    expect(() => parseDecimal('')).toThrow(/invalid decimal string/);
  });
});

describe('normalizeMoney', () => {
  it('null/undefined pass through as null', () => {
    expect(normalizeMoney(null)).toBeNull();
    expect(normalizeMoney(undefined)).toBeNull();
  });

  it('normalizes to a fixed 6 dp string', () => {
    expect(normalizeMoney('7')).toBe('7.000000');
    expect(normalizeMoney('7.5')).toBe('7.500000');
  });
});

describe('normalizeTokenAmount', () => {
  it('null/undefined pass through as null', () => {
    expect(normalizeTokenAmount(null)).toBeNull();
    expect(normalizeTokenAmount(undefined)).toBeNull();
  });

  it('accepts a 30-digit integer string unchanged', () => {
    const tokens = '123456789012345678901234567890';
    expect(normalizeTokenAmount(tokens)).toBe(tokens);
  });

  it('rejects a fractional token amount', () => {
    expect(() => normalizeTokenAmount('1.5')).toThrow(/invalid token amount/);
  });
});

describe('subDecimal / maxDecimal', () => {
  it('subtracts exactly', () => {
    expect(formatDecimal(subDecimal(parseDecimal('5.5'), parseDecimal('2.25')))).toBe('3.250000');
  });

  it('max picks the larger of two scaled decimals', () => {
    const a = parseDecimal('0.000001');
    const b = parseDecimal('0.01');
    expect(formatDecimal(maxDecimal(a, b))).toBe('0.010000');
    expect(formatDecimal(maxDecimal(b, a))).toBe('0.010000');
  });
});

describe('divideDecimal', () => {
  it('divides exactly when it divides evenly', () => {
    expect(formatDecimal(divideDecimal(parseDecimal('9'), parseDecimal('3')))).toBe('3.000000');
  });

  it('rounds half away from zero at the 6th decimal place', () => {
    // 1 / 3 = 0.3333... -> rounds to 0.333333 (not up, remainder < half)
    expect(formatDecimal(divideDecimal(parseDecimal('1'), parseDecimal('3')))).toBe('0.333333');
    // 2 / 3 = 0.6666... -> rounds to 0.666667
    expect(formatDecimal(divideDecimal(parseDecimal('2'), parseDecimal('3')))).toBe('0.666667');
  });

  it('handles a negative numerator or denominator, sign of the result follows normal division', () => {
    expect(formatDecimal(divideDecimal(parseDecimal('-9'), parseDecimal('3')))).toBe('-3.000000');
    expect(formatDecimal(divideDecimal(parseDecimal('9'), parseDecimal('-3')))).toBe('-3.000000');
    expect(formatDecimal(divideDecimal(parseDecimal('-9'), parseDecimal('-3')))).toBe('3.000000');
  });

  it('throws on division by zero rather than returning Infinity', () => {
    expect(() => divideDecimal(parseDecimal('1'), parseDecimal('0'))).toThrow(/division by zero/);
  });
});

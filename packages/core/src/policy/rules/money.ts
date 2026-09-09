/**
 * Decimal-string arithmetic the policy needs beyond what `ledger/decimal.ts` exports (parse,
 * format, subtract, max, divide — no multiply). This file adds only the one missing primitive
 * (`mulDecimal`) plus a tiny percent helper built on it; it does not reimplement parsing or
 * formatting, and mirrors `decimal.ts`'s private scale (10^6, matching `numeric(18,6)`) and its
 * "round half away from zero" rule so a value behaves identically through either module.
 *
 * `ScaledDecimal` is `bigint` end to end — see `ledger/decimal.ts` — so ordinary bigint
 * comparison operators (`<`, `>=`, ...) are used directly wherever the policy compares two
 * money/rate values; no separate compare helper is needed.
 */
import { divideDecimal, parseDecimal, type ScaledDecimal } from '../../ledger/decimal.js';

const SCALE = 10n ** 6n;
const HUNDRED: ScaledDecimal = parseDecimal('100');

/**
 * Multiplies two `ScaledDecimal`s, rounding half-away-from-zero at the 6th decimal place —
 * `decimal.ts`'s `divideDecimal` uses the same rounding rule, kept consistent on purpose.
 */
export function mulDecimal(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  const negative = a < 0n !== b < 0n;
  const magnitude = (a < 0n ? -a : a) * (b < 0n ? -b : b);
  const scaled = magnitude / SCALE;
  const remainder = magnitude % SCALE;
  const rounded = remainder * 2n >= SCALE ? scaled + 1n : scaled;
  return negative && rounded !== 0n ? -rounded : rounded;
}

/** Converts a whole-percent `ScaledDecimal` (e.g. "35" meaning 35%) to a 0..1 fraction. */
export function percentToFraction(pct: ScaledDecimal): ScaledDecimal {
  return divideDecimal(pct, HUNDRED);
}

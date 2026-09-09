/**
 * Exact decimal-string arithmetic for money and token-amount fields (T-011, ADR-002).
 *
 * ADR-002: "Money columns are numeric(18,6) in Postgres and TEXT decimal strings in SQLite,
 * converted at the repository boundary, never floats in storage." This module is that
 * boundary's arithmetic: every money value is represented as a BigInt scaled by 10^6 (six
 * decimal places, matching numeric(18,6)) so add/subtract/compare/divide never touch an
 * IEEE-754 double — the classic 0.1 + 0.2 drift is structurally impossible here.
 *
 * Callers pass and receive plain decimal strings (`"12.340000"`, `"0"`, `"-3.5"`); this module
 * is the only place that parses one into a BigInt or formats a BigInt back into one.
 */

const MONEY_DP = 6;
const SCALE = 10n ** BigInt(MONEY_DP);

/** A money/percentage/rate value scaled by 10^6, per numeric(18,6) — see schema.ts. */
export type ScaledDecimal = bigint;

const DECIMAL_STRING_RE = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;

/**
 * Parses a decimal string (at most 6 fractional digits — numeric(18,6)'s scale) into a
 * `ScaledDecimal`. Throws on anything that isn't exactly that shape, including a value with
 * more than 6 decimal digits: silently truncating extra precision would be exactly the kind
 * of quiet data loss ADR-002 exists to prevent, so it's rejected instead.
 */
export function parseDecimal(input: string): ScaledDecimal {
  const match = DECIMAL_STRING_RE.exec(input.trim());
  if (!match) {
    throw new Error(
      `invalid decimal string (expected up to ${MONEY_DP} dp): ${JSON.stringify(input)}`,
    );
  }
  const [, sign, intPart, fracPartRaw] = match;
  const fracPart = (fracPartRaw ?? '').padEnd(MONEY_DP, '0');
  const magnitude = BigInt(intPart as string) * SCALE + BigInt(fracPart);
  return sign === '-' && magnitude !== 0n ? -magnitude : magnitude;
}

/** Formats a `ScaledDecimal` back into a fixed 6-dp decimal string, e.g. `"12.340000"`. */
export function formatDecimal(value: ScaledDecimal): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / SCALE;
  const fracPart = abs % SCALE;
  const fracStr = fracPart.toString().padStart(MONEY_DP, '0');
  return `${negative ? '-' : ''}${intPart.toString()}.${fracStr}`;
}

/**
 * Validates and re-normalizes a money decimal string to a fixed 6-dp string (`"10"` ->
 * `"10.000000"`), or passes `null`/`undefined` through as `null`. This is the boundary
 * conversion the repositories apply to every money field before it reaches either driver.
 */
export function normalizeMoney(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  return formatDecimal(parseDecimal(input));
}

const TOKEN_AMOUNT_RE = /^-?\d+$/;

/**
 * Validates a token-amount decimal string (numeric(30,0) — an exact integer, no fractional
 * part, on-chain token balances) and passes it through unchanged. `null`/`undefined` -> `null`.
 */
export function normalizeTokenAmount(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (!TOKEN_AMOUNT_RE.test(trimmed)) {
    throw new Error(`invalid token amount (expected an integer string): ${JSON.stringify(input)}`);
  }
  return trimmed;
}

export function subDecimal(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  return a - b;
}

export function maxDecimal(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  return a > b ? a : b;
}

/**
 * Divides two `ScaledDecimal`s and returns a `ScaledDecimal` (i.e. the mathematical quotient,
 * itself re-scaled by 10^6), rounded half-away-from-zero at the 6th decimal place. Throws on
 * division by zero — callers are expected to have already applied an ε floor (FR-1.3) to the
 * denominator before calling this.
 */
export function divideDecimal(numerator: ScaledDecimal, denominator: ScaledDecimal): ScaledDecimal {
  if (denominator === 0n) {
    throw new Error('divideDecimal: division by zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const scaledNumerator = n * SCALE;
  const quotient = scaledNumerator / d;
  const remainder = scaledNumerator % d;
  // Round half away from zero: bump up when the remainder is at least half of the divisor.
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative && rounded !== 0n ? -rounded : rounded;
}

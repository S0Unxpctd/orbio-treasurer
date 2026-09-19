/**
 * PRD FR-4.4's default `PolicyConfig`. Every value here matches the PRD number exactly where
 * one is given. Where the PRD leaves a number unspecified, the conservative default chosen is
 * documented below and in tasks/T-015.md Discovered — never a number tuned to enable live
 * money (CLAUDE.md rule 5: caps here only change with a ticket So has written "ok live" in).
 *
 * All overridable per agent in `treasurer.config.ts` — this module only supplies the fallback.
 */
import { DEFAULT_EPSILON_USD_PER_DAY } from '../ledger/metrics.js';
import type { PolicyConfig } from './types.js';

export const DEFAULT_POLICY: PolicyConfig = {
  comfortableDays: '7',
  tightDays: '3',
  maxBuyUsdPerDay: '10',
  maxStakeUsdPerDay: '10',
  minSwapUsd: '5',
  stakePaybackMaxDays: '30',
  maxSlippagePct: '1.5',
  maxSpendUsdPerDay: '15',
  mode: 'dry_run',
  // FR-11.2's default stable-balance floor a stake option must not dip below.
  stableReserveUsd: '5',
  // FR-4.8's default minimum book discount for a predictive prebuy.
  prebuyMinDiscountPct: '25',
  // Not given a number by FR-4.8 ("credits_available − reserve"). Defaulting to 0 is the
  // conservative choice: the full forecast must be coverable from credits alone before prebuy
  // is skipped, so this never under-buys relative to what the PRD's formula intends. See
  // tasks/T-015.md Discovered.
  prebuyReserveUsd: '0',
  // Reused from ledger/metrics.ts, not redefined — the same ε backs §10's payback_days floor.
  epsilonUsdPerDay: DEFAULT_EPSILON_USD_PER_DAY,
};

// --- S-05: buyAndActivate gates (docs/PRD-1.0-sprint.md §4 T-5, §6; tasks/S-05.md "In scope") --
//
// A different money path from the `DEFAULT_POLICY` above (S-05's on-chain book buy, not the
// older T-015 deficit/prebuy engine) with its own PRD-given numbers. Kept as bare constants
// here, not as functions or a config object, per CLAUDE.md rule 3: `policy/**` stays pure — the
// env-override arithmetic and every bit of I/O around these live in `chain/buy.ts`
// (`resolveBuyCaps()`), which imports these four as its defaults.
//
// Only `BUY_MAX_USDG_PER_TX` and `BUY_MAX_PER_DAY` are true exposure caps — a *smaller* number
// is the safer direction for both, which is exactly what CLAUDE.md rule 5's "overridable only
// downward" is about, and `resolveBuyCaps()` enforces that for these two only. For
// `MIN_DISCOUNT_RATIO` and `SLIPPAGE_BPS` the safer direction runs the other way (a *lower*
// minimum discount or a *higher* slippage tolerance is what would be risky) — so neither has an
// env override at all; changing either needs a new ticket with So's `ok live`, same as any other
// PRD number, never an env var flipped in production.

/** PRD §4 T-5 / §6: max USDG spent per `buyCredit()` call. Decimal string, USDG units (not raw
 *  atoms) — same string style as `DEFAULT_POLICY`'s money fields above. */
export const BUY_MAX_USDG_PER_TX = '10';

/** PRD §4 T-5 / §6: max number of *executed* (non-dry-run) buys per UTC calendar day. */
export const BUY_MAX_PER_DAY = 1;

/** PRD §4 T-5: refuse a quote whose discount is under 10% (`creditOut / usdgIn < 1.10`). */
export const MIN_DISCOUNT_RATIO = 1.1;

/** S-05 "In scope": the slippage guard behind `minCreditOut = floor(quote.creditOut × 0.98)` —
 *  200 bps is exactly that 2% haircut (10000 − 200 = 9800 ⇒ × 0.98). */
export const SLIPPAGE_BPS = 200;

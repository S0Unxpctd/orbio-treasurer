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

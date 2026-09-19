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

// --- S-04: settle -> claim -> activate gates (docs/PRD-1.0-sprint.md §3, §4 T-4, §6;
// tasks/S-04.md "In scope") --
//
// A bare constant, not a function or part of `DEFAULT_POLICY` above, per CLAUDE.md rule 3:
// `policy/**` stays pure — the env-override arithmetic and all I/O around this live in
// `chain/claim.ts` (`resolveClaimCaps()`), which imports this as its default. This is a true
// exposure cap (a *smaller* number is always the safer direction, CLAUDE.md rule 5) — the only
// one S-04 has — so it's the only one `resolveClaimCaps()` restricts to downward-only env
// overrides, exactly like S-05's `BUY_MAX_USDG_PER_TX`/`BUY_MAX_PER_DAY` restrict theirs.

/** PRD §4 T-4 / §6: max CREDIT activated (minted onto the Orbio API balance) per UTC calendar
 *  day, across whichever activate leg ran (the staker-key auto flow's `activate()`, or the
 *  manual-fallback's hot-wallet `activate()`) — one shared daily budget, not per-leg. Decimal
 *  string, CREDIT units (6 dp) — `"50"` → `50_000_000n` atoms via `ledger/decimal.ts`'s
 *  `parseDecimal`, matching PRD §4 T-4's literal "default 50 CREDIT = 50e6 atoms". */
export const ACTIVATE_MAX_PER_DAY = '50';

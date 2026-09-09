/**
 * DEFICIT funding option selection (FR-4.3, PRD §10). Computes `need`, the available
 * `BUY_CREDIT` / `STAKE_UP` options (respecting caps, reserves and the payback gate), and picks
 * between them.
 *
 * Audit-1 M2 (orchestrator arbitration, PRD wins): §10's literal line —
 *
 *   "else: pick BUY_CREDIT if present and need can be covered today, else STAKE_UP
 *    (rationale: credit closes the gap now; stake closes it over payback_days)"
 *
 * — is implemented exactly: `pickDeficitOption` below picks BUY_CREDIT only when it is present
 * *and* its (cap-limited) amount fully covers `need`; otherwise STAKE_UP if it is present
 * (already gated by its own caps, reserve and `payback_days ≤ stake_payback_max_days` in
 * `computeStakeOption`); otherwise the caller (`evaluate.ts`) falls back to SIGNAL_FUND — even
 * when a non-covering BUY_CREDIT option exists but STAKE_UP doesn't qualify either, per this
 * same line (nothing in §10 says to fall back to a partial buy).
 *
 * §10 does not specify a cost comparison between BUY_CREDIT and STAKE_UP beyond this ordering
 * plus STAKE_UP's own payback gate — no such comparison is added here. ADR-003's "the policy
 * chooses between buying credit ... and staking ... by cost" is read as satisfied by that gate:
 * STAKE_UP is cost-bounded by `stake_payback_max_days` (a option whose payback is too slow is
 * cost-rejected before it ever reaches `pickDeficitOption`), while BUY_CREDIT has no
 * PRD-specified cost ceiling of its own beyond fully covering `need`. See tasks/T-015.md Build
 * notes ("Fixes after audit 1") for the full arbitration.
 */
import {
  divideDecimal,
  formatDecimal,
  maxDecimal,
  parseDecimal,
  subDecimal,
} from '../../ledger/decimal.js';
import type { ActionPayload, EvaluateInput } from '../types.js';
import { mulDecimal, percentToFraction } from './money.js';

const ONE = parseDecimal('1');
const ZERO = 0n;

export interface DeficitOption {
  readonly ruleId: 'R-BUY-1' | 'R-STAKE-1';
  readonly action: Extract<ActionPayload, { kind: 'BUY_CREDIT' | 'STAKE_UP' }>;
}

/** `need = tight_days * burn - credits_available`, floored at 0 (§10). */
export function computeNeedUsd(input: EvaluateInput): string {
  const tightDays = parseDecimal(input.policy.tightDays);
  const burn = parseDecimal(input.burnRateUsdPerDay);
  const credits = parseDecimal(input.creditsAvailableUsd);
  return formatDecimal(maxDecimal(subDecimal(mulDecimal(tightDays, burn), credits), ZERO));
}

function computeBuyOption(input: EvaluateInput, needScaled: bigint): DeficitOption | null {
  if (!input.book.buyAvailable || input.book.depthAtBestUsd === null) return null;
  const depth = parseDecimal(input.book.depthAtBestUsd);
  if (depth < ONE) return null;

  const budget = subDecimal(
    parseDecimal(input.policy.maxBuyUsdPerDay),
    parseDecimal(input.caps.boughtTodayUsd),
  );
  if (budget < ONE) return null;

  const usd = needScaled < budget ? needScaled : budget;
  const bestDiscountPct =
    input.book.bestDiscountPct === null ? ZERO : parseDecimal(input.book.bestDiscountPct);
  const costPerUsd = subDecimal(ONE, percentToFraction(bestDiscountPct));

  return {
    ruleId: 'R-BUY-1',
    action: { kind: 'BUY_CREDIT', usd: formatDecimal(usd), costPerUsd: formatDecimal(costPerUsd) },
  };
}

function computeStakeOption(input: EvaluateInput): DeficitOption | null {
  if (!input.stake.available) return null;

  const stableBalance = parseDecimal(input.stake.stableBalanceUsd);
  const reserve = parseDecimal(input.policy.stableReserveUsd);
  const minSwap = parseDecimal(input.policy.minSwapUsd);
  const spendable = subDecimal(stableBalance, reserve);
  if (spendable < minSwap) return null;

  const capBudget = subDecimal(
    parseDecimal(input.policy.maxStakeUsdPerDay),
    parseDecimal(input.caps.stakedTodayUsd),
  );
  const budget = capBudget < spendable ? capBudget : spendable;
  if (budget < minSwap) return null;

  const orbioPrice = parseDecimal(input.stake.orbioPriceUsd);
  const yieldPerToken = parseDecimal(input.stake.yieldPerTokenPerDay);
  const epsilon = parseDecimal(input.policy.epsilonUsdPerDay);

  const tokens = orbioPrice <= ZERO ? ZERO : divideDecimal(budget, orbioPrice);
  const addedAccrualPerDay = mulDecimal(tokens, yieldPerToken);
  const paybackDays = divideDecimal(budget, maxDecimal(addedAccrualPerDay, epsilon));
  const paybackMax = parseDecimal(input.policy.stakePaybackMaxDays);
  if (paybackDays > paybackMax) return null;

  return {
    ruleId: 'R-STAKE-1',
    action: {
      kind: 'STAKE_UP',
      usd: formatDecimal(budget),
      paybackDays: formatDecimal(paybackDays),
      yieldLowConfidence: input.stake.yieldLowConfidence,
    },
  };
}

/** All funding options whose adapter is available and whose caps/reserve/payback gate pass. */
export function computeDeficitOptions(input: EvaluateInput): DeficitOption[] {
  const needScaled = parseDecimal(computeNeedUsd(input));
  const options: DeficitOption[] = [];
  const buy = computeBuyOption(input, needScaled);
  if (buy) options.push(buy);
  const stake = computeStakeOption(input);
  if (stake) options.push(stake);
  return options;
}

/**
 * §10's pick, literally: BUY_CREDIT only if present and it fully covers `need`; else STAKE_UP
 * if present; else null (caller emits SIGNAL_FUND). See this module's header comment.
 */
export function pickDeficitOption(options: DeficitOption[], needUsd: string): DeficitOption | null {
  const need = parseDecimal(needUsd);
  const buy = options.find((o) => o.action.kind === 'BUY_CREDIT');
  if (buy && parseDecimal(buy.action.usd) >= need) return buy;
  return options.find((o) => o.action.kind === 'STAKE_UP') ?? null;
}

/**
 * DEFICIT funding option selection (FR-4.3, PRD §10). Computes `need`, the available
 * `BUY_CREDIT` / `STAKE_UP` options (respecting caps, reserves and the payback gate), and picks
 * between them.
 *
 * §10: "pick BUY_CREDIT if present and need can be covered today, else STAKE_UP (rationale:
 * credit closes the gap now; stake closes it over payback_days)." Read literally this could
 * gate the BUY_CREDIT pick on the buy amount alone covering `need`; taken with FR-4.3's ordered
 * list ("Choose the funding action by cost, among the ones whose adapter is available: BUY_CREDIT
 * ... STAKE_UP ...") and the stated rationale (credit is faster than a multi-day payback), this
 * module resolves the ambiguity by preferring BUY_CREDIT whenever it is present in `options` at
 * all — see tasks/T-015.md Discovered.
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

/** §10's pick: BUY_CREDIT whenever present, else STAKE_UP, else null (caller emits SIGNAL_FUND). */
export function pickDeficitOption(options: DeficitOption[]): DeficitOption | null {
  return (
    options.find((o) => o.action.kind === 'BUY_CREDIT') ??
    options.find((o) => o.action.kind === 'STAKE_UP') ??
    null
  );
}

/**
 * FR-4.8 · Predictive prebuy for recurring workloads. Rule `R-PREBUY-1`, evaluated regardless
 * of runway state (it fires "even in COMFORTABLE" per the PRD): if the forecast for the next
 * workload window exceeds what current credits (minus a reserve) will cover, and the book's
 * best discount clears `prebuy_min_discount`, buy the shortfall now — capped by
 * `max_buy_usd_per_day` like any other buy — or signal a manual fund with the amount and
 * deadline when buying isn't available.
 */
import { formatDecimal, parseDecimal, subDecimal } from '../../ledger/decimal.js';
import type { ActionPayload, EvaluateInput } from '../types.js';
import { percentToFraction } from './money.js';

const ONE = parseDecimal('1');
const ZERO = 0n;

export interface PrebuyResult {
  readonly ruleId: 'R-PREBUY-1';
  readonly action: Extract<ActionPayload, { kind: 'BUY_CREDIT' | 'SIGNAL_FUND' }>;
}

/** Returns null when there is no forecast, it's already covered, or the discount is too low —
 *  i.e. whenever R-PREBUY-1 does not fire. */
export function computePrebuy(input: EvaluateInput): PrebuyResult | null {
  const { forecastUsdNextWindow, windowDeadlineLabel } = input.prebuy;
  if (forecastUsdNextWindow === null) return null;

  const forecast = parseDecimal(forecastUsdNextWindow);
  const credits = parseDecimal(input.creditsAvailableUsd);
  const reserve = parseDecimal(input.policy.prebuyReserveUsd);
  const available = subDecimal(credits, reserve);
  if (forecast <= available) return null; // already covered — no rescue needed

  const bestDiscountPct =
    input.book.bestDiscountPct === null ? ZERO : parseDecimal(input.book.bestDiscountPct);
  const minDiscountPct = parseDecimal(input.policy.prebuyMinDiscountPct);
  if (bestDiscountPct < minDiscountPct) return null; // not cheap enough to buy early

  const shortfall = subDecimal(forecast, available);

  if (input.book.buyAvailable) {
    const budget = subDecimal(
      parseDecimal(input.policy.maxBuyUsdPerDay),
      parseDecimal(input.caps.boughtTodayUsd),
    );
    if (budget >= ONE) {
      const usd = shortfall < budget ? shortfall : budget;
      const costPerUsd = subDecimal(ONE, percentToFraction(bestDiscountPct));
      return {
        ruleId: 'R-PREBUY-1',
        action: {
          kind: 'BUY_CREDIT',
          usd: formatDecimal(usd),
          costPerUsd: formatDecimal(costPerUsd),
        },
      };
    }
  }

  return {
    ruleId: 'R-PREBUY-1',
    action: {
      kind: 'SIGNAL_FUND',
      amountUsd: formatDecimal(shortfall),
      deadlineLabel: windowDeadlineLabel,
      reason: 'prebuy_unfunded',
    },
  };
}

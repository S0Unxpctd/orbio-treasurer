/**
 * Runway state (FR-4.2) and hysteresis (FR-4.7), from PRD §10's normative pseudocode:
 *
 *   net_burn = max(burn - accrual, 0)
 *   runway   = net_burn == 0 ? ∞ : credits_available / net_burn
 *   state:   runway ≥ comfortable_days → COMFORTABLE
 *            runway ≥ tight_days       → TIGHT
 *            else                      → DEFICIT
 *
 * `∞` runway is COMFORTABLE (FR-4.2) — represented here as `runwayDays: null`, matching
 * `ledger/metrics.ts`'s convention of never storing the literal string "Infinity".
 */
import {
  divideDecimal,
  formatDecimal,
  maxDecimal,
  parseDecimal,
  subDecimal,
} from '../../ledger/decimal.js';
import type { EvaluateInput, HysteresisInput, PolicyState } from '../types.js';

export interface RawStateResult {
  readonly rawState: PolicyState;
  readonly runwayDays: string | null;
}

export function computeRawState(input: EvaluateInput): RawStateResult {
  const burn = parseDecimal(input.burnRateUsdPerDay);
  const accrual = parseDecimal(input.accrualRateUsdPerDay);
  const credits = parseDecimal(input.creditsAvailableUsd);
  const netBurn = maxDecimal(subDecimal(burn, accrual), 0n);

  if (netBurn === 0n) {
    return { rawState: 'COMFORTABLE', runwayDays: null };
  }

  const runway = divideDecimal(credits, netBurn);
  const comfortableDays = parseDecimal(input.policy.comfortableDays);
  const tightDays = parseDecimal(input.policy.tightDays);

  let rawState: PolicyState;
  if (runway >= comfortableDays) {
    rawState = 'COMFORTABLE';
  } else if (runway >= tightDays) {
    rawState = 'TIGHT';
  } else {
    rawState = 'DEFICIT';
  }
  return { rawState, runwayDays: formatDecimal(runway) };
}

/**
 * FR-4.7: a state change requires two consecutive ticks in the new (raw) state, except entry
 * into DEFICIT, which is immediate. Only entry into DEFICIT skips the debounce — leaving
 * DEFICIT (into TIGHT or COMFORTABLE) still needs the two-tick streak like any other change.
 */
export function computeEffectiveState(
  rawState: PolicyState,
  hysteresis: HysteresisInput,
): PolicyState {
  const { previousEffectiveState, consecutiveRawTicks } = hysteresis;

  if (previousEffectiveState === null) {
    // First tick ever evaluated for this agent: nothing to debounce against.
    return rawState;
  }
  if (rawState === 'DEFICIT') {
    return 'DEFICIT';
  }
  if (rawState === previousEffectiveState) {
    return previousEffectiveState;
  }
  return consecutiveRawTicks >= 2 ? rawState : previousEffectiveState;
}

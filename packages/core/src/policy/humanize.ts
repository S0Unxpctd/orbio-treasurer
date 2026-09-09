/**
 * FR-4.6: "a one-line human string rendered from a template (not an LLM)". Every function here
 * is a pure string template over an already-computed action payload — no formatting decision
 * depends on anything but its argument, so the same action always renders the same sentence.
 *
 * FR-11.4: stake-up is labelled as a purchase of a volatile asset — payback in days with a
 * confidence flag, never an APY figure.
 */
import type { ActionPayload, PolicyState } from './types.js';

const TIER_LABEL: Record<PolicyState, string> = {
  COMFORTABLE: 'frontier',
  TIGHT: 'standard',
  DEFICIT: 'economy',
};

export function humanizeRoute(state: PolicyState): string {
  return `Routing to ${TIER_LABEL[state]} models (state: ${state.toLowerCase()}).`;
}

export function humanizeAlertTight(): string {
  return 'Runway is tight (< comfortable, ≥ tight days) — routing down to standard models.';
}

export function humanizeFunding(
  action: Extract<ActionPayload, { kind: 'BUY_CREDIT' | 'STAKE_UP' }>,
): string {
  if (action.kind === 'BUY_CREDIT') {
    return `Buying $${action.usd} of credit at $${action.costPerUsd} per $1.`;
  }
  const confidence = action.yieldLowConfidence ? ', low-confidence yield estimate' : '';
  return `Staking $${action.usd} into $ORBIO — payback in ${action.paybackDays} days${confidence}. Not an APY.`;
}

export function humanizeSignalFund(
  action: Extract<ActionPayload, { kind: 'SIGNAL_FUND' }>,
): string {
  if (action.reason === 'prebuy_unfunded' && action.deadlineLabel) {
    return `$${action.amountUsd} needed before ${action.deadlineLabel} for the next workload — no automatic funding available.`;
  }
  return `Need $${action.amountUsd} to cover runway — no automatic funding available. Fund manually.`;
}

export function humanizeAlertDeficitUnfunded(): string {
  return 'In deficit with no funding option available — manual top-up needed.';
}

export function humanizeKeyRotate(): string {
  return 'Key invalid or flagged — revoking and rotating to a new key.';
}

export function humanizeTickMissed(
  action: Extract<ActionPayload, { kind: 'ALERT_TICK_MISSED' }>,
): string {
  return `Tick gap of ${action.gapMinutes} min exceeded the 45-min threshold.`;
}

export function humanizeMcpUnavailable(): string {
  return 'Orbio MCP unreachable — balance is now an estimate.';
}

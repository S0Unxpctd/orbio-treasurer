/**
 * evaluate() — the pure policy function (FR-4.1, PRD §10). No I/O, no LLM, no clock: every
 * decision below is a deterministic function of `input` alone, so re-calling `evaluate` with a
 * stored `Decision.inputs` reproduces the same `Decision[]` (FR-4.6, AC3).
 *
 * Order of decisions in the returned array (stable, not load-bearing for correctness, but kept
 * fixed so tests and the property check can compare arrays directly):
 *   ROUTE → [ALERT_TIGHT] → [DEFICIT funding: BUY_CREDIT|STAKE_UP|SIGNAL_FUND[+ALERT_DEFICIT_UNFUNDED]]
 *   → [R-PREBUY-1] → [KEY_ROTATE] → [ALERT_TICK_MISSED] → [MCP_UNAVAILABLE]
 */
import {
  humanizeAlertDeficitUnfunded,
  humanizeAlertTight,
  humanizeFunding,
  humanizeKeyRotate,
  humanizeMcpUnavailable,
  humanizeRoute,
  humanizeSignalFund,
  humanizeTickMissed,
} from './humanize.js';
import { computeKeyRotate, computeMcpUnavailable, computeTickMissed } from './rules/always.js';
import { computeDeficitOptions, computeNeedUsd, pickDeficitOption } from './rules/deficit.js';
import { computePrebuy } from './rules/prebuy.js';
import { computeEffectiveState, computeRawState } from './rules/state.js';
import type { ActionPayload, Decision, EvaluateInput, ModelTier, PolicyState } from './types.js';

const TIER_BY_STATE: Record<PolicyState, ModelTier> = {
  COMFORTABLE: 'frontier',
  TIGHT: 'standard',
  DEFICIT: 'economy',
};

const ROUTE_RULE_ID: Record<PolicyState, string> = {
  COMFORTABLE: 'R-ROUTE-COMFORTABLE',
  TIGHT: 'R-ROUTE-TIGHT',
  DEFICIT: 'R-ROUTE-DEFICIT',
};

export function evaluate(input: EvaluateInput): Decision[] {
  const { rawState } = computeRawState(input);
  const effectiveState = computeEffectiveState(rawState, input.hysteresis);
  const stateBefore = input.hysteresis.previousEffectiveState;
  const enteredState = stateBefore !== effectiveState;

  const decisions: Decision[] = [];
  const emit = (ruleId: string, action: ActionPayload, human: string): void => {
    decisions.push({
      type: action.kind,
      ruleId,
      stateBefore,
      stateAfter: effectiveState,
      inputs: input,
      action,
      human,
    });
  };

  // ROUTE — every tick, per §10 ("COMFORTABLE: ROUTE(frontier)", etc.).
  emit(
    ROUTE_RULE_ID[effectiveState],
    { kind: 'ROUTE', tier: TIER_BY_STATE[effectiveState] },
    humanizeRoute(effectiveState),
  );

  if (effectiveState === 'TIGHT' && enteredState) {
    emit('R-ALERT-TIGHT', { kind: 'ALERT_TIGHT' }, humanizeAlertTight());
  }

  if (effectiveState === 'DEFICIT') {
    const options = computeDeficitOptions(input);
    const chosen = pickDeficitOption(options);

    if (chosen) {
      emit(chosen.ruleId, chosen.action, humanizeFunding(chosen.action));
    } else {
      const action: ActionPayload = {
        kind: 'SIGNAL_FUND',
        amountUsd: computeNeedUsd(input),
        deadlineLabel: null,
        reason: 'deficit_unfunded',
      };
      emit('R-SIGNAL-1', action, humanizeSignalFund(action));
      if (enteredState) {
        emit(
          'R-ALERT-DEFICIT-UNFUNDED',
          { kind: 'ALERT_DEFICIT_UNFUNDED' },
          humanizeAlertDeficitUnfunded(),
        );
      }
    }
  }

  // FR-4.8 — evaluated regardless of state, "even in COMFORTABLE".
  const prebuy = computePrebuy(input);
  if (prebuy) {
    const human =
      prebuy.action.kind === 'BUY_CREDIT'
        ? humanizeFunding(prebuy.action)
        : humanizeSignalFund(prebuy.action);
    emit(prebuy.ruleId, prebuy.action, human);
  }

  const keyRotate = computeKeyRotate(input);
  if (keyRotate) emit(keyRotate.ruleId, keyRotate.action, humanizeKeyRotate());

  const tickMissed = computeTickMissed(input);
  if (tickMissed) {
    emit(
      tickMissed.ruleId,
      tickMissed.action,
      humanizeTickMissed(
        tickMissed.action as Extract<ActionPayload, { kind: 'ALERT_TICK_MISSED' }>,
      ),
    );
  }

  const mcpUnavailable = computeMcpUnavailable(input);
  if (mcpUnavailable) emit(mcpUnavailable.ruleId, mcpUnavailable.action, humanizeMcpUnavailable());

  return decisions;
}

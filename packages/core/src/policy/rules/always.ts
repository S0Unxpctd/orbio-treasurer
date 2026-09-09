/**
 * The "always" rules from PRD §10's tail line — independent of runway state:
 *
 *   if key invalid → KEY_ROTATE ; if tick gap > 45min → ALERT_TICK_MISSED ;
 *   if mcp unreachable → MCP_UNAVAILABLE (once per entry), balance_source = gateway|estimate
 */
import type { ActionPayload, EvaluateInput } from '../types.js';

export interface AlwaysResult {
  readonly ruleId: string;
  readonly action: ActionPayload;
}

export function computeKeyRotate(input: EvaluateInput): AlwaysResult | null {
  if (input.keyStatus.valid) return null;
  return { ruleId: 'R-KEY-ROTATE', action: { kind: 'KEY_ROTATE' } };
}

/** > 45 min (FR-10.2's `ALERT_TICK_MISSED` threshold), fires every tick the gap stays over it —
 *  §10 states this condition plainly, with no "once per entry" qualifier unlike MCP_UNAVAILABLE. */
export function computeTickMissed(input: EvaluateInput): AlwaysResult | null {
  const { gapMinutes } = input.tick;
  if (gapMinutes === null || gapMinutes <= 45) return null;
  return { ruleId: 'R-ALERT-TICK-MISSED', action: { kind: 'ALERT_TICK_MISSED', gapMinutes } };
}

/** "once per state entry": fires only on the tick the MCP first becomes unreachable, not on
 *  every subsequent tick it stays unreachable. */
export function computeMcpUnavailable(input: EvaluateInput): AlwaysResult | null {
  const { mcpReachable, mcpPreviouslyReachable } = input.tick;
  if (mcpReachable) return null;
  const isEntry = mcpPreviouslyReachable === null || mcpPreviouslyReachable === true;
  if (!isEntry) return null;
  return { ruleId: 'R-MCP-UNAVAILABLE', action: { kind: 'MCP_UNAVAILABLE' } };
}

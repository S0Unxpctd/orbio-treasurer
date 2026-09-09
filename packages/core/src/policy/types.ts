/**
 * Policy engine types (T-015, PRD FR-4.1..FR-4.8, FR-11.3, §10).
 *
 * Pure input/output shapes only — nothing here does I/O (CLAUDE.md rule 3). Money, rate and
 * day-count fields are decimal strings (see `../ledger/decimal.ts`), never `number`, matching
 * how they are stored (`numeric(18,6)` / TEXT — ADR-002).
 *
 * `evaluate()` never reads a clock. Every time-shaped fact a rule needs — the gap since the
 * previous tick, whether the MCP was reachable last tick, how many consecutive ticks the raw
 * runway state has held — is a field the caller (the executor, T-016) computes from the ledger
 * and passes in here, so a stored `Decision.inputs` object re-evaluates byte-for-byte (FR-4.6).
 */

/** Decimal string — see `ledger/decimal.ts`. Never a float. */
export type Money = string;

export type PolicyState = 'COMFORTABLE' | 'TIGHT' | 'DEFICIT';

export type ModelTier = 'frontier' | 'standard' | 'economy';

// --- policy configuration (FR-4.4) -----------------------------------------------------------

export interface PolicyConfig {
  readonly comfortableDays: Money;
  readonly tightDays: Money;
  readonly maxBuyUsdPerDay: Money;
  readonly maxStakeUsdPerDay: Money;
  readonly minSwapUsd: Money;
  readonly stakePaybackMaxDays: Money;
  /** FR-11.2's slippage guard — carried here so one config object round-trips through
   *  `treasurer.config.ts`, but not consumed by `evaluate()` itself (that guard lives at the
   *  stake executor, against the live quote, per ADR-003 / FR-11.2). */
  readonly maxSlippagePct: Money;
  /** FR-3.4's daily spend cap — carried here for the same reason; enforced by
   *  `treasurer.model()`, not by `evaluate()`. */
  readonly maxSpendUsdPerDay: Money;
  readonly mode: 'dry_run' | 'live';
  /** FR-11.2 default 5 — the stable balance floor a stake option must not dip below. */
  readonly stableReserveUsd: Money;
  /** FR-4.8 default 25 (whole percent, e.g. "25" = 25%) — minimum book discount for a
   *  predictive prebuy. */
  readonly prebuyMinDiscountPct: Money;
  /**
   * The "reserve" FR-4.8 subtracts from `credits_available` before comparing to the forecast
   * (`forecast_usd_next_window > credits_available − reserve`). The PRD does not give this a
   * number — see tasks/T-015.md Discovered for the conservative default chosen (0, i.e. the
   * forecast must be fully covered by credits alone before prebuy is skipped).
   */
  readonly prebuyReserveUsd: Money;
  /** Reused verbatim from `ledger/metrics.ts` (`DEFAULT_EPSILON_USD_PER_DAY`) — do not
   *  redefine; §10's payback_days floor and this ledger ε are the same constant. */
  readonly epsilonUsdPerDay: Money;
}

// --- evaluate() inputs ------------------------------------------------------------------------

export interface BookViewInput {
  /** `capabilities.buy` on the active `BookClient` (FR-5.1). */
  readonly buyAvailable: boolean;
  /** Whole percent (e.g. "35" = 35%), null when no book data exists (FR-5.2). */
  readonly bestDiscountPct: Money | null;
  readonly depthAtBestUsd: Money | null;
}

export interface StakeInput {
  /** `capabilities.stake` — gated by probe P-7 and ADR-003 upstream of this input. */
  readonly available: boolean;
  readonly stableBalanceUsd: Money;
  readonly orbioPriceUsd: Money;
  /** FR-11.3 — the agent's own measured accrual per held token/day, or a network-wide
   *  fallback flagged via `yieldLowConfidence`. */
  readonly yieldPerTokenPerDay: Money;
  readonly yieldLowConfidence: boolean;
}

export interface DailyCapsInput {
  readonly boughtTodayUsd: Money;
  readonly stakedTodayUsd: Money;
}

export interface KeyStatusInput {
  readonly valid: boolean;
}

export interface TickHealthInput {
  /** Minutes since the previous tick; null on the agent's very first tick. */
  readonly gapMinutes: number | null;
  readonly mcpReachable: boolean;
  /** Whether the MCP was reachable on the previous tick; null when there is no previous tick
   *  to compare against (so an unreachable MCP now always counts as a fresh entry). */
  readonly mcpPreviouslyReachable: boolean | null;
}

export interface HysteresisInput {
  /** The *effective* (already-debounced) state as of the previous tick; null on the first
   *  tick ever evaluated for this agent. */
  readonly previousEffectiveState: PolicyState | null;
  /** Consecutive ticks, including this one, that the *raw* runway-derived state has equalled
   *  this tick's raw state. 1 on the tick the raw state first changes. */
  readonly consecutiveRawTicks: number;
}

export interface PrebuyInput {
  /** FR-4.8 `forecast_usd_next_window` — from a declared `workloads[]` schedule or the
   *  trailing 7-day same-hour median, computed by the caller. Null when no forecast exists. */
  readonly forecastUsdNextWindow: Money | null;
  /** Human label for the deadline, e.g. "Monday 06:00" (FR-4.8's example sentence). Only
   *  read when a `SIGNAL_FUND` fallback is emitted for the prebuy shortfall. */
  readonly windowDeadlineLabel: string | null;
}

export interface EvaluateInput {
  readonly creditsAvailableUsd: Money;
  readonly accrualRateUsdPerDay: Money;
  readonly burnRateUsdPerDay: Money;
  readonly book: BookViewInput;
  readonly stake: StakeInput;
  readonly caps: DailyCapsInput;
  readonly keyStatus: KeyStatusInput;
  readonly tick: TickHealthInput;
  readonly hysteresis: HysteresisInput;
  readonly prebuy: PrebuyInput;
  readonly policy: PolicyConfig;
}

// --- decisions (FR-4.6) ------------------------------------------------------------------------

export type SignalFundReason = 'deficit_unfunded' | 'prebuy_unfunded';

export type ActionPayload =
  | { readonly kind: 'ROUTE'; readonly tier: ModelTier }
  | { readonly kind: 'ALERT_TIGHT' }
  | { readonly kind: 'BUY_CREDIT'; readonly usd: Money; readonly costPerUsd: Money }
  | {
      readonly kind: 'STAKE_UP';
      readonly usd: Money;
      readonly paybackDays: Money;
      readonly yieldLowConfidence: boolean;
    }
  | {
      readonly kind: 'SIGNAL_FUND';
      readonly amountUsd: Money;
      readonly deadlineLabel: string | null;
      readonly reason: SignalFundReason;
    }
  | { readonly kind: 'ALERT_DEFICIT_UNFUNDED' }
  | { readonly kind: 'KEY_ROTATE' }
  | { readonly kind: 'ALERT_TICK_MISSED'; readonly gapMinutes: number }
  | { readonly kind: 'MCP_UNAVAILABLE' };

export type ActionType = ActionPayload['kind'];

/**
 * FR-4.6: every decision carries the rule that fired, state before/after, the exact numeric
 * inputs, the action payload, and a template-rendered human string — enough to re-derive it by
 * calling `evaluate(decision.inputs)` again (AC3).
 */
export interface Decision {
  readonly type: ActionType;
  readonly ruleId: string;
  readonly stateBefore: PolicyState | null;
  readonly stateAfter: PolicyState;
  readonly inputs: EvaluateInput;
  readonly action: ActionPayload;
  readonly human: string;
}

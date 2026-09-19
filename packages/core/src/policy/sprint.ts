/**
 * `decide()` — the Sprint 1.0 tick's policy function (S-06, docs/PRD-1.0-sprint.md §1 "the
 * loop", §4 T-6, §6; tasks/S-06.md "In scope"). PURE, per CLAUDE.md rule 3: no I/O, no reading
 * the system clock directly (`now` is a parameter), no env read — `runTick()` (`tick/tick.ts`)
 * is the only caller and does every read/write around this.
 *
 * T-015's older `evaluate()` engine (`policy/evaluate.ts` + `policy/types.ts`) is superseded by
 * this file, per the ticket: "keep the existing T-015 engine untouched, it is superseded — do
 * not delete, do not call". Nothing in this file imports from `evaluate.ts`/`types.ts`/
 * `rules/**`/`humanize.ts`, and nothing there imports from here.
 *
 * Three steps, in order:
 *  1. `computeRunwayDays()` — `available / burnDaily`, with the ticket's own ∞-as-999 rule.
 *  2. `computeMode()` — the three-way runway threshold (`RUNWAY_ECO_DAYS`/`RUNWAY_CRITICAL_DAYS`).
 *  3. Zero or more actions, in the ticket's fixed order — `claim_activate`, then `buy`, then
 *     `stakeup` — each carrying `{reason, inputs}` so the whole decision can be re-derived from
 *     `action.inputs` alone (FR-4.6 spirit, ticket's own wording), independent of `live`: `decide()`
 *     is live-agnostic (AC1) — every action it would emit live, it emits in dry-run too; only the
 *     tick's executors (`tick/executors.ts`) turn "would buy" into an actual dry-run vs. a real
 *     send, from `input.live` (recorded on every action's `inputs`, never branched on here).
 */
import type { ChainSnapshot } from '../chain/read.js';
import {
  divideDecimal,
  formatDecimal,
  multiplyDecimal,
  parseDecimal,
  subDecimal,
} from '../ledger/decimal.js';
import { DEFAULT_EPSILON_USD_PER_DAY } from '../ledger/metrics.js';
import type { Mode } from '../router/types.js';
import {
  BUY_MAX_USDG_PER_TX,
  RUNWAY_BUY_DAYS,
  RUNWAY_CRITICAL_DAYS,
  RUNWAY_ECO_DAYS,
  STAKEUP_EVERY_CALLS,
  STAKEUP_USDG,
} from './defaults.js';

/** Decimal string — see `ledger/decimal.ts`. Never a float (same convention as `policy/types.ts`). */
export type Money = string;

// --- config -------------------------------------------------------------------------------------

export interface SprintPolicyConfig {
  /** PRD §4 T-5/§6, reused unchanged — the cap `usdg` is sized against (`min(cap, ceil(deficit))`). */
  readonly buyMaxUsdgPerTx: Money;
  readonly stakeupEveryCalls: number;
  readonly stakeupUsdg: Money;
  readonly runwayEcoDays: Money;
  readonly runwayCriticalDays: Money;
  readonly runwayBuyDays: Money;
}

export const DEFAULT_SPRINT_POLICY_CONFIG: SprintPolicyConfig = {
  buyMaxUsdgPerTx: BUY_MAX_USDG_PER_TX,
  stakeupEveryCalls: STAKEUP_EVERY_CALLS,
  stakeupUsdg: STAKEUP_USDG,
  runwayEcoDays: RUNWAY_ECO_DAYS,
  runwayCriticalDays: RUNWAY_CRITICAL_DAYS,
  runwayBuyDays: RUNWAY_BUY_DAYS,
};

// --- decide() inputs ------------------------------------------------------------------------

export interface SprintApiBalance {
  readonly available: Money;
  readonly used: Money;
}

export interface SprintDecideInput {
  readonly snapshot: ChainSnapshot;
  readonly apiBalance: SprintApiBalance;
  /** `ledger/metrics.ts`'s `burnDaily()` output — already ε-floored, so this is never "0". */
  readonly burnDaily: Money;
  readonly callsSinceLastStakeup: number;
  /** *Executed* (non-dry-run, non-refused) buys today (UTC) — echoed into every action's
   *  `inputs` for FR-4.6-style re-derivability; `decide()` itself never gates on it (the day cap
   *  is `buyCredit()`'s own job, per `chain/buy.ts`'s `resolveBuyCaps()` — a capped-out tick
   *  still emits the `buy` action here and the executor turns it into an `alert`, ticket: "blocked
   *  action → alert with the gate reason"). */
  readonly buysToday: number;
  /** Total CREDIT activated today (UTC), decimal string — same "echoed, not gated on" reasoning
   *  as `buysToday` (`ACTIVATE_MAX_PER_DAY` is `claimAndActivate()`'s own gate). */
  readonly activatedToday: Money;
  /** CREDIT settled/claimable for the staker (`Staking.settledOf`) — one of the three
   *  `claim_activate` triggers, alongside the two on-chain wallet balances already inside
   *  `snapshot`. */
  readonly claimable: Money;
  readonly now: Date;
  /** Recorded verbatim into every action's `inputs.live` — never branched on in this file
   *  (ticket AC1: "the policy is live-agnostic except for `inputs.live` being recorded"). */
  readonly live: boolean;
}

/** JSON-safe mirror of `SprintDecideInput` (`now` as an ISO string) — what actually lands in
 *  every action's `inputs` field, so a stored `Decision`/`treasury_events.meta` round-trips
 *  through `JSON.stringify`/`JSON.parse` without losing anything `decide()` itself read. */
export interface SprintDecideInputSnapshot {
  readonly snapshot: ChainSnapshot;
  readonly apiBalance: SprintApiBalance;
  readonly burnDaily: Money;
  readonly callsSinceLastStakeup: number;
  readonly buysToday: number;
  readonly activatedToday: Money;
  readonly claimable: Money;
  readonly now: string;
  readonly live: boolean;
}

function snapshotInput(input: SprintDecideInput): SprintDecideInputSnapshot {
  return {
    snapshot: input.snapshot,
    apiBalance: input.apiBalance,
    burnDaily: input.burnDaily,
    callsSinceLastStakeup: input.callsSinceLastStakeup,
    buysToday: input.buysToday,
    activatedToday: input.activatedToday,
    claimable: input.claimable,
    now: input.now.toISOString(),
    live: input.live,
  };
}

// --- actions --------------------------------------------------------------------------------

export interface SprintClaimActivateAction {
  readonly kind: 'claim_activate';
  /** `;`-joined, one entry per matched trigger — same convention as `router/route.ts`'s own
   *  `reason` string (`reasonParts.join(';')`). One of `claimable_settled`,
   *  `staker_credit_balance`, `hot_credit_balance`; any subset, in that order. */
  readonly reason: string;
  readonly inputs: SprintDecideInputSnapshot;
}

export interface SprintBuyAction {
  readonly kind: 'buy';
  /** `min(config.buyMaxUsdgPerTx, ceil(deficit))`, decimal string, USDG units. */
  readonly usdg: Money;
  readonly reason: string;
  readonly inputs: SprintDecideInputSnapshot;
}

export interface SprintStakeupAction {
  readonly kind: 'stakeup';
  /** `config.stakeupUsdg` verbatim (S-06: always the fixed amount; S-07 may size this for real). */
  readonly usdg: Money;
  readonly reason: string;
  readonly inputs: SprintDecideInputSnapshot;
}

export type SprintAction = SprintClaimActivateAction | SprintBuyAction | SprintStakeupAction;

export interface SprintDecision {
  readonly mode: Mode;
  readonly runwayDays: Money;
  /** Ticket's fixed order: `claim_activate`, then `buy`, then `stakeup` — zero, one, two or all
   *  three may be present; never more than one of each kind. */
  readonly actions: readonly SprintAction[];
}

// --- runway / mode ----------------------------------------------------------------------------

/** The ticket's own sentinel for "infinite" runway — a `Money` string, never `null`/`Infinity`,
 *  so every consumer (the router's `RouteOpts.mode` cap, the public page) can treat `runwayDays`
 *  as a plain decimal like any other. */
export const INFINITE_RUNWAY_DAYS: Money = formatDecimal(parseDecimal('999'));

/**
 * `available / burnDaily`, decimal strings, per the ticket: "∞ when burn = ε and available > 0
 * → treat as 999". Also treats a burn of exactly 0 (shouldn't happen once `burnDaily()`'s own ε
 * floor has run, but this function must still be total, never throw, given an unexpected 0) the
 * same way, rather than dividing by zero.
 */
export function computeRunwayDays(availableUsd: Money, burnDailyUsd: Money): Money {
  const available = parseDecimal(availableUsd);
  const burn = parseDecimal(burnDailyUsd);
  if (burn <= 0n) return INFINITE_RUNWAY_DAYS;
  const epsilon = parseDecimal(DEFAULT_EPSILON_USD_PER_DAY);
  if (burn === epsilon && available > 0n) return INFINITE_RUNWAY_DAYS;
  // `burn > 0n` here (the `burn <= 0n` check above already excluded zero), so `divideDecimal`'s
  // own division-by-zero throw can never fire.
  return formatDecimal(divideDecimal(available, burn));
}

/** `normal` ≥ `config.runwayEcoDays`; `critical` < `config.runwayCriticalDays`; `eco` in between —
 *  the ticket's exact three-way threshold, boundaries inclusive on the "safer" side of each (a
 *  runway of exactly `runwayEcoDays` is `normal`; exactly `runwayCriticalDays` is `eco`, not
 *  `critical`). */
export function computeMode(runwayDaysStr: Money, config: SprintPolicyConfig): Mode {
  const runway = parseDecimal(runwayDaysStr);
  const eco = parseDecimal(config.runwayEcoDays);
  const critical = parseDecimal(config.runwayCriticalDays);
  if (runway >= eco) return 'normal';
  if (runway >= critical) return 'eco';
  return 'critical';
}

// --- buy sizing -----------------------------------------------------------------------------

const ONE_SCALED = parseDecimal('1');

/** Ceils a `ScaledDecimal` up to the nearest whole unit — `4.000001` -> `5`, `4.000000` -> `4`,
 *  a non-positive value -> `0` (buy sizing never runs on a non-positive deficit; kept total
 *  anyway rather than assuming the caller's guard). Bigint-only, per the audit focus this
 *  mirrors from `chain/buy.ts`'s `minCreditOutFor()`: no float ever touches this number. */
function ceilToWholeUnit(value: bigint): bigint {
  if (value <= 0n) return 0n;
  const remainder = value % ONE_SCALED;
  return remainder === 0n ? value : value + (ONE_SCALED - remainder);
}

// --- decide() ---------------------------------------------------------------------------------

export function decide(input: SprintDecideInput, config: SprintPolicyConfig): SprintDecision {
  const runwayDays = computeRunwayDays(input.apiBalance.available, input.burnDaily);
  const mode = computeMode(runwayDays, config);
  const inputs = snapshotInput(input);

  const actions: SprintAction[] = [];

  // 1. claim_activate — claimable > 0 OR staker CREDIT wallet > 0 OR hot CREDIT wallet > 0.
  const claimReasons: string[] = [];
  if (parseDecimal(input.claimable) > 0n) claimReasons.push('claimable_settled');
  if (BigInt(input.snapshot.creditWalletStaker) > 0n) claimReasons.push('staker_credit_balance');
  if (BigInt(input.snapshot.creditWalletHot) > 0n) claimReasons.push('hot_credit_balance');
  if (claimReasons.length > 0) {
    actions.push({ kind: 'claim_activate', reason: claimReasons.join(';'), inputs });
  }

  // 2. buy — runway < config.runwayBuyDays AND deficit > 1 USDG, where
  //    deficit = runwayBuyDays × burnDaily − available; usdg = min(cap, ceil(deficit)).
  const runwayBuyDaysScaled = parseDecimal(config.runwayBuyDays);
  const runwayScaled = parseDecimal(runwayDays);
  if (runwayScaled < runwayBuyDaysScaled) {
    const targetUsd = multiplyDecimal(runwayBuyDaysScaled, parseDecimal(input.burnDaily));
    const deficitScaled = subDecimal(targetUsd, parseDecimal(input.apiBalance.available));
    if (deficitScaled > ONE_SCALED) {
      const ceiledDeficit = ceilToWholeUnit(deficitScaled);
      const capScaled = parseDecimal(config.buyMaxUsdgPerTx);
      const usdgScaled = ceiledDeficit < capScaled ? ceiledDeficit : capScaled;
      actions.push({
        kind: 'buy',
        usdg: formatDecimal(usdgScaled),
        reason: 'runway_below_buy_threshold',
        inputs,
      });
    }
  }

  // 3. stakeup — callsSinceLastStakeup >= config.stakeupEveryCalls.
  if (input.callsSinceLastStakeup >= config.stakeupEveryCalls) {
    actions.push({
      kind: 'stakeup',
      usdg: formatDecimal(parseDecimal(config.stakeupUsdg)),
      reason: 'stakeup_interval_reached',
      inputs,
    });
  }

  return { mode, runwayDays, actions };
}

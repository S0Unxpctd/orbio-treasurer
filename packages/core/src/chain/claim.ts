/**
 * settle -> claim -> activate — CREDIT earned by the staked ORBIO position reaches the
 * Treasurer's Orbio API balance without a human (S-04, docs/PRD-1.0-sprint.md §3, §4 T-4, §6;
 * tasks/S-04.md "In scope"). MONEY TICKET, gated by CLAUDE.md rule 5: `TREASURER_LIVE` stays
 * unset in this sandbox, there is no private key here, and `executeClaim()`/
 * `executeActivateFromHot()` are exercised only against a fake viem client in tests — nothing
 * in this file can send a transaction on its own. Mirrors S-05's `chain/buy.ts` three-layer
 * shape (pure plan -> narrow-client execute -> ledger-writing orchestrator); shared helpers
 * that shape needs live in `chain/tx.ts`, not in `buy.ts` (untouched — it's on its own branch,
 * mid-fix, per this ticket's instruction).
 *
 * Three flows, per the ticket, chosen by which env vars are set:
 *
 *  - `STAKER_PRIVATE_KEY` set — "staker_key" mode: `settle(periodIds)` (only the ids the caller
 *    resolved via `discoverPeriodsToSettle()`/`STAKING_SETTLE_PERIODS` — never `settle([])`,
 *    which the PRD says isn't allowed) -> `claim()` -> `CREDIT.activate(amount, bytes32(hot))`,
 *    all signed by the staker, so the minted API balance lands on the HOT wallet's key. Fully
 *    automated; `planClaim()` decides `dryRun` from `caps.treasurerLive` like every other gate
 *    in this codebase.
 *  - Only `STAKER_ADDRESS` set (no key) — "manual" mode: read-only. `settledOf`/
 *    `CREDIT.balanceOf(staker)` (plus any periods `discoverPeriodsToSettle()` found unsettled)
 *    decide ONE `alert` treasury event per tick bucket describing the next manual step a human
 *    must take on `robin.etherscan.io`'s write-contract page.
 *  - Independently of the above (needs only `TREASURER_PRIVATE_KEY`) — "hot_activate" leg: if
 *    `CREDIT.balanceOf(hot) > 0` (e.g. a human already ran the manual steps and transferred
 *    CREDIT to hot by hand), `activate(amount)` from the hot wallet itself. This runs whenever
 *    `STAKER_PRIVATE_KEY` is absent — alongside "manual" mode's alert (the ticket's two "if"
 *    checks are independent), or on its own if no staking wallet is configured at all.
 *
 * A single shared `ACTIVATE_MAX_PER_DAY` (policy/defaults.ts) caps whichever leg actually
 * activates, per UTC calendar day, across every leg — never per-leg.
 */
import type { Abi, Account, Address, Hex, TransactionReceipt } from 'viem';
import { parseEther, parseGwei } from 'viem';
import type { Env } from '../env.js';
import { parseDecimal } from '../ledger/decimal.js';
import type { Id, LedgerStore } from '../ledger/types.js';
import { ACTIVATE_MAX_PER_DAY } from '../policy/defaults.js';
import type { ChainAddresses } from './contracts.js';
import { creditAbi, erc20Abi, stakingAbi } from './contracts.js';
import {
  addressToBytes32,
  capRemaining,
  decodeEventFromContract,
  requireSuccessReceipt,
  resolvePositiveNumberEnv,
  sumAtomsForUtcDay,
} from './tx.js';

// --- caps -------------------------------------------------------------------------------------

/** `executeClaim()`/`executeActivateFromHot()`'s `maxFeePerGas` cap, in gwei, when env
 *  `MAX_FEE_GWEI` is unset. Same number and meaning as S-05's `buy.ts` constant of the same
 *  name — duplicated here (never imported from `buy.ts`, per this ticket's "do NOT modify
 *  buy.ts") since it's a plain PRD-given constant, not logic that could drift between copies. */
export const DEFAULT_MAX_FEE_GWEI = 5;

/** `planClaim()`'s minimum HOT-wallet ETH balance for the `hot_activate` leg (one tx: a single
 *  `activate()` call) — same number as S-05's `DEFAULT_MIN_GAS_ETH`, since it's gating the same
 *  wallet for a similarly-sized single tx. */
export const DEFAULT_MIN_GAS_ETH = '0.0005';

/** `planClaim()`'s minimum STAKER-wallet ETH balance for the `staker_key` flow. Not a PRD
 *  number (the PRD doesn't give one — Discovered, tasks/S-04.md) — set to 3x
 *  `DEFAULT_MIN_GAS_ETH` as a conservative estimate covering the flow's worst case, up to three
 *  sequential txs (`settle` + `claim` + `activate`), rather than reusing the single-tx default
 *  and under-covering it. */
export const DEFAULT_STAKER_MIN_GAS_ETH = '0.0015';

export interface ClaimCaps {
  /** Mirrors env `TREASURER_LIVE` (CLAUDE.md rule 5) — `false` in every sandbox run. */
  readonly treasurerLive: boolean;
  /** Raw CREDIT atoms (6 dec). Defaults to `ACTIVATE_MAX_PER_DAY` atoms; env may only lower it —
   *  the one true exposure cap in this file (CLAUDE.md rule 5), shared across every leg. */
  readonly activateMaxPerDayAtoms: bigint;
  /** Raw wei — the HOT wallet's gas floor (`hot_activate` leg only). */
  readonly minGasWeiHot: bigint;
  /** Raw wei — the STAKER wallet's gas floor (`staker_key` flow only). */
  readonly minGasWeiStaker: bigint;
}

export interface ResolveClaimCapsOptions {
  readonly env: Pick<
    Env,
    'TREASURER_LIVE' | 'ACTIVATE_MAX_PER_DAY' | 'MIN_GAS_ETH' | 'STAKER_MIN_GAS_ETH'
  >;
  /** Injectable so tests can assert on the "would raise a cap, ignored" warning without a
   *  console spy. Defaults to `console.error` (biome's noConsole rule allows only 'error'). */
  readonly warn?: (message: string) => void;
}

const DEFAULT_ACTIVATE_MAX_PER_DAY_ATOMS = parseDecimal(ACTIVATE_MAX_PER_DAY);

/**
 * Resolves `ClaimCaps` from env, per CLAUDE.md rule 5: `ACTIVATE_MAX_PER_DAY` may only be
 * LOWERED by its same-named env var — a value that would raise it is ignored and logged (never
 * thrown), same as S-05's `resolveBuyCaps()` treats its two caps. `MIN_GAS_ETH`/
 * `STAKER_MIN_GAS_ETH` are plain overrides (operational tuning, not exposure caps — no
 * directionality restriction).
 */
export function resolveClaimCaps(options: ResolveClaimCapsOptions): ClaimCaps {
  const { env } = options;
  const warn = options.warn ?? ((message: string) => console.error(message));

  let activateMaxPerDayAtoms = DEFAULT_ACTIVATE_MAX_PER_DAY_ATOMS;
  if (env.ACTIVATE_MAX_PER_DAY !== undefined) {
    let envAtoms: bigint | undefined;
    try {
      envAtoms = parseDecimal(env.ACTIVATE_MAX_PER_DAY);
    } catch {
      warn(
        `ACTIVATE_MAX_PER_DAY="${env.ACTIVATE_MAX_PER_DAY}" is not a valid decimal — ignoring, keeping default ${ACTIVATE_MAX_PER_DAY}`,
      );
    }
    if (envAtoms !== undefined) {
      if (envAtoms < DEFAULT_ACTIVATE_MAX_PER_DAY_ATOMS) {
        activateMaxPerDayAtoms = envAtoms;
      } else if (envAtoms > DEFAULT_ACTIVATE_MAX_PER_DAY_ATOMS) {
        warn(
          `ACTIVATE_MAX_PER_DAY="${env.ACTIVATE_MAX_PER_DAY}" would RAISE the default cap (${ACTIVATE_MAX_PER_DAY}) — ignored (CLAUDE.md rule 5: caps only lower via env).`,
        );
      }
      // Equal to the default: no-op, no warning either way.
    }
  }

  const resolveGasWei = (raw: string | undefined, fallback: string, label: string): bigint => {
    const value = raw ?? fallback;
    try {
      return parseEther(value);
    } catch {
      warn(`${label}="${value}" is not a valid decimal — falling back to ${fallback}`);
      return parseEther(fallback);
    }
  };

  return {
    treasurerLive: env.TREASURER_LIVE === true,
    activateMaxPerDayAtoms,
    minGasWeiHot: resolveGasWei(env.MIN_GAS_ETH, DEFAULT_MIN_GAS_ETH, 'MIN_GAS_ETH'),
    minGasWeiStaker: resolveGasWei(
      env.STAKER_MIN_GAS_ETH,
      DEFAULT_STAKER_MIN_GAS_ETH,
      'STAKER_MIN_GAS_ETH',
    ),
  };
}

/** `executeClaim()`/`executeActivateFromHot()`'s `maxFeePerGas` cap (gwei), from env
 *  `MAX_FEE_GWEI` or `DEFAULT_MAX_FEE_GWEI`. */
export function resolveMaxFeeGweiCap(
  env: Pick<Env, 'MAX_FEE_GWEI'>,
  warn: (message: string) => void = (message) => console.error(message),
): number {
  return resolvePositiveNumberEnv(env.MAX_FEE_GWEI, DEFAULT_MAX_FEE_GWEI, 'MAX_FEE_GWEI', warn);
}

// --- planClaim (pure) ---------------------------------------------------------------------------

/** Executed `activate` events (any leg) from today onward, for the shared day-cap check —
 *  `amount` is the raw CREDIT atoms that specific activation minted. */
export interface ClaimHistoryInput {
  readonly activatedToday: readonly { readonly at: string; readonly amount: bigint }[];
}

export type ClaimRefusalReason = 'insufficient_gas_balance';

export interface ClaimRefusal {
  readonly kind: 'refusal';
  readonly reason: ClaimRefusalReason;
  /** Human-readable and secret-free (only ever numbers/counts) — safe straight into a ledger
   *  row's `meta.detail` or a CLI print with no `redact()` pass needed. */
  readonly detail: string;
}

export interface NoOpClaimPlan {
  readonly kind: 'no_op';
  readonly detail: string;
}

export interface SettleClaimActivatePlan {
  readonly kind: 'settle_claim_activate';
  /** `true` whenever `!caps.treasurerLive` — a dry-run plan is exactly what a live one would
   *  have done (same convention as `buy.ts`'s `BuyPlan`). */
  readonly dryRun: boolean;
  /** Ids to pass to `Staking.settle()` — may be empty (skip the settle tx entirely; `claim()`
   *  still runs to mint whatever was already settled from an earlier tick). Never calls
   *  `settle([])` on-chain — an empty array here means "don't call settle at all". */
  readonly periodIds: readonly bigint[];
  /** What `claim()` is expected to mint — `settledCredit` from the input, i.e. the reward
   *  already-settled-but-not-yet-claimed BEFORE this tick's `settle()` call (any newly-settled
   *  periods from `periodIds` become claimable only on the NEXT tick, once `settledOf` reflects
   *  them — this plan does not predict that number). */
  readonly claimAmount: bigint;
  /** `min(creditBalanceStaker + settledCredit, dayCapRemaining)` — capped so the shared daily
   *  activate budget is never exceeded. */
  readonly activateAmount: bigint;
  /** `creditBalanceStaker + settledCredit − activateAmount` — left as a plain CREDIT balance in
   *  the staker wallet (not activated this tick) when the day cap is tighter than what's
   *  available; picked up by a later tick once the day rolls over. */
  readonly remainderAmount: bigint;
}

export type ManualAlertStep = 'settle' | 'claim' | 'transfer';

export interface ManualAlertPlan {
  readonly kind: 'manual_alert';
  readonly step: ManualAlertStep;
  readonly amount: bigint;
}

export interface HotActivatePlan {
  readonly kind: 'hot_activate';
  readonly dryRun: boolean;
  readonly activateAmount: bigint;
  readonly remainderAmount: bigint;
}

export type ClaimPlan =
  | NoOpClaimPlan
  | SettleClaimActivatePlan
  | ManualAlertPlan
  | HotActivatePlan
  | ClaimRefusal;

export type PlanClaimInput =
  | {
      readonly kind: 'staker_key';
      readonly periodIdsToSettle: readonly bigint[];
      readonly settledCredit: bigint;
      readonly creditBalanceStaker: bigint;
      readonly stakerEthWei: bigint;
      readonly caps: ClaimCaps;
      readonly history: ClaimHistoryInput;
      readonly now: Date;
    }
  | {
      readonly kind: 'manual';
      readonly periodIdsToSettle: readonly bigint[];
      readonly settledCredit: bigint;
      readonly creditBalanceStaker: bigint;
    }
  | {
      readonly kind: 'hot_activate';
      readonly creditBalanceHot: bigint;
      readonly hotEthWei: bigint;
      readonly caps: ClaimCaps;
      readonly history: ClaimHistoryInput;
      readonly now: Date;
    };

/**
 * Decides what to do for one of the three flows described at the top of this file. PURE: no
 * I/O, no `Date.now()` (the clock is a parameter), no env read — every input is a plain value,
 * per S-05's `planBuy()` convention this mirrors.
 *
 * Overloaded (rather than a single `input: PlanClaimInput` signature) so a call site passing a
 * literal `{ kind: 'staker_key', ... }` (etc.) gets back only the plan kinds THAT input variant
 * can actually produce, instead of the full 5-member `ClaimPlan` union — `runStakerKeyLeg()`/
 * `runManualLeg()`/`runHotLeg()` below all rely on this to narrow correctly after their own
 * `if (plan.kind === ...)` checks, with no cast anywhere.
 */
export function planClaim(
  input: Extract<PlanClaimInput, { readonly kind: 'staker_key' }>,
): SettleClaimActivatePlan | ClaimRefusal | NoOpClaimPlan;
export function planClaim(
  input: Extract<PlanClaimInput, { readonly kind: 'manual' }>,
): ManualAlertPlan | NoOpClaimPlan;
export function planClaim(
  input: Extract<PlanClaimInput, { readonly kind: 'hot_activate' }>,
): HotActivatePlan | ClaimRefusal | NoOpClaimPlan;
export function planClaim(input: PlanClaimInput): ClaimPlan {
  if (input.kind === 'manual') {
    // Ticket: "read settledOf(staker) and CREDIT.balanceOf(staker); if either > 0, write ONE
    // alert ... {step: 'settle'|'claim'|'transfer', ...}". `periodIdsToSettle` (when the caller
    // supplied any, via the same discovery/env-override path the staker_key flow uses) takes
    // priority — you must settle before you can claim, and claim before you can transfer/
    // activate, so the earliest unfinished pipeline step is always the one reported.
    if (input.periodIdsToSettle.length > 0) {
      return { kind: 'manual_alert', step: 'settle', amount: input.settledCredit };
    }
    if (input.settledCredit > 0n) {
      return { kind: 'manual_alert', step: 'claim', amount: input.settledCredit };
    }
    if (input.creditBalanceStaker > 0n) {
      return { kind: 'manual_alert', step: 'transfer', amount: input.creditBalanceStaker };
    }
    return {
      kind: 'no_op',
      detail: 'nothing to settle, claim or transfer for the staker wallet',
    };
  }

  // Both 'staker_key' and 'hot_activate' share the "compute uncapped amount, apply the shared
  // day cap, decide dryRun" shape below — only what's being activated, and from which wallet,
  // differs.
  const usedTodayAtoms = sumAtomsForUtcDay(input.history.activatedToday, input.now);
  const dayCapRemaining = capRemaining(input.caps.activateMaxPerDayAtoms, usedTodayAtoms);

  if (input.kind === 'hot_activate') {
    if (input.creditBalanceHot === 0n) {
      return { kind: 'no_op', detail: 'CREDIT.balanceOf(hot) is 0 — nothing to activate' };
    }
    // Gas floor checked before the day cap (mirrors buy.ts: every refusal check runs the same
    // way regardless of what the day cap would otherwise allow — a dry run models exactly what
    // a live run would have refused).
    if (input.hotEthWei < input.caps.minGasWeiHot) {
      return {
        kind: 'refusal',
        reason: 'insufficient_gas_balance',
        detail: `hot wallet ETH balance ${input.hotEthWei.toString()} wei is below MIN_GAS_ETH (${input.caps.minGasWeiHot.toString()} wei)`,
      };
    }
    const activateAmount =
      input.creditBalanceHot < dayCapRemaining ? input.creditBalanceHot : dayCapRemaining;
    const remainderAmount = input.creditBalanceHot - activateAmount;
    if (activateAmount === 0n) {
      return {
        kind: 'no_op',
        detail: `ACTIVATE_MAX_PER_DAY already used up today (${usedTodayAtoms.toString()} atoms activated)`,
      };
    }
    return {
      kind: 'hot_activate',
      dryRun: !input.caps.treasurerLive,
      activateAmount,
      remainderAmount,
    };
  }

  // input.kind === 'staker_key'
  const totalClaimable = input.creditBalanceStaker + input.settledCredit;
  if (totalClaimable === 0n && input.periodIdsToSettle.length === 0) {
    return {
      kind: 'no_op',
      detail: 'nothing claimable: settledCredit=0, creditBalanceStaker=0, no unsettled periods',
    };
  }
  if (input.stakerEthWei < input.caps.minGasWeiStaker) {
    return {
      kind: 'refusal',
      reason: 'insufficient_gas_balance',
      detail: `staker wallet ETH balance ${input.stakerEthWei.toString()} wei is below STAKER_MIN_GAS_ETH (${input.caps.minGasWeiStaker.toString()} wei)`,
    };
  }
  const activateAmount = totalClaimable < dayCapRemaining ? totalClaimable : dayCapRemaining;
  const remainderAmount = totalClaimable - activateAmount;
  return {
    kind: 'settle_claim_activate',
    dryRun: !input.caps.treasurerLive,
    periodIds: input.periodIdsToSettle,
    claimAmount: input.settledCredit,
    activateAmount,
    remainderAmount,
  };
}

// --- period discovery ---------------------------------------------------------------------------

/** The minimal read-only viem surface period discovery needs. A subset of `ClaimExecClient`
 *  below (every `ClaimExecClient` satisfies this). */
export interface ClaimReadClient {
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/** PRD §3/tasks/S-04.md: "binary search on `rewardOf(staker, id) > 0` within the last 168 ids". */
export const DISCOVERY_MAX_PERIODS_BACK = 168;

export interface DiscoverLatestPeriodIdOptions {
  /** `STAKING_LAST_PERIOD_HINT`, if any — a period id already known to exist, purely to save
   *  round-trips. Discovery is correct without it (falls back to starting from id 1). */
  readonly hint?: bigint;
}

/**
 * Finds the highest period id `Staking.rewardPeriod(id)` answers without reverting — the same
 * "a revert means the period doesn't exist yet" signal docs/api-notes.md's "S-04 period
 * discovery" probe used by hand on 2026-09-19 (ids 1..82 existed, id 0 and 83+ reverted).
 * `rewardPeriod` is the ticket-specified, verified-shape selector (PRD §3); `genesisTime()`/
 * `currentPeriodStart()` are never called (unverified, per the ticket).
 *
 * Exponential search upward from `options.hint` (or id 1) for a known-missing upper bound, then
 * binary search the gap — O(log n) calls, same asymptotic shape as the ticket's "binary search"
 * wording. Returns `null` only if id 1 itself doesn't exist yet (the contract has created no
 * periods at all).
 */
export async function discoverLatestPeriodId(
  client: ClaimReadClient,
  addresses: ChainAddresses,
  options: DiscoverLatestPeriodIdOptions = {},
): Promise<bigint | null> {
  const exists = async (id: bigint): Promise<boolean> => {
    try {
      await client.readContract({
        address: addresses.staking,
        abi: stakingAbi,
        functionName: 'rewardPeriod',
        args: [id],
      });
      return true;
    } catch {
      return false;
    }
  };

  let low = options.hint && options.hint > 0n ? options.hint : 1n;
  if (!(await exists(low))) {
    if (low === 1n) return null;
    // The hint itself doesn't exist (too high, or stale) — walk down to find a real floor
    // rather than assuming no periods exist at all from one miss.
    let probe = low - 1n;
    let found: bigint | null = null;
    while (probe >= 1n) {
      if (await exists(probe)) {
        found = probe;
        break;
      }
      probe -= 1n;
    }
    if (found === null) return null;
    low = found;
  }

  // Exponential search: `low` exists, double `high` until it doesn't.
  let high = low + 1n;
  while (await exists(high)) {
    low = high;
    high = low * 2n;
  }

  // Binary search the (low, high) gap: low exists, high doesn't.
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n;
    if (await exists(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

export interface DiscoverPeriodsToSettleOptions extends DiscoverLatestPeriodIdOptions {
  readonly maxPeriodsBack?: number;
}

/**
 * Returns every period id in the last `maxPeriodsBack` (default `DISCOVERY_MAX_PERIODS_BACK`,
 * PRD's "168") existing ids for which `rewardOf(staker, id) > 0` — i.e. periods with an
 * unsettled reward for `staker`, exactly what `Staking.settle()` needs. Ascending order.
 *
 * Deliberately a bounded LINEAR scan of the window, not a binary search ON `rewardOf` itself —
 * unlike `discoverLatestPeriodId()`'s existence check (monotonic: ids exist up to a boundary,
 * then stop existing), `rewardOf(staker, id) > 0` has no such monotonic structure across ids
 * (a staker's weight varies period to period, so "unsettled" ids are scattered, not a
 * contiguous prefix/suffix) — a binary search would silently miss ids a linear scan of the same
 * bounded window catches. The ticket's "binary search" phrasing is satisfied by
 * `discoverLatestPeriodId()` above, which this function uses to find the window's upper bound.
 */
export async function discoverPeriodsToSettle(
  client: ClaimReadClient,
  addresses: ChainAddresses,
  staker: Address,
  options: DiscoverPeriodsToSettleOptions = {},
): Promise<readonly bigint[]> {
  const latest = await discoverLatestPeriodId(client, addresses, options);
  if (latest === null) return [];
  const maxBack = BigInt(options.maxPeriodsBack ?? DISCOVERY_MAX_PERIODS_BACK);
  const floor = latest - maxBack + 1n > 1n ? latest - maxBack + 1n : 1n;

  const ids: bigint[] = [];
  for (let id = floor; id <= latest; id += 1n) {
    try {
      const reward = (await client.readContract({
        address: addresses.staking,
        abi: stakingAbi,
        functionName: 'rewardOf',
        args: [staker, id],
      })) as bigint;
      if (reward > 0n) ids.push(id);
    } catch {
      // An id inside [floor, latest] was already confirmed to exist by discoverLatestPeriodId's
      // own search — this shouldn't revert, but one bad read must never abort the whole scan.
    }
  }
  return ids;
}

// --- executeClaim / executeActivateFromHot (the only writeContract calls in this file) --------

/** The minimal viem surface the write paths need — narrow on purpose so tests can fake it
 *  completely, mirroring S-05's `BuyExecClient`. */
export interface ClaimExecClient {
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  getBalance(args: { address: Address }): Promise<bigint>;
  writeContract?(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    account: Account;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }): Promise<Hex>;
  waitForTransactionReceipt?(args: { hash: Hex }): Promise<TransactionReceipt>;
  estimateFeesPerGas?(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

export interface ClaimExecuteDeps {
  readonly client: ClaimExecClient;
  /** The STAKER's derived account (never the raw private key — CLAUDE.md rule 4). Every
   *  `writeContract` call in `executeClaim()` signs as this account: settle/claim/activate in
   *  the `staker_key` flow are all sent by the staker (PRD §3). */
  readonly account: Account;
  readonly addresses: ChainAddresses;
  readonly hot: Address;
  readonly maxFeeGweiCap: number;
}

export type ClaimStep = 'settle' | 'claim' | 'activate';

export interface ClaimStepResult {
  readonly step: ClaimStep;
  readonly txHash: Hex;
}

/** Thrown by `executeClaim()` when any step's tx fails to send or reverts. Carries every step
 *  that DID complete (with its tx hash) before the failure, so a caller can still write ledger
 *  rows for whatever succeeded (ticket AC2: "a reverted receipt at any step stops the chain and
 *  records what completed"). */
export class ClaimExecutionError extends Error {
  readonly completed: readonly ClaimStepResult[];
  readonly failedStep: ClaimStep;

  constructor(message: string, completed: readonly ClaimStepResult[], failedStep: ClaimStep) {
    super(message);
    this.name = 'ClaimExecutionError';
    this.completed = completed;
    this.failedStep = failedStep;
  }
}

export interface ClaimExecutionResult {
  /** Present only when `plan.periodIds` was non-empty (a `settle()` tx was actually sent). */
  readonly settle?: { readonly txHash: Hex; readonly settledAmount: bigint };
  readonly claim: { readonly txHash: Hex; readonly claimedAmount: bigint };
  /** Present only when `plan.activateAmount > 0n` (an `activate()` tx was actually sent — the
   *  day cap may have brought this to exactly 0, in which case settle/claim still ran but no
   *  activate tx is sent at all). */
  readonly activate?: {
    readonly txHash: Hex;
    readonly activationId: bigint;
    readonly amount: bigint;
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveFeeCaps(
  client: ClaimExecClient,
  maxFeeGweiCap: number,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const feeCapWei = parseGwei(String(maxFeeGweiCap));
  let maxFeePerGas = feeCapWei;
  let maxPriorityFeePerGas = feeCapWei;
  if (client.estimateFeesPerGas) {
    const estimated = await client.estimateFeesPerGas();
    maxFeePerGas = estimated.maxFeePerGas < feeCapWei ? estimated.maxFeePerGas : feeCapWei;
    maxPriorityFeePerGas =
      estimated.maxPriorityFeePerGas < maxFeePerGas ? estimated.maxPriorityFeePerGas : maxFeePerGas;
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Sends `settle(periodIds)` (skipped entirely if `plan.periodIds` is empty — never
 * `settle([])`, per the ticket), then `claim()`, then — only if `plan.activateAmount > 0n` —
 * `CREDIT.activate(activateAmount, bytes32(hot))`, all signed by `deps.account` (the staker).
 * Each tx waits for one confirmation and its receipt's `status` is checked before moving on
 * (audit focus: "receipt with status reverted treated as success"); a revert or send failure at
 * any step throws `ClaimExecutionError` carrying whichever earlier steps DID complete. The
 * `Activated` event is decoded from the activate step's receipt only (ticket: "Activated event
 * decoded (CREDIT ABI) for the activate step"), matched against the real CREDIT contract
 * address (audit focus: "event decoding trusting a wrong contract address"). Refuses outright —
 * before touching the network — if `plan.dryRun`, as a second gate on top of the orchestrator's
 * own dryRun check.
 */
export async function executeClaim(
  plan: SettleClaimActivatePlan,
  deps: ClaimExecuteDeps,
): Promise<ClaimExecutionResult> {
  if (plan.dryRun) {
    throw new Error(
      'executeClaim: refused — plan.dryRun is true (call only when caps.treasurerLive)',
    );
  }
  const { client, account, addresses, maxFeeGweiCap } = deps;
  if (!client.writeContract || !client.waitForTransactionReceipt) {
    throw new Error(
      'executeClaim: client does not support sending transactions (writeContract/waitForTransactionReceipt missing) — a read-only client was passed where a wallet-capable one was required',
    );
  }
  const writeContract = client.writeContract;
  const waitForTransactionReceipt = client.waitForTransactionReceipt;
  const { maxFeePerGas, maxPriorityFeePerGas } = await resolveFeeCaps(client, maxFeeGweiCap);

  const completed: ClaimStepResult[] = [];

  let settleResult: { txHash: Hex; settledAmount: bigint } | undefined;
  if (plan.periodIds.length > 0) {
    let settleHash: Hex;
    try {
      settleHash = await writeContract({
        address: addresses.staking,
        abi: stakingAbi,
        functionName: 'settle',
        args: [plan.periodIds],
        account,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } catch (err) {
      throw new ClaimExecutionError(
        `executeClaim: settle failed to send: ${errMsg(err)}`,
        completed,
        'settle',
      );
    }
    const settleReceipt = await waitForTransactionReceipt({ hash: settleHash });
    try {
      requireSuccessReceipt(settleReceipt, 'executeClaim: settle');
    } catch (err) {
      throw new ClaimExecutionError(errMsg(err), completed, 'settle');
    }
    completed.push({ step: 'settle', txHash: settleHash });
    settleResult = { txHash: settleHash, settledAmount: plan.claimAmount };
  }

  let claimHash: Hex;
  try {
    claimHash = await writeContract({
      address: addresses.staking,
      abi: stakingAbi,
      functionName: 'claim',
      args: [],
      account,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
  } catch (err) {
    throw new ClaimExecutionError(
      `executeClaim: claim failed to send: ${errMsg(err)}`,
      completed,
      'claim',
    );
  }
  const claimReceipt = await waitForTransactionReceipt({ hash: claimHash });
  try {
    requireSuccessReceipt(claimReceipt, 'executeClaim: claim');
  } catch (err) {
    throw new ClaimExecutionError(errMsg(err), completed, 'claim');
  }
  completed.push({ step: 'claim', txHash: claimHash });

  let activateResult: { txHash: Hex; activationId: bigint; amount: bigint } | undefined;
  if (plan.activateAmount > 0n) {
    const beneficiary = addressToBytes32(deps.hot);
    let activateHash: Hex;
    try {
      activateHash = await writeContract({
        address: addresses.credit,
        abi: creditAbi,
        functionName: 'activate',
        args: [plan.activateAmount, beneficiary],
        account,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } catch (err) {
      throw new ClaimExecutionError(
        `executeClaim: activate failed to send: ${errMsg(err)}`,
        completed,
        'activate',
      );
    }
    const activateReceipt = await waitForTransactionReceipt({ hash: activateHash });
    try {
      requireSuccessReceipt(activateReceipt, 'executeClaim: activate');
    } catch (err) {
      throw new ClaimExecutionError(errMsg(err), completed, 'activate');
    }
    completed.push({ step: 'activate', txHash: activateHash });
    const decoded = decodeEventFromContract<{ activationId: bigint; amount: bigint }>(
      activateReceipt,
      creditAbi,
      'Activated',
      addresses.credit,
    );
    if (!decoded) {
      throw new ClaimExecutionError(
        `executeClaim: no Activated event from CREDIT (${addresses.credit}) found in receipt for ${activateHash}`,
        completed,
        'activate',
      );
    }
    activateResult = {
      txHash: activateHash,
      activationId: decoded.activationId,
      amount: decoded.amount,
    };
  }

  return {
    ...(settleResult ? { settle: settleResult } : {}),
    claim: { txHash: claimHash, claimedAmount: plan.claimAmount },
    ...(activateResult ? { activate: activateResult } : {}),
  };
}

export interface ExecuteActivateFromHotDeps {
  readonly client: ClaimExecClient;
  /** The HOT wallet's derived account (`TREASURER_PRIVATE_KEY`) — this leg never touches the
   *  staker's key at all. */
  readonly account: Account;
  readonly addresses: ChainAddresses;
  readonly maxFeeGweiCap: number;
}

/**
 * Sends `CREDIT.activate(amount)` (the single-argument overload — beneficiary defaults to
 * `msg.sender`, which IS the hot wallet here, per the ticket: "`activate(amount)` from the hot
 * wallet") signed by `deps.account`. Same receipt/event-decoding discipline as `executeClaim()`.
 */
export async function executeActivateFromHot(
  plan: HotActivatePlan,
  deps: ExecuteActivateFromHotDeps,
): Promise<{ readonly txHash: Hex; readonly activationId: bigint; readonly amount: bigint }> {
  if (plan.dryRun) {
    throw new Error(
      'executeActivateFromHot: refused — plan.dryRun is true (call only when caps.treasurerLive)',
    );
  }
  const { client, account, addresses, maxFeeGweiCap } = deps;
  if (!client.writeContract || !client.waitForTransactionReceipt) {
    throw new Error(
      'executeActivateFromHot: client does not support sending transactions (writeContract/waitForTransactionReceipt missing)',
    );
  }
  const { maxFeePerGas, maxPriorityFeePerGas } = await resolveFeeCaps(client, maxFeeGweiCap);

  const activateHash = await client.writeContract({
    address: addresses.credit,
    abi: creditAbi,
    functionName: 'activate',
    args: [plan.activateAmount],
    account,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const receipt = await client.waitForTransactionReceipt({ hash: activateHash });
  requireSuccessReceipt(receipt, 'executeActivateFromHot: activate');
  const decoded = decodeEventFromContract<{ activationId: bigint; amount: bigint }>(
    receipt,
    creditAbi,
    'Activated',
    addresses.credit,
  );
  if (!decoded) {
    throw new Error(
      `executeActivateFromHot: no Activated event from CREDIT (${addresses.credit}) found in receipt for ${activateHash}`,
    );
  }
  return { txHash: activateHash, activationId: decoded.activationId, amount: decoded.amount };
}

// --- claimAndActivate (the orchestrator) --------------------------------------------------------

export interface ClaimAndActivateDeps {
  readonly store: LedgerStore;
  readonly agentId: Id;
  /** Used for both the read-only balance calls (every leg needs some) and, only when live, the
   *  writes — the same client is passed either way; the write paths are simply never reached in
   *  dry-run. */
  readonly client: ClaimExecClient;
  readonly addresses: ChainAddresses;
  readonly hot: Address;
  /** `STAKER_ADDRESS`, if set — the wallet whose `settledOf`/`CREDIT.balanceOf` are read for
   *  both the `staker_key` and `manual` flows. */
  readonly staker?: Address;
  /** The staker's derived account (`STAKER_PRIVATE_KEY`). Presence alone selects the
   *  `staker_key` flow over `manual` — never read for anything else here (CLAUDE.md rule 4:
   *  this orchestrator never sees a private key, only the account `key.ts`'s
   *  `privateKeyToAccount` already derived). */
  readonly account?: Account;
  /** The hot wallet's derived account (`TREASURER_PRIVATE_KEY`) — required only when the
   *  `hot_activate` leg ends up live; never read for anything else. */
  readonly hotAccount?: Account;
  /** Ids to pass to `Staking.settle()`/considered "still needing settlement" in `manual` mode —
   *  resolved by the CALLER (via `discoverPeriodsToSettle()` or `STAKING_SETTLE_PERIODS`), not
   *  read here: period discovery is a bounded-but-still-O(168) read operation the ticket
   *  deliberately separates out. May be empty. */
  readonly periodIdsToSettle: readonly bigint[];
  readonly caps: ClaimCaps;
  readonly maxFeeGweiCap?: number;
  /** Tick-bucket idempotency key. A prior run under the same key — on EITHER the staker leg
   *  (`idempotencyKey` itself) or the hot leg (`${idempotencyKey}-hot`) — is replayed as a
   *  no-op: no new ledger rows, no new chain calls, for the whole tick. */
  readonly idempotencyKey: string;
  readonly now?: () => Date;
  /** How many of the agent's most recent `treasury_events` to scan for the idempotency check
   *  and the UTC-day activate total. Default 200 — same rationale as S-05's `buyCredit()`. */
  readonly eventLookback?: number;
}

const DEFAULT_EVENT_LOOKBACK = 200;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const EXPLORER_BASE = 'https://robin.etherscan.io';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function serializeSettlePlan(plan: SettleClaimActivatePlan): Record<string, unknown> {
  return {
    dryRun: plan.dryRun,
    periodIds: plan.periodIds.map((id) => id.toString()),
    claimAmount: plan.claimAmount.toString(),
    activateAmount: plan.activateAmount.toString(),
    remainderAmount: plan.remainderAmount.toString(),
  };
}

/** `robin.etherscan.io`'s write-contract link for the next manual step (ticket: "explorerWriteUrl
 *  (robin.etherscan.io write-contract link)"). `settle`/`claim` both live on the Staking
 *  contract; `transfer` (moving already-claimed CREDIT to hot by hand) is a plain ERC-20
 *  `transfer` on the CREDIT contract. */
function explorerWriteUrl(step: ManualAlertStep, addresses: ChainAddresses): string {
  const address = step === 'transfer' ? addresses.credit : addresses.staking;
  return `${EXPLORER_BASE}/address/${address}#writeContract`;
}

export type ClaimLegResult =
  | { readonly leg: 'staker'; readonly status: 'no_op'; readonly detail: string }
  | {
      readonly leg: 'staker';
      readonly status: 'refused';
      readonly reason: ClaimRefusalReason;
      readonly detail: string;
    }
  | {
      readonly leg: 'staker';
      readonly status: 'alerted';
      readonly step: ManualAlertStep;
      readonly amount: string;
    }
  | { readonly leg: 'staker'; readonly status: 'dry_run'; readonly plan: SettleClaimActivatePlan }
  | { readonly leg: 'staker'; readonly status: 'executed'; readonly result: ClaimExecutionResult }
  | {
      readonly leg: 'hot';
      readonly status: 'refused';
      readonly reason: ClaimRefusalReason;
      readonly detail: string;
    }
  | { readonly leg: 'hot'; readonly status: 'dry_run'; readonly plan: HotActivatePlan }
  | {
      readonly leg: 'hot';
      readonly status: 'executed';
      readonly txHash: Hex;
      readonly amount: bigint;
    };

export interface ClaimAndActivateResult {
  /** `true` when a prior call under the same idempotency key (staker or hot) already ran this
   *  tick bucket — no new ledger rows, no new chain calls happened on THIS call. `legs` is
   *  empty in that case. */
  readonly idempotentReplay: boolean;
  readonly legs: readonly ClaimLegResult[];
}

async function runStakerKeyLeg(
  deps: ClaimAndActivateDeps,
  account: Account,
  staker: Address,
  history: ClaimHistoryInput,
  now: Date,
  maxFeeGweiCap: number,
): Promise<ClaimLegResult> {
  const [settledRaw, creditStakerRaw, stakerEthWei] = await Promise.all([
    deps.client.readContract({
      address: deps.addresses.staking,
      abi: stakingAbi,
      functionName: 'settledOf',
      args: [staker],
    }),
    deps.client.readContract({
      address: deps.addresses.credit,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [staker],
    }),
    deps.client.getBalance({ address: staker }),
  ]);

  const plan = planClaim({
    kind: 'staker_key',
    periodIdsToSettle: deps.periodIdsToSettle,
    settledCredit: settledRaw as bigint,
    creditBalanceStaker: creditStakerRaw as bigint,
    stakerEthWei,
    caps: deps.caps,
    history,
    now,
  });

  if (plan.kind === 'no_op') {
    return { leg: 'staker', status: 'no_op', detail: plan.detail };
  }
  if (plan.kind === 'refusal') {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'dry_run',
      meta: { reason: plan.reason, detail: plan.detail, idempotencyKey: deps.idempotencyKey },
    });
    return { leg: 'staker', status: 'refused', reason: plan.reason, detail: plan.detail };
  }

  // plan.kind === 'settle_claim_activate' — the only remaining option this input shape produces.
  if (plan.dryRun) {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'dry_run',
      meta: { plan: serializeSettlePlan(plan), idempotencyKey: deps.idempotencyKey },
    });
    return { leg: 'staker', status: 'dry_run', plan };
  }

  const executed = await executeClaim(plan, {
    client: deps.client,
    account,
    addresses: deps.addresses,
    hot: deps.hot,
    maxFeeGweiCap,
  });

  if (executed.settle) {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'settle',
      amount: executed.settle.settledAmount.toString(),
      token: 'CREDIT',
      txHash: executed.settle.txHash,
      meta: { idempotencyKey: deps.idempotencyKey },
    });
  }
  await deps.store.insertTreasuryEvent({
    agentId: deps.agentId,
    at: now.toISOString(),
    kind: 'claim',
    amount: executed.claim.claimedAmount.toString(),
    token: 'CREDIT',
    txHash: executed.claim.txHash,
    meta: { idempotencyKey: deps.idempotencyKey },
  });
  if (executed.activate) {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'activate',
      amount: executed.activate.amount.toString(),
      token: 'CREDIT',
      txHash: executed.activate.txHash,
      meta: {
        activationId: executed.activate.activationId.toString(),
        idempotencyKey: deps.idempotencyKey,
      },
    });
  }

  return { leg: 'staker', status: 'executed', result: executed };
}

async function runManualLeg(
  deps: ClaimAndActivateDeps,
  staker: Address,
  now: Date,
): Promise<ClaimLegResult> {
  const [settledRaw, creditStakerRaw] = await Promise.all([
    deps.client.readContract({
      address: deps.addresses.staking,
      abi: stakingAbi,
      functionName: 'settledOf',
      args: [staker],
    }),
    deps.client.readContract({
      address: deps.addresses.credit,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [staker],
    }),
  ]);

  const plan = planClaim({
    kind: 'manual',
    periodIdsToSettle: deps.periodIdsToSettle,
    settledCredit: settledRaw as bigint,
    creditBalanceStaker: creditStakerRaw as bigint,
  });

  if (plan.kind === 'no_op') {
    return { leg: 'staker', status: 'no_op', detail: plan.detail };
  }

  // plan.kind === 'manual_alert' — the only other option 'manual' input produces.
  await deps.store.insertTreasuryEvent({
    agentId: deps.agentId,
    at: now.toISOString(),
    kind: 'alert',
    meta: {
      manual: {
        step: plan.step,
        amount: plan.amount.toString(),
        explorerWriteUrl: explorerWriteUrl(plan.step, deps.addresses),
      },
      idempotencyKey: deps.idempotencyKey,
    },
  });
  return { leg: 'staker', status: 'alerted', step: plan.step, amount: plan.amount.toString() };
}

async function runHotLeg(
  deps: ClaimAndActivateDeps,
  history: ClaimHistoryInput,
  now: Date,
  maxFeeGweiCap: number,
): Promise<ClaimLegResult | null> {
  const [creditHotRaw, hotEthWei] = await Promise.all([
    deps.client.readContract({
      address: deps.addresses.credit,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [deps.hot],
    }),
    deps.client.getBalance({ address: deps.hot }),
  ]);

  const plan = planClaim({
    kind: 'hot_activate',
    creditBalanceHot: creditHotRaw as bigint,
    hotEthWei,
    caps: deps.caps,
    history,
    now,
  });

  if (plan.kind === 'no_op') return null;

  const hotIdempotencyKey = `${deps.idempotencyKey}-hot`;

  if (plan.kind === 'refusal') {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'dry_run',
      meta: {
        reason: plan.reason,
        detail: plan.detail,
        leg: 'hot_activate',
        idempotencyKey: hotIdempotencyKey,
      },
    });
    return { leg: 'hot', status: 'refused', reason: plan.reason, detail: plan.detail };
  }

  // plan.kind === 'hot_activate'
  if (plan.dryRun) {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'dry_run',
      meta: {
        plan: {
          activateAmount: plan.activateAmount.toString(),
          remainderAmount: plan.remainderAmount.toString(),
        },
        leg: 'hot_activate',
        idempotencyKey: hotIdempotencyKey,
      },
    });
    return { leg: 'hot', status: 'dry_run', plan };
  }

  if (!deps.hotAccount) {
    throw new Error(
      'claimAndActivate: hot-activate leg is live but no hot account (TREASURER_PRIVATE_KEY) was supplied',
    );
  }

  const executed = await executeActivateFromHot(plan, {
    client: deps.client,
    account: deps.hotAccount,
    addresses: deps.addresses,
    maxFeeGweiCap,
  });

  await deps.store.insertTreasuryEvent({
    agentId: deps.agentId,
    at: now.toISOString(),
    kind: 'activate',
    amount: executed.amount.toString(),
    token: 'CREDIT',
    txHash: executed.txHash,
    meta: {
      activationId: executed.activationId.toString(),
      leg: 'hot_activate',
      idempotencyKey: hotIdempotencyKey,
    },
  });

  return { leg: 'hot', status: 'executed', txHash: executed.txHash, amount: executed.amount };
}

/**
 * The ticket's orchestrating function. Checks idempotency first (so a replay touches neither
 * the chain nor the ledger again — matching on EITHER the staker leg's key or the hot leg's,
 * since a single tick can write rows under both), then runs:
 *
 *  - the `staker_key` leg alone (when `deps.account` is set) — settle/claim/activate all
 *    signed by the staker, writing 1 row (dry-run or a refusal) or up to 3 rows sharing
 *    `meta.idempotencyKey` (settle only if `periodIds` was non-empty; claim always; activate
 *    only if `activateAmount > 0`), each with its own `tx_hash`; or
 *  - both the `manual` leg (only if `deps.staker` is set) and the independent `hot_activate` leg
 *    (always attempted when `deps.account` is unset) — the ticket's two "if" checks run
 *    independently, so both may write a row in the same tick.
 */
export async function claimAndActivate(
  deps: ClaimAndActivateDeps,
): Promise<ClaimAndActivateResult> {
  const now = deps.now?.() ?? new Date();
  const lookback = deps.eventLookback ?? DEFAULT_EVENT_LOOKBACK;
  const maxFeeGweiCap = deps.maxFeeGweiCap ?? DEFAULT_MAX_FEE_GWEI;

  const recent = await deps.store.listTreasuryEvents(deps.agentId, lookback);
  const hotIdempotencyKey = `${deps.idempotencyKey}-hot`;
  const alreadyRan = recent.some(
    (e) =>
      isRecord(e.meta) &&
      (e.meta.idempotencyKey === deps.idempotencyKey ||
        e.meta.idempotencyKey === hotIdempotencyKey),
  );
  if (alreadyRan) {
    return { idempotentReplay: true, legs: [] };
  }

  const activatedToday = recent
    .filter((e) => e.kind === 'activate')
    .map((e) => ({ at: e.at, amount: e.amount ? BigInt(e.amount) : 0n }));
  const history: ClaimHistoryInput = { activatedToday };

  const staker = deps.staker ?? ZERO_ADDRESS;

  if (deps.account) {
    const legResult = await runStakerKeyLeg(
      deps,
      deps.account,
      staker,
      history,
      now,
      maxFeeGweiCap,
    );
    return { idempotentReplay: false, legs: [legResult] };
  }

  const legs: ClaimLegResult[] = [];
  if (deps.staker && deps.staker !== ZERO_ADDRESS) {
    legs.push(await runManualLeg(deps, staker, now));
  }
  const hotLeg = await runHotLeg(deps, history, now, maxFeeGweiCap);
  if (hotLeg) legs.push(hotLeg);

  if (legs.length === 0) {
    legs.push({
      leg: 'staker',
      status: 'no_op',
      detail: 'no staking wallet configured and no hot CREDIT balance to activate',
    });
  }

  return { idempotentReplay: false, legs };
}

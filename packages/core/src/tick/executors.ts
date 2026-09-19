/**
 * `runExecutors()` — maps `policy/sprint.ts`'s `decide()` actions onto the real chain executors
 * (S-06, docs/PRD-1.0-sprint.md §4 T-6; tasks/S-06.md "In scope"). Three action kinds:
 *
 *  - `claim_activate` → S-04's `claimAndActivate()` (`chain/claim.ts`) — already writes its own
 *    `settle`/`claim`/`activate`/`dry_run`/`alert` treasury_events rows internally, keyed by
 *    `caps.treasurerLive` (so "dry_run rows when live is off" is `claimAndActivate()`'s own
 *    behaviour, unchanged here — this file only resolves and passes the caps).
 *  - `buy` → S-05's `buyCredit()` (`chain/buy.ts`) — same story: it writes its own `buy`+
 *    `activate` (executed) or `dry_run` (refused/not-live) rows.
 *  - `stakeup` → **this ticket's own executor**, not S-07's (which doesn't exist yet): always
 *    writes one `alert` treasury_events row carrying the signalled USDG amount and a deep link
 *    (PRD §4 T-7's NO-probe fallback: "the page shows 'manual stake-up pending'") — never sends a
 *    transaction, live or otherwise. S-07 replaces this function's body, not its call site.
 *
 * Two more things every action, of every kind, gets:
 *  - **Never throw past the tick.** Each `claim_activate`/`buy` call is wrapped in try/catch; a
 *    thrown error is redacted and recorded as its own `alert` treasury_events row, then the loop
 *    continues to the next action (ticket: "a throwing `buyCredit` does not prevent
 *    `claimAndActivate` from running"). `runExecutors()` itself never rejects.
 *  - **Mode change.** If `previousMode` (the prior tick's mode, from the prior `chain_snapshots`
 *    row — `null` on the agent's very first tick, which never fires this) differs from this
 *    tick's `mode`, one `mode_change` treasury_events row is written before any action runs.
 */
import type { Account, Address } from 'viem';
import { type BuyCaps, type BuyCreditResult, type BuyExecClient, buyCredit } from '../chain/buy.js';
import {
  type ClaimAndActivateResult,
  type ClaimCaps,
  type ClaimExecClient,
  claimAndActivate,
} from '../chain/claim.js';
import type { ChainAddresses } from '../chain/contracts.js';
import { parseDecimal } from '../ledger/decimal.js';
import type { Id, LedgerStore } from '../ledger/types.js';
import type {
  SprintAction,
  SprintBuyAction,
  SprintClaimActivateAction,
  SprintStakeupAction,
} from '../policy/sprint.js';
import { redact } from '../redact.js';
import type { Mode } from '../router/types.js';

/** The one chain-client surface every executor needs — the union of S-04's and S-05's own
 *  narrow client interfaces (structurally near-identical; a real viem client satisfies both, and
 *  a test fake only needs to implement this one shape). */
export type TickExecClient = BuyExecClient & ClaimExecClient;

export interface RunExecutorsDeps {
  readonly store: LedgerStore;
  readonly agentId: Id;
  readonly client: TickExecClient;
  readonly addresses: ChainAddresses;
  readonly hot: Address;
  /** `STAKER_ADDRESS`, if set — forwarded to `claimAndActivate()`'s `staker`. */
  readonly staker?: Address;
  /** `STAKER_PRIVATE_KEY`'s derived account, if set — selects `claimAndActivate()`'s
   *  `staker_key` flow (see that function's own doc comment). */
  readonly account?: Account;
  /** `TREASURER_PRIVATE_KEY`'s derived account, if set — used by `claimAndActivate()`'s
   *  `hot_activate` leg AND, when live, `buyCredit()`'s send. */
  readonly hotAccount?: Account;
  readonly claimCaps: ClaimCaps;
  readonly buyCaps: BuyCaps;
  /** Resolved once per tick by the caller (`tick/tick.ts`), via
   *  `discoverPeriodsToSettle()`/`STAKING_SETTLE_PERIODS` — never re-resolved per action. */
  readonly periodIdsToSettle: readonly bigint[];
  readonly maxFeeGweiCap?: number;
  /** The tick's own 15-min-bucket idempotency key (`tick/tick.ts`) — suffixed per action kind so
   *  `claim_activate`'s and `buy`'s own idempotency checks (inside `claimAndActivate()`/
   *  `buyCredit()`) never collide with each other under the same tick. */
  readonly idempotencyKey: string;
  readonly now?: () => Date;
}

export type ExecutorActionResult =
  | {
      readonly kind: 'claim_activate';
      readonly outcome: 'ok';
      readonly result: ClaimAndActivateResult;
    }
  | { readonly kind: 'claim_activate'; readonly outcome: 'error'; readonly error: string }
  | { readonly kind: 'buy'; readonly outcome: 'ok'; readonly result: BuyCreditResult }
  | { readonly kind: 'buy'; readonly outcome: 'error'; readonly error: string }
  | {
      readonly kind: 'stakeup';
      readonly outcome: 'alerted';
      readonly usdg: string;
      readonly deepLink: string;
    };

export interface RunExecutorsResult {
  readonly modeChanged: boolean;
  readonly results: readonly ExecutorActionResult[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes one `alert` row for an executor that threw. Wrapped in its own try/catch — a failure
 *  to even WRITE the alert must not itself throw past the tick (this file's own header rule). */
async function recordExecutorError(
  deps: RunExecutorsDeps,
  action: 'claim_activate' | 'buy',
  err: unknown,
  now: () => Date,
): Promise<void> {
  try {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now().toISOString(),
      kind: 'alert',
      meta: redact({ action, error: errMsg(err), idempotencyKey: deps.idempotencyKey }),
    });
  } catch {
    // See doc comment above.
  }
}

async function runClaimActivate(
  _action: SprintClaimActivateAction,
  deps: RunExecutorsDeps,
  now: () => Date,
): Promise<ExecutorActionResult> {
  try {
    const result = await claimAndActivate({
      store: deps.store,
      agentId: deps.agentId,
      client: deps.client,
      addresses: deps.addresses,
      hot: deps.hot,
      ...(deps.staker ? { staker: deps.staker } : {}),
      ...(deps.account ? { account: deps.account } : {}),
      ...(deps.hotAccount ? { hotAccount: deps.hotAccount } : {}),
      periodIdsToSettle: deps.periodIdsToSettle,
      caps: deps.claimCaps,
      ...(deps.maxFeeGweiCap !== undefined ? { maxFeeGweiCap: deps.maxFeeGweiCap } : {}),
      idempotencyKey: `${deps.idempotencyKey}-claim`,
      now,
    });
    return { kind: 'claim_activate', outcome: 'ok', result };
  } catch (err) {
    await recordExecutorError(deps, 'claim_activate', err, now);
    return { kind: 'claim_activate', outcome: 'error', error: errMsg(err) };
  }
}

async function runBuy(
  action: SprintBuyAction,
  deps: RunExecutorsDeps,
  now: () => Date,
): Promise<ExecutorActionResult> {
  try {
    // `action.usdg` is a decimal-string USDG amount; USDG has exactly 6 decimals, the same scale
    // `ledger/decimal.ts`'s `ScaledDecimal` uses — so its raw bigint IS already the raw USDG atom
    // count `buyCredit()` wants, with no separate decimal-shifting step (same fact `chain/buy.ts`'s
    // own `DEFAULT_BUY_MAX_USDG_PER_TX_ATOMS` relies on).
    const result = await buyCredit({
      store: deps.store,
      agentId: deps.agentId,
      client: deps.client,
      addresses: deps.addresses,
      hot: deps.hot,
      ...(deps.hotAccount ? { account: deps.hotAccount } : {}),
      usdgIn: parseDecimal(action.usdg),
      caps: deps.buyCaps,
      ...(deps.maxFeeGweiCap !== undefined ? { maxFeeGweiCap: deps.maxFeeGweiCap } : {}),
      idempotencyKey: `${deps.idempotencyKey}-buy`,
      now,
      // S-06 discovery (see chain/buy.ts's `BuyCreditDeps.skipOwnLock` doc comment): `tick/tick.ts`
      // already holds `store.withAgentLock(agentId, ...)` for this agent across the whole tick —
      // without this, buyCredit()'s own internal `withAgentLock` call for the SAME agentId
      // deadlocks against the tick's own outer lock (SQLite's per-agent FIFO chain never lets a
      // second call for the same agent start before the first settles).
      skipOwnLock: true,
    });
    return { kind: 'buy', outcome: 'ok', result };
  } catch (err) {
    await recordExecutorError(deps, 'buy', err, now);
    return { kind: 'buy', outcome: 'error', error: errMsg(err) };
  }
}

async function runStakeup(
  action: SprintStakeupAction,
  deps: RunExecutorsDeps,
  now: () => Date,
): Promise<ExecutorActionResult> {
  // No automated stake-up path exists yet (S-07) — PRD §4 T-7's NO fallback: always signal with
  // a deep link and the amount, never send a transaction. `robin.etherscan.io`'s own address page
  // for $ORBIO is the deep link (no Uniswap router address is configured by default —
  // `STAKE_CLIENT=none`, ARCHITECTURE §6), same explorer base S-04's `claim.ts` already links to.
  const deepLink = `https://robin.etherscan.io/address/${deps.addresses.orbio}`;
  await deps.store.insertTreasuryEvent({
    agentId: deps.agentId,
    at: now().toISOString(),
    kind: 'alert',
    meta: {
      action: 'stakeup',
      usdg: action.usdg,
      reason: action.reason,
      detail: 'no automated stake-up executor yet (S-07) — manual stake-up pending',
      deepLink,
      idempotencyKey: `${deps.idempotencyKey}-stakeup`,
    },
  });
  return { kind: 'stakeup', outcome: 'alerted', usdg: action.usdg, deepLink };
}

/**
 * Runs every action from a `decide()` `SprintDecision.actions`, in the order given (the ticket's
 * own fixed order — `claim_activate`, `buy`, `stakeup`), after writing a `mode_change` row if
 * `mode` differs from `previousMode`. Never rejects — every executor call is isolated (see this
 * file's header).
 */
export async function runExecutors(
  actions: readonly SprintAction[],
  mode: Mode,
  previousMode: string | null,
  deps: RunExecutorsDeps,
): Promise<RunExecutorsResult> {
  const now = deps.now ?? (() => new Date());
  const modeChanged = previousMode !== null && previousMode !== mode;

  if (modeChanged) {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now().toISOString(),
      kind: 'mode_change',
      meta: { from: previousMode, to: mode },
    });
  }

  const results: ExecutorActionResult[] = [];
  for (const action of actions) {
    if (action.kind === 'claim_activate') {
      results.push(await runClaimActivate(action, deps, now));
    } else if (action.kind === 'buy') {
      results.push(await runBuy(action, deps, now));
    } else {
      results.push(await runStakeup(action, deps, now));
    }
  }

  return { modeChanged, results };
}

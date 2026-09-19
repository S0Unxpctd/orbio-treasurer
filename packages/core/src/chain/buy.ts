/**
 * buyAndActivate — buy CREDIT on Orbio's on-chain Exchange with USDG and activate it straight
 * onto the hot wallet's Orbio API balance (S-05, docs/PRD-1.0-sprint.md §3, §4 T-5, §6;
 * tasks/S-05.md "In scope"). MONEY TICKET, gated by CLAUDE.md rule 5: `TREASURER_LIVE` stays
 * unset in this sandbox, there is no private key here, and `executeBuy()` is exercised only
 * against a fake viem client in tests — nothing in this file can send a transaction on its own.
 *
 * Three layers, in the order the ticket lists them:
 *
 *  - `planBuy()` — PURE. No I/O, no `Date.now()`, no env read: the quote, the caps, the wallet
 *    balances, the past-buy timestamps and the clock are all parameters. Every refusal reason
 *    is therefore a table-driven test (buy.test.ts) rather than something that needs a real
 *    chain to exercise — including the two the audit checklist calls out by name: "day counter
 *    using local time" (see `utcDateKey()` — UTC calendar fields only, never a local getter) and
 *    "minCreditOut rounding up" (see `minCreditOutFor()` — bigint truncation only, never float).
 *  - `executeBuy()` — the one function here that calls `writeContract`. Only ever reached via
 *    `buyCredit()` below when `planBuy()` returned a plan with `dryRun: false`, which itself
 *    requires `caps.treasurerLive` — and only ever tested against a fake client (buy.test.ts).
 *  - `buyCredit()` — the ticket's "orchestrating function". Checks idempotency first (so a
 *    replay touches neither the chain nor the ledger again), reads the quote and wallet
 *    balances, reads recent `treasury_events` for the UTC-day buy count, calls `planBuy()`, and
 *    writes exactly one ledger row for a refusal or a not-executed dry run, or a `buy` + a
 *    matching `activate` row (sharing `tx_hash`) for an executed one — never zero rows, per the
 *    ticket's ledger section.
 */
import type { Abi, Account, Address, Hex, TransactionReceipt } from 'viem';
import { decodeEventLog, pad, parseEther, parseGwei } from 'viem';
import type { Env } from '../env.js';
import { formatDecimal, parseDecimal } from '../ledger/decimal.js';
import type { Id, LedgerStore } from '../ledger/types.js';
import {
  BUY_MAX_PER_DAY,
  BUY_MAX_USDG_PER_TX,
  MIN_DISCOUNT_RATIO,
  SLIPPAGE_BPS,
} from '../policy/defaults.js';
import type { ChainAddresses } from './contracts.js';
import { creditAbi, erc20Abi, exchangeAbi } from './contracts.js';
import { QUOTE_PROBE_MAX_FILLS } from './read.js';

// --- caps -----------------------------------------------------------------------------------

/** `executeBuy()`'s `maxFeePerGas` cap, in gwei, when env `MAX_FEE_GWEI` is unset. */
export const DEFAULT_MAX_FEE_GWEI = 5;

/** `planBuy()`'s minimum hot-wallet ETH balance, in ETH, when env `MIN_GAS_ETH` is unset. */
export const DEFAULT_MIN_GAS_ETH = '0.0005';

export interface BuyCaps {
  /** Mirrors env `TREASURER_LIVE` (CLAUDE.md rule 5) — `false` in every sandbox run. */
  readonly treasurerLive: boolean;
  /** Raw USDG atoms (6 dec). Defaults to `BUY_MAX_USDG_PER_TX` atoms; env may only lower it. */
  readonly buyMaxUsdgPerTxAtoms: bigint;
  /** Max *executed* buys per UTC calendar day. Defaults to `BUY_MAX_PER_DAY`; env may only
   *  lower it. */
  readonly buyMaxPerDay: number;
  /** Fixed — see policy/defaults.ts's header for why this has no env override. */
  readonly minDiscountRatio: number;
  /** The `maxFills` argument `getQuote`/`buyAndActivate` are called with. A quote reporting more
   *  fills than this is refused as a sanity check (audit focus). Defaults to
   *  `QUOTE_PROBE_MAX_FILLS` (10n) — the same ceiling S-03's probe read and PRD §4 T-5's example
   *  both use, so there's exactly one place this number is a literal. */
  readonly maxFills: bigint;
  /** Raw wei. Below this, `executeBuy()` couldn't even pay for its own gas. */
  readonly minGasWei: bigint;
}

export interface ResolveBuyCapsOptions {
  readonly env: Pick<
    Env,
    'TREASURER_LIVE' | 'BUY_MAX_USDG_PER_TX' | 'BUY_MAX_PER_DAY' | 'MIN_GAS_ETH'
  >;
  /** Injectable so tests can assert on the "would raise a cap, ignored" warning without a
   *  console spy. Defaults to `console.error` (biome's noConsole rule allows only 'error'). */
  readonly warn?: (message: string) => void;
}

/** Raw USDG atoms for `BUY_MAX_USDG_PER_TX` (`"10"` → `10000000n`) — exact bigint math via
 *  `ledger/decimal.ts`'s `parseDecimal` (USDG's 6 decimals happen to match `Money`'s scale
 *  exactly, the same fact snapshot.ts's `quoteCreditPerUsdg` conversion relies on). */
const DEFAULT_BUY_MAX_USDG_PER_TX_ATOMS = parseDecimal(BUY_MAX_USDG_PER_TX);

/**
 * Resolves the four `BuyCaps` from env, per CLAUDE.md rule 5: `BUY_MAX_USDG_PER_TX` and
 * `BUY_MAX_PER_DAY` may only be LOWERED by their same-named env var — a value that would raise
 * either is ignored and logged (never thrown; a bad env value must not crash the tick), and a
 * value that fails to parse is treated the same way.
 *
 * `MIN_GAS_ETH` (audit pass 1, Minor/Question 2 — closed): directionality-restricted the OTHER
 * way around from the two caps above, because it's a *minimum required balance*, not a ceiling
 * on exposure — the safer direction for a floor is UP (refuse more often, never send with too
 * little gas budgeted), never down. Env may only RAISE it above `DEFAULT_MIN_GAS_ETH`; a value
 * that would LOWER it is ignored and logged, exactly mirroring the two caps' own downward-only
 * rule but mirrored to match what "safer" means for a floor instead of a ceiling. `MAX_FEE_GWEI`
 * gets the matching ceiling-shaped restriction in `resolveMaxFeeGweiCap()` below.
 * `MIN_DISCOUNT_RATIO`/`maxFills` have no env input at all; they're always the PRD-fixed
 * defaults.
 */
export function resolveBuyCaps(options: ResolveBuyCapsOptions): BuyCaps {
  const { env } = options;
  const warn = options.warn ?? ((message: string) => console.error(message));

  let buyMaxUsdgPerTxAtoms = DEFAULT_BUY_MAX_USDG_PER_TX_ATOMS;
  if (env.BUY_MAX_USDG_PER_TX !== undefined) {
    let envAtoms: bigint | undefined;
    try {
      envAtoms = parseDecimal(env.BUY_MAX_USDG_PER_TX);
    } catch {
      warn(
        `BUY_MAX_USDG_PER_TX="${env.BUY_MAX_USDG_PER_TX}" is not a valid decimal — ignoring, keeping default ${BUY_MAX_USDG_PER_TX}`,
      );
    }
    if (envAtoms !== undefined) {
      if (envAtoms < DEFAULT_BUY_MAX_USDG_PER_TX_ATOMS) {
        buyMaxUsdgPerTxAtoms = envAtoms;
      } else if (envAtoms > DEFAULT_BUY_MAX_USDG_PER_TX_ATOMS) {
        warn(
          `BUY_MAX_USDG_PER_TX="${env.BUY_MAX_USDG_PER_TX}" would RAISE the default cap (${BUY_MAX_USDG_PER_TX}) — ignored (CLAUDE.md rule 5: caps only lower via env).`,
        );
      }
      // Equal to the default: no-op, no warning either way.
    }
  }

  let buyMaxPerDay = BUY_MAX_PER_DAY;
  if (env.BUY_MAX_PER_DAY !== undefined) {
    const parsed = Number(env.BUY_MAX_PER_DAY);
    if (!Number.isInteger(parsed) || parsed < 0) {
      warn(
        `BUY_MAX_PER_DAY="${env.BUY_MAX_PER_DAY}" is not a valid non-negative integer — ignoring, keeping default ${BUY_MAX_PER_DAY}`,
      );
    } else if (parsed < BUY_MAX_PER_DAY) {
      buyMaxPerDay = parsed;
    } else if (parsed > BUY_MAX_PER_DAY) {
      warn(
        `BUY_MAX_PER_DAY="${env.BUY_MAX_PER_DAY}" would RAISE the default cap (${BUY_MAX_PER_DAY}) — ignored (CLAUDE.md rule 5: caps only lower via env).`,
      );
    }
  }

  const defaultMinGasWei = parseEther(DEFAULT_MIN_GAS_ETH);
  let minGasWei = defaultMinGasWei;
  if (env.MIN_GAS_ETH !== undefined) {
    let envMinGasWei: bigint | undefined;
    try {
      envMinGasWei = parseEther(env.MIN_GAS_ETH);
    } catch {
      warn(
        `MIN_GAS_ETH="${env.MIN_GAS_ETH}" is not a valid decimal — ignoring, keeping default ${DEFAULT_MIN_GAS_ETH}`,
      );
    }
    if (envMinGasWei !== undefined) {
      if (envMinGasWei > defaultMinGasWei) {
        minGasWei = envMinGasWei;
      } else if (envMinGasWei < defaultMinGasWei) {
        warn(
          `MIN_GAS_ETH="${env.MIN_GAS_ETH}" would LOWER the default gas-safety floor (${DEFAULT_MIN_GAS_ETH}) — ignored (a minimum balance may only be raised via env, never lowered).`,
        );
      }
      // Equal to the default: no-op, no warning either way.
    }
  }

  return {
    treasurerLive: env.TREASURER_LIVE === true,
    buyMaxUsdgPerTxAtoms,
    buyMaxPerDay,
    minDiscountRatio: MIN_DISCOUNT_RATIO,
    maxFills: QUOTE_PROBE_MAX_FILLS,
    minGasWei,
  };
}

/** `executeBuy()`'s `maxFeePerGas` cap (gwei), from env `MAX_FEE_GWEI` or `DEFAULT_MAX_FEE_GWEI`.
 *  Audit pass 1, Minor/Question 2 (closed): directionality-restricted like
 *  `resolveBuyCaps()`'s two exposure caps — this IS a ceiling (a maximum), so the safer
 *  direction is DOWN. Env may only LOWER it below `DEFAULT_MAX_FEE_GWEI`; a value that would
 *  raise it is ignored and logged, never thrown (a bad env value must not crash the tick). See
 *  `resolveBuyCaps()`'s comment on `MIN_GAS_ETH` for the mirror-image floor case. */
export function resolveMaxFeeGweiCap(
  env: Pick<Env, 'MAX_FEE_GWEI'>,
  warn: (message: string) => void = (message) => console.error(message),
): number {
  if (env.MAX_FEE_GWEI === undefined) return DEFAULT_MAX_FEE_GWEI;
  const parsed = Number(env.MAX_FEE_GWEI);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(
      `MAX_FEE_GWEI="${env.MAX_FEE_GWEI}" is not a valid positive number — ignoring, keeping default ${DEFAULT_MAX_FEE_GWEI}`,
    );
    return DEFAULT_MAX_FEE_GWEI;
  }
  if (parsed > DEFAULT_MAX_FEE_GWEI) {
    warn(
      `MAX_FEE_GWEI="${env.MAX_FEE_GWEI}" would RAISE the default fee cap (${DEFAULT_MAX_FEE_GWEI}) — ignored (a maximum-fee cap may only be lowered via env, never raised).`,
    );
    return DEFAULT_MAX_FEE_GWEI;
  }
  return parsed;
}

// --- planBuy (pure) ---------------------------------------------------------------------------

export interface BuyQuoteInput {
  readonly creditOut: bigint;
  readonly fills: bigint;
}

export interface BuyWalletBalances {
  readonly usdgAtoms: bigint;
  readonly ethWei: bigint;
}

export interface BuyHistoryInput {
  /** ISO-8601 UTC timestamps of past *executed* buys (`treasury_events` rows of kind `buy`),
   *  as many as the caller fetched. Only the ones sharing `now`'s UTC calendar day count toward
   *  `buysToday` — the counting itself happens in here, not in the caller, precisely so the UTC
   *  boundary is a `planBuy()` unit test rather than an untested assumption in `buyCredit()`. */
  readonly buyTimestamps: readonly string[];
}

export type BuyRefusalReason =
  | 'per_tx_cap_exceeded'
  | 'per_day_cap_exceeded'
  | 'discount_too_low'
  | 'fills_exceeded'
  | 'insufficient_usdg_balance'
  | 'insufficient_gas_balance';

export interface BuyRefusal {
  readonly kind: 'refusal';
  readonly reason: BuyRefusalReason;
  /** Human-readable and secret-free (only ever numbers/counts) — safe straight into a ledger
   *  row's `meta.detail` or a CLI print with no `redact()` pass needed. */
  readonly detail: string;
}

export interface BuyPlan {
  readonly kind: 'plan';
  /** `true` whenever `!caps.treasurerLive`. Every other field is still fully computed either
   *  way (ticket: "plan still returned with dryRun: true") — a dry-run plan is exactly what a
   *  live one would have done. */
  readonly dryRun: boolean;
  readonly usdgIn: bigint;
  readonly minCreditOut: bigint;
  readonly maxFills: bigint;
  readonly quote: BuyQuoteInput;
}

export interface PlanBuyInput {
  readonly usdgIn: bigint;
  readonly quote: BuyQuoteInput;
  readonly caps: BuyCaps;
  readonly wallet: BuyWalletBalances;
  readonly history: BuyHistoryInput;
  readonly now: Date;
}

/** Opaque per-UTC-calendar-day key. Deliberately built only from `getUTC*` accessors — never
 *  `getMonth()`/`getDate()`/`toDateString()` — so this can never drift with the process's (or a
 *  CI runner's) local timezone (audit focus: "day counter using local time"). */
function utcDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/** `floor(creditOut × (1 − SLIPPAGE_BPS / 10000))`. Bigint division truncates toward zero, and
 *  every operand here is non-negative, so truncation IS floor — no float ever touches this
 *  number (audit focus: "minCreditOut rounding up"; AC: "exact integer"). */
function minCreditOutFor(creditOut: bigint): bigint {
  return (creditOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
}

/** `creditOut / usdgIn >= minRatio`, entirely in bigint: `minRatio` (e.g. `1.10`) is scaled by
 *  1e6 exactly once, here — the comparison itself is a cross-multiplication, never a float
 *  division on either side. */
function meetsMinDiscount(creditOut: bigint, usdgIn: bigint, minRatio: number): boolean {
  const ratioScaled = BigInt(Math.round(minRatio * 1_000_000));
  return creditOut * 1_000_000n >= usdgIn * ratioScaled;
}

/**
 * Decides whether — and how — to buy CREDIT with `usdgIn` USDG atoms, given a fresh `quote`.
 * PURE: every refusal in the ticket's list is checked, in the ticket's order, before anything
 * about `caps.treasurerLive` is looked at, so a refusal is a refusal regardless of live/dry-run
 * (a dry run models exactly what a live run would have decided, including refusing).
 */
export function planBuy(input: PlanBuyInput): BuyPlan | BuyRefusal {
  const { usdgIn, quote, caps, wallet, history, now } = input;

  if (usdgIn > caps.buyMaxUsdgPerTxAtoms) {
    return {
      kind: 'refusal',
      reason: 'per_tx_cap_exceeded',
      detail: `usdgIn ${usdgIn.toString()} atoms exceeds the per-tx cap of ${caps.buyMaxUsdgPerTxAtoms.toString()} atoms`,
    };
  }

  const todayKey = utcDateKey(now.toISOString());
  const buysToday = history.buyTimestamps.filter((t) => utcDateKey(t) === todayKey).length;
  if (buysToday >= caps.buyMaxPerDay) {
    return {
      kind: 'refusal',
      reason: 'per_day_cap_exceeded',
      detail: `${buysToday} buy(s) already executed today (UTC); cap is ${caps.buyMaxPerDay}`,
    };
  }

  if (!meetsMinDiscount(quote.creditOut, usdgIn, caps.minDiscountRatio)) {
    return {
      kind: 'refusal',
      reason: 'discount_too_low',
      detail: `quote ${quote.creditOut.toString()}/${usdgIn.toString()} is below the minimum discount ratio ${caps.minDiscountRatio}`,
    };
  }

  if (quote.fills > caps.maxFills) {
    return {
      kind: 'refusal',
      reason: 'fills_exceeded',
      detail: `quote used ${quote.fills.toString()} fills, more than the ${caps.maxFills.toString()} this plan allows`,
    };
  }

  if (wallet.usdgAtoms < usdgIn) {
    return {
      kind: 'refusal',
      reason: 'insufficient_usdg_balance',
      detail: `hot wallet USDG balance ${wallet.usdgAtoms.toString()} atoms is below usdgIn ${usdgIn.toString()} atoms`,
    };
  }

  if (wallet.ethWei < caps.minGasWei) {
    return {
      kind: 'refusal',
      reason: 'insufficient_gas_balance',
      detail: `hot wallet ETH balance ${wallet.ethWei.toString()} wei is below MIN_GAS_ETH (${caps.minGasWei.toString()} wei)`,
    };
  }

  return {
    kind: 'plan',
    dryRun: !caps.treasurerLive,
    usdgIn,
    minCreditOut: minCreditOutFor(quote.creditOut),
    maxFills: caps.maxFills,
    quote,
  };
}

// --- executeBuy (the only writeContract call in this file) --------------------------------------

/** The minimal viem surface `executeBuy()`/`buyCredit()` need — narrow on purpose so tests can
 *  fake it completely (no real `PublicClient`/`WalletClient` construction) while still typing
 *  every call site against the real contract ABIs.
 *
 * `readContract`/`getBalance` are required — `buyCredit()` needs them even in dry-run, to build
 * a real `planBuy()` input. The three write-path methods are optional: a genuine read-only
 * `PublicClient` (exactly what the CLI and every dry-run call site actually hold — see
 * treasury-buy.ts) has no `writeContract` at all, and that absence is never reached anyway
 * unless `caps.treasurerLive` — `executeBuy()` checks for it explicitly below rather than
 * letting TypeScript paper over a client that can't actually send. */
export interface BuyExecClient {
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
  /** Optional — viem's real `PublicClient` has it; a minimal fake in a test may not. */
  estimateFeesPerGas?(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

export interface BuyExecuteDeps {
  readonly client: BuyExecClient;
  /** The derived account, never the raw private key (CLAUDE.md rule 4: "never passed around as
   *  a string beyond `privateKeyToAccount`" — callers derive this once with `key.ts`'s
   *  `privateKeyToAccount`, this module never sees the key itself). */
  readonly account: Account;
  readonly addresses: ChainAddresses;
  readonly hot: Address;
  /** `maxFeePerGas` cap in gwei (see `resolveMaxFeeGweiCap()`). */
  readonly maxFeeGweiCap: number;
}

export interface BuyExecutionResult {
  readonly txHash: Hex;
  readonly creditOut: bigint;
  readonly activationId: bigint;
}

/** `bytes32(hot address, left-padded)` — the exact shape PRD §3's `Exchange.buyAndActivate`'s
 *  `beneficiary` param (and `CREDIT.activate(amount, beneficiary)`) both expect. */
export function addressToBeneficiary(address: Address): Hex {
  return pad(address, { size: 32 });
}

/** Only a log FROM the real CREDIT contract is ever considered a candidate `Activated` event —
 *  never merely one whose topics happen to decode against `creditAbi` (audit focus: "event
 *  decoding trusting a wrong contract address"). Returns `null` if none is found; the caller
 *  treats that as fatal. */
function decodeActivatedEvent(
  receipt: TransactionReceipt,
  creditAddress: Address,
): { activationId: bigint; amount: bigint } | null {
  for (const receiptLog of receipt.logs) {
    if (receiptLog.address.toLowerCase() !== creditAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: creditAbi,
        data: receiptLog.data,
        topics: receiptLog.topics,
        eventName: 'Activated',
      });
      const args = decoded.args as unknown as { activationId: bigint; amount: bigint };
      return { activationId: args.activationId, amount: args.amount };
    } catch {
      // Not an Activated log (wrong topic0, or a different event on the same contract) — keep
      // scanning the rest of the receipt's logs.
    }
  }
  return null;
}

/**
 * Sends the buy: reads `USDG.allowance` first and approves only if it's short (exact `usdgIn`,
 * never an unlimited allowance — audit focus), then calls `Exchange.buyAndActivate`, waits for
 * one confirmation, and decodes the `Activated` event from the receipt. Throws (never returns a
 * "successful" result) on a `reverted` receipt for either transaction (audit focus: "receipt
 * with status reverted treated as success") or if no matching `Activated` event is found.
 * Refuses outright — before touching the network at all — if `plan.dryRun`, as a second,
 * belt-and-braces gate on top of `buyCredit()`'s own dryRun check.
 */
export async function executeBuy(plan: BuyPlan, deps: BuyExecuteDeps): Promise<BuyExecutionResult> {
  if (plan.dryRun) {
    throw new Error(
      'executeBuy: refused — plan.dryRun is true (call only when caps.treasurerLive)',
    );
  }

  const { client, account, addresses, hot, maxFeeGweiCap } = deps;
  if (!client.writeContract || !client.waitForTransactionReceipt) {
    throw new Error(
      'executeBuy: client does not support sending transactions (writeContract/waitForTransactionReceipt missing) — a read-only PublicClient was passed where a wallet-capable one was required',
    );
  }
  const writeContract = client.writeContract;
  const waitForTransactionReceipt = client.waitForTransactionReceipt;

  const feeCapWei = parseGwei(String(maxFeeGweiCap));
  let maxFeePerGas = feeCapWei;
  let maxPriorityFeePerGas = feeCapWei;
  if (client.estimateFeesPerGas) {
    const estimated = await client.estimateFeesPerGas();
    maxFeePerGas = estimated.maxFeePerGas < feeCapWei ? estimated.maxFeePerGas : feeCapWei;
    maxPriorityFeePerGas =
      estimated.maxPriorityFeePerGas < maxFeePerGas ? estimated.maxPriorityFeePerGas : maxFeePerGas;
  }

  const allowance = (await client.readContract({
    address: addresses.usdg,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [hot, addresses.exchange],
  })) as bigint;

  if (allowance < plan.usdgIn) {
    const approveHash = await writeContract({
      address: addresses.usdg,
      abi: erc20Abi,
      functionName: 'approve',
      args: [addresses.exchange, plan.usdgIn],
      account,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const approveReceipt = await waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') {
      throw new Error(`executeBuy: USDG.approve reverted (tx ${approveHash})`);
    }
  }

  const beneficiary = addressToBeneficiary(hot);
  const buyHash = await writeContract({
    address: addresses.exchange,
    abi: exchangeAbi,
    functionName: 'buyAndActivate',
    args: [plan.usdgIn, plan.minCreditOut, beneficiary, plan.maxFills],
    account,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const receipt = await waitForTransactionReceipt({ hash: buyHash });
  if (receipt.status !== 'success') {
    throw new Error(`executeBuy: buyAndActivate reverted (tx ${buyHash})`);
  }

  const activated = decodeActivatedEvent(receipt, addresses.credit);
  if (!activated) {
    throw new Error(
      `executeBuy: no Activated event from CREDIT (${addresses.credit}) found in receipt for ${buyHash}`,
    );
  }

  return { txHash: buyHash, creditOut: activated.amount, activationId: activated.activationId };
}

// --- buyCredit (the orchestrator) --------------------------------------------------------------

export interface BuyCreditDeps {
  readonly store: LedgerStore;
  readonly agentId: Id;
  /** Used for both the read-only quote/balance calls and, only when live, the writes —
   *  `buyCredit()` never distinguishes; `executeBuy()` is simply never reached in dry-run. */
  readonly client: BuyExecClient;
  readonly addresses: ChainAddresses;
  readonly hot: Address;
  /** Required only when `caps.treasurerLive` ends up true; never read for anything else here.
   *  `buyCredit()` itself never sees a private key (CLAUDE.md rule 4). */
  readonly account?: Account;
  readonly usdgIn: bigint;
  readonly caps: BuyCaps;
  readonly maxFeeGweiCap?: number;
  /** Tick-bucket idempotency key (ticket: "buyCredit() takes an idempotencyKey"). A prior `buy`
   *  event carrying the same key in its `meta` is replayed verbatim, with no new ledger rows and
   *  no chain calls at all. A prior refusal or dry-run under the same key is NOT treated as a
   *  replay — only an executed `buy` blocks a resend, so a refused/dry-run tick can still be
   *  retried on the next one. */
  readonly idempotencyKey: string;
  readonly now?: () => Date;
  /** How many of the agent's most recent `treasury_events` to scan for the idempotency check and
   *  the UTC-day buy count. Default 200 — see Discovered in tasks/S-05.md for why this isn't an
   *  indexed lookup. */
  readonly eventLookback?: number;
  /** S-06 discovery (tasks/S-06.md Discovered): `tick/tick.ts` already runs the ENTIRE tick
   *  (every read, `decide()`, and every executor call) inside one
   *  `store.withAgentLock(agentId, ...)` for this same `agentId`. `LedgerStore.withAgentLock`'s
   *  SQLite implementation is a per-`agentId` FIFO promise chain (`ledger/sqlite/store.ts`) — a
   *  SECOND call for the same `agentId` is queued strictly BEHIND the first and only starts once
   *  it settles. Without this flag, `buyCredit()` calling `store.withAgentLock(deps.agentId, ...)`
   *  from inside the tick's own lock body deadlocks forever (the tick's call can't settle until
   *  buyCredit's nested call does, and buyCredit's call can't even START until the tick's settles).
   *  Set `true` only by a caller that already holds this agent's lock for the whole duration of
   *  this call (today: `tick/executors.ts`'s `runBuy()`, only). Every other caller (the CLI,
   *  `buy.test.ts`) leaves this unset/`false` and keeps buyCredit's own locking exactly as S-05
   *  built it — this is additive, not a behavior change for any existing caller. */
  readonly skipOwnLock?: boolean;
}

export type BuyCreditResult =
  | {
      readonly status: 'idempotent_replay';
      readonly txHash: string;
      readonly creditOut: string;
      readonly activationId: string;
    }
  | { readonly status: 'refused'; readonly reason: BuyRefusalReason; readonly detail: string }
  | { readonly status: 'dry_run'; readonly plan: BuyPlan }
  | {
      readonly status: 'executed';
      readonly txHash: Hex;
      readonly creditOut: bigint;
      readonly activationId: bigint;
    };

const DEFAULT_EVENT_LOOKBACK = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** JSON-safe serialization of a `BuyPlan` for a `dry_run` ledger row's `meta.plan` — every
 *  bigint becomes a decimal string; nothing else. */
function serializePlan(plan: BuyPlan): Record<string, unknown> {
  return {
    dryRun: plan.dryRun,
    usdgIn: plan.usdgIn.toString(),
    minCreditOut: plan.minCreditOut.toString(),
    maxFills: plan.maxFills.toString(),
    quote: { creditOut: plan.quote.creditOut.toString(), fills: plan.quote.fills.toString() },
  };
}

/**
 * The ticket's "orchestrating function": reads the quote and wallet balances live (read-only —
 * never a transaction on this path), calls `planBuy()`, and writes exactly one ledger event for
 * a refusal or dry run — two (`buy` + `activate`, sharing `tx_hash`) for an executed buy — unless
 * `idempotencyKey` already has a `buy` event on file, in which case this makes no ledger writes
 * and no chain calls at all.
 *
 * Audit fix (S-05 audit pass 1, Major): the idempotency lookup, `planBuy()`'s day-cap check, the
 * ledger writes AND the on-chain send (for a live buy) all run inside one
 * `store.withAgentLock(agentId, ...)` call (`LedgerStore.withAgentLock`, ledger/types.ts) —
 * the whole thing is now check-AND-act, not check-then-act. Two concurrent `buyCredit()` calls
 * for the SAME agent (same or different `idempotencyKey`) can never both read the pre-buy state
 * and both pass `planBuy()`'s cap check: the second call's lock body starts only after the
 * first's has fully settled (ledger rows written, on-chain send done or refused), by which point
 * its own idempotency/day-cap reads see the first call's effects. Held duration is irrelevant
 * per the ticket ("1 buy/day cap makes the held duration irrelevant") — `BUY_MAX_PER_DAY` is 1 by
 * default, so a second call for the same agent is expected to be rare, not hot-path-latency-
 * sensitive. Calls for DIFFERENT agents never wait on each other (see `withAgentLock`'s own
 * per-dialect guarantee).
 */
export async function buyCredit(deps: BuyCreditDeps): Promise<BuyCreditResult> {
  if (deps.skipOwnLock) return buyCreditLocked(deps);
  return deps.store.withAgentLock(deps.agentId, () => buyCreditLocked(deps));
}

async function buyCreditLocked(deps: BuyCreditDeps): Promise<BuyCreditResult> {
  const now = deps.now?.() ?? new Date();
  const lookback = deps.eventLookback ?? DEFAULT_EVENT_LOOKBACK;

  const recent = await deps.store.listTreasuryEvents(deps.agentId, lookback);

  const existingBuy = recent.find(
    (e) => e.kind === 'buy' && isRecord(e.meta) && e.meta.idempotencyKey === deps.idempotencyKey,
  );
  if (existingBuy) {
    const activateEvent = recent.find(
      (e) => e.kind === 'activate' && e.txHash !== null && e.txHash === existingBuy.txHash,
    );
    const activationId =
      activateEvent && isRecord(activateEvent.meta) && activateEvent.meta.activationId !== undefined
        ? String(activateEvent.meta.activationId)
        : '';
    return {
      status: 'idempotent_replay',
      txHash: existingBuy.txHash ?? '',
      creditOut: existingBuy.amount ?? '0',
      activationId,
    };
  }

  const buyTimestamps = recent.filter((e) => e.kind === 'buy').map((e) => e.at);

  const [usdgAtomsRaw, ethWei, quoteRaw] = await Promise.all([
    deps.client.readContract({
      address: deps.addresses.usdg,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [deps.hot],
    }),
    deps.client.getBalance({ address: deps.hot }),
    deps.client.readContract({
      address: deps.addresses.exchange,
      abi: exchangeAbi,
      functionName: 'getQuote',
      args: [deps.usdgIn, deps.caps.maxFills],
    }),
  ]);

  const quote = quoteRaw as { creditOut: bigint; fills: bigint };

  const plan = planBuy({
    usdgIn: deps.usdgIn,
    quote: { creditOut: quote.creditOut, fills: quote.fills },
    caps: deps.caps,
    wallet: { usdgAtoms: usdgAtomsRaw as bigint, ethWei },
    history: { buyTimestamps },
    now,
  });

  if (plan.kind === 'refusal') {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'dry_run',
      meta: {
        reason: plan.reason,
        detail: plan.detail,
        usdgIn: deps.usdgIn.toString(),
        idempotencyKey: deps.idempotencyKey,
      },
    });
    return { status: 'refused', reason: plan.reason, detail: plan.detail };
  }

  if (plan.dryRun) {
    await deps.store.insertTreasuryEvent({
      agentId: deps.agentId,
      at: now.toISOString(),
      kind: 'dry_run',
      meta: { plan: serializePlan(plan), idempotencyKey: deps.idempotencyKey },
    });
    return { status: 'dry_run', plan };
  }

  if (!deps.account) {
    throw new Error('buyCredit: caps.treasurerLive is true but no account was supplied');
  }

  const executed = await executeBuy(plan, {
    client: deps.client,
    account: deps.account,
    addresses: deps.addresses,
    hot: deps.hot,
    maxFeeGweiCap: deps.maxFeeGweiCap ?? DEFAULT_MAX_FEE_GWEI,
  });

  await deps.store.insertTreasuryEvent({
    agentId: deps.agentId,
    at: now.toISOString(),
    kind: 'buy',
    amount: executed.creditOut.toString(),
    token: 'CREDIT',
    usdValue: formatDecimal(deps.usdgIn),
    txHash: executed.txHash,
    meta: { idempotencyKey: deps.idempotencyKey },
  });
  await deps.store.insertTreasuryEvent({
    agentId: deps.agentId,
    at: now.toISOString(),
    kind: 'activate',
    amount: executed.creditOut.toString(),
    token: 'CREDIT',
    txHash: executed.txHash,
    meta: { activationId: executed.activationId.toString(), idempotencyKey: deps.idempotencyKey },
  });

  return {
    status: 'executed',
    txHash: executed.txHash,
    creditOut: executed.creditOut,
    activationId: executed.activationId,
  };
}

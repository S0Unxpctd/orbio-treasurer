/**
 * `readTreasury()` — the read-only chain snapshot (S-03, docs/PRD-1.0-sprint.md §3, tasks/S-03.md
 * "In scope"). Every amount is a decimal string of the raw on-chain integer (no floats, no
 * decimal-point scaling here — that's the ledger repository's job at the boundary, per
 * `ledger/decimal.ts`'s `TokenAmount`/`Money` split). RPC results are validated by viem's own
 * ABI decoding (a shape/type mismatch throws viem's typed errors) — see chain/errors.ts's header
 * for why that, not a second Zod pass, is this file's half of CLAUDE.md #6.
 *
 * Multicall: tries `client.multicall()` first (Multicall3 is deployed on 4663, confirmed live —
 * see chain.ts). `allowFailure: true` means a reverting `getQuote` degrades to a `null` quote
 * (AC3) without failing the other 9 reads. viem's `multicall({allowFailure: true})` never
 * throws for a failing/reverting/unavailable aggregate3 call — it converts that into a
 * `{status:'failure'}` entry for every leg instead (confirmed against viem@2.56.8's source;
 * see tasks/S-03.md Test report's "Discovered"). So a genuinely down Multicall3 is detected as
 * *every* leg coming back `'failure'`, not as a thrown error — that (or the multicall call
 * itself throwing, kept as a belt-and-suspenders case for other transports/viem versions) is
 * what falls back to 9 sequential `Promise.allSettled` `readContract` reads through the same
 * fallback client — ticket: "Uses multicall if available on 4663, else sequential with the
 * fallback client". A partial failure (some legs ok, some not) is not treated as "multicall
 * down" and keeps the current per-leg behaviour (quote → null, required legs → typed error).
 */
import type { Address, PublicClient } from 'viem';
import type { ChainAddresses } from './contracts.js';
import { erc20Abi, exchangeAbi, stakingAbi } from './contracts.js';

/** 10 USDG (6 decimals) — the fixed probe amount PRD §3/T-3 quote and AC3 both use. */
export const QUOTE_PROBE_USDG_IN = 10_000_000n;
export const QUOTE_PROBE_MAX_FILLS = 10n;

export interface QuoteResult {
  readonly creditOut: string;
  readonly usdgSpent: string;
  readonly feeAtoms: string;
  readonly fills: string;
  readonly reason: number;
}

export interface ChainSnapshot {
  readonly asOf: string;
  /** `Staking.positionOf(staker)` — raw ORBIO (18 dec). */
  readonly stakedOrbio: string;
  /** `Staking.settledOf(staker)` — raw CREDIT (6 dec) settled/claimable. */
  readonly settledCredit: string;
  /** `CREDIT.balanceOf(hot)` — raw CREDIT (6 dec). */
  readonly creditWalletHot: string;
  /** `CREDIT.balanceOf(staker)` — raw CREDIT (6 dec). */
  readonly creditWalletStaker: string;
  /** `USDG.balanceOf(hot)` — raw USDG (6 dec). */
  readonly usdgBalanceHot: string;
  /** `getBalance(hot)` — raw wei (18 dec). */
  readonly ethBalanceHot: string;
  /** `Exchange.getQuote(10 USDG, 10)`, or `null` if the call reverted (AC3). */
  readonly quote: QuoteResult | null;
  /** `Staking.totalStaked()` — raw ORBIO (18 dec). */
  readonly totalStaked: string;
  /** `Staking.MIN_POSITION()` — raw ORBIO (18 dec); PRD §3: `1000e18`. */
  readonly minPosition: string;
  /** `Staking.PERIOD()` — seconds; PRD §3: `3600`. */
  readonly period: string;
  /** Host of the RPC that answered the last request this snapshot made, if known. */
  readonly rpcUrlHost: string | null;
  /** `true` when the batched `multicall()` path was used; `false` when it fell back to
   *  sequential reads (audit focus: "fallback never loops forever" — this makes the degraded
   *  path visible in the printed/persisted snapshot rather than silent). */
  readonly usedMulticall: boolean;
}

/** The minimal viem `PublicClient` surface `readTreasury()` actually calls — `multicall`,
 *  `readContract` (the sequential fallback) and `getBalance`. S-06 discovery (tasks/S-06.md
 *  Discovered): `tick/tick.ts`'s injectable test client (AC2: "fake chain client") only needs to
 *  satisfy this, not viem's full ~70-member `PublicClient` — narrowed here, rather than at every
 *  call site, so a test fake never has to fake dozens of unrelated methods. Any real
 *  `PublicClient` (the production default, and `read.test.ts`'s/`treasury-read.ts`'s own real
 *  client) already satisfies this structurally, so nothing about `readTreasury()`'s real
 *  behaviour changes. `Pick<PublicClient, ...>`, not a hand-rolled interface (unlike
 *  `chain/buy.ts`'s `BuyExecClient`): viem's `multicall`/`readContract` are heavily overloaded
 *  generics — a hand-rolled simplification of their signature is NOT assignable from a real
 *  `PublicClient` (contravariant parameter mismatch), which would break every real call site.
 *  A plain object-literal test fake therefore still needs an explicit cast to satisfy this exact
 *  type (see `tick/tick.test.ts`'s `fakeClient()`) — the tradeoff is real-client compatibility
 *  everywhere else, which matters far more here. */
export type TreasuryReadClient = Pick<PublicClient, 'multicall' | 'readContract' | 'getBalance'>;

export interface ReadTreasuryOptions {
  readonly hot: Address;
  /** Wallet whose staking position is read. Defaults to the zero address — ticket AC1: "a
   *  zero-position read still returns a well-formed snapshot with zeros" when `STAKER_ADDRESS`
   *  is unset. */
  readonly staker?: Address;
  readonly now?: () => Date;
  /** Read after the call, if the client tracks it (chain.ts's `RpcTracker`). */
  readonly rpcUrlHost?: () => string | null;
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** The 9 non-ETH reads, run one `readContract` call at a time instead of batched through
 *  Multicall3 — the degraded path used when multicall itself is unavailable (see this file's
 *  header comment). */
async function sequentialReadContracts(
  client: TreasuryReadClient,
  contracts: readonly {
    readonly address: Address;
    readonly abi: unknown;
    readonly functionName: string;
    readonly args: readonly unknown[];
  }[],
): Promise<
  readonly ({ status: 'success'; result: unknown } | { status: 'failure'; error: Error })[]
> {
  const settled = await Promise.allSettled(
    contracts.map((c) =>
      client.readContract({
        address: c.address,
        // biome-ignore lint/suspicious/noExplicitAny: heterogeneous ABIs across the 9 legs.
        abi: c.abi as any,
        functionName: c.functionName,
        args: c.args,
      }),
    ),
  );
  return settled.map((s) =>
    s.status === 'fulfilled'
      ? { status: 'success' as const, result: s.value }
      : { status: 'failure' as const, error: s.reason as Error },
  );
}

function toQuoteResult(raw: {
  creditOut: bigint;
  usdgSpent: bigint;
  feeAtoms: bigint;
  fills: bigint;
  reason: number;
}): QuoteResult {
  return {
    creditOut: raw.creditOut.toString(),
    usdgSpent: raw.usdgSpent.toString(),
    feeAtoms: raw.feeAtoms.toString(),
    fills: raw.fills.toString(),
    reason: raw.reason,
  };
}

export async function readTreasury(
  client: TreasuryReadClient,
  addresses: ChainAddresses,
  options: ReadTreasuryOptions,
): Promise<ChainSnapshot> {
  const staker = options.staker ?? ZERO_ADDRESS;
  const hot = options.hot;
  const now = options.now ?? (() => new Date());

  const contracts = [
    { address: addresses.staking, abi: stakingAbi, functionName: 'positionOf', args: [staker] },
    { address: addresses.staking, abi: stakingAbi, functionName: 'settledOf', args: [staker] },
    { address: addresses.credit, abi: erc20Abi, functionName: 'balanceOf', args: [hot] },
    { address: addresses.credit, abi: erc20Abi, functionName: 'balanceOf', args: [staker] },
    { address: addresses.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [hot] },
    {
      address: addresses.exchange,
      abi: exchangeAbi,
      functionName: 'getQuote',
      args: [QUOTE_PROBE_USDG_IN, QUOTE_PROBE_MAX_FILLS],
    },
    { address: addresses.staking, abi: stakingAbi, functionName: 'totalStaked', args: [] },
    { address: addresses.staking, abi: stakingAbi, functionName: 'MIN_POSITION', args: [] },
    { address: addresses.staking, abi: stakingAbi, functionName: 'PERIOD', args: [] },
  ] as const;

  type LegResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

  let results: readonly LegResult[];
  let usedMulticall: boolean;

  try {
    const multicallResults = await client.multicall({
      contracts: [...contracts],
      allowFailure: true,
    });
    if (multicallResults.every((r) => r.status === 'failure')) {
      // `allowFailure: true` means `client.multicall()` never throws for a down/broken
      // Multicall3 — every leg comes back `{status:'failure'}` instead (see this file's header
      // comment). That's indistinguishable, leg-by-leg, from "every read happened to revert",
      // but 9 unrelated reads (5 different contracts) all reverting at once is the Multicall3
      // aggregator being unavailable, not a coincidence — so treat it as the fallback signal and
      // degrade to sequential reads, one `readContract` call at a time, through the same
      // (fallback-wrapped) client.
      results = await sequentialReadContracts(client, contracts);
      usedMulticall = false;
    } else {
      // Partial failure (some legs ok, some not) is a real per-leg result, not "multicall is
      // down" — keep it as-is so quote reverts still degrade to `null` (AC3) and a failing
      // required leg still throws its typed error, without masking either behind a full
      // sequential retry.
      results = multicallResults;
      usedMulticall = true;
    }
  } catch {
    // Belt-and-suspenders: not reachable with viem@2.56.8's `allowFailure: true` (see header
    // comment), but kept in case some other transport/viem version does throw here.
    results = await sequentialReadContracts(client, contracts);
    usedMulticall = false;
  }

  const [
    positionOf,
    settledOf,
    creditHot,
    creditStaker,
    usdgHot,
    quoteRaw,
    totalStaked,
    minPosition,
    period,
  ] = results;

  const ethBalanceHot = await client.getBalance({ address: hot });

  const quote =
    quoteRaw?.status === 'success'
      ? toQuoteResult(
          quoteRaw.result as {
            creditOut: bigint;
            usdgSpent: bigint;
            feeAtoms: bigint;
            fills: bigint;
            reason: number;
          },
        )
      : null;

  return {
    asOf: now().toISOString(),
    stakedOrbio: requireBigint(positionOf, 'positionOf').toString(),
    settledCredit: requireBigint(settledOf, 'settledOf').toString(),
    creditWalletHot: requireBigint(creditHot, 'CREDIT.balanceOf(hot)').toString(),
    creditWalletStaker: requireBigint(creditStaker, 'CREDIT.balanceOf(staker)').toString(),
    usdgBalanceHot: requireBigint(usdgHot, 'USDG.balanceOf(hot)').toString(),
    ethBalanceHot: ethBalanceHot.toString(),
    quote,
    totalStaked: requireBigint(totalStaked, 'totalStaked').toString(),
    minPosition: requireBigint(minPosition, 'MIN_POSITION').toString(),
    period: requireBigint(period, 'PERIOD').toString(),
    rpcUrlHost: options.rpcUrlHost ? options.rpcUrlHost() : null,
    usedMulticall,
  };
}

/** The 8 non-quote reads are required — a revert on any of them (staking/CREDIT/USDG address
 *  misconfigured, wrong ABI) must fail the whole snapshot loudly (CLAUDE.md #6), not be
 *  silently zeroed. Only `getQuote` (handled separately above) is allowed to fail into `null`. */
function requireBigint(
  entry: { status: 'success'; result: unknown } | { status: 'failure'; error: Error } | undefined,
  label: string,
): bigint {
  if (entry?.status !== 'success') {
    const cause = entry?.status === 'failure' ? entry.error : undefined;
    throw new Error(`readTreasury: ${label} failed`, cause ? { cause } : undefined);
  }
  return entry.result as bigint;
}

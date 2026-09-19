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
 * (AC3) without failing the other 9 reads. Only if the multicall call itself throws (a
 * genuinely unavailable/broken multicall, not a single reverting leg) does this fall back to 9
 * sequential `Promise.allSettled` reads through the same fallback client — ticket: "Uses
 * multicall if available on 4663, else sequential with the fallback client".
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
  client: PublicClient,
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

  let results: readonly (
    | { status: 'success'; result: unknown }
    | { status: 'failure'; error: Error }
  )[];
  let usedMulticall: boolean;

  try {
    results = await client.multicall({ contracts: [...contracts], allowFailure: true });
    usedMulticall = true;
  } catch {
    // Multicall itself is unavailable/broken (not: one leg reverted — allowFailure already
    // covers that) — fall back to the same 9 reads run sequentially, one `readContract` call at
    // a time, through the same (fallback-wrapped) client.
    const settled = await Promise.allSettled(
      contracts.map((c) =>
        client.readContract({
          address: c.address,
          abi: c.abi,
          functionName: c.functionName,
          args: c.args as readonly unknown[],
        }),
      ),
    );
    results = settled.map((s) =>
      s.status === 'fulfilled'
        ? { status: 'success' as const, result: s.value }
        : { status: 'failure' as const, error: s.reason as Error },
    );
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

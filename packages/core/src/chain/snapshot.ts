/**
 * `snapshotTreasury()` — calls `readTreasury()` and persists the result through
 * `LedgerStore.insertChainSnapshot()` (S-02) in one step (S-03, tasks/S-03.md "In scope":
 * "readTreasury result persisted through LedgerStore.insertChainSnapshot by a small
 * snapshotTreasury(store, agentId, now) function"). `store` and `agentId` are explicit
 * positional params per the ticket; the clock (`now`) and every other read dependency are
 * grouped into one `params` object rather than a long positional list.
 *
 * Money-vs-TokenAmount conversion at this one boundary (per `ledger/decimal.ts`): `stakedOrbio`,
 * `settledCredit`, `creditWallet`, `ethBalance`, `usdgBalance` are `TokenAmount` (raw integer
 * strings — `insertChainSnapshot()` itself calls `normalizeTokenAmount()`); `creditApiAvailable`/
 * `creditApiUsed`/`quoteCreditPerUsdg` are `Money` (numeric(18,6) decimal strings —
 * `insertChainSnapshot()` calls `normalizeMoney()`). `quoteCreditPerUsdg` needs one conversion
 * here: CREDIT has exactly 6 decimals, the same scale `ledger/decimal.ts`'s `ScaledDecimal`
 * uses for Money, so the raw `creditOut` integer IS already a correctly-scaled `ScaledDecimal` —
 * `formatDecimal(BigInt(creditOut))` turns "13333332" into "13.333332" with no separate
 * decimal-shifting logic to get wrong.
 */
import type { Address, PublicClient } from 'viem';
import { formatDecimal } from '../ledger/decimal.js';
import type { ChainSnapshotRow, Id, LedgerStore } from '../ledger/types.js';
import type { ChainAddresses } from './contracts.js';
import type { ApiBalance } from './key.js';
import type { ChainSnapshot } from './read.js';
import { readTreasury } from './read.js';

export interface SnapshotTreasuryParams {
  readonly client: PublicClient;
  readonly addresses: ChainAddresses;
  readonly hot: Address;
  /** Wallet whose staking position is read; defaults to the zero address in `readTreasury()`. */
  readonly staker?: Address;
  /** `readApiBalance()`'s result, if the caller already fetched it this tick — kept optional
   *  and separate from the chain read (which never touches the gateway) so a gateway outage
   *  never blocks persisting the chain half of the snapshot. */
  readonly apiBalance?: ApiBalance | null;
  readonly mode?: string | null;
  readonly now?: () => Date;
  readonly rpcUrlHost?: () => string | null;
}

export interface SnapshotTreasuryResult {
  readonly snapshot: ChainSnapshot;
  readonly row: ChainSnapshotRow;
}

export async function snapshotTreasury(
  store: LedgerStore,
  agentId: Id,
  params: SnapshotTreasuryParams,
): Promise<SnapshotTreasuryResult> {
  const snapshot = await readTreasury(params.client, params.addresses, {
    hot: params.hot,
    ...(params.staker !== undefined ? { staker: params.staker } : {}),
    ...(params.now !== undefined ? { now: params.now } : {}),
    ...(params.rpcUrlHost !== undefined ? { rpcUrlHost: params.rpcUrlHost } : {}),
  });

  const row = await store.insertChainSnapshot({
    agentId,
    asOf: snapshot.asOf,
    stakedOrbio: snapshot.stakedOrbio,
    settledCredit: snapshot.settledCredit,
    creditWallet: snapshot.creditWalletHot,
    creditApiAvailable: params.apiBalance?.available ?? null,
    creditApiUsed: params.apiBalance?.used ?? null,
    quoteCreditPerUsdg: snapshot.quote ? formatDecimal(BigInt(snapshot.quote.creditOut)) : null,
    ethBalance: snapshot.ethBalanceHot,
    usdgBalance: snapshot.usdgBalanceHot,
    mode: params.mode ?? null,
    rpcUrlHost: snapshot.rpcUrlHost,
  });

  return { snapshot, row };
}

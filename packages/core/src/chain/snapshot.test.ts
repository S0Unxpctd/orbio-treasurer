/**
 * snapshot.ts — `snapshotTreasury()` persists a `readTreasury()` result through
 * `LedgerStore.insertChainSnapshot()` (S-02) (S-03, tasks/S-03.md "In scope"). Uses a real
 * in-memory SQLite `LedgerStore` (the ticket's own S-02 dependency) and a fake `PublicClient`
 * (same technique as read.test.ts) — no network.
 */
import type { Address, PublicClient } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import type { ChainAddresses } from './contracts.js';
import { snapshotTreasury } from './snapshot.js';

const ADDRESSES: ChainAddresses = {
  credit: '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C',
  staking: '0xE0710011278BFb63E57C5f227E5980984B1EDDca',
  exchange: '0x6951fFd32630b05e06F50062AEA801625A58eBC0',
  orbio: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  payout: '0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5',
};
const HOT: Address = '0x1111111111111111111111111111111111111111';

function ok(result: unknown) {
  return { status: 'success' as const, result };
}

/** Same 9-leg order as read.ts's `contracts` array. */
function fakeClient(overrides: {
  quote?: unknown;
  totalStaked?: bigint;
  ethBalance?: bigint;
}): PublicClient {
  const results = [
    ok(12_000000000000000000n), // positionOf -> stakedOrbio (18dp)
    ok(500000n), // settledOf -> settledCredit (6dp)
    ok(2500000n), // creditHot -> creditWalletHot (6dp)
    ok(0n), // creditStaker
    ok(9000000n), // usdgHot -> usdgBalanceHot (6dp)
    ok(
      overrides.quote ?? {
        creditOut: 13333332n,
        usdgSpent: 10000000n,
        feeAtoms: 0n,
        fills: 2n,
        reason: 0,
      },
    ),
    ok(overrides.totalStaked ?? 355360274239331697639652256n),
    ok(1000000000000000000000n), // MIN_POSITION
    ok(3600n), // PERIOD
  ];
  const multicall = async () => results;
  const getBalance = async () => overrides.ethBalance ?? 123456789012345678n;
  return { multicall, getBalance } as unknown as PublicClient;
}

describe('snapshotTreasury', () => {
  let store: LedgerStore;
  let agentId: string;

  beforeEach(async () => {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s03-${Math.random()}`,
      name: 'S-03 test agent',
      mode: 'dry_run',
    });
    agentId = agent.id;
  });

  it('persists TokenAmount fields as raw integer strings (no decimal point)', async () => {
    const client = fakeClient({});
    const { row } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
    });

    expect(row.stakedOrbio).toBe('12000000000000000000');
    expect(row.settledCredit).toBe('500000');
    expect(row.creditWallet).toBe('2500000'); // creditWalletHot, per S-02's single creditWallet column
    expect(row.ethBalance).toBe('123456789012345678');
    expect(row.usdgBalance).toBe('9000000');
  });

  it('converts the raw CREDIT-out quote (6dp integer) to a 6dp Money decimal string', async () => {
    const client = fakeClient({
      quote: { creditOut: 13333332n, usdgSpent: 10000000n, feeAtoms: 0n, fills: 2n, reason: 0 },
    });
    const { row } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
    });
    expect(row.quoteCreditPerUsdg).toBe('13.333332');
  });

  it('quoteCreditPerUsdg is null when the quote reverted', async () => {
    const client = {
      multicall: async () => [
        ok(0n),
        ok(0n),
        ok(0n),
        ok(0n),
        ok(0n),
        { status: 'failure' as const, error: new Error('reverted') },
        ok(0n),
        ok(1000000000000000000000n),
        ok(3600n),
      ],
      getBalance: async () => 0n,
    } as unknown as PublicClient;
    const { row } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
    });
    expect(row.quoteCreditPerUsdg).toBeNull();
  });

  it('creditApiAvailable/Used are null when no apiBalance is given, set (as Money) when it is', async () => {
    const client = fakeClient({});
    const { row: withoutBalance } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
    });
    expect(withoutBalance.creditApiAvailable).toBeNull();
    expect(withoutBalance.creditApiUsed).toBeNull();

    const { row: withBalance } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
      apiBalance: { available: '12.34', used: '0.66' },
    });
    expect(withBalance.creditApiAvailable).toBe('12.340000');
    expect(withBalance.creditApiUsed).toBe('0.660000');
  });

  it('mode and rpcUrlHost pass through', async () => {
    const client = fakeClient({});
    const { row } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
      mode: 'normal',
      rpcUrlHost: () => 'robinhood-rpc.publicnode.com',
    });
    expect(row.mode).toBe('normal');
    expect(row.rpcUrlHost).toBe('robinhood-rpc.publicnode.com');
  });

  it('the persisted row round-trips through latestChainSnapshot', async () => {
    const client = fakeClient({});
    const { row } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
    });
    const latest = await store.latestChainSnapshot(agentId);
    expect(latest?.id).toBe(row.id);
  });

  it('returns the raw ChainSnapshot alongside the persisted row (asOf matches)', async () => {
    const client = fakeClient({});
    const { snapshot, row } = await snapshotTreasury(store, agentId, {
      client,
      addresses: ADDRESSES,
      hot: HOT,
    });
    expect(snapshot.asOf).toBe(row.asOf);
  });
});

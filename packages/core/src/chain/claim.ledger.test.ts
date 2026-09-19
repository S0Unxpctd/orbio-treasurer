/**
 * claimAndActivate() against a real SQLite LedgerStore (S-04, tasks/S-04.md "Tests required":
 * "chain/claim.ledger.test.ts"; AC3, AC4, AC5). Every chain call still goes through a fake
 * `ClaimExecClient` — this file's own contribution over claim.test.ts is proving the LEDGER
 * side: exactly 1 row for a dry run, 3 rows sharing `meta.idempotencyKey` (each with its own
 * `tx_hash`) for a full staker_key success, 1 `alert` row for the manual leg, 1 `activate` row
 * for the hot leg, and zero extra rows/chain calls on an idempotent replay. Also asserts no
 * private key ever reaches a ledger row (AC5).
 */
import type { Address, Hex, TransactionReceipt } from 'viem';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import type { ClaimAndActivateDeps, ClaimCaps, ClaimExecClient } from './claim.js';
import { claimAndActivate, resolveClaimCaps } from './claim.js';
import { creditAbi } from './contracts.js';

const HOT: Address = '0x1111111111111111111111111111111111111111';
const STAKER: Address = '0x2222222222222222222222222222222222222222';

const ADDRESSES = {
  credit: '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C' as Address,
  staking: '0xE0710011278BFb63E57C5f227E5980984B1EDDca' as Address,
  exchange: '0x6951fFd32630b05e06F50062AEA801625A58eBC0' as Address,
  orbio: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3' as Address,
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address,
  payout: '0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5' as Address,
};

const SETTLE_HASH: Hex = `0x${'1'.repeat(64)}`;
const CLAIM_HASH: Hex = `0x${'2'.repeat(64)}`;
const ACTIVATE_HASH: Hex = `0x${'3'.repeat(64)}`;

function buildActivatedLog(address: Address, activationId: bigint, amount: bigint) {
  const topics = encodeEventTopics({
    abi: creditAbi,
    eventName: 'Activated',
    args: {
      activationId,
      from: STAKER,
      beneficiary: `0x${'0'.repeat(24)}${HOT.slice(2).toLowerCase()}` as Hex,
    },
  });
  const data = encodeAbiParameters([{ type: 'uint256', name: 'amount' }], [amount]);
  return { address, topics, data };
}

/** Distinguishes `CREDIT.balanceOf(staker)` from `CREDIT.balanceOf(hot)` by call ARGS, not
 *  address — both calls target the same CREDIT contract address. */
function fakeClientWithBalances(opts: {
  settledOf?: bigint;
  creditBalanceStaker?: bigint;
  creditBalanceHot?: bigint;
  stakerEthWei?: bigint;
  hotEthWei?: bigint;
}): { client: ClaimExecClient; writeContract: ReturnType<typeof vi.fn> } {
  const readContract = vi.fn(async (args: { functionName: string; args: readonly unknown[] }) => {
    if (args.functionName === 'settledOf') return opts.settledOf ?? 0n;
    if (args.functionName === 'balanceOf') {
      const target = (args.args[0] as string).toLowerCase();
      if (target === STAKER.toLowerCase()) return opts.creditBalanceStaker ?? 0n;
      if (target === HOT.toLowerCase()) return opts.creditBalanceHot ?? 0n;
      throw new Error(`fakeClientWithBalances: unexpected balanceOf target ${target}`);
    }
    throw new Error(`fakeClientWithBalances: unexpected readContract ${args.functionName}`);
  });
  const getBalance = vi.fn(async (args: { address: Address }) => {
    if (args.address.toLowerCase() === STAKER.toLowerCase()) return opts.stakerEthWei ?? 10n ** 18n;
    return opts.hotEthWei ?? 10n ** 18n;
  });
  const writeContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'settle') return SETTLE_HASH;
    if (args.functionName === 'claim') return CLAIM_HASH;
    if (args.functionName === 'activate') return ACTIVATE_HASH;
    throw new Error(`fakeClientWithBalances: unexpected writeContract ${args.functionName}`);
  });
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (hash === ACTIVATE_HASH) {
      return {
        status: 'success',
        logs: [buildActivatedLog(ADDRESSES.credit, 9n, 12_000_000n)],
        transactionHash: hash,
      } as unknown as TransactionReceipt;
    }
    return { status: 'success', logs: [], transactionHash: hash } as unknown as TransactionReceipt;
  });

  return {
    client: { readContract, getBalance, writeContract, waitForTransactionReceipt },
    writeContract,
  };
}

function dryCaps(overrides: Partial<ClaimCaps> = {}): ClaimCaps {
  return { ...resolveClaimCaps({ env: { TREASURER_LIVE: false } }), ...overrides };
}
function liveCaps(overrides: Partial<ClaimCaps> = {}): ClaimCaps {
  return { ...resolveClaimCaps({ env: { TREASURER_LIVE: true } }), ...overrides };
}

describe('claimAndActivate — ledger rows (S-04 AC3, AC4, AC5)', () => {
  let store: LedgerStore;

  afterEach(async () => {
    await store?.close();
  });

  async function seedAgent(): Promise<string> {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s04-${Math.random().toString(36).slice(2)}`,
      name: 'S-04 claim test agent',
      mode: 'dry_run',
    });
    return agent.id;
  }

  it('AC4: TREASURER_LIVE unset -> caps.treasurerLive=false -> writeContract is never called', async () => {
    const agentId = await seedAgent();
    const { client, writeContract } = fakeClientWithBalances({ settledOf: 10_000_000n });
    const result = await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      account: { address: STAKER } as never,
      periodIdsToSettle: [],
      caps: dryCaps(),
      idempotencyKey: 'tick-1',
    });
    expect(writeContract).not.toHaveBeenCalled();
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]?.status).toBe('dry_run');
  });

  it('AC3: dry-run staker_key flow writes exactly 1 treasury_events row', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClientWithBalances({ settledOf: 10_000_000n });
    await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      account: { address: STAKER } as never,
      periodIdsToSettle: [],
      caps: dryCaps(),
      idempotencyKey: 'tick-2',
    });
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('dry_run');
  });

  it('AC3: full live success writes 3 rows (settle, claim, activate) sharing meta.idempotencyKey, each with its own tx_hash', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClientWithBalances({
      settledOf: 10_000_000n,
      creditBalanceStaker: 2_000_000n,
    });
    const result = await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      account: { address: STAKER } as never,
      periodIdsToSettle: [10n, 11n],
      caps: liveCaps(),
      idempotencyKey: 'tick-3',
    });
    expect(result.legs[0]?.status).toBe('executed');
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(3);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['activate', 'claim', 'settle']);
    const key = (rows[0]?.meta as { idempotencyKey?: string } | null)?.idempotencyKey;
    expect(key).toBe('tick-3');
    for (const row of rows) {
      expect((row.meta as { idempotencyKey?: string } | null)?.idempotencyKey).toBe('tick-3');
    }
    const txHashes = new Set(rows.map((r) => r.txHash));
    expect(txHashes.size).toBe(3); // each row has its OWN tx_hash
    expect(txHashes.has(SETTLE_HASH)).toBe(true);
    expect(txHashes.has(CLAIM_HASH)).toBe(true);
    expect(txHashes.has(ACTIVATE_HASH)).toBe(true);
  });

  it('re-call with the same idempotencyKey -> no new rows, no new chain calls', async () => {
    const agentId = await seedAgent();
    const { client, writeContract } = fakeClientWithBalances({
      settledOf: 10_000_000n,
      creditBalanceStaker: 2_000_000n,
    });
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      account: { address: STAKER } as never,
      periodIdsToSettle: [10n, 11n],
      caps: liveCaps(),
      idempotencyKey: 'tick-4',
    };
    await claimAndActivate(deps);
    const rowsAfterFirst = await store.listTreasuryEvents(agentId, 50);
    expect(rowsAfterFirst).toHaveLength(3);

    writeContract.mockClear();
    const replay = await claimAndActivate(deps);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.legs).toEqual([]);
    expect(writeContract).not.toHaveBeenCalled();
    const rowsAfterSecond = await store.listTreasuryEvents(agentId, 50);
    expect(rowsAfterSecond).toHaveLength(3); // unchanged
  });

  it('manual leg (staker address only, no key): nothing claimable -> no_op, no rows', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClientWithBalances({
      settledOf: 0n,
      creditBalanceStaker: 0n,
      creditBalanceHot: 0n,
    });
    const result = await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      periodIdsToSettle: [],
      caps: dryCaps(),
      idempotencyKey: 'tick-5',
    });
    expect(result.legs).toEqual([{ leg: 'staker', status: 'no_op', detail: expect.any(String) }]);
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(0);
  });

  it('manual leg: settledOf > 0 -> exactly ONE alert row with meta.manual.step="claim"', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClientWithBalances({ settledOf: 5_000_000n, creditBalanceHot: 0n });
    const result = await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      periodIdsToSettle: [],
      caps: dryCaps(),
      idempotencyKey: 'tick-6',
    });
    const stakerLeg = result.legs.find((l) => l.leg === 'staker');
    expect(stakerLeg?.status).toBe('alerted');
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('alert');
    const manual = (
      rows[0]?.meta as { manual?: { step?: string; explorerWriteUrl?: string } } | null
    )?.manual;
    expect(manual?.step).toBe('claim');
    expect(manual?.explorerWriteUrl).toMatch(/^https:\/\/robin\.etherscan\.io\/address\//);
  });

  it('manual leg + independent hot_activate leg can BOTH fire in the same tick', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClientWithBalances({
      settledOf: 5_000_000n,
      creditBalanceHot: 8_000_000n,
    });
    const result = await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      hotAccount: { address: HOT } as never,
      periodIdsToSettle: [],
      caps: liveCaps(),
      idempotencyKey: 'tick-7',
    });
    expect(result.legs).toHaveLength(2);
    const stakerLeg = result.legs.find((l) => l.leg === 'staker');
    const hotLeg = result.legs.find((l) => l.leg === 'hot');
    expect(stakerLeg?.status).toBe('alerted');
    expect(hotLeg?.status).toBe('executed');
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(['activate', 'alert']);
  });

  it('hot_activate leg alone (no staker configured at all): live -> 1 activate row with tx_hash', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClientWithBalances({ creditBalanceHot: 12_000_000n });
    const result = await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      hotAccount: { address: HOT } as never,
      periodIdsToSettle: [],
      caps: liveCaps(),
      idempotencyKey: 'tick-8',
    });
    expect(result.legs).toEqual([
      { leg: 'hot', status: 'executed', txHash: ACTIVATE_HASH, amount: 12_000_000n },
    ]);
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('activate');
    expect(rows[0]?.txHash).toBe(ACTIVATE_HASH);
  });

  it('nothing configured at all, nothing on hot -> single reported no_op leg, zero rows', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClientWithBalances({ creditBalanceHot: 0n });
    const result = await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      periodIdsToSettle: [],
      caps: dryCaps(),
      idempotencyKey: 'tick-9',
    });
    expect(result.legs).toEqual([{ leg: 'staker', status: 'no_op', detail: expect.any(String) }]);
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(0);
  });

  it('AC5: no private key material appears in any ledger row, even if the caller mistakenly attached one to the account object', async () => {
    const agentId = await seedAgent();
    // Shape of a real private key, never a real one — simulates a caller bug where a raw key
    // ends up attached to the (viem `Account`-shaped) object claim.ts is handed. `claim.ts`
    // never reads anything off `account` besides what `writeContract` itself needs (its
    // `.address`), so a stray extra field like this can never reach a ledger row.
    const FAKE_PK = `0x${'ab'.repeat(32)}`;
    const accountWithExtraField = { address: STAKER, privateKey: FAKE_PK } as never;
    const { client } = fakeClientWithBalances({
      settledOf: 10_000_000n,
      creditBalanceStaker: 2_000_000n,
    });
    await claimAndActivate({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      staker: STAKER,
      account: accountWithExtraField,
      periodIdsToSettle: [10n, 11n],
      caps: liveCaps(),
      idempotencyKey: 'tick-10',
    });
    const rows = await store.listTreasuryEvents(agentId, 50);
    expect(rows).toHaveLength(3);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(FAKE_PK);
  });
});

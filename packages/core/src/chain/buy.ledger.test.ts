/**
 * buyCredit() against a real SQLite LedgerStore (S-05, tasks/S-05.md "Tests required":
 * "chain/buy.ledger.test.ts"; AC3, AC4). Every chain call still goes through a fake
 * `BuyExecClient` — this file's own contribution over buy.test.ts is proving the *ledger* side:
 * exactly one row for a refusal, one for a not-executed dry run, two (sharing `tx_hash`) for an
 * executed buy, and zero extra rows/chain calls on an idempotent replay.
 */
import type { Address, Hex, TransactionReceipt } from 'viem';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import type { BuyCaps, BuyExecClient } from './buy.js';
import { addressToBeneficiary, buyCredit, DEFAULT_MAX_FEE_GWEI, resolveBuyCaps } from './buy.js';
import type { ChainAddresses } from './contracts.js';
import { creditAbi } from './contracts.js';

const HOT: Address = '0x1111111111111111111111111111111111111111';
const ADDRESSES: ChainAddresses = {
  credit: '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C',
  staking: '0xE0710011278BFb63E57C5f227E5980984B1EDDca',
  exchange: '0x6951fFd32630b05e06F50062AEA801625A58eBC0',
  orbio: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  payout: '0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5',
};

const APPROVE_HASH: Hex = `0x${'1'.repeat(64)}`;
const BUY_HASH: Hex = `0x${'2'.repeat(64)}`;

function buildActivatedLog(activationId: bigint, amount: bigint) {
  const topics = encodeEventTopics({
    abi: creditAbi,
    eventName: 'Activated',
    args: { activationId, from: HOT, beneficiary: addressToBeneficiary(HOT) },
  });
  const data = encodeAbiParameters([{ type: 'uint256', name: 'amount' }], [amount]);
  return { address: ADDRESSES.credit, topics, data };
}

/** A passing quote: 10 USDG in, ~33% discount (the live 2026-09-19 fixture reused from
 *  read.test.ts/buy.test.ts). */
const QUOTE = {
  creditOut: 13_333_332n,
  usdgSpent: 10_000_000n,
  feeAtoms: 0n,
  fills: 2n,
  reason: 0,
};

function fakeClient(opts: {
  usdgBalance?: bigint;
  ethBalance?: bigint;
  allowance?: bigint;
  quote?: typeof QUOTE;
}): {
  client: BuyExecClient;
  writeContract: ReturnType<typeof vi.fn>;
  readContract: ReturnType<typeof vi.fn>;
} {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'balanceOf') return opts.usdgBalance ?? 1_000_000_000n;
    if (args.functionName === 'getQuote') return opts.quote ?? QUOTE;
    if (args.functionName === 'allowance') return opts.allowance ?? 0n;
    throw new Error(`fakeClient: unexpected readContract ${args.functionName}`);
  });
  const getBalance = vi.fn(async () => opts.ethBalance ?? 10n ** 18n);
  const writeContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'approve') return APPROVE_HASH;
    if (args.functionName === 'buyAndActivate') return BUY_HASH;
    throw new Error(`fakeClient: unexpected writeContract ${args.functionName}`);
  });
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (hash === APPROVE_HASH) {
      return { status: 'success', logs: [] } as unknown as TransactionReceipt;
    }
    return {
      status: 'success',
      logs: [buildActivatedLog(7n, 13_066_665n)],
    } as unknown as TransactionReceipt;
  });
  return {
    client: { readContract, getBalance, writeContract, waitForTransactionReceipt },
    writeContract,
    readContract,
  };
}

function dryCaps(overrides: Partial<BuyCaps> = {}): BuyCaps {
  return { ...resolveBuyCaps({ env: { TREASURER_LIVE: false } }), ...overrides };
}
function liveCaps(overrides: Partial<BuyCaps> = {}): BuyCaps {
  return { ...resolveBuyCaps({ env: { TREASURER_LIVE: true } }), ...overrides };
}

describe('buyCredit — ledger rows (S-05 AC3, AC4)', () => {
  let store: LedgerStore;

  afterEach(async () => {
    await store?.close();
  });

  async function seedAgent(): Promise<string> {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s05-${Math.random().toString(36).slice(2)}`,
      name: 'S-05 buy test agent',
      mode: 'dry_run',
    });
    return agent.id;
  }

  it('AC4: with TREASURER_LIVE unset (caps.treasurerLive=false), the whole flow never calls writeContract', async () => {
    const agentId = await seedAgent();
    const { client, writeContract } = fakeClient({});
    const result = await buyCredit({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      usdgIn: 10_000_000n,
      caps: dryCaps(),
      idempotencyKey: 'tick-1',
    });
    expect(result.status).toBe('dry_run');
    expect(writeContract).toHaveBeenCalledTimes(0);
  });

  it('a refusal writes exactly one dry_run row with meta.reason, and never calls writeContract', async () => {
    const agentId = await seedAgent();
    const { client, writeContract } = fakeClient({ usdgBalance: 0n }); // insufficient balance
    const result = await buyCredit({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      usdgIn: 10_000_000n,
      caps: dryCaps(),
      idempotencyKey: 'tick-refuse',
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('insufficient_usdg_balance');

    const events = await store.listTreasuryEvents(agentId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('dry_run');
    expect((events[0]?.meta as { reason?: string })?.reason).toBe('insufficient_usdg_balance');
    expect(writeContract).toHaveBeenCalledTimes(0);
  });

  it('a not-executed dry run (live off) writes exactly one dry_run row with meta.plan', async () => {
    const agentId = await seedAgent();
    const { client } = fakeClient({});
    await buyCredit({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      usdgIn: 10_000_000n,
      caps: dryCaps(),
      idempotencyKey: 'tick-dry',
    });
    const events = await store.listTreasuryEvents(agentId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('dry_run');
    const meta = events[0]?.meta as { plan?: { usdgIn?: string } };
    expect(meta.plan?.usdgIn).toBe('10000000');
  });

  it('an executed buy writes a buy row + an activate row sharing tx_hash', async () => {
    const agentId = await seedAgent();
    const { client, writeContract } = fakeClient({});
    const result = await buyCredit({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      account: { address: HOT } as never,
      usdgIn: 10_000_000n,
      caps: liveCaps(),
      idempotencyKey: 'tick-live-1',
    });
    expect(result.status).toBe('executed');
    if (result.status !== 'executed') throw new Error('unreachable');
    expect(result.txHash).toBe(BUY_HASH);
    expect(result.creditOut).toBe(13_066_665n);
    expect(result.activationId).toBe(7n);
    expect(writeContract).toHaveBeenCalledTimes(2); // approve + buyAndActivate (allowance was 0)

    const events = await store.listTreasuryEvents(agentId, 10);
    expect(events).toHaveLength(2);
    const buyEvent = events.find((e) => e.kind === 'buy');
    const activateEvent = events.find((e) => e.kind === 'activate');
    expect(buyEvent).toBeDefined();
    expect(activateEvent).toBeDefined();
    expect(buyEvent?.txHash).toBe(BUY_HASH);
    expect(activateEvent?.txHash).toBe(BUY_HASH);
    expect(buyEvent?.amount).toBe('13066665');
    expect(buyEvent?.usdValue).toBe('10.000000');
    expect((activateEvent?.meta as { activationId?: string })?.activationId).toBe('7');
  });

  it('an idempotent re-call (same idempotencyKey) returns the same result with NO new rows and NO new chain calls', async () => {
    const agentId = await seedAgent();
    const { client, writeContract, readContract } = fakeClient({});
    const first = await buyCredit({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      account: { address: HOT } as never,
      usdgIn: 10_000_000n,
      caps: liveCaps(),
      idempotencyKey: 'tick-live-replay',
    });
    expect(first.status).toBe('executed');

    const rowsAfterFirst = await store.listTreasuryEvents(agentId, 10);
    expect(rowsAfterFirst).toHaveLength(2);
    const writeCallsAfterFirst = writeContract.mock.calls.length;
    const readCallsAfterFirst = readContract.mock.calls.length;

    const second = await buyCredit({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      account: { address: HOT } as never,
      usdgIn: 10_000_000n,
      caps: liveCaps(),
      idempotencyKey: 'tick-live-replay', // same key
    });

    expect(second.status).toBe('idempotent_replay');
    if (first.status !== 'executed' || second.status !== 'idempotent_replay') {
      throw new Error('unreachable');
    }
    expect(second.txHash).toBe(first.txHash);
    expect(second.creditOut).toBe(first.creditOut.toString());
    expect(second.activationId).toBe(first.activationId.toString());

    const rowsAfterSecond = await store.listTreasuryEvents(agentId, 10);
    expect(rowsAfterSecond).toHaveLength(2); // no new rows
    expect(writeContract.mock.calls.length).toBe(writeCallsAfterFirst); // no new writes
    expect(readContract.mock.calls.length).toBe(readCallsAfterFirst); // no new chain reads either
  });

  it('a refusal is NOT deduped by idempotencyKey — a retry under the same key can still succeed once the cause clears', async () => {
    const agentId = await seedAgent();
    const refusing = fakeClient({ usdgBalance: 0n });
    const refused = await buyCredit({
      store,
      agentId,
      client: refusing.client,
      addresses: ADDRESSES,
      hot: HOT,
      usdgIn: 10_000_000n,
      caps: dryCaps(),
      idempotencyKey: 'tick-retry',
    });
    expect(refused.status).toBe('refused');

    const passing = fakeClient({}); // now the wallet has enough USDG
    const retried = await buyCredit({
      store,
      agentId,
      client: passing.client,
      addresses: ADDRESSES,
      hot: HOT,
      usdgIn: 10_000_000n,
      caps: dryCaps(),
      idempotencyKey: 'tick-retry', // same key as the refusal
    });
    expect(retried.status).toBe('dry_run'); // not blocked by the earlier refusal

    const events = await store.listTreasuryEvents(agentId, 10);
    expect(events).toHaveLength(2); // the refusal row + the dry_run row — both kept
  });

  it("MAX_FEE_GWEI default is used when buyCredit()'s deps omit it", async () => {
    const agentId = await seedAgent();
    const { client, writeContract } = fakeClient({});
    await buyCredit({
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      account: { address: HOT } as never,
      usdgIn: 10_000_000n,
      caps: liveCaps(),
      idempotencyKey: 'tick-fee-default',
    });
    const buyCall = writeContract.mock.calls.find(
      (c) => c[0]?.functionName === 'buyAndActivate',
    )?.[0];
    expect(buyCall.maxFeePerGas).toBeLessThanOrEqual(BigInt(DEFAULT_MAX_FEE_GWEI) * 1_000_000_000n);
  });
});

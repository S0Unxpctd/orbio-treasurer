/**
 * read.ts — `readTreasury()` (S-03, tasks/S-03.md "Tests required": "chain/read.test.ts (fake
 * transport, fixtures from the live reads, dated 2026-09-19)"). Every fixture value below is
 * taken verbatim from the live read recorded 2026-09-19 in docs/api-notes.md "S-03 chain reads"
 * (staking totals, MIN_POSITION, PERIOD, the 10-USDG quote, and the zero address's real ETH
 * balance on 4663) — this file fakes the *client* (its `multicall`/`readContract`/`getBalance`
 * methods), not the numbers, so a fixture drifting from what the chain actually said would be
 * an easy, deliberate lie to catch in review.
 */
import type { Address, PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { ChainAddresses } from './contracts.js';
import { readTreasury } from './read.js';

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
const STAKER: Address = '0x2222222222222222222222222222222222222222';

// Live 2026-09-19 fixture values (docs/api-notes.md "S-03 chain reads"):
const LIVE_TOTAL_STAKED = 355360274239331697639652256n;
const LIVE_MIN_POSITION = 1000000000000000000000n; // 1000e18
const LIVE_PERIOD = 3600n;
const LIVE_QUOTE = {
  creditOut: 13333332n,
  usdgSpent: 10000000n,
  feeAtoms: 0n,
  fills: 2n,
  reason: 0,
};
const LIVE_ZERO_ADDRESS_ETH_BALANCE = 4986956241336233746n;

/** The order `readTreasury()` builds its 9-leg `contracts` array in — every fake client below
 *  returns results/errors in this exact order. */
const ORDER = [
  'positionOf',
  'settledOf',
  'creditHot',
  'creditStaker',
  'usdgHot',
  'quote',
  'totalStaked',
  'minPosition',
  'period',
] as const;

function ok(result: unknown) {
  return { status: 'success' as const, result };
}
function fail(message: string) {
  return { status: 'failure' as const, error: new Error(message) };
}

const HAPPY_PATH_RESULTS = {
  positionOf: ok(0n),
  settledOf: ok(0n),
  creditHot: ok(0n),
  creditStaker: ok(0n),
  usdgHot: ok(0n),
  quote: ok(LIVE_QUOTE),
  totalStaked: ok(LIVE_TOTAL_STAKED),
  minPosition: ok(LIVE_MIN_POSITION),
  period: ok(LIVE_PERIOD),
};

function fakeClient(opts: {
  results?: Partial<
    Record<(typeof ORDER)[number], ReturnType<typeof ok> | ReturnType<typeof fail>>
  >;
  multicallThrows?: boolean;
  ethBalance?: bigint;
}): PublicClient {
  const results = { ...HAPPY_PATH_RESULTS, ...opts.results };
  const orderedResults = ORDER.map((key) => results[key]);

  const multicall = vi.fn(async () => {
    if (opts.multicallThrows) throw new Error('multicall unavailable');
    return orderedResults;
  });

  // Sequential fallback: readContract is called once per leg, in the same order, and must
  // return the *unwrapped* value (readContract throws on failure, unlike multicall's
  // allowFailure array) — mirroring viem's real per-call semantics.
  let sequentialCallIndex = 0;
  const readContract = vi.fn(async () => {
    const entry = orderedResults[sequentialCallIndex];
    sequentialCallIndex++;
    if (!entry) throw new Error('fakeClient: too many sequential readContract calls');
    if (entry.status === 'failure') throw entry.error;
    return entry.result;
  });

  const getBalance = vi.fn(async () => opts.ethBalance ?? LIVE_ZERO_ADDRESS_ETH_BALANCE);

  return { multicall, readContract, getBalance } as unknown as PublicClient;
}

describe('readTreasury — multicall happy path (live 2026-09-19 fixture values)', () => {
  it('returns a fully populated snapshot, using multicall', async () => {
    const client = fakeClient({});
    const snapshot = await readTreasury(client, ADDRESSES, { hot: HOT, staker: STAKER });

    expect(snapshot.usedMulticall).toBe(true);
    expect(snapshot.stakedOrbio).toBe('0');
    expect(snapshot.settledCredit).toBe('0');
    expect(snapshot.creditWalletHot).toBe('0');
    expect(snapshot.creditWalletStaker).toBe('0');
    expect(snapshot.usdgBalanceHot).toBe('0');
    expect(snapshot.ethBalanceHot).toBe(LIVE_ZERO_ADDRESS_ETH_BALANCE.toString());
    expect(snapshot.totalStaked).toBe(LIVE_TOTAL_STAKED.toString());
    expect(snapshot.minPosition).toBe(LIVE_MIN_POSITION.toString());
    expect(snapshot.period).toBe(LIVE_PERIOD.toString());
    expect(snapshot.quote).toEqual({
      creditOut: '13333332',
      usdgSpent: '10000000',
      feeAtoms: '0',
      fills: '2',
      reason: 0,
    });
    expect(new Date(snapshot.asOf).toISOString()).toBe(snapshot.asOf);
  });

  it('defaults staker to the zero address and still returns a well-formed snapshot (AC1)', async () => {
    const client = fakeClient({});
    const snapshot = await readTreasury(client, ADDRESSES, { hot: HOT });
    expect(snapshot.stakedOrbio).toBe('0');
    expect(snapshot.settledCredit).toBe('0');
  });

  it('uses the injected clock, never the real one', async () => {
    const client = fakeClient({});
    const fixed = new Date('2026-09-19T00:00:00.000Z');
    const snapshot = await readTreasury(client, ADDRESSES, {
      hot: HOT,
      staker: STAKER,
      now: () => fixed,
    });
    expect(snapshot.asOf).toBe('2026-09-19T00:00:00.000Z');
  });

  it('reports rpcUrlHost from the injected callback', async () => {
    const client = fakeClient({});
    const snapshot = await readTreasury(client, ADDRESSES, {
      hot: HOT,
      staker: STAKER,
      rpcUrlHost: () => 'robinhood-rpc.publicnode.com',
    });
    expect(snapshot.rpcUrlHost).toBe('robinhood-rpc.publicnode.com');
  });

  it('rpcUrlHost is null when no callback is given', async () => {
    const client = fakeClient({});
    const snapshot = await readTreasury(client, ADDRESSES, { hot: HOT, staker: STAKER });
    expect(snapshot.rpcUrlHost).toBeNull();
  });
});

describe('readTreasury — quote revert (AC3: null, not a thrown error)', () => {
  it('a reverting getQuote degrades to quote: null while every other field still populates', async () => {
    const client = fakeClient({
      results: { quote: fail('execution reverted') },
    });
    const snapshot = await readTreasury(client, ADDRESSES, { hot: HOT, staker: STAKER });
    expect(snapshot.quote).toBeNull();
    expect(snapshot.totalStaked).toBe(LIVE_TOTAL_STAKED.toString());
    expect(snapshot.usedMulticall).toBe(true);
  });
});

describe('readTreasury — a non-quote leg failing is fatal (CLAUDE.md #6: fail loudly)', () => {
  it('throws if positionOf (or any of the other 8 required reads) fails', async () => {
    const client = fakeClient({
      results: { positionOf: fail('execution reverted') },
    });
    await expect(readTreasury(client, ADDRESSES, { hot: HOT, staker: STAKER })).rejects.toThrow(
      /positionOf/,
    );
  });
});

describe('readTreasury — sequential fallback when multicall itself is unavailable', () => {
  it('falls back to sequential reads and still returns the same values, with usedMulticall: false', async () => {
    const client = fakeClient({ multicallThrows: true });
    const snapshot = await readTreasury(client, ADDRESSES, { hot: HOT, staker: STAKER });

    expect(snapshot.usedMulticall).toBe(false);
    expect(snapshot.totalStaked).toBe(LIVE_TOTAL_STAKED.toString());
    expect(snapshot.minPosition).toBe(LIVE_MIN_POSITION.toString());
    expect(snapshot.period).toBe(LIVE_PERIOD.toString());
    expect(snapshot.quote).toEqual({
      creditOut: '13333332',
      usdgSpent: '10000000',
      feeAtoms: '0',
      fills: '2',
      reason: 0,
    });
  });

  it('sequential fallback also degrades a reverting getQuote to null (not a thrown error)', async () => {
    const client = fakeClient({ multicallThrows: true, results: { quote: fail('reverted') } });
    const snapshot = await readTreasury(client, ADDRESSES, { hot: HOT, staker: STAKER });
    expect(snapshot.usedMulticall).toBe(false);
    expect(snapshot.quote).toBeNull();
  });

  it('sequential fallback still fails loudly on a non-quote leg failure', async () => {
    const client = fakeClient({ multicallThrows: true, results: { totalStaked: fail('boom') } });
    await expect(readTreasury(client, ADDRESSES, { hot: HOT, staker: STAKER })).rejects.toThrow(
      /totalStaked/,
    );
  });
});

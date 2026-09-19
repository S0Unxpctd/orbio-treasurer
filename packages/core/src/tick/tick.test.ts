/**
 * `runTick()` — S-06, tasks/S-06.md "Tests required": `tick/tick.test.ts`. AC2: "runTick against
 * fakes (fake chain client, fake gateway fetch, real SQLite store): writes 1 chain snapshot, N
 * events, returns the summary; called twice in the same bucket → second call returns
 * `{skipped:'duplicate'}` and writes nothing."
 *
 * The fake chain client deliberately has no `multicall` method — `readTreasury()`'s own
 * try/catch (chain/read.ts) treats that as "multicall unavailable" and falls back to sequential
 * `readContract` calls, exactly like `tick/executors.test.ts`'s `fakeClient()` already relies on.
 */
import type { Hex, TransactionReceipt } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreasuryReadClient } from '../chain/read.js';
import type { Env } from '../env.js';
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import type { TickExecClient } from './executors.js';
import { computeTickBucket, type RunTickResult, runTick } from './tick.js';

/** Narrows a nullable test read to non-null, throwing (not asserting `!`) on a genuine test-setup
 *  bug — biome's `noNonNullAssertion` disallows `!` project-wide, so this is the one small helper
 *  every "we just inserted/read this, it must exist" spot in this file goes through instead. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('tick.test.ts: expected a value, got null/undefined');
  }
  return value;
}

const ADDRESSES = {
  CREDIT_ADDRESS: '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C',
  STAKING_ADDRESS: '0xE0710011278BFb63E57C5f227E5980984B1EDDca',
  EXCHANGE_ADDRESS: '0x6951fFd32630b05e06F50062AEA801625A58eBC0',
  ORBIO_ADDRESS: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3',
  USDG_ADDRESS: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  NVDA_ADDRESS: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  PAYOUT_ADDRESS: '0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5',
} as const;

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    LEDGER: 'sqlite',
    LEDGER_SQLITE_PATH: ':memory:',
    ORBIO_MCP_URL: 'https://www.orbio.so/api/mcp',
    BOOK_CLIENT: 'readonly',
    STAKE_CLIENT: 'none',
    RH_CHAIN_ID: 4663,
    TREASURER_LIVE: false,
    RH_RPC_URLS: 'https://robinhood-rpc.publicnode.com,https://rpc.ordofi.network',
    ...ADDRESSES,
    TREASURER_MODE: 'normal',
    REFERENCE_AGENT_SLUG: 'treasurer',
    ORBIO_KEY: 'sk-orb-test-fake-key',
    ...overrides,
  } as Env;
}

/** Same "everything reads zero" fake as executors.test.ts, plus a `multicall` that always throws
 *  — `readTreasury()` (chain/read.ts) treats that exactly like "Multicall3 unavailable" and falls
 *  back to sequential `readContract` calls (see this file's own header comment), so this fake
 *  never has to model a real batched multicall result. */
function fakeClient(opts: { creditOut?: bigint } = {}): TickExecClient & TreasuryReadClient {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'getQuote') {
      return { creditOut: opts.creditOut ?? 0n, usdgSpent: 0n, feeAtoms: 0n, fills: 0n, reason: 0 };
    }
    return 0n;
  });
  const getBalance = vi.fn(async () => 10n ** 18n);
  const multicall = vi.fn(async () => {
    throw new Error('fakeClient: no multicall — readTreasury() falls back to sequential reads');
  });
  const writeContract = vi.fn(async (): Promise<Hex> => {
    throw new Error('fakeClient: writeContract should never be called (TREASURER_LIVE=false)');
  });
  const waitForTransactionReceipt = vi.fn(
    async (): Promise<TransactionReceipt> =>
      ({ status: 'success', logs: [] }) as unknown as TransactionReceipt,
  );
  // `TreasuryReadClient` is `Pick<PublicClient, ...>` (chain/read.ts's own header explains why) —
  // viem's real `multicall`/`readContract` signatures are overloaded generics no plain object
  // literal structurally satisfies; every method this fake needs is present and behaves exactly
  // like the real thing would for `readTreasury()`'s purposes (see the header comment above), so
  // this cast is a deliberate, narrow test-only escape, not a way to skip implementing something.
  return {
    readContract,
    getBalance,
    multicall,
    writeContract,
    waitForTransactionReceipt,
  } as unknown as TickExecClient & TreasuryReadClient;
}

function fakeFetch(available: string, used = '0'): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ balance: { available, used } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('runTick (S-06 AC2)', () => {
  let store: LedgerStore;

  afterEach(async () => {
    await store?.close();
  });

  function slug(): string {
    return `s06-tick-${Math.random().toString(36).slice(2)}`;
  }

  it('writes exactly 1 chain_snapshots row and returns a summary on a fresh agent/bucket', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const now = new Date('2026-09-19T12:07:00.000Z');
    const env = baseEnv({ ORBIO_GATEWAY_BASE_URL: 'https://fake-gateway.test' });
    const client = fakeClient();
    const fetchImpl = fakeFetch('5.000000');

    const result = await runTick({ store, agentSlug, now, env, client, fetchImpl });

    expect(result).not.toEqual({ skipped: 'duplicate' });
    const summary = result as Exclude<RunTickResult, { skipped: 'duplicate' }>;
    expect(summary.bucket).toBe(computeTickBucket(now));
    expect(summary.mode).toBe('normal'); // no burn history yet -> infinite runway
    expect(summary.previousMode).toBeNull();
    expect(summary.modeChanged).toBe(false); // previousMode null -> never "changed"

    const agent = await store.getAgentBySlug(agentSlug);
    expect(agent).not.toBeNull();
    const snapshot = await store.latestChainSnapshot(must(agent).id);
    expect(snapshot).not.toBeNull();
    expect(must(snapshot).mode).toBe('normal');
    expect(must(snapshot).creditApiAvailable).toBe('5.000000');

    const events = await store.listTreasuryEvents(must(agent).id, 50);
    const tickMarkers = events.filter((e) => e.kind === 'tick');
    expect(tickMarkers).toHaveLength(1);
    expect(tickMarkers[0]?.meta).toEqual({ bucket: computeTickBucket(now) });
  });

  it('a second runTick in the SAME bucket returns {skipped:"duplicate"} and writes nothing new', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const now = new Date('2026-09-19T12:07:00.000Z');
    const laterSameBucket = new Date('2026-09-19T12:14:59.000Z'); // still the :00-:15 bucket
    const env = baseEnv();
    const client = fakeClient();

    const first = await runTick({ store, agentSlug, now, env, client });
    expect(first).not.toEqual({ skipped: 'duplicate' });

    const agent = await store.getAgentBySlug(agentSlug);
    const eventsAfterFirst = await store.listTreasuryEvents(must(agent).id, 50);

    const second = await runTick({ store, agentSlug, now: laterSameBucket, env, client });
    expect(second).toEqual({ skipped: 'duplicate' });

    const eventsAfterSecond = await store.listTreasuryEvents(must(agent).id, 50);
    expect(eventsAfterSecond).toHaveLength(eventsAfterFirst.length); // nothing new written

    const snapshotsCount = eventsAfterSecond.filter((e) => e.kind === 'tick').length;
    expect(snapshotsCount).toBe(1); // still just the one tick marker
  });

  it('a call in a DIFFERENT bucket proceeds normally and writes a second tick marker', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const firstBucket = new Date('2026-09-19T12:07:00.000Z');
    const nextBucket = new Date('2026-09-19T12:16:00.000Z'); // 12:15 bucket
    const env = baseEnv();
    const client = fakeClient();

    const first = await runTick({ store, agentSlug, now: firstBucket, env, client });
    const second = await runTick({ store, agentSlug, now: nextBucket, env, client });

    expect(first).not.toEqual({ skipped: 'duplicate' });
    expect(second).not.toEqual({ skipped: 'duplicate' });
    expect((second as { bucket: string }).bucket).not.toBe((first as { bucket: string }).bucket);

    const agent = await store.getAgentBySlug(agentSlug);
    const events = await store.listTreasuryEvents(must(agent).id, 50);
    expect(events.filter((e) => e.kind === 'tick')).toHaveLength(2);
  });

  it('gateway fetch failure degrades to a $0 balance instead of crashing the tick', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const now = new Date('2026-09-19T12:07:00.000Z');
    const env = baseEnv({ ORBIO_GATEWAY_BASE_URL: 'https://fake-gateway.test' });
    const client = fakeClient();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network exploded');
    }) as unknown as typeof fetch;

    const result = await runTick({ store, agentSlug, now, env, client, fetchImpl });
    expect(result).not.toEqual({ skipped: 'duplicate' });

    const agent = await store.getAgentBySlug(agentSlug);
    const snapshot = await store.latestChainSnapshot(must(agent).id);
    expect(must(snapshot).creditApiAvailable).toBe('0.000000');
  });

  it('records a mode_change event when the computed mode differs from the previous tick', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const env = baseEnv({ ORBIO_GATEWAY_BASE_URL: 'https://fake-gateway.test' });
    const client = fakeClient();

    // Tick 1: healthy balance -> mode 'normal' (no burn history yet -> infinite runway).
    const t1 = new Date('2026-09-19T12:07:00.000Z');
    await runTick({ store, agentSlug, now: t1, env, client, fetchImpl: fakeFetch('5.000000') });

    const agent = await store.getAgentBySlug(agentSlug);

    // Seed heavy burn (usage_events) so tick 2's burnDaily() pushes runway into 'critical', with
    // a near-zero gateway balance.
    for (let i = 0; i < 5; i++) {
      await store.insertUsageEvent({
        agentId: must(agent).id,
        at: t1.toISOString(),
        costUsd: '10.000000',
        baselineCostUsd: '10.000000',
        model: 'test-model',
        status: 'ok',
      });
    }

    const t2 = new Date('2026-09-19T12:16:00.000Z');
    const second = await runTick({
      store,
      agentSlug,
      now: t2,
      env,
      client,
      fetchImpl: fakeFetch('0.010000'),
    });
    const summary = second as Exclude<RunTickResult, { skipped: 'duplicate' }>;
    expect(summary.previousMode).toBe('normal');
    expect(summary.mode).toBe('critical');
    expect(summary.modeChanged).toBe(true);

    const events = await store.listTreasuryEvents(must(agent).id, 50);
    const modeChanges = events.filter((e) => e.kind === 'mode_change');
    expect(modeChanges).toHaveLength(1);
    expect(modeChanges[0]?.meta).toEqual({ from: 'normal', to: 'critical' });
  });
});

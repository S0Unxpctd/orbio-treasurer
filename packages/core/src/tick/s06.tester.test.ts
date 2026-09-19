/**
 * Tester pass for S-06 (tasks/S-06.md) — independent of the builder's own `policy/sprint.test.ts`,
 * `tick/tick.test.ts`, `tick/executors.test.ts` and `tick/recorder-adapter.test.ts`. Written from
 * the ticket's "Acceptance criteria" and "Tests required" sections alone (PROCESS.md §3), with
 * its own fixtures/data so an AC misread by the builder doesn't survive into this suite too.
 *
 * Covers, per the Tester instructions:
 *  - decide() mode boundaries at exactly 2.0/0.5 days; buy sizing ceil + cap; ∞ runway; stakeup
 *    trigger at exactly 1000 calls; claim trigger from each of the three balances (table-driven).
 *  - runTick against fakes on a real SQLite store: 1 chain snapshot + events + summary; the
 *    duplicate-bucket skip proven with REAL `Promise.all` concurrency (two `runTick` calls for the
 *    same agent/bucket started simultaneously → exactly one does the work).
 *  - Executor isolation: a throwing `buy` does not stop `claim_activate`; the alert row is
 *    redacted.
 *  - `recorder-adapter.ts`'s pure mapping (the web-level, through-the-route AC5 integration lives
 *    in `apps/web/app/api/tick/s06.tester.test.ts`, per the Tester instructions' file split).
 *  - Migration 006 on a real local Postgres (AC7) — the `cron.job` half can't run without
 *    `pg_cron`/`pg_net` installed in this sandbox; noted, not faked, below.
 *
 * AC1 (decide() live-agnostic except inputs.live), AC6/AC8/AC4/AC5's route-level halves are
 * covered in the `apps/web` sibling file.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import type { Hex, TransactionReceipt } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveBuyCaps } from '../chain/buy.js';
import { resolveClaimCaps } from '../chain/claim.js';
import type { ChainAddresses } from '../chain/contracts.js';
import type { TreasuryReadClient } from '../chain/read.js';
import type { Env } from '../env.js';
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import {
  computeMode,
  computeRunwayDays,
  DEFAULT_SPRINT_POLICY_CONFIG,
  decide,
  INFINITE_RUNWAY_DAYS,
  type SprintDecideInput,
} from '../policy/sprint.js';
import { runExecutors, type TickExecClient } from './executors.js';
import {
  isLedgerRowId,
  RouterToLedgerCallRecorder,
  toLedgerCallRecord,
} from './recorder-adapter.js';
import { computeTickBucket, type RunTickResult, runTick } from './tick.js';

function must<T>(value: T | null | undefined, msg = 'expected a value'): T {
  if (value === null || value === undefined) throw new Error(`s06.tester.test.ts: ${msg}`);
  return value;
}

// --- shared fixtures --------------------------------------------------------------------------

const ZERO_SNAPSHOT = {
  asOf: '2026-09-19T00:00:00.000Z',
  stakedOrbio: '0',
  settledCredit: '0',
  creditWalletHot: '0',
  creditWalletStaker: '0',
  usdgBalanceHot: '0',
  ethBalanceHot: '0',
  quote: null,
  totalStaked: '0',
  minPosition: '1000000000000000000000',
  period: '3600',
  rpcUrlHost: null,
  usedMulticall: true,
} as const;

function baseInput(overrides: Partial<SprintDecideInput> = {}): SprintDecideInput {
  return {
    snapshot: ZERO_SNAPSHOT,
    apiBalance: { available: '0.000000', used: '0.000000' },
    burnDaily: '1.000000',
    callsSinceLastStakeup: 0,
    buysToday: 0,
    activatedToday: '0.000000',
    claimable: '0.000000',
    now: new Date('2026-09-19T12:00:00.000Z'),
    live: false,
    ...overrides,
  };
}

// =================================================================================================
// AC1 — decide() table-driven tests (>= 15 rows)
// =================================================================================================

describe('decide() — S-06 AC1 (table-driven)', () => {
  it('computeMode: normal is >= runwayEcoDays (2), critical is < runwayCriticalDays (0.5), eco between', () => {
    expect(computeMode('2.000000', DEFAULT_SPRINT_POLICY_CONFIG)).toBe('normal'); // exact boundary
    expect(computeMode('2.000001', DEFAULT_SPRINT_POLICY_CONFIG)).toBe('normal');
    expect(computeMode('1.999999', DEFAULT_SPRINT_POLICY_CONFIG)).toBe('eco'); // just under 2.0
    expect(computeMode('0.500000', DEFAULT_SPRINT_POLICY_CONFIG)).toBe('eco'); // exact boundary -> eco, not critical
    expect(computeMode('0.500001', DEFAULT_SPRINT_POLICY_CONFIG)).toBe('eco');
    expect(computeMode('0.499999', DEFAULT_SPRINT_POLICY_CONFIG)).toBe('critical'); // just under 0.5
    expect(computeMode('0.000000', DEFAULT_SPRINT_POLICY_CONFIG)).toBe('critical');
  });

  it('computeRunwayDays: ∞ (999) when burn == epsilon(0.01) and available > 0; also when burn == 0', () => {
    expect(computeRunwayDays('100.000000', '0.010000')).toBe(INFINITE_RUNWAY_DAYS);
    expect(computeRunwayDays('100.000000', '0.000000')).toBe(INFINITE_RUNWAY_DAYS);
    expect(INFINITE_RUNWAY_DAYS).toBe('999.000000');
    // available == 0 with burn == epsilon is NOT the infinite case (available > 0 required).
    expect(computeRunwayDays('0.000000', '0.010000')).toBe('0.000000');
  });

  // Full decide() rows: [description, input overrides, expected mode, expected action kinds].
  const rows: Array<{
    readonly name: string;
    readonly input: Partial<SprintDecideInput>;
    readonly mode: 'normal' | 'eco' | 'critical';
    readonly kinds: readonly string[];
  }> = [
    {
      name: 'runway exactly 2.0 days -> normal, no buy',
      input: { apiBalance: { available: '20.000000', used: '0' }, burnDaily: '10.000000' },
      mode: 'normal',
      kinds: [],
    },
    {
      name: 'runway 1.999999 days (just under eco boundary) -> eco',
      input: { apiBalance: { available: '19.99999', used: '0' }, burnDaily: '10.000000' },
      mode: 'eco',
      kinds: [],
    },
    {
      name: 'runway exactly 0.5 days -> eco (not critical); deficit (0.5) too small to buy',
      input: { apiBalance: { available: '0.500000', used: '0' }, burnDaily: '1.000000' },
      mode: 'eco',
      kinds: [], // runway < 1 (RUNWAY_BUY_DAYS) but deficit = 1*1 - 0.5 = 0.5, not > 1
    },
    {
      name: 'runway 0.499999 days (just under critical boundary) -> critical; deficit still too small to buy',
      input: { apiBalance: { available: '0.499999', used: '0' }, burnDaily: '1.000000' },
      mode: 'critical',
      kinds: [], // deficit = 1*1 - 0.499999 = 0.500001, not > 1
    },
    {
      name: '∞ runway (burn == epsilon, available > 0) -> normal',
      input: { apiBalance: { available: '100.000000', used: '0' }, burnDaily: '0.010000' },
      mode: 'normal',
      kinds: [],
    },
    {
      name: 'runway between buy threshold (1) and eco threshold (2) -> eco, but NO buy (runway >= 1)',
      input: { apiBalance: { available: '15.000000', used: '0' }, burnDaily: '10.000000' }, // runway 1.5
      mode: 'eco',
      kinds: [],
    },
    {
      name: 'deficit exactly 1.000000 -> NOT > 1 -> no buy even though runway < 1',
      // burnDaily*runwayBuyDays(1) - available = 2 - 1 = 1 exactly; runway = 1/2 = 0.5 -> mode 'eco'
      // (0.5 >= runwayCriticalDays(0.5), boundary inclusive on the safer side, per computeMode()).
      input: { apiBalance: { available: '1.000000', used: '0' }, burnDaily: '2.000000' },
      mode: 'eco',
      kinds: [],
    },
    {
      name: 'deficit 1.1 (just over the >1 threshold) -> buy fires, ceiled up to 2',
      // runway = 0.9/2 = 0.45 -> critical; target = 1*2 = 2; deficit = 2 - 0.9 = 1.1 -> ceil(1.1) = 2.
      input: { apiBalance: { available: '0.900000', used: '0' }, burnDaily: '2.000000' },
      mode: 'critical',
      kinds: ['buy'],
    },
    {
      name: 'deficit far above cap (100) -> usdg capped at buyMaxUsdgPerTx (10)',
      input: { apiBalance: { available: '0.000000', used: '0' }, burnDaily: '100.000000' },
      mode: 'critical',
      kinds: ['buy'],
    },
    {
      name: 'claim trigger: claimable > 0 alone (all wallet balances zero)',
      input: {
        claimable: '5.000000',
        burnDaily: '0.010000',
        apiBalance: { available: '100.000000', used: '0' },
      },
      mode: 'normal',
      kinds: ['claim_activate'],
    },
    {
      name: 'claim trigger: staker CREDIT wallet > 0 alone',
      input: {
        snapshot: { ...ZERO_SNAPSHOT, creditWalletStaker: '1' },
        burnDaily: '0.010000',
        apiBalance: { available: '100.000000', used: '0' },
      },
      mode: 'normal',
      kinds: ['claim_activate'],
    },
    {
      name: 'claim trigger: hot CREDIT wallet > 0 alone',
      input: {
        snapshot: { ...ZERO_SNAPSHOT, creditWalletHot: '1' },
        burnDaily: '0.010000',
        apiBalance: { available: '100.000000', used: '0' },
      },
      mode: 'normal',
      kinds: ['claim_activate'],
    },
    {
      name: 'no claim trigger when all three balances are zero',
      input: { burnDaily: '0.010000', apiBalance: { available: '100.000000', used: '0' } },
      mode: 'normal',
      kinds: [],
    },
    {
      name: 'stakeup fires at exactly 1000 calls',
      input: {
        callsSinceLastStakeup: 1000,
        burnDaily: '0.010000',
        apiBalance: { available: '100.000000', used: '0' },
      },
      mode: 'normal',
      kinds: ['stakeup'],
    },
    {
      name: 'stakeup does NOT fire at 999 calls',
      input: {
        callsSinceLastStakeup: 999,
        burnDaily: '0.010000',
        apiBalance: { available: '100.000000', used: '0' },
      },
      mode: 'normal',
      kinds: [],
    },
    {
      name: 'stakeup fires above 1000 calls too (>=, not ==)',
      input: {
        callsSinceLastStakeup: 1500,
        burnDaily: '0.010000',
        apiBalance: { available: '100.000000', used: '0' },
      },
      mode: 'normal',
      kinds: ['stakeup'],
    },
    {
      name: 'all three actions can fire together, in fixed order claim_activate, buy, stakeup',
      input: {
        claimable: '3.000000',
        callsSinceLastStakeup: 2000,
        apiBalance: { available: '0.000000', used: '0' },
        burnDaily: '50.000000',
      },
      mode: 'critical',
      kinds: ['claim_activate', 'buy', 'stakeup'],
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const input = baseInput(row.input);
      const decision = decide(input, DEFAULT_SPRINT_POLICY_CONFIG);
      expect(decision.mode).toBe(row.mode);
      expect(decision.actions.map((a) => a.kind)).toEqual(row.kinds);
    });
  }

  it('buy sizing: usdg = min(cap, ceil(deficit)) — deficit 4.5 ceils to 5, under cap 10', () => {
    const input = baseInput({
      apiBalance: { available: '5.500000', used: '0' },
      burnDaily: '10.000000', // runway 0.55 -> < 1; target = 1*10=10; deficit = 4.5
    });
    const decision = decide(input, DEFAULT_SPRINT_POLICY_CONFIG);
    const buy = decision.actions.find((a) => a.kind === 'buy');
    expect(buy).toBeDefined();
    expect((buy as { usdg: string }).usdg).toBe('5.000000'); // ceil(4.5) = 5
  });

  it('buy sizing: an exact whole-unit deficit (5) is NOT bumped up by ceil', () => {
    const input = baseInput({
      apiBalance: { available: '5.000000', used: '0' },
      burnDaily: '10.000000', // target=10, deficit=5.000000 exactly
    });
    const decision = decide(input, DEFAULT_SPRINT_POLICY_CONFIG);
    const buy = decision.actions.find((a) => a.kind === 'buy');
    expect((buy as { usdg: string }).usdg).toBe('5.000000');
  });

  it('buy sizing: cap wins over a much larger ceiled deficit', () => {
    const input = baseInput({
      apiBalance: { available: '0.000000', used: '0' },
      burnDaily: '1000.000000', // target=1000, deficit=1000, cap=10
    });
    const decision = decide(input, DEFAULT_SPRINT_POLICY_CONFIG);
    const buy = decision.actions.find((a) => a.kind === 'buy');
    expect((buy as { usdg: string }).usdg).toBe('10.000000');
  });

  it('AC1: decide() is live-agnostic — live:true vs live:false produce IDENTICAL actions except inputs.live', () => {
    const shared = {
      claimable: '1.000000',
      callsSinceLastStakeup: 1000,
      apiBalance: { available: '0.000000', used: '0' },
      burnDaily: '10.000000',
    };
    const liveOff = decide(baseInput({ ...shared, live: false }), DEFAULT_SPRINT_POLICY_CONFIG);
    const liveOn = decide(baseInput({ ...shared, live: true }), DEFAULT_SPRINT_POLICY_CONFIG);
    expect(liveOff.actions.map((a) => a.kind)).toEqual(liveOn.actions.map((a) => a.kind));
    expect(liveOff.actions.map((a) => a.inputs.live)).toEqual([false, false, false]);
    expect(liveOn.actions.map((a) => a.inputs.live)).toEqual([true, true, true]);
  });

  it('deficit exactly 1.000000 does not trigger a buy (strict > 1), confirmed against mode independently', () => {
    // available=1, burnDaily=2 -> runway = 0.5 -> mode 'eco' (boundary, not critical); deficit = 2*1-1=1 -> no buy.
    const input = baseInput({
      apiBalance: { available: '1.000000', used: '0' },
      burnDaily: '2.000000',
    });
    const decision = decide(input, DEFAULT_SPRINT_POLICY_CONFIG);
    expect(decision.mode).toBe('eco');
    expect(decision.actions).toHaveLength(0);
  });
});

// =================================================================================================
// AC2 — runTick against fakes on a real SQLite store
// =================================================================================================

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
    RH_RPC_URLS: 'https://tester-rpc-1.test,https://tester-rpc-2.test',
    ...ADDRESSES,
    TREASURER_MODE: 'normal',
    REFERENCE_AGENT_SLUG: 'treasurer',
    ORBIO_KEY: 'sk-orb-test-tester-fixture-key',
    ...overrides,
  } as Env;
}

function fakeClient(opts: { creditOut?: bigint } = {}): TickExecClient & TreasuryReadClient {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'getQuote') {
      return { creditOut: opts.creditOut ?? 0n, usdgSpent: 0n, feeAtoms: 0n, fills: 0n, reason: 0 };
    }
    return 0n;
  });
  const getBalance = vi.fn(async () => 10n ** 18n);
  const multicall = vi.fn(async () => {
    throw new Error('s06.tester fakeClient: no multicall — readTreasury() falls back sequentially');
  });
  const writeContract = vi.fn(async (): Promise<Hex> => {
    throw new Error(
      's06.tester fakeClient: writeContract must never be called (TREASURER_LIVE=false)',
    );
  });
  const waitForTransactionReceipt = vi.fn(
    async (): Promise<TransactionReceipt> =>
      ({ status: 'success', logs: [] }) as unknown as TransactionReceipt,
  );
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

describe('runTick — S-06 AC2 (real SQLite store)', () => {
  let store: LedgerStore;

  afterEach(async () => {
    await store?.close();
  });

  function slug(): string {
    return `s06-tester-${Math.random().toString(36).slice(2)}`;
  }

  it('a fresh tick writes exactly 1 chain_snapshots row, at least 1 event, and returns a summary', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const now = new Date('2026-09-19T09:03:00.000Z');
    const env = baseEnv({ ORBIO_GATEWAY_BASE_URL: 'https://tester-gateway.test' });
    const client = fakeClient();
    const fetchImpl = fakeFetch('7.500000');

    const result = await runTick({ store, agentSlug, now, env, client, fetchImpl });
    expect(result).not.toEqual({ skipped: 'duplicate' });
    const summary = result as Exclude<RunTickResult, { skipped: 'duplicate' }>;
    expect(summary.bucket).toBe(computeTickBucket(now));
    expect(summary.mode).toBeDefined();

    const agent = await store.getAgentBySlug(agentSlug);
    const snapshot = await store.latestChainSnapshot(must(agent).id);
    expect(snapshot).not.toBeNull();
    expect(must(snapshot).creditApiAvailable).toBe('7.500000');

    const events = await store.listTreasuryEvents(must(agent).id, 50);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.kind === 'tick')).toHaveLength(1);

    // Exactly 1 chain_snapshots row is proven by only-1-snapshot-ever + latestChainSnapshot above
    // returning the one we just wrote; belt-and-suspenders: a second read finds the same asOf.
    const again = await store.latestChainSnapshot(must(agent).id);
    expect(must(again).asOf).toBe(must(snapshot).asOf);
  });

  it('AC2 duplicate-bucket skip: two runTick calls for the SAME agent/bucket, started with REAL Promise.all concurrency, and exactly one does the work', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const env = baseEnv();

    // Pre-seed the agent with an earlier tick (the steady-state case: by the time a cron fires
    // and a manual `pnpm tick` race each other, the reference agent already exists from every
    // prior 15-min tick — `runTick()`'s OWN `getAgentBySlug`-then-`insertAgent` race for a
    // genuinely brand-new slug is a separate concern from this AC, noted in the Test report).
    const warmup = new Date('2026-09-19T08:47:00.000Z'); // an earlier, different bucket
    await runTick({ store, agentSlug, now: warmup, env, client: fakeClient() });

    const now = new Date('2026-09-19T09:03:00.000Z'); // same bucket for both racing calls
    const clientA = fakeClient();
    const clientB = fakeClient();

    // Both calls are STARTED together (not awaited one after another) — this is the point of the
    // test per the Tester instructions ("real Promise.all concurrency ... started simultaneously").
    // withAgentLock()'s in-process FIFO chain (ledger/sqlite/store.ts) must serialize them so only
    // the first to acquire the lock does the real work; the second finds the tick marker already
    // written and returns {skipped:'duplicate'}.
    const [resultA, resultB] = await Promise.all([
      runTick({ store, agentSlug, now, env, client: clientA }),
      runTick({ store, agentSlug, now, env, client: clientB }),
    ]);

    const outcomes = [resultA, resultB];
    const duplicates = outcomes.filter((r) => 'skipped' in r && r.skipped === 'duplicate');
    const real = outcomes.filter((r) => !('skipped' in r));
    expect(duplicates).toHaveLength(1);
    expect(real).toHaveLength(1);

    // And no NEW tick marker/chain_snapshots row beyond the warmup + the one real racer, no
    // matter which of the two concurrent calls "won" the race to go first.
    const agent = await store.getAgentBySlug(agentSlug);
    expect(agent).not.toBeNull();
    const events = await store.listTreasuryEvents(must(agent).id, 50);
    expect(events.filter((e) => e.kind === 'tick')).toHaveLength(2); // warmup bucket + the one racer
  });

  it('a THIRD concurrent call for a different bucket is unaffected by the other two racing in an earlier bucket', async () => {
    store = openSqliteLedger(':memory:');
    const agentSlug = slug();
    const bucketA = new Date('2026-09-19T09:03:00.000Z');
    const bucketB = new Date('2026-09-19T09:20:00.000Z'); // a later, different 15-min bucket
    const env = baseEnv();

    // Same warmup rationale as the previous test — pre-seeds the agent so all three concurrent
    // calls below race only on the tick-bucket marker (this AC), not on `runTick()`'s own
    // separate first-ever-agent-creation race (noted, not tested, in the Test report).
    const warmup = new Date('2026-09-19T08:30:00.000Z');
    await runTick({ store, agentSlug, now: warmup, env, client: fakeClient() });

    const [r1, r2, r3] = await Promise.all([
      runTick({ store, agentSlug, now: bucketA, env, client: fakeClient() }),
      runTick({ store, agentSlug, now: bucketA, env, client: fakeClient() }),
      runTick({ store, agentSlug, now: bucketB, env, client: fakeClient() }),
    ]);

    const dupCount = [r1, r2, r3].filter((r) => 'skipped' in r && r.skipped === 'duplicate').length;
    expect(dupCount).toBe(1); // exactly one of the two bucketA calls was the duplicate
    const agent = await store.getAgentBySlug(agentSlug);
    const events = await store.listTreasuryEvents(must(agent).id, 50);
    expect(events.filter((e) => e.kind === 'tick')).toHaveLength(3); // warmup + bucketA (once) + bucketB
  });
});

// =================================================================================================
// AC3 — Executor error isolation
// =================================================================================================

const EXEC_ADDRESSES: ChainAddresses = {
  credit: ADDRESSES.CREDIT_ADDRESS,
  staking: ADDRESSES.STAKING_ADDRESS,
  exchange: ADDRESSES.EXCHANGE_ADDRESS,
  orbio: ADDRESSES.ORBIO_ADDRESS,
  usdg: ADDRESSES.USDG_ADDRESS,
  nvda: ADDRESSES.NVDA_ADDRESS,
  payout: ADDRESSES.PAYOUT_ADDRESS,
};

describe('runExecutors — S-06 AC3 (executor isolation)', () => {
  let store: LedgerStore;

  afterEach(async () => {
    await store?.close();
  });

  async function seedAgent(): Promise<string> {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s06-tester-exec-${Math.random().toString(36).slice(2)}`,
      name: 'S-06 tester exec agent',
      mode: 'dry_run',
    });
    return agent.id;
  }

  it('a throwing buy does not prevent claim_activate from running, AND the alert row is redacted', async () => {
    const agentId = await seedAgent();
    const secretLike = 'sk-orb-live-totallysecretvalue999';
    const readContract = vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'getQuote') {
        throw new Error(`upstream exploded, leaking: ${secretLike}`);
      }
      return 0n; // every claim-leg read (positionOf/settledOf/balanceOf/...) is a harmless no_op
    });
    const client: TickExecClient = {
      readContract,
      getBalance: vi.fn(async () => 10n ** 18n),
      writeContract: vi.fn(async (): Promise<Hex> => {
        throw new Error('must never be called — TREASURER_LIVE=false');
      }),
      waitForTransactionReceipt: vi.fn(
        async (): Promise<TransactionReceipt> =>
          ({ status: 'success', logs: [] }) as unknown as TransactionReceipt,
      ),
    };

    const deps = {
      store,
      agentId,
      client,
      addresses: EXEC_ADDRESSES,
      hot: '0x2222222222222222222222222222222222222222' as const,
      claimCaps: resolveClaimCaps({ env: { TREASURER_LIVE: false } }),
      buyCaps: resolveBuyCaps({ env: { TREASURER_LIVE: false } }),
      periodIdsToSettle: [] as const,
      idempotencyKey: 's06-tester-2026-09-19T09:00-exec',
      now: () => new Date('2026-09-19T09:00:00.000Z'),
    };

    const result = await runExecutors(
      [
        { kind: 'claim_activate', reason: 'claimable_settled', inputs: {} as never },
        {
          kind: 'buy',
          usdg: '10.000000',
          reason: 'runway_below_buy_threshold',
          inputs: {} as never,
        },
      ],
      'critical',
      'critical',
      deps,
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.kind).toBe('claim_activate');
    expect(result.results[0]?.outcome).toBe('ok'); // ran to completion despite buy's throw
    expect(result.results[1]?.kind).toBe('buy');
    expect(result.results[1]?.outcome).toBe('error');

    const events = await store.listTreasuryEvents(agentId, 20);
    const buyAlert = events.find(
      (e) => e.kind === 'alert' && (e.meta as { action?: string } | null)?.action === 'buy',
    );
    expect(buyAlert).toBeDefined();
    const serializedAlert = JSON.stringify(buyAlert?.meta);
    expect(serializedAlert).not.toContain(secretLike); // redact() scrubbed the secret-looking value
    // redact()'s own masking format is `<prefix>…<last4>` (redact.ts's maskPrefixLast4), not a
    // fixed "[redacted]" literal — the ellipsis is the marker that masking actually ran, rather
    // than the error simply being dropped or the row failing to write at all.
    expect(serializedAlert).toContain('…');
    expect(serializedAlert).toContain('upstream exploded'); // surrounding message text preserved
  });
});

// =================================================================================================
// tick/recorder-adapter.ts — pure mapping (web-level integration test lives in apps/web)
// =================================================================================================

describe('recorder-adapter — pure toLedgerCallRecord()/isLedgerRowId() mapping', () => {
  it('isLedgerRowId: only a real UUID is treated as a ledger row id', () => {
    expect(isLedgerRowId('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
    expect(isLedgerRowId('key_0123456789abcdef')).toBe(false);
    expect(isLedgerRowId('')).toBe(false);
  });

  it('toLedgerCallRecord: null usage fields become zero/"0.000000", not null, and status maps 1:1', () => {
    const record = toLedgerCallRecord(
      {
        ts: '2026-09-19T09:00:00.000Z',
        keyId: 'key_deadbeefdeadbeef', // synthetic, not a ledger row id
        agentId: null,
        requestedModel: 'auto',
        routedModel: 'orbio/tiny',
        tier: 'S',
        reason: 'runway_cap',
        stream: false,
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        baselineModel: null,
        baselineCostUsd: null,
        latencyMs: 42,
        status: 'upstream_error',
      },
      'fallback-agent-id',
    );
    expect(record.agentId).toBe('fallback-agent-id'); // null agentId -> fallback
    expect(record.callerKeyId).toBeNull(); // synthetic key id never forwarded
    expect(record.promptTokens).toBe(0);
    expect(record.completionTokens).toBe(0);
    expect(record.costUsd).toBe('0.000000');
    expect(record.baselineCostUsd).toBe('0.000000');
    expect(record.status).toBe('upstream_error');
  });

  it('toLedgerCallRecord: a real UUID keyId IS forwarded as callerKeyId, and a real agentId wins over the fallback', () => {
    const record = toLedgerCallRecord(
      {
        ts: '2026-09-19T09:00:00.000Z',
        keyId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        agentId: 'real-agent-id',
        requestedModel: 'auto',
        routedModel: 'orbio/tiny',
        tier: 'S',
        reason: 'ok',
        stream: false,
        promptTokens: 12,
        completionTokens: 34,
        costUsd: 0.001234,
        baselineModel: 'orbio/large',
        baselineCostUsd: 0.05,
        latencyMs: 100,
        status: 'ok',
      },
      'fallback-agent-id',
    );
    expect(record.callerKeyId).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(record.agentId).toBe('real-agent-id');
    expect(record.costUsd).toBe('0.001234');
    expect(record.baselineCostUsd).toBe('0.050000');
  });

  it("auth_error (router-only status) maps to upstream_error on the ledger side (total map, per this file's header)", () => {
    const record = toLedgerCallRecord(
      {
        ts: '2026-09-19T09:00:00.000Z',
        keyId: 'key_x',
        agentId: null,
        requestedModel: 'auto',
        routedModel: 'auto',
        tier: 'S',
        reason: 'unauth',
        stream: false,
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        baselineModel: null,
        baselineCostUsd: null,
        latencyMs: 1,
        status: 'auth_error',
      },
      'fallback-agent-id',
    );
    expect(record.status).toBe('upstream_error');
  });

  it('RouterToLedgerCallRecorder forwards the converted record to the underlying ledger recorder exactly once', async () => {
    const seen: unknown[] = [];
    const fakeLedgerRecorder = { record: vi.fn(async (r: unknown) => void seen.push(r)) };
    const adapter = new RouterToLedgerCallRecorder(fakeLedgerRecorder, 'fallback-agent-id');
    await adapter.record({
      ts: '2026-09-19T09:00:00.000Z',
      keyId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      agentId: null,
      requestedModel: 'auto',
      routedModel: 'orbio/tiny',
      tier: 'S',
      reason: 'ok',
      stream: false,
      promptTokens: 1,
      completionTokens: 2,
      costUsd: 0.01,
      baselineModel: null,
      baselineCostUsd: 0.02,
      latencyMs: 5,
      status: 'ok',
    });
    expect(fakeLedgerRecorder.record).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { agentId: string }).agentId).toBe('fallback-agent-id');
    expect((seen[0] as { callerKeyId: string | null }).callerKeyId).toBe(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    );
  });
});

// =================================================================================================
// AC7 — Migration 006 on a real local Postgres
// =================================================================================================

/**
 * Same recipe as `tasks/S-02.md` Evidence / `ledger/migration-005.test.ts` (a local, loopback-only
 * Postgres cluster; `TEST_DATABASE_URL` set by the Tester run — see this ticket's Test report for
 * the exact commands used to stand it up). Skips cleanly with a clear message otherwise.
 *
 * The `cron.job`-row half of AC7 ("the cron job row has the new command") CANNOT be proven here:
 * `pg_cron`/`pg_net` are not installed in this sandbox (`select cron.schedule(...)` fails with
 * `schema "cron" does not exist` — confirmed while writing this file), so there is no `cron.job`
 * table to read at all locally. That half is only provable on the real hosted Supabase project
 * (docs/runbook.md's two `alter database ... set app.tick_url/app.tick_secret` statements) — noted
 * here, not faked, per the Tester instructions ("say so").
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    's06.tester.test.ts: TEST_DATABASE_URL not set — skipping the AC7 Postgres migration-006 ' +
      'suite. See tasks/S-02.md Evidence for the local-cluster recipe.',
  );
}

const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

describeOrSkip('migration 006 — AC7 (real local Postgres, applied twice)', () => {
  const sql = postgres(TEST_DATABASE_URL as string, { max: 1 });

  beforeAll(async () => {
    await sql.unsafe(`
      drop table if exists chain_snapshots, treasury_events, orders, book_snapshots, decisions,
        usage_events, treasury_snapshots, caller_keys, key_meta, agents cascade;
      drop function if exists ledger_reject_write() cascade;
      drop function if exists agents_guard_write() cascade;
      drop function if exists orders_guard_write() cascade;
      drop function if exists caller_keys_guard_write() cascade;
    `);
    await sql.unsafe(
      "do $$ begin\n      if not exists (select 1 from pg_roles where rolname = 'anon') then\n        create role anon nologin;\n      end if;\n    end $$;",
    );
    await sql.unsafe(readMigration('001_schema.sql'));
    await sql.unsafe(readMigration('002_rls.sql'));
    await sql.unsafe(readMigration('003_append_only.sql'));
    // Roll the CHECK back to its pre-006 list so this test faithfully exercises 006 as a delta,
    // exactly like the builder's own migration-006.test.ts does.
    await sql.unsafe(`
      alter table treasury_events drop constraint if exists treasury_events_kind_check;
      alter table treasury_events add constraint treasury_events_kind_check
        check (kind in ('settle','claim','activate','buy','stake','mode_change','alert','dry_run'));
    `);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("AC7: applying migration 006's constraint statements TWICE in a row does not error", async () => {
    const full = readMigration('006_tick_marker_and_cron.sql');
    const marker = '-- --- 2. re-point the cron job';
    const idx = full.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const constraintOnly = full.slice(0, idx);

    await expect(sql.unsafe(constraintOnly)).resolves.toBeDefined();
    await expect(sql.unsafe(constraintOnly)).resolves.toBeDefined(); // second apply: no error
  });

  it("after applying 006, a treasury_events row of kind 'tick' with a bucket in meta is accepted", async () => {
    const rows = await sql`
      insert into agents (slug, name, mode) values ('s06-tester-m006-agent', 'Tester agent', 'dry_run')
      returning id
    `;
    const agentId = rows[0]?.id as string;
    const inserted = await sql`
      insert into treasury_events (agent_id, at, kind, meta)
      values (${agentId}, now(), 'tick', ${sql.json({ bucket: '2026-09-19T09:00' })})
      returning kind, meta
    `;
    expect(inserted[0]?.kind).toBe('tick');
    expect(inserted[0]?.meta).toEqual({ bucket: '2026-09-19T09:00' });
  });

  it('cron.job cannot be read at all in this sandbox (pg_cron/pg_net absent) — the cron half of AC7 is unprovable here, by design, not faked', async () => {
    await expect(
      sql.unsafe(`select cron.schedule('x', '*/15 * * * *', $$select 1$$)`),
    ).rejects.toThrow(/schema "cron" does not exist/i);
  });
});

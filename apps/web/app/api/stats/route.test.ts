/**
 * Integration test for `GET /api/stats` (S-08 AC1, AC2, AC3) against a temp SQLite ledger —
 * never the hosted Postgres one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteLedger } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resetLedgerStoreForTesting } from '../../_ledger.js';
import { GET } from './route.js';

const ENV_KEYS = ['LEDGER', 'LEDGER_SQLITE_PATH', 'REFERENCE_AGENT_SLUG'] as const;
const savedEnv: Record<string, string | undefined> = {};

let dir: string;
let dbPath: string;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), 's08-stats-'));
  dbPath = join(dir, 'treasurer.db');
  process.env.LEDGER = 'sqlite';
  process.env.LEDGER_SQLITE_PATH = dbPath;
  process.env.REFERENCE_AGENT_SLUG = 'treasurer';
  resetLedgerStoreForTesting();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetLedgerStoreForTesting();
  rmSync(dir, { recursive: true, force: true });
});

const savingsSchema = z.object({
  calls: z.number(),
  costUsd: z.string(),
  baselineUsd: z.string(),
  savedUsd: z.string(),
  savedPct: z.string(),
  costUsdDisplay: z.string(),
  baselineUsdDisplay: z.string(),
  savedUsdDisplay: z.string(),
  savedPctDisplay: z.string(),
});

const tierLineSchema = z.object({
  tier: z.enum(['S', 'M', 'L']),
  calls: z.number(),
  costUsd: z.string(),
  costUsdDisplay: z.string(),
});

const statsSchema = z.object({
  agent: z
    .object({
      slug: z.string(),
      name: z.string(),
      repoUrl: z.string().nullable(),
      lastSeenAt: z.string().nullable(),
    })
    .nullable(),
  savings: z.object({
    h24: savingsSchema,
    all: savingsSchema,
    byTier: z.array(tierLineSchema).length(3),
  }),
  treasury: z
    .object({
      stakedOrbioDisplay: z.string(),
      creditClaimableDisplay: z.string(),
      creditWalletDisplay: z.string(),
      apiAvailableDisplay: z.string(),
      apiUsedDisplay: z.string(),
      quote: z
        .object({ usdgIn: z.string(), creditOut: z.string(), discountPct: z.string() })
        .nullable(),
      ethGasDisplay: z.string(),
      usdgDisplay: z.string(),
      mode: z.string().nullable(),
      runwayDays: z.string().nullable(),
      runwayDisplay: z.string(),
      asOf: z.string(),
      ageDisplay: z.string(),
    })
    .nullable(),
  events: z.array(z.unknown()),
  agents: z.array(z.unknown()),
  generatedAt: z.string(),
});

describe('GET /api/stats — AC1: no reference agent', () => {
  it('200s with zeros, a null agent and null treasury, never crashes', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60');

    const body: unknown = await res.json();
    const parsed = statsSchema.parse(body);
    expect(parsed.agent).toBeNull();
    expect(parsed.savings.h24.calls).toBe(0);
    expect(parsed.treasury).toBeNull();
    expect(parsed.events).toEqual([]);
  });
});

describe('GET /api/stats — AC2/AC3: seeded ledger', () => {
  const TX_A = `0x${'a'.repeat(64)}`;
  const TX_B = `0x${'b'.repeat(64)}`;

  beforeEach(async () => {
    const store = openSqliteLedger(dbPath);
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

    const agentA = await store.insertAgent({
      slug: 'treasurer',
      name: 'Treasurer',
      mode: 'dry_run',
      public: true,
    });
    await store.insertAgent({
      slug: 'private-one',
      name: 'Private One',
      mode: 'dry_run',
      public: false,
    });

    const tierPlan: { tier: 'S' | 'M' | 'L'; cost: string; baseline: string; count: number }[] = [
      { tier: 'S', cost: '0.100000', baseline: '0.200000', count: 5 },
      { tier: 'M', cost: '0.300000', baseline: '0.600000', count: 3 },
      { tier: 'L', cost: '1.000000', baseline: '2.000000', count: 2 },
    ];
    for (const plan of tierPlan) {
      for (let i = 0; i < plan.count; i += 1) {
        await store.insertUsageEvent({
          agentId: agentA.id,
          at: iso(60_000 * (i + 1)),
          model: 'orbio/test-model',
          tierServed: plan.tier,
          costUsd: plan.cost,
          baselineCostUsd: plan.baseline,
          status: 'ok',
        });
      }
    }

    await store.insertChainSnapshot({
      agentId: agentA.id,
      asOf: iso(2 * 60_000),
      stakedOrbio: '2000000000000000000000', // 2000 ORBIO
      settledCredit: '3000000', // 3 CREDIT
      creditWallet: '500000', // 0.5 CREDIT
      creditApiAvailable: '40.000000',
      creditApiUsed: '5.000000',
      quoteCreditPerUsdg: '1.500000', // 10 USDG -> 15 CREDIT, 33.3% discount
      ethBalance: '5000000000000000', // 0.005 ETH
      usdgBalance: '10000000', // 10 USDG
      mode: 'dry_run',
    });

    await store.insertTreasuryEvent({
      agentId: agentA.id,
      at: iso(30 * 60_000),
      kind: 'claim',
      amount: '1000000000000000000',
      token: 'ORBIO',
      usdValue: '2.500000',
      txHash: TX_A,
    });
    await store.insertTreasuryEvent({
      agentId: agentA.id,
      at: iso(20 * 60_000),
      kind: 'settle',
      amount: '2000000',
      token: 'CREDIT',
      usdValue: '2.000000',
      txHash: TX_B,
    });
    await store.insertTreasuryEvent({
      agentId: agentA.id,
      at: iso(10 * 60_000),
      kind: 'dry_run',
      meta: { reason: 'TREASURER_LIVE is false' },
    });

    await store.close();
  });

  it('savings totals match the seeded usage events; treasury/proof/agents formatted as specified', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = statsSchema.parse(await res.json());

    expect(body.agent).toEqual({
      slug: 'treasurer',
      name: 'Treasurer',
      repoUrl: null,
      lastSeenAt: null,
    });

    // All 10 events are within the last hour, so 24h and all-time agree.
    for (const window of [body.savings.h24, body.savings.all] as const) {
      expect(window.calls).toBe(10);
      expect(window.costUsd).toBe('3.400000');
      expect(window.baselineUsd).toBe('6.800000');
      expect(window.savedUsd).toBe('3.400000');
      expect(window.savedPct).toBe('0.5000');
      expect(window.savedPctDisplay).toBe('50.00%');
    }
    expect(body.savings.byTier).toEqual([
      { tier: 'S', calls: 5, costUsd: '0.500000', costUsdDisplay: '$0.50' },
      { tier: 'M', calls: 3, costUsd: '0.900000', costUsdDisplay: '$0.90' },
      { tier: 'L', calls: 2, costUsd: '2.000000', costUsdDisplay: '$2.00' },
    ]);

    expect(body.treasury?.stakedOrbioDisplay).toBe('2,000.00');
    expect(body.treasury?.creditClaimableDisplay).toBe('3.00');
    expect(body.treasury?.creditWalletDisplay).toBe('0.50');
    expect(body.treasury?.apiAvailableDisplay).toBe('$40.00');
    expect(body.treasury?.apiUsedDisplay).toBe('$5.00');
    expect(body.treasury?.usdgDisplay).toBe('10.00');
    expect(body.treasury?.ethGasDisplay).toBe('0.005000');
    expect(body.treasury?.quote).toEqual({
      usdgIn: '10.00',
      creditOut: '15.00',
      discountPct: '33.3%',
    });

    // Exactly 2 rows with an explorer link + 1 greyed dry_run row.
    expect(body.events).toHaveLength(3);
    const withLinks = (body.events as { explorerUrl: string | null }[]).filter(
      (e) => e.explorerUrl !== null,
    );
    const dryRuns = (body.events as { dryRun: boolean }[]).filter((e) => e.dryRun);
    expect(withLinks).toHaveLength(2);
    expect(dryRuns).toHaveLength(1);

    // Exactly 1 public agent listed (the private one is excluded).
    expect(body.agents).toHaveLength(1);
    expect((body.agents[0] as { slug: string }).slug).toBe('treasurer');
  });
});

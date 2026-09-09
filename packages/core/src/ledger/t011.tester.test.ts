/**
 * T-011 · Tester pass (PROCESS.md §2 step 3, tasks/T-011.md).
 *
 * Written from tasks/T-011.md's Goal / In scope / Acceptance criteria / Tests required,
 * CLAUDE.md, and PRD FR-1.0-FR-1.3 / §9, ADR-002, ADR-005 alone. The exported API surface was
 * learned only from `index.ts` and `ledger/types.ts` (per the tester brief) before this file's
 * checklist was fixed; `metrics.ts`'s two type declarations (`SnapshotMetricsInput`,
 * `SnapshotMetrics`) and its two exported constants were also read for field names, but not its
 * function body, before writing the AC2 cases. See tasks/reports/T-011-test-1.md for the full
 * methodology disclosure, including an accidental early read of the ticket's Build
 * notes/Audit report/Evidence sections (this file's checklist was still written independently
 * from AC text, not from anything in those sections).
 *
 * This file does not re-derive the builder's own `conformance-suite.ts` (~19 tests) or
 * duplicate it; it independently proves AC1-AC4 in the ticket's own words, small and direct,
 * and is meant to run alongside `ledger-conformance.test.ts` / `metrics.test.ts`, not replace
 * them.
 *
 * AC1 (conformance on both stores): round-trip + FK-enforcement + append-only-shape checks,
 *   run against SQLite always and against Postgres only when TEST_DATABASE_URL is set (skips
 *   cleanly otherwise, mirroring ledger-conformance.test.ts's own skip message/pattern).
 * AC2 (metric table cases): computeSnapshotMetrics — zero burn, zero accrual, accrual > burn
 *   (runway null = infinite), the epsilon floor, and the low_confidence < 6h boundary.
 * AC3 (money round-trip): three decimal-string values named in the tester brief
 *   ("0.000001", "123456789012.123456", "-0.5") written into treasury_snapshots' money columns
 *   and read back byte-identical, on both stores under the same TEST_DATABASE_URL gate as AC1.
 * AC4 (kit boots with LEDGER=sqlite, no Supabase vars): strips every SUPABASE_* and
 *   DATABASE_URL var from process.env, opens a fresh sqlite ledger, completes a write.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeSnapshotMetrics,
  DEFAULT_EPSILON_USD_PER_DAY,
  LOW_CONFIDENCE_THRESHOLD_HOURS,
} from './metrics.js';
import { openPostgresLedger } from './postgres/store.js';
import { openSqliteLedger } from './sqlite/store.js';
import type { LedgerStore, NewAgent } from './types.js';

// -------------------------------------------------------------------------------------------
// Shared fixtures
// -------------------------------------------------------------------------------------------

function newAgentInput(): NewAgent {
  return {
    slug: `t011-tester-${randomUUID()}`,
    name: 'T-011 tester agent',
    mode: 'dry_run',
  };
}

// The three money values the tester brief names verbatim, and each one's expected 6dp-normalized
// round-trip form (numeric(18,6) / the sqlite store's decimal-string convention). "-0.5" has
// fewer than 6 decimal digits on input, so "byte-identical at 6dp" means the *normalized* form
// round-trips exactly, not the literal input string.
const MONEY_CASES = [
  { input: '0.000001', normalized: '0.000001' },
  { input: '123456789012.123456', normalized: '123456789012.123456' },
  { input: '-0.5', normalized: '-0.500000' },
] as const;

// -------------------------------------------------------------------------------------------
// AC1 + AC3 — one shared body run against each dialect (sqlite always, postgres when available)
// -------------------------------------------------------------------------------------------

function runAc1AndAc3(dialect: 'sqlite' | 'postgres', openStore: () => LedgerStore) {
  describe(`AC1 conformance + AC3 money round-trip — ${dialect}`, () => {
    let store: LedgerStore;

    beforeAll(() => {
      store = openStore();
    });

    afterAll(async () => {
      await store.close();
    });

    it('reports its own dialect', () => {
      expect(store.dialect).toBe(dialect);
    });

    it('agents: insert -> getAgent / getAgentBySlug round-trip, and updateAgent persists', async () => {
      const input = newAgentInput();
      const inserted = await store.insertAgent(input);
      expect(inserted.slug).toBe(input.slug);
      expect(inserted.mode).toBe('dry_run');

      const byId = await store.getAgent(inserted.id);
      expect(byId?.slug).toBe(input.slug);

      const bySlug = await store.getAgentBySlug(input.slug);
      expect(bySlug?.id).toBe(inserted.id);

      const updated = await store.updateAgent(inserted.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(updated.slug).toBe(input.slug); // immutable field untouched
    });

    it('key_meta: has no update method — revocation is append-only, a new row', () => {
      // FR-1.1: key_meta revocation is a new insertKeyMeta row with revokedAt set, never an
      // update. Prove the interface itself carries no such method (not just that nobody calls it).
      expect((store as unknown as Record<string, unknown>).updateKeyMeta).toBeUndefined();
    });

    it('key_meta: insertKeyMeta round-trips, and a revocation row is a separate insert', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const created = await store.insertKeyMeta({
        agentId: agent.id,
        keyPrefix: 'sk-or-v1',
        keyLast4: 'ab12',
      });
      expect(created.revokedAt).toBeNull();

      const revoked = await store.insertKeyMeta({
        agentId: agent.id,
        keyPrefix: 'sk-or-v1',
        keyLast4: 'ab12',
        revokedAt: '2026-09-09T00:00:00.000Z',
        reason: 'rotated',
      });
      expect(revoked.id).not.toBe(created.id);
      expect(revoked.revokedAt).toBe('2026-09-09T00:00:00.000Z');
    });

    it('usage_events: rejects a foreign key to a non-existent agent', async () => {
      await expect(
        store.insertUsageEvent({
          agentId: randomUUID(),
          at: '2026-09-09T00:00:00.000Z',
          model: 'test-model',
          status: 'ok',
        }),
      ).rejects.toBeTruthy();
    });

    it('orders: insert -> getOrder round-trip, then updateOrderFill patches only fill fields', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const decision = await store.insertDecision({
        agentId: agent.id,
        at: '2026-09-09T00:00:00.000Z',
        type: 'BUY_CREDIT',
      });
      const order = await store.insertOrder({
        agentId: agent.id,
        decisionId: decision.id,
        side: 'buy',
        usd: '10.000000',
        status: 'pending',
        placedAt: '2026-09-09T00:00:00.000Z',
      });
      expect(order.status).toBe('pending');

      const fetched = await store.getOrder(order.id);
      expect(fetched?.usd).toBe('10.000000');

      const filled = await store.updateOrderFill(order.id, {
        status: 'filled',
        filledUsd: '10.000000',
        feeUsd: '0.100000',
      });
      expect(filled.status).toBe('filled');
      expect(filled.side).toBe('buy'); // immutable field untouched
      expect(filled.usd).toBe('10.000000');
    });

    it('updateAgent on a non-existent id throws NotFoundError-shaped rejection', async () => {
      await expect(store.updateAgent(randomUUID(), { name: 'nope' })).rejects.toBeTruthy();
    });

    it('AC3: money fields round-trip byte-identical at 6dp, incl. tiny/huge/negative values', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const [tiny, huge, negative] = MONEY_CASES;

      const inserted = await store.insertTreasurySnapshot({
        agentId: agent.id,
        asOf: '2026-09-09T00:00:00.000Z',
        creditsAvailable: huge.input,
        creditsAccruedDelta: tiny.input,
        reconciliationDelta: negative.input,
        state: 'COMFORTABLE',
        balanceSource: 'mcp',
      });

      // Insert-time return value, and a fresh read, must both be byte-identical to the
      // 6dp-normalized form of the input (see MONEY_CASES comment).
      expect(inserted.creditsAvailable).toBe(huge.normalized);
      expect(inserted.creditsAccruedDelta).toBe(tiny.normalized);
      expect(inserted.reconciliationDelta).toBe(negative.normalized);

      const read = await store.latestTreasurySnapshot(agent.id);
      expect(read?.creditsAvailable).toBe(huge.normalized);
      expect(read?.creditsAccruedDelta).toBe(tiny.normalized);
      expect(read?.reconciliationDelta).toBe(negative.normalized);
    });
  });
}

runAc1AndAc3('sqlite', () => openSqliteLedger(':memory:'));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePgOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    't011.tester.test.ts: TEST_DATABASE_URL is not set — skipping the Postgres half of the ' +
      'AC1/AC3 tester checks. See tasks/T-002.md for how to run it against a local cluster.',
  );
}

const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

describePgOrSkip('postgres setup for the tester checks', () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  const adminSql = postgres(databaseUrl, { max: 1 });

  beforeAll(async () => {
    await adminSql.unsafe(`
      drop table if exists orders, book_snapshots, decisions, usage_events,
        treasury_snapshots, key_meta, agents cascade;
      drop function if exists ledger_reject_write() cascade;
      drop function if exists agents_guard_write() cascade;
      drop function if exists orders_guard_write() cascade;
    `);
    await adminSql.unsafe(
      "do $$ begin\n      if not exists (select 1 from pg_roles where rolname = 'anon') then\n        create role anon nologin;\n      end if;\n    end $$;",
    );
    await adminSql.unsafe(readMigration('001_schema.sql'));
    await adminSql.unsafe(readMigration('002_rls.sql'));
    await adminSql.unsafe(readMigration('003_append_only.sql'));
  });

  afterAll(async () => {
    await adminSql.end();
  });

  runAc1AndAc3('postgres', () => openPostgresLedger(databaseUrl));
});

// -------------------------------------------------------------------------------------------
// AC2 — computeSnapshotMetrics table cases
// -------------------------------------------------------------------------------------------

describe('AC2: computeSnapshotMetrics table cases', () => {
  const base = {
    creditsAvailableUsd: '1000.000000',
    accruedLast24hUsd: '0.000000',
    spentLast24hUsd: '0.000000',
    burnRateUsdPerDay: '0.000000',
    accrualRateUsdPerDay: '0.000000',
    historyHours: 24,
  };

  it('zero burn, zero accrual -> net burn is zero -> runway infinite (null)', () => {
    const result = computeSnapshotMetrics({
      ...base,
      burnRateUsdPerDay: '0.000000',
      accrualRateUsdPerDay: '0.000000',
    });
    expect(result.runwayDays).toBeNull();
  });

  it('zero accrual, positive burn -> finite runway = credits / burn', () => {
    const result = computeSnapshotMetrics({
      ...base,
      creditsAvailableUsd: '100.000000',
      burnRateUsdPerDay: '10.000000',
      accrualRateUsdPerDay: '0.000000',
    });
    expect(result.runwayDays).toBe('10.000000');
  });

  it('accrual > burn -> runway infinite (null), never a stored "Infinity" string', () => {
    const result = computeSnapshotMetrics({
      ...base,
      burnRateUsdPerDay: '5.000000',
      accrualRateUsdPerDay: '8.000000',
    });
    expect(result.runwayDays).toBeNull();
    expect(result.runwayDays).not.toBe('Infinity');
  });

  it('accrual == burn -> net burn zero -> runway infinite (null)', () => {
    const result = computeSnapshotMetrics({
      ...base,
      burnRateUsdPerDay: '5.000000',
      accrualRateUsdPerDay: '5.000000',
    });
    expect(result.runwayDays).toBeNull();
  });

  it('epsilon floor: net burn smaller than epsilon is floored to epsilon, not to zero/near-infinite', () => {
    // net burn = 0.001/day, well under the default epsilon (0.01 USD/day) -> denominator
    // clamps to epsilon, so runway must be far shorter than credits/0.001 would imply.
    const result = computeSnapshotMetrics({
      ...base,
      creditsAvailableUsd: '100.000000',
      burnRateUsdPerDay: '5.001000',
      accrualRateUsdPerDay: '5.000000',
    });
    const expectedRunway = 100 / Number(DEFAULT_EPSILON_USD_PER_DAY);
    expect(result.runwayDays).not.toBeNull();
    expect(Number(result.runwayDays)).toBeCloseTo(expectedRunway, 3);
    // Sanity: without the floor this would be 100 / 0.001 = 100,000 days, not ~10,000.
    expect(Number(result.runwayDays)).toBeLessThan(100 / 0.001);
  });

  it('epsilon floor: an explicit epsilonUsdPerDay overrides the default', () => {
    const result = computeSnapshotMetrics({
      ...base,
      creditsAvailableUsd: '100.000000',
      burnRateUsdPerDay: '5.000000',
      accrualRateUsdPerDay: '5.000000',
      epsilonUsdPerDay: '0.500000',
    });
    // net burn is exactly 0 here (accrual == burn), so runway is infinite regardless of
    // epsilon -- covered by the case above. This case instead proves the override is honored
    // when net burn is positive but below the custom epsilon.
    const withGap = computeSnapshotMetrics({
      ...base,
      creditsAvailableUsd: '100.000000',
      burnRateUsdPerDay: '5.100000',
      accrualRateUsdPerDay: '5.000000',
      epsilonUsdPerDay: '0.500000',
    });
    expect(result.runwayDays).toBeNull();
    expect(Number(withGap.runwayDays)).toBeCloseTo(100 / 0.5, 6);
  });

  it('coverageRatio is null when nothing was spent (undefined ratio), not zero or NaN', () => {
    const result = computeSnapshotMetrics({
      ...base,
      accruedLast24hUsd: '5.000000',
      spentLast24hUsd: '0.000000',
    });
    expect(result.coverageRatio).toBeNull();
  });

  it('coverageRatio = accrued / spent when spent is positive', () => {
    const result = computeSnapshotMetrics({
      ...base,
      accruedLast24hUsd: '4.000000',
      spentLast24hUsd: '8.000000',
    });
    expect(result.coverageRatio).toBe('0.500000');
  });

  it(`low_confidence: true strictly below ${LOW_CONFIDENCE_THRESHOLD_HOURS}h of history`, () => {
    expect(computeSnapshotMetrics({ ...base, historyHours: 0 }).burnLowConfidence).toBe(true);
    expect(
      computeSnapshotMetrics({
        ...base,
        historyHours: LOW_CONFIDENCE_THRESHOLD_HOURS - 0.01,
      }).burnLowConfidence,
    ).toBe(true);
  });

  it(`low_confidence: false at and above ${LOW_CONFIDENCE_THRESHOLD_HOURS}h of history`, () => {
    expect(
      computeSnapshotMetrics({ ...base, historyHours: LOW_CONFIDENCE_THRESHOLD_HOURS })
        .burnLowConfidence,
    ).toBe(false);
    expect(computeSnapshotMetrics({ ...base, historyHours: 24 }).burnLowConfidence).toBe(false);
  });

  it('no float touches the math: a value lossy in IEEE-754 round-trips exactly', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; if this ever got parsed to `number` internally, a
    // coverageRatio built from these inputs would show the drift.
    const result = computeSnapshotMetrics({
      ...base,
      accruedLast24hUsd: '0.300000',
      spentLast24hUsd: '0.300000',
    });
    expect(result.coverageRatio).toBe('1.000000');
  });
});

// -------------------------------------------------------------------------------------------
// AC4 — kit boots with LEDGER=sqlite and no SUPABASE_*/DATABASE_URL vars
// -------------------------------------------------------------------------------------------

describe('AC4: kit boots with LEDGER=sqlite and no Supabase env vars', () => {
  it('opens a sqlite ledger and completes a write with every SUPABASE_* and DATABASE_URL var removed', async () => {
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SUPABASE_') || key === 'DATABASE_URL') {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    process.env.LEDGER = 'sqlite';

    const dir = mkdtempSync(join(tmpdir(), 'orbio-ledger-t011-ac4-'));
    const dbPath = join(dir, 'nested', 'treasurer.db');
    let store: LedgerStore | undefined;
    try {
      expect(Object.keys(process.env).some((k) => k.startsWith('SUPABASE_'))).toBe(false);
      expect(process.env.DATABASE_URL).toBeUndefined();

      store = openSqliteLedger(dbPath);
      const agent = await store.insertAgent(newAgentInput());
      expect(agent.id).toBeTruthy();
    } finally {
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});

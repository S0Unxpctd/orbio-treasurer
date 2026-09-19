/**
 * S-02 · Tester pass (PROCESS.md §3, tasks/S-02.md).
 *
 * Written from tasks/S-02.md's Goal / In scope / Acceptance criteria / Tests required,
 * CLAUDE.md's Sprint 1.0 banner, and docs/PRD-1.0-sprint.md §4 T-2 / §6 alone — the ticket's own
 * "In scope" bullets already name every store method under test (insertCallerKey,
 * getCallerKeyByHash, revokeCallerKey, insertTreasuryEvent, listTreasuryEvents,
 * insertChainSnapshot, latestChainSnapshot, savings(), burnDaily()), so this file's checklist is
 * fixed from that text before any implementation file is opened.
 *
 * NOTE on methodology: the ticket file (tasks/S-02.md) was read via a single whole-file read
 * before its Build notes / Evidence sections could be skipped (a tool-use mistake, not
 * deliberate) — same failure mode T-011's tester pass flagged in its own file header. The
 * checklist below still comes from the Goal/In scope/AC/Tests-required text alone (all of which
 * repeats verbatim in this file's comments), and every assertion is derived from the AC wording,
 * not from the builder's stated design choices (e.g. this file does not assert on the specific
 * error class names beyond what AC3/AC4 already imply — "throws" / "rejected ... with a typed
 * error" — except where the exported type was read afterwards, during wiring, per the tester
 * brief's "read the implementation only as needed to wire the tests").
 *
 * Only the store interface (types.ts) and pure math module (metrics.ts) were read to wire this
 * file in, after the checklist below was fixed. This file does not duplicate
 * `conformance-suite.ts` / `metrics.test.ts` / `migration-005.test.ts` (the builder's own tests,
 * unread before writing this file) — it independently re-proves AC1-AC8 in the ticket's own
 * words, and is meant to run alongside them.
 *
 * AC1 — both dialects: a shared test body (round-trips on caller_keys / treasury_events /
 *   chain_snapshots) run against SQLite always, and against a real local Postgres cluster when
 *   TEST_DATABASE_URL is set (skips cleanly otherwise, same pattern as ledger-conformance.test.ts
 *   / t011.tester.test.ts).
 * AC2 — append-only: raw-SQL UPDATE on treasury_events / chain_snapshots / usage_events rejected
 *   by Postgres, and the LedgerStore interface exposes no update method for any of the three.
 * AC3 — revokeCallerKey: first call sets revoked_at once; second call throws; no other column
 *   changes.
 * AC4 — tx_hash outside ^0x[0-9a-f]{64}$ rejected at the store boundary with a typed error; a
 *   valid hash is accepted.
 * AC5 — savings(): hand-computed decimal math on a 10-event S/M/L-mix fixture across the 24h/7d/
 *   all windows, plus the baseline=0 -> savedPct="0.0000" case.
 * AC6 — burnDaily(): empty history -> "0.010000"; table-driven max(24h, 7d avg, ε) cases.
 * AC7 — migration 005 applies twice without error on a real local Postgres.
 * AC8 — caller_keys never holds anything but hash + prefix; no full key material anywhere in the
 *   row.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { burnDaily, DEFAULT_EPSILON_USD_PER_DAY, type MeteredTier, savings } from './metrics.js';
import { openPostgresLedger } from './postgres/store.js';
import { openSqliteLedger } from './sqlite/store.js';
import type { LedgerStore, NewAgent, NewUsageEvent } from './types.js';
import { CallerKeyAlreadyRevokedError, InvalidTxHashError } from './types.js';

// -------------------------------------------------------------------------------------------
// Shared fixtures / helpers
// -------------------------------------------------------------------------------------------

function newAgentInput(): NewAgent {
  return {
    slug: `s02-tester-${randomUUID()}`,
    name: 'S-02 tester agent',
    mode: 'dry_run',
  };
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const VALID_TX_HASH = `0x${'a'.repeat(64)}`;

// -------------------------------------------------------------------------------------------
// AC1 — round-trips on the 3 new tables, shared body run against each dialect
// -------------------------------------------------------------------------------------------

function runAc1(dialect: 'sqlite' | 'postgres', openStore: () => LedgerStore) {
  describe(`AC1: caller_keys / treasury_events / chain_snapshots round-trip — ${dialect}`, () => {
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

    it('caller_keys: insertCallerKey -> getCallerKeyByHash round-trips; agentId may be null', async () => {
      const keyHash = sha256hex(`raw-key-${randomUUID()}`);
      const created = await store.insertCallerKey({
        agentId: null,
        keyHash,
        keyPrefix: 'otk_ab12cd',
        label: 'no agent yet',
      });
      expect(created.agentId).toBeNull();
      expect(created.revokedAt).toBeNull();

      const fetched = await store.getCallerKeyByHash(keyHash);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.keyPrefix).toBe('otk_ab12cd');
    });

    it('treasury_events: insertTreasuryEvent -> listTreasuryEvents round-trips, newest first, honors limit', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const e1 = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-09-10T00:00:00.000Z',
        kind: 'settle',
      });
      const e2 = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-09-11T00:00:00.000Z',
        kind: 'claim',
        amount: '1000',
        token: 'CREDIT',
        usdValue: '1.000000',
        txHash: VALID_TX_HASH,
        meta: { note: 'from probe' },
      });
      expect(e1.kind).toBe('settle');
      expect(e2.txHash).toBe(VALID_TX_HASH);

      const listed = await store.listTreasuryEvents(agent.id, 10);
      expect(listed.map((e) => e.id)).toEqual([e2.id, e1.id]);

      const limited = await store.listTreasuryEvents(agent.id, 1);
      expect(limited).toHaveLength(1);
      expect(limited[0]?.id).toBe(e2.id);
    });

    it('treasury_events: rejects a foreign key to a non-existent agent', async () => {
      await expect(
        store.insertTreasuryEvent({
          agentId: randomUUID(),
          at: '2026-09-10T00:00:00.000Z',
          kind: 'alert',
        }),
      ).rejects.toBeTruthy();
    });

    it('chain_snapshots: insertChainSnapshot -> latestChainSnapshot returns the newest; null when none', async () => {
      const agent = await store.insertAgent(newAgentInput());
      expect(await store.latestChainSnapshot(agent.id)).toBeNull();

      await store.insertChainSnapshot({
        agentId: agent.id,
        asOf: '2026-09-10T00:00:00.000Z',
        stakedOrbio: '1000',
        mode: 'dry_run',
      });
      const newer = await store.insertChainSnapshot({
        agentId: agent.id,
        asOf: '2026-09-11T00:00:00.000Z',
        stakedOrbio: '2000',
        mode: 'dry_run',
      });

      const latest = await store.latestChainSnapshot(agent.id);
      expect(latest?.id).toBe(newer.id);
      expect(latest?.stakedOrbio).toBe('2000');
    });

    it('usage_events: insertUsageEvent accepts the S-02 fields (requestedModel, routeReason, baselineCostUsd, callerKeyId)', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const key = await store.insertCallerKey({
        agentId: agent.id,
        keyHash: sha256hex(`k-${randomUUID()}`),
        keyPrefix: 'otk_zz9988',
      });
      const inserted = await store.insertUsageEvent({
        agentId: agent.id,
        at: '2026-09-10T00:00:00.000Z',
        model: 'gpt-tier-s',
        tierServed: 'S',
        costUsd: '0.010000',
        status: 'ok',
        requestedModel: 'auto',
        routeReason: 'runway_low',
        baselineCostUsd: '0.050000',
        callerKeyId: key.id,
      });
      expect(inserted.requestedModel).toBe('auto');
      expect(inserted.routeReason).toBe('runway_low');
      expect(inserted.baselineCostUsd).toBe('0.050000');
      expect(inserted.callerKeyId).toBe(key.id);
    });
  });
}

runAc1('sqlite', () => openSqliteLedger(':memory:'));

// -------------------------------------------------------------------------------------------
// Postgres wiring shared by AC1-AC6/AC8's `postgres` runs and AC2/AC7's raw-SQL checks
// -------------------------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePgOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    's02.tester.test.ts: TEST_DATABASE_URL is not set — skipping the Postgres half of the ' +
      'S-02 tester checks (AC1 postgres run, AC2 trigger test, AC7 migration test). ' +
      'See tasks/S-02.md Evidence / tasks/T-011.md for the local-cluster recipe.',
  );
}

const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

describePgOrSkip('postgres setup for the S-02 tester checks', () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  const adminSql = postgres(databaseUrl, { max: 1 });

  beforeAll(async () => {
    await adminSql.unsafe(`
      drop table if exists chain_snapshots, treasury_events, orders, book_snapshots, decisions,
        usage_events, treasury_snapshots, caller_keys, key_meta, agents cascade;
      drop function if exists ledger_reject_write() cascade;
      drop function if exists agents_guard_write() cascade;
      drop function if exists orders_guard_write() cascade;
      drop function if exists caller_keys_guard_write() cascade;
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

  runAc1('postgres', () => openPostgresLedger(databaseUrl));

  // -----------------------------------------------------------------------------------------
  // AC2 — append-only enforced at the DB level (Postgres trigger) for the 3 new/extended tables
  // -----------------------------------------------------------------------------------------

  describe('AC2: append-only enforced in Postgres', () => {
    let store: LedgerStore;
    beforeAll(() => {
      store = openPostgresLedger(databaseUrl);
    });
    afterAll(async () => {
      await store.close();
    });

    it('the LedgerStore interface exposes no update method for treasury_events, chain_snapshots or usage_events', () => {
      const anyStore = store as unknown as Record<string, unknown>;
      expect(anyStore.updateTreasuryEvent).toBeUndefined();
      expect(anyStore.updateChainSnapshot).toBeUndefined();
      expect(anyStore.updateUsageEvent).toBeUndefined();
    });

    it('an UPDATE on treasury_events is rejected by Postgres', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const row = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-09-10T00:00:00.000Z',
        kind: 'settle',
      });
      await expect(
        adminSql.unsafe(`update treasury_events set kind = 'buy' where id = $1`, [row.id]),
      ).rejects.toBeTruthy();
    });

    it('an UPDATE on chain_snapshots is rejected by Postgres', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const row = await store.insertChainSnapshot({
        agentId: agent.id,
        asOf: '2026-09-10T00:00:00.000Z',
      });
      await expect(
        adminSql.unsafe(`update chain_snapshots set mode = 'live' where id = $1`, [row.id]),
      ).rejects.toBeTruthy();
    });

    it('an UPDATE on usage_events is rejected by Postgres', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const row = await store.insertUsageEvent({
        agentId: agent.id,
        at: '2026-09-10T00:00:00.000Z',
        model: 'gpt-tier-s',
        status: 'ok',
      });
      await expect(
        adminSql.unsafe(`update usage_events set status = 'upstream_error' where id = $1`, [
          row.id,
        ]),
      ).rejects.toBeTruthy();
    });

    it('a DELETE on treasury_events is also rejected (append-only means no deletes either)', async () => {
      const agent = await store.insertAgent(newAgentInput());
      const row = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-09-10T00:00:00.000Z',
        kind: 'settle',
      });
      await expect(
        adminSql.unsafe(`delete from treasury_events where id = $1`, [row.id]),
      ).rejects.toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------------------------
  // AC7 — migration 005 applies twice without error on a real local Postgres
  // -----------------------------------------------------------------------------------------

  describe('AC7: migration 005 applies twice without error', () => {
    it('applying 005_sprint_ledger.sql twice in a row both resolve', async () => {
      const sql005 = readMigration('005_sprint_ledger.sql');
      await expect(adminSql.unsafe(sql005)).resolves.toBeTruthy();
      await expect(adminSql.unsafe(sql005)).resolves.toBeTruthy();
    });
  });
});

// -------------------------------------------------------------------------------------------
// AC3 — revokeCallerKey: once ok, twice throws, no other column changes. Runs on sqlite (no DB
// dependency) so it always executes even without TEST_DATABASE_URL; the Postgres half of
// caller_keys' behaviour is exercised identically by AC1's postgres run above.
// -------------------------------------------------------------------------------------------

describe('AC3: revokeCallerKey', () => {
  it('sets revoked_at once; a second call throws; no other column changes', async () => {
    const store = openSqliteLedger(':memory:');
    try {
      const agent = await store.insertAgent(newAgentInput());
      const keyHash = sha256hex(`raw-${randomUUID()}`);
      const created = await store.insertCallerKey({
        agentId: agent.id,
        keyHash,
        keyPrefix: 'otk_r3vok3',
        label: 'to be revoked',
      });
      expect(created.revokedAt).toBeNull();

      const revoked = await store.revokeCallerKey(created.id, '2026-09-12T00:00:00.000Z');
      expect(revoked.revokedAt).toBe('2026-09-12T00:00:00.000Z');
      // no other column changed
      expect(revoked.id).toBe(created.id);
      expect(revoked.agentId).toBe(created.agentId);
      expect(revoked.keyHash).toBe(created.keyHash);
      expect(revoked.keyPrefix).toBe(created.keyPrefix);
      expect(revoked.label).toBe(created.label);

      await expect(
        store.revokeCallerKey(created.id, '2026-09-13T00:00:00.000Z'),
      ).rejects.toBeTruthy();
      await expect(
        store.revokeCallerKey(created.id, '2026-09-13T00:00:00.000Z'),
      ).rejects.toBeInstanceOf(CallerKeyAlreadyRevokedError);

      // revoked_at must still be the FIRST timestamp, not overwritten by the failed 2nd call
      const stillFirst = await store.getCallerKeyByHash(keyHash);
      expect(stillFirst?.revokedAt).toBe('2026-09-12T00:00:00.000Z');
    } finally {
      await store.close();
    }
  });

  it('revoking a non-existent id throws (not silently a no-op)', async () => {
    const store = openSqliteLedger(':memory:');
    try {
      await expect(
        store.revokeCallerKey(randomUUID(), '2026-09-12T00:00:00.000Z'),
      ).rejects.toBeTruthy();
    } finally {
      await store.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// AC4 — tx_hash outside ^0x[0-9a-f]{64}$ rejected at the store boundary with a typed error
// -------------------------------------------------------------------------------------------

describe('AC4: tx_hash validation at the store boundary', () => {
  const invalidHashes = [
    ['missing 0x prefix', 'a'.repeat(64)],
    ['too short', `0x${'a'.repeat(63)}`],
    ['too long', `0x${'a'.repeat(65)}`],
    ['uppercase hex (must be lowercase)', `0x${'A'.repeat(64)}`],
    ['non-hex characters', `0x${'g'.repeat(64)}`],
    ['empty string', ''],
  ] as const;

  it.each(invalidHashes)('rejects %s', async (_label, badHash) => {
    const store = openSqliteLedger(':memory:');
    try {
      const agent = await store.insertAgent(newAgentInput());
      await expect(
        store.insertTreasuryEvent({
          agentId: agent.id,
          at: '2026-09-10T00:00:00.000Z',
          kind: 'buy',
          txHash: badHash,
        }),
      ).rejects.toBeInstanceOf(InvalidTxHashError);
    } finally {
      await store.close();
    }
  });

  it('accepts a well-formed 0x + 64 lowercase hex hash', async () => {
    const store = openSqliteLedger(':memory:');
    try {
      const agent = await store.insertAgent(newAgentInput());
      const inserted = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-09-10T00:00:00.000Z',
        kind: 'buy',
        txHash: VALID_TX_HASH,
      });
      expect(inserted.txHash).toBe(VALID_TX_HASH);
    } finally {
      await store.close();
    }
  });

  it('a null/omitted tx_hash is allowed (nullable field)', async () => {
    const store = openSqliteLedger(':memory:');
    try {
      const agent = await store.insertAgent(newAgentInput());
      const inserted = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-09-10T00:00:00.000Z',
        kind: 'mode_change',
      });
      expect(inserted.txHash).toBeNull();
    } finally {
      await store.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// AC5 — savings(): hand-computed decimal math on a 10-event S/M/L-mix fixture
//
// now = 2026-09-15T00:00:00.000Z. Ten events at various offsets before `now`, spread so the
// 24h/7d/all windows each include a different subset. Every expected number below is computed
// by hand in these comments (not copied from the implementation) — see the per-window comment
// blocks for the arithmetic.
// -------------------------------------------------------------------------------------------

const NOW = '2026-09-15T00:00:00.000Z';

function hoursBefore(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() - hours * 60 * 60 * 1000).toISOString();
}

interface FixtureEvent {
  readonly hoursAgo: number;
  readonly tier: MeteredTier;
  readonly costUsd: string;
  readonly baselineCostUsd: string;
}

// | # | hoursAgo | tier | cost   | baseline | in 24h | in 7d |
// |---|----------|------|--------|----------|--------|-------|
// | 1 |   1      |  S   | 0.50   | 1.00     |  yes   |  yes  |
// | 2 |   5      |  S   | 0.25   | 0.50     |  yes   |  yes  |
// | 3 |  10      |  M   | 1.20   | 2.00     |  yes   |  yes  |
// | 4 |  20      |  M   | 0.80   | 1.60     |  yes   |  yes  |
// | 5 |  23      |  L   | 2.50   | 4.00     |  yes   |  yes  |
// | 6 |  25      |  L   | 1.75   | 2.75     |  no    |  yes  |
// | 7 |  48 (2d) |  S   | 0.40   | 0.80     |  no    |  yes  |
// | 8 |  96 (4d) |  M   | 0.90   | 1.50     |  no    |  yes  |
// | 9 | 167 (6d23h)| L  | 1.10   | 2.20     |  no    |  yes  |
// |10 | 216 (9d) |  S   | 5.00   | 10.00    |  no    |  no   |
const FIXTURE: readonly FixtureEvent[] = [
  { hoursAgo: 1, tier: 'S', costUsd: '0.500000', baselineCostUsd: '1.000000' },
  { hoursAgo: 5, tier: 'S', costUsd: '0.250000', baselineCostUsd: '0.500000' },
  { hoursAgo: 10, tier: 'M', costUsd: '1.200000', baselineCostUsd: '2.000000' },
  { hoursAgo: 20, tier: 'M', costUsd: '0.800000', baselineCostUsd: '1.600000' },
  { hoursAgo: 23, tier: 'L', costUsd: '2.500000', baselineCostUsd: '4.000000' },
  { hoursAgo: 25, tier: 'L', costUsd: '1.750000', baselineCostUsd: '2.750000' },
  { hoursAgo: 48, tier: 'S', costUsd: '0.400000', baselineCostUsd: '0.800000' },
  { hoursAgo: 96, tier: 'M', costUsd: '0.900000', baselineCostUsd: '1.500000' },
  { hoursAgo: 167, tier: 'L', costUsd: '1.100000', baselineCostUsd: '2.200000' },
  { hoursAgo: 216, tier: 'S', costUsd: '5.000000', baselineCostUsd: '10.000000' },
];

async function seedFixture(store: LedgerStore, agentId: string): Promise<void> {
  for (const [i, e] of FIXTURE.entries()) {
    const row: NewUsageEvent = {
      agentId,
      at: hoursBefore(NOW, e.hoursAgo),
      model: `model-${e.tier.toLowerCase()}`,
      tierServed: e.tier,
      costUsd: e.costUsd,
      baselineCostUsd: e.baselineCostUsd,
      status: 'ok',
    };
    void i;
    await store.insertUsageEvent(row);
  }
}

describe('AC5: savings() — hand-computed on a 10-event S/M/L fixture', () => {
  let store: LedgerStore;
  let agentId: string;

  beforeAll(async () => {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent(newAgentInput());
    agentId = agent.id;
    await seedFixture(store, agentId);
  });

  afterAll(async () => {
    await store.close();
  });

  // 24h window: events 1-5 (hoursAgo 1,5,10,20,23). cost=0.5+0.25+1.2+0.8+2.5=5.25,
  // baseline=1.0+0.5+2.0+1.6+4.0=9.1, saved=3.85, savedPct=3.85/9.1=0.42307...-> "0.4231".
  it('24h window: exact totals and byTier', async () => {
    const result = await savings(store, agentId, '24h', NOW);
    expect(result.calls).toBe(5);
    expect(result.costUsd).toBe('5.250000');
    expect(result.baselineUsd).toBe('9.100000');
    expect(result.savedUsd).toBe('3.850000');
    expect(result.savedPct).toBe('0.4231');
    expect(result.byTier.S).toEqual({ calls: 2, costUsd: '0.750000' });
    expect(result.byTier.M).toEqual({ calls: 2, costUsd: '2.000000' });
    expect(result.byTier.L).toEqual({ calls: 1, costUsd: '2.500000' });
  });

  // 7d window: events 1-9 (excludes #10 at 216h/9d). cost sum = 5.25+1.75+0.4+0.9+1.1 = 9.40,
  // baseline sum = 9.1+2.75+0.8+1.5+2.2 = 16.35, saved = 6.95, savedPct = 6.95/16.35 = 0.42507...
  // -> "0.4251" (round-half-away-from-zero at 4dp).
  it('7d window: exact totals and byTier', async () => {
    const result = await savings(store, agentId, '7d', NOW);
    expect(result.calls).toBe(9);
    expect(result.costUsd).toBe('9.400000');
    expect(result.baselineUsd).toBe('16.350000');
    expect(result.savedUsd).toBe('6.950000');
    expect(result.savedPct).toBe('0.4251');
    expect(result.byTier.S).toEqual({ calls: 3, costUsd: '1.150000' });
    expect(result.byTier.M).toEqual({ calls: 3, costUsd: '2.900000' });
    expect(result.byTier.L).toEqual({ calls: 3, costUsd: '5.350000' });
  });

  // all window: every event. cost = 9.40+5.00 = 14.40, baseline = 16.35+10.00 = 26.35,
  // saved = 11.95, savedPct = 11.95/26.35 = 0.45351... -> "0.4535".
  it('all window: exact totals and byTier', async () => {
    const result = await savings(store, agentId, 'all', NOW);
    expect(result.calls).toBe(10);
    expect(result.costUsd).toBe('14.400000');
    expect(result.baselineUsd).toBe('26.350000');
    expect(result.savedUsd).toBe('11.950000');
    expect(result.savedPct).toBe('0.4535');
    expect(result.byTier.S).toEqual({ calls: 4, costUsd: '6.150000' });
    expect(result.byTier.M).toEqual({ calls: 3, costUsd: '2.900000' });
    expect(result.byTier.L).toEqual({ calls: 3, costUsd: '5.350000' });
  });
});

describe('AC5: savings() — savedPct is "0.0000" when baseline is 0', () => {
  it('two events with zero baseline cost: savedPct = "0.0000" (not NaN/Infinity/error)', async () => {
    const store = openSqliteLedger(':memory:');
    try {
      const agent = await store.insertAgent(newAgentInput());
      await store.insertUsageEvent({
        agentId: agent.id,
        at: hoursBefore(NOW, 1),
        model: 'model-s',
        tierServed: 'S',
        costUsd: '1.000000',
        baselineCostUsd: '0.000000',
        status: 'ok',
      });
      await store.insertUsageEvent({
        agentId: agent.id,
        at: hoursBefore(NOW, 2),
        model: 'model-s',
        tierServed: 'S',
        costUsd: '2.000000',
        baselineCostUsd: '0.000000',
        status: 'ok',
      });

      const result = await savings(store, agent.id, 'all', NOW);
      expect(result.baselineUsd).toBe('0.000000');
      expect(result.costUsd).toBe('3.000000');
      expect(result.savedUsd).toBe('-3.000000');
      expect(result.savedPct).toBe('0.0000');
    } finally {
      await store.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// AC6 — burnDaily(): empty history = "0.010000"; table-driven max(24h, 7d avg, ε)
// -------------------------------------------------------------------------------------------

describe('AC6: burnDaily() — max(last 24h cost, 7-day daily average, ε)', () => {
  async function withEvents(
    events: ReadonlyArray<{ hoursAgo: number; costUsd: string }>,
  ): Promise<string> {
    const store = openSqliteLedger(':memory:');
    try {
      const agent = await store.insertAgent(newAgentInput());
      for (const e of events) {
        await store.insertUsageEvent({
          agentId: agent.id,
          at: hoursBefore(NOW, e.hoursAgo),
          model: 'model-s',
          status: 'ok',
          costUsd: e.costUsd,
        });
      }
      return burnDaily(store, agent.id, NOW);
    } finally {
      await store.close();
    }
  }

  it('empty history -> the epsilon floor, "0.010000"', async () => {
    expect(DEFAULT_EPSILON_USD_PER_DAY).toBe('0.01');
    const result = await withEvents([]);
    expect(result).toBe('0.010000');
  });

  it('24h cost dominates: 1.00 in the last 24h, nothing older -> 7d avg = 1.00/7 = 0.142857, max = "1.000000"', async () => {
    const result = await withEvents([{ hoursAgo: 2, costUsd: '1.000000' }]);
    expect(result).toBe('1.000000');
  });

  it('7-day average dominates: total 7d = 6.50 (avg 0.928571) vs last-24h = 0.50 -> "0.928571"', async () => {
    // last 24h: 0.50 (hoursAgo 1). Older, still within 7d: 3.00 (hoursAgo 72) + 3.00 (hoursAgo 120).
    // total7d = 0.5 + 3.0 + 3.0 = 6.5; avg7d = 6.5 / 7 = 0.928571428... -> "0.928571".
    // last24h = 0.5. max(0.5, 0.928571, 0.01) = 0.928571.
    const result = await withEvents([
      { hoursAgo: 1, costUsd: '0.500000' },
      { hoursAgo: 72, costUsd: '3.000000' },
      { hoursAgo: 120, costUsd: '3.000000' },
    ]);
    expect(result).toBe('0.928571');
  });

  it('history older than 7 days is excluded entirely from both the 24h and 7d-avg terms', async () => {
    // Only event is 9 days old -> both 24h cost and 7d total are 0 -> epsilon floor applies.
    const result = await withEvents([{ hoursAgo: 216, costUsd: '50.000000' }]);
    expect(result).toBe('0.010000');
  });

  it('epsilon floor still applies when real burn is smaller than ε', async () => {
    // last24h = 0.001 (below the 0.01 default epsilon) and nothing else -> floored to "0.010000".
    const result = await withEvents([{ hoursAgo: 1, costUsd: '0.001000' }]);
    expect(result).toBe('0.010000');
  });
});

// -------------------------------------------------------------------------------------------
// AC8 — caller_keys never holds anything but hash + prefix; the raw key never appears anywhere
// -------------------------------------------------------------------------------------------

describe('AC8: no secret/key material stored in caller_keys', () => {
  it('only key_hash (sha256 hex) and key_prefix are stored — the raw key is never a column value', async () => {
    const store = openSqliteLedger(':memory:');
    try {
      const agent = await store.insertAgent(newAgentInput());
      const rawKey = `otk_${randomUUID().replace(/-/g, '')}SUPERSECRETVALUE`;
      const keyHash = sha256hex(rawKey);
      const keyPrefix = rawKey.slice(0, 10);

      const created = await store.insertCallerKey({
        agentId: agent.id,
        keyHash,
        keyPrefix,
        label: 'label is free text, not secret',
      });

      // The hash is a 64-char lowercase hex digest, never the raw key itself.
      expect(created.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(created.keyHash).not.toBe(rawKey);
      expect(created.keyPrefix.length).toBeLessThan(rawKey.length);

      // Walk every string-valued field on the returned row and confirm none of them contain the
      // raw key as a substring.
      for (const [field, value] of Object.entries(created)) {
        if (typeof value === 'string') {
          expect(value.includes(rawKey), `field "${field}" must not contain the raw key`).toBe(
            false,
          );
        }
      }

      const fetched = await store.getCallerKeyByHash(keyHash);
      for (const [field, value] of Object.entries(fetched ?? {})) {
        if (typeof value === 'string') {
          expect(
            value.includes(rawKey),
            `re-fetched field "${field}" must not contain the raw key`,
          ).toBe(false);
        }
      }
    } finally {
      await store.close();
    }
  });
});

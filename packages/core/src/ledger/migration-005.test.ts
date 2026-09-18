/**
 * S-02 acceptance criteria that only a real Postgres cluster can prove: AC7 ("migration 005
 * applies twice without error") and the raw-SQL trigger guarantees on the three new tables
 * (AC2's "no update method" half is the LedgerStore side, covered by types.ts/conformance-suite;
 * this file is the SQL-level half, same split T-002's schema.postgres.test.ts already uses for
 * the original four append-only tables).
 *
 * SKIPS with a clear message unless TEST_DATABASE_URL is set — see tasks/S-02.md Evidence for
 * how to stand up a local cluster (same recipe as T-002/T-011).
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    'migration-005.test.ts: TEST_DATABASE_URL is not set — skipping the S-02 Postgres migration ' +
      'suite. See tasks/S-02.md for how to run it against a local cluster.',
  );
}

const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

describeOrSkip('migration 005 — Postgres delta (S-02)', () => {
  const sql = postgres(TEST_DATABASE_URL as string, { max: 1 });

  beforeAll(async () => {
    // Fresh slate, then apply 001-003 (the pre-S-02 baseline a real deployment already has —
    // note this run deliberately does NOT include 005 yet, so the "applies once" half of AC7 is
    // exercised for real, not just the "applies twice" half).
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
  });

  afterAll(async () => {
    await sql.end();
  });

  it('AC7: applies twice without error', async () => {
    await sql.unsafe(readMigration('005_sprint_ledger.sql'));
    // Second application must not throw — every statement is IF NOT EXISTS / DROP-then-CREATE.
    await expect(sql.unsafe(readMigration('005_sprint_ledger.sql'))).resolves.toBeDefined();
  });

  it('the new tables and usage_events columns exist after 005', async () => {
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(['caller_keys', 'treasury_events', 'chain_snapshots']),
    );

    const cols = await sql`
      select column_name from information_schema.columns where table_name = 'usage_events'
    `;
    const names = cols.map((c) => c.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'requested_model',
        'route_reason',
        'baseline_cost_usd',
        'caller_key_id',
      ]),
    );
  });

  async function insertAgent(slug: string): Promise<string> {
    const rows = await sql`
      insert into agents (slug, name, mode) values (${slug}, 'Test Agent', 'dry_run') returning id
    `;
    return rows[0]?.id as string;
  }

  describe('append-only: treasury_events, chain_snapshots reject UPDATE and DELETE', () => {
    it('treasury_events', async () => {
      const agentId = await insertAgent('m005-te-agent');
      const rows = await sql`
        insert into treasury_events (agent_id, at, kind) values (${agentId}, now(), 'dry_run')
        returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`update treasury_events set kind = 'buy' where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`delete from treasury_events where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
    });

    it('chain_snapshots', async () => {
      const agentId = await insertAgent('m005-cs-agent');
      const rows = await sql`
        insert into chain_snapshots (agent_id, as_of) values (${agentId}, now()) returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`update chain_snapshots set mode = 'live' where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`delete from chain_snapshots where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
    });
  });

  describe('caller_keys: mutable-guard — only revoked_at, DELETE always rejected', () => {
    it('allows updating only revoked_at', async () => {
      const rows = await sql`
        insert into caller_keys (key_hash, key_prefix) values ('hash-guard-1', 'otk_ab')
        returning id
      `;
      const id = rows[0]?.id as string;
      await expect(
        sql`update caller_keys set revoked_at = now() where id = ${id}`,
      ).resolves.toBeDefined();
    });

    it('rejects changing any other column', async () => {
      const rows = await sql`
        insert into caller_keys (key_hash, key_prefix) values ('hash-guard-2', 'otk_cd')
        returning id
      `;
      const id = rows[0]?.id as string;
      await expect(
        sql`update caller_keys set key_prefix = 'otk_zz' where id = ${id}`,
      ).rejects.toThrow(/only revoked_at may be updated/i);
    });

    it('rejects DELETE', async () => {
      const rows = await sql`
        insert into caller_keys (key_hash, key_prefix) values ('hash-guard-3', 'otk_ef')
        returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`delete from caller_keys where id = ${id}`).rejects.toThrow(
        /cannot be deleted/i,
      );
    });
  });

  it('tx_hash has no DB-level CHECK — validation is the store boundary’s job (AC4, S-02)', async () => {
    // Confirms the design choice documented in schema.ts/util.ts: an arbitrary string is
    // accepted at the SQL level (LedgerStore.insertTreasuryEvent is what rejects it — see
    // conformance-suite.ts's "tx_hash outside ^0x[0-9a-f]{64}$..." tests).
    const agentId = await insertAgent('m005-txhash-agent');
    await expect(
      sql`insert into treasury_events (agent_id, at, kind, tx_hash) values (${agentId}, now(), 'claim', 'not-a-hash')`,
    ).resolves.toBeDefined();
  });
});

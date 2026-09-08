/**
 * T-002 acceptance criteria against Postgres (the hosted-reference ADR-002 store).
 *
 * SKIPS with a clear message unless TEST_DATABASE_URL is set. See tasks/T-002.md "Evidence"
 * for how to stand up a local cluster and run this file.
 *
 * Assumes TEST_DATABASE_URL points at an empty database owned by a superuser (or at least a
 * role that can `create extension`, create roles/policies, and run migrations 001-003). This
 * suite creates the `anon` role itself if it doesn't already exist, applies migrations 001-003
 * from supabase/migrations/, and cleans up its own rows between tests (it does not drop the
 * database).
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    'schema.postgres.test.ts: TEST_DATABASE_URL is not set — skipping the Postgres ledger suite. ' +
      'See tasks/T-002.md for how to run it against a local cluster.',
  );
}

const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);

function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

describeOrSkip('postgres ledger schema (TEST_DATABASE_URL set)', () => {
  const sql = postgres(TEST_DATABASE_URL as string, { max: 1 });
  const anonSql = postgres(TEST_DATABASE_URL as string, { max: 1 });

  beforeAll(async () => {
    // Fresh slate: drop anything a previous run left, then apply 001-003.
    // 004_cron.sql is intentionally not applied — pg_cron/pg_net aren't installed locally
    // (T-002's scope note); it is instead checked below for syntax/content only.
    await sql.unsafe(`
      drop table if exists orders, book_snapshots, decisions, usage_events,
        treasury_snapshots, key_meta, agents cascade;
      drop function if exists ledger_reject_write() cascade;
      drop function if exists agents_guard_write() cascade;
      drop function if exists orders_guard_write() cascade;
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
    await anonSql.end();
  });

  it('AC1: supabase db push equivalent applies on an empty project', async () => {
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining([
        'agents',
        'book_snapshots',
        'decisions',
        'key_meta',
        'orders',
        'treasury_snapshots',
        'usage_events',
      ]),
    );
  });

  it('money columns are numeric(18,6), never float/real', async () => {
    const cols = await sql`
      select column_name, data_type, numeric_precision, numeric_scale
      from information_schema.columns
      where table_name = 'treasury_snapshots' and column_name = 'credits_available'
    `;
    expect(cols[0]?.data_type).toBe('numeric');
    expect(cols[0]?.numeric_precision).toBe(18);
    expect(cols[0]?.numeric_scale).toBe(6);
  });

  it('token amount columns are numeric(30,0)', async () => {
    const cols = await sql`
      select data_type, numeric_precision, numeric_scale
      from information_schema.columns
      where table_name = 'treasury_snapshots' and column_name = 'orbio_balance_tokens'
    `;
    expect(cols[0]?.data_type).toBe('numeric');
    expect(cols[0]?.numeric_precision).toBe(30);
    expect(cols[0]?.numeric_scale).toBe(0);
  });

  async function insertAgent(overrides: { slug: string; public?: boolean }) {
    const rows = await sql`
      insert into agents (slug, name, mode, public)
      values (${overrides.slug}, 'Test Agent', 'dry_run', ${overrides.public ?? true})
      returning id
    `;
    return rows[0]?.id as string;
  }

  async function insertDecision(agentId: string, isPublic = true) {
    const rows = await sql`
      insert into decisions (agent_id, at, type, public)
      values (${agentId}, now(), 'ROUTE', ${isPublic})
      returning id
    `;
    return rows[0]?.id as string;
  }

  describe('AC2: append-only tables reject UPDATE and DELETE (FR-1.1)', () => {
    it('treasury_snapshots', async () => {
      const agentId = await insertAgent({ slug: 'ts-agent' });
      const rows = await sql`
        insert into treasury_snapshots (agent_id, as_of, state, balance_source)
        values (${agentId}, now(), 'COMFORTABLE', 'mcp') returning id
      `;
      const id = rows[0]?.id as string;
      await expect(
        sql`update treasury_snapshots set state = 'TIGHT' where id = ${id}`,
      ).rejects.toThrow(/append-only/i);
      await expect(sql`delete from treasury_snapshots where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
    });

    it('usage_events', async () => {
      const agentId = await insertAgent({ slug: 'ue-agent' });
      const rows = await sql`
        insert into usage_events (agent_id, at, model, status)
        values (${agentId}, now(), 'gpt', 'ok') returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`update usage_events set status = 'error' where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`delete from usage_events where id = ${id}`).rejects.toThrow(/append-only/i);
    });

    it('decisions', async () => {
      const agentId = await insertAgent({ slug: 'dec-agent' });
      const id = await insertDecision(agentId);
      await expect(sql`update decisions set type = 'ALERT' where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`delete from decisions where id = ${id}`).rejects.toThrow(/append-only/i);
    });

    it('book_snapshots', async () => {
      const rows = await sql`
        insert into book_snapshots (at, source) values (now(), 'api') returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`update book_snapshots set source = 'page' where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`delete from book_snapshots where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
    });

    it('key_meta (PRD 0.3.1, FR-1.1 — revocation is a new row, never an update)', async () => {
      const agentId = await insertAgent({ slug: 'km-agent' });
      const rows = await sql`
        insert into key_meta (agent_id, key_prefix, key_last4) values (${agentId}, 'sk-or', '1234')
        returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`update key_meta set revoked_at = now() where id = ${id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`delete from key_meta where id = ${id}`).rejects.toThrow(/append-only/i);
    });
  });

  describe('orders: only status/filled_usd/fee_usd/resolved_at/external_id are mutable', () => {
    it('allows updating status', async () => {
      const agentId = await insertAgent({ slug: 'ord-agent-1' });
      const decisionId = await insertDecision(agentId);
      const rows = await sql`
        insert into orders (agent_id, decision_id, side, usd, status, placed_at)
        values (${agentId}, ${decisionId}, 'buy', 10, 'pending', now()) returning id
      `;
      const id = rows[0]?.id as string;
      await expect(
        sql`update orders set status = 'filled' where id = ${id}`,
      ).resolves.toBeDefined();
    });

    it('rejects updating an immutable column', async () => {
      const agentId = await insertAgent({ slug: 'ord-agent-2' });
      const decisionId = await insertDecision(agentId);
      const rows = await sql`
        insert into orders (agent_id, decision_id, side, usd, status, placed_at)
        values (${agentId}, ${decisionId}, 'buy', 10, 'pending', now()) returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`update orders set usd = 999 where id = ${id}`).rejects.toThrow(
        /only status, filled_usd, fee_usd, resolved_at, external_id may be updated/,
      );
    });

    it('rejects DELETE (parity with the SQLite suite — audit pass 1 F3)', async () => {
      const agentId = await insertAgent({ slug: 'ord-agent-3' });
      const decisionId = await insertDecision(agentId);
      const rows = await sql`
        insert into orders (agent_id, decision_id, side, usd, status, placed_at)
        values (${agentId}, ${decisionId}, 'buy', 10, 'pending', now()) returning id
      `;
      const id = rows[0]?.id as string;
      await expect(sql`delete from orders where id = ${id}`).rejects.toThrow(
        /orders rows cannot be deleted/,
      );
    });
  });

  describe('agents: mutable-column guard (parity with the SQLite suite — audit pass 1 F3)', () => {
    it('allows updating a display field and last_seen_at', async () => {
      const agentId = await insertAgent({ slug: 'agents-guard-1' });
      await expect(
        sql`update agents set name = 'Renamed Agent', last_seen_at = now() where id = ${agentId}`,
      ).resolves.toBeDefined();
      const rows = await sql`select name from agents where id = ${agentId}`;
      expect(rows[0]?.name).toBe('Renamed Agent');
    });

    it('rejects updating an immutable column (e.g. mode)', async () => {
      const agentId = await insertAgent({ slug: 'agents-guard-2' });
      await expect(sql`update agents set mode = 'live' where id = ${agentId}`).rejects.toThrow(
        /only name, repo_url, x_handle, template, last_seen_at may be updated/,
      );
    });

    it('rejects DELETE', async () => {
      const agentId = await insertAgent({ slug: 'agents-guard-3' });
      await expect(sql`delete from agents where id = ${agentId}`).rejects.toThrow(
        /agents rows cannot be deleted/,
      );
    });
  });

  describe('AC3: RLS — anon sees only public rows', () => {
    it('agents: anon sees only public = true rows', async () => {
      await insertAgent({ slug: 'rls-public', public: true });
      await insertAgent({ slug: 'rls-private', public: false });
      await anonSql.unsafe('set role anon');
      const rows =
        await anonSql`select slug from agents where slug in ('rls-public', 'rls-private')`;
      expect(rows.map((r) => r.slug)).toEqual(['rls-public']);
      await anonSql.unsafe('reset role');
    });

    it('decisions: anon sees only public = true rows', async () => {
      const agentId = await insertAgent({ slug: 'rls-dec-agent' });
      await insertDecision(agentId, true);
      await insertDecision(agentId, false);
      await anonSql.unsafe('set role anon');
      const rows = await anonSql`
        select public from decisions where agent_id = ${agentId}
      `;
      expect(rows.every((r) => r.public === true)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      await anonSql.unsafe('reset role');
    });

    it('treasury_snapshots: anon sees rows only for agents with public = true', async () => {
      const publicAgent = await insertAgent({ slug: 'rls-ts-public', public: true });
      const privateAgent = await insertAgent({ slug: 'rls-ts-private', public: false });
      await sql`insert into treasury_snapshots (agent_id, as_of, state, balance_source) values (${publicAgent}, now(), 'COMFORTABLE', 'mcp')`;
      await sql`insert into treasury_snapshots (agent_id, as_of, state, balance_source) values (${privateAgent}, now(), 'COMFORTABLE', 'mcp')`;

      await anonSql.unsafe('set role anon');
      const rows = await anonSql`
        select agent_id from treasury_snapshots where agent_id in (${publicAgent}, ${privateAgent})
      `;
      expect(rows.map((r) => r.agent_id)).toEqual([publicAgent]);
      await anonSql.unsafe('reset role');
    });

    it('key_meta: anon has no read access at all', async () => {
      const agentId = await insertAgent({ slug: 'rls-km-agent' });
      await sql`insert into key_meta (agent_id, key_prefix, key_last4) values (${agentId}, 'sk-or', '1234')`;
      await anonSql.unsafe('set role anon');
      await expect(anonSql`select * from key_meta`).rejects.toThrow(/permission denied/i);
      await anonSql.unsafe('reset role');
    });

    it('book_snapshots: readable by anon (global, no agent to gate on — see schema.ts doc)', async () => {
      await sql`insert into book_snapshots (at, source) values (now(), 'api')`;
      await anonSql.unsafe('set role anon');
      const rows = await anonSql`select count(*)::int as n from book_snapshots`;
      expect((rows[0]?.n as number) ?? 0).toBeGreaterThan(0);
      await anonSql.unsafe('reset role');
    });
  });

  it('AC4 (syntax only, pg_cron/pg_net not installed locally): 004_cron.sql schedules */15 * * * *', () => {
    const cron = readMigration('004_cron.sql');
    expect(cron).toContain("cron.schedule(\n  'treasurer-tick',\n  '*/15 * * * *',");
    expect(cron).toContain('create extension if not exists pg_cron;');
    expect(cron).toContain('create extension if not exists pg_net;');
    expect(cron).not.toMatch(/https?:\/\//); // no hard-coded URL
  });
});

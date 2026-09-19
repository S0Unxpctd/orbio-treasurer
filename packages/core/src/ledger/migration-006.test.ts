/**
 * S-06 acceptance criteria that only a real Postgres cluster can prove (AC7: "Migration 006
 * applies twice on local Postgres; the cron job row has the new command"), plus what can't be
 * proven locally at all — same split as T-002's `schema.postgres.test.ts` uses for 004_cron.sql
 * and S-02's `migration-005.test.ts` uses for 005: `pg_cron`/`pg_net` are not installed in this
 * sandbox (confirmed: `select cron.schedule(...)` fails with `schema "cron" does not exist`), so
 * the cron half of 006 is checked for syntax/content only, never executed — the `cron.job`
 * row it would update can only be read on the real Supabase project (docs/runbook.md).
 *
 * SKIPS with a clear message unless TEST_DATABASE_URL is set — see tasks/S-02.md Evidence for
 * how to stand up a local cluster (same recipe reused for this ticket).
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    'migration-006.test.ts: TEST_DATABASE_URL is not set — skipping the S-06 Postgres migration ' +
      'suite. See tasks/S-02.md for how to run it against a local cluster.',
  );
}

const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

/** The part of 006 this sandbox CAN execute for real — everything before the cron re-point
 *  (marked by this exact comment in the migration file itself). Splitting here, rather than
 *  wrapping the whole file in a try/catch that swallows the expected `schema "cron" does not
 *  exist` error, keeps this test unable to silently pass on a DIFFERENT, unexpected failure in
 *  the constraint half. */
const CRON_SECTION_MARKER = '-- --- 2. re-point the cron job';
function splitMigration006(): {
  readonly constraintSql: string;
  readonly full: string;
  /** The cron section's SQL only — comment lines (`--...`) stripped, so an assertion like "does
   *  not mention x-cron-secret" checks the actual statement, not this file's own prose
   *  explaining what it replaces. */
  readonly cronSqlNoComments: string;
} {
  const full = readMigration('006_tick_marker_and_cron.sql');
  const idx = full.indexOf(CRON_SECTION_MARKER);
  if (idx === -1) {
    throw new Error(
      'migration-006.test.ts: cron section marker not found — did 006 get rewritten?',
    );
  }
  const cronSection = full.slice(idx);
  const cronSqlNoComments = cronSection
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return { constraintSql: full.slice(0, idx), full, cronSqlNoComments };
}

describeOrSkip('migration 006 — Postgres delta (S-06)', () => {
  const sql = postgres(TEST_DATABASE_URL as string, { max: 1 });

  beforeAll(async () => {
    // Fresh 001-003 (current schema.ts — already includes 'tick' in the CHECK, since it's the
    // single source of truth gen-sql.ts renders from). To faithfully exercise 006 as a DELTA
    // against the real, already-migrated Supabase project (which does NOT have 'tick' yet —
    // it was migrated before this ticket), the constraint is rolled back to the pre-006 list
    // right after, exactly mirroring what that project's `treasury_events_kind_check` looks like
    // today.
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
    await sql.unsafe(`
      alter table treasury_events drop constraint if exists treasury_events_kind_check;
      alter table treasury_events add constraint treasury_events_kind_check
        check (kind in ('settle','claim','activate','buy','stake','mode_change','alert','dry_run'));
    `);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function insertAgent(slug: string): Promise<string> {
    const rows = await sql`
      insert into agents (slug, name, mode) values (${slug}, 'Test Agent', 'dry_run') returning id
    `;
    return rows[0]?.id as string;
  }

  it("pre-006 baseline: 'tick' is NOT yet a valid kind (proves the rollback above worked)", async () => {
    const agentId = await insertAgent('m006-pre-agent');
    await expect(
      sql`insert into treasury_events (agent_id, at, kind) values (${agentId}, now(), 'tick')`,
    ).rejects.toThrow(/violates check constraint/i);
  });

  it('AC7: the executable (constraint) half of 006 applies twice without error', async () => {
    const { constraintSql } = splitMigration006();
    await expect(sql.unsafe(constraintSql)).resolves.toBeDefined();
    await expect(sql.unsafe(constraintSql)).resolves.toBeDefined();
  });

  it("after 006, 'tick' is a valid treasury_events.kind — the tick marker row S-06's tick.ts writes", async () => {
    const agentId = await insertAgent('m006-post-agent');
    const rows = await sql`
      insert into treasury_events (agent_id, at, kind, meta)
      values (${agentId}, now(), 'tick', ${sql.json({ bucket: '2026-09-19T12:00' })})
      returning kind, meta
    `;
    expect(rows[0]?.kind).toBe('tick');
    expect(rows[0]?.meta).toEqual({ bucket: '2026-09-19T12:00' });
  });

  it('every pre-006 kind is still accepted (the CHECK list only grew, nothing was removed)', async () => {
    const agentId = await insertAgent('m006-old-kinds-agent');
    const oldKinds = [
      'settle',
      'claim',
      'activate',
      'buy',
      'stake',
      'mode_change',
      'alert',
      'dry_run',
    ];
    for (const kind of oldKinds) {
      await expect(
        sql`insert into treasury_events (agent_id, at, kind) values (${agentId}, now(), ${kind})`,
      ).resolves.toBeDefined();
    }
  });

  it('a tick marker row is append-only, same as every other treasury_events row', async () => {
    const agentId = await insertAgent('m006-append-only-agent');
    const rows = await sql`
      insert into treasury_events (agent_id, at, kind) values (${agentId}, now(), 'tick') returning id
    `;
    const id = rows[0]?.id as string;
    await expect(sql`update treasury_events set kind = 'buy' where id = ${id}`).rejects.toThrow(
      /append-only/i,
    );
    await expect(sql`delete from treasury_events where id = ${id}`).rejects.toThrow(/append-only/i);
  });

  it(
    'NOT executable locally (pg_cron/pg_net not installed — confirmed: "schema \\"cron\\" does not exist"): ' +
      "the cron re-point is checked by content only, same as 004_cron.sql's own test",
    () => {
      const { cronSqlNoComments } = splitMigration006();
      expect(cronSqlNoComments).toContain("cron.schedule(\n  'treasurer-tick',\n  '*/15 * * * *',");
      expect(cronSqlNoComments).toContain("'x-tick-secret', current_setting('app.tick_secret')");
      expect(cronSqlNoComments).not.toContain('x-cron-secret');
      expect(cronSqlNoComments).not.toContain('app.cron_secret');
      expect(cronSqlNoComments).not.toMatch(/https?:\/\//); // no hard-coded URL, same rule as 004
    },
  );
});

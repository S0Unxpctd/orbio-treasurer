/**
 * Runs the shared LedgerStore conformance suite (FR-1.0) against both dialects:
 *   - SQLite: a fresh in-memory database, always runs — no external dependency (CLAUDE.md #5c).
 *   - Postgres: only when TEST_DATABASE_URL is set. Skips cleanly with a console message
 *     otherwise, exactly like schema.postgres.test.ts (T-002) — this sandbox has outbound TCP
 *     5432 blocked, so this suite is written to be run, not run here.
 *
 * Postgres setup mirrors schema.postgres.test.ts: drop-and-reapply migrations 001-003 against
 * an empty/owned test database, then hand the same connection string to `openPostgresLedger`
 * (PostgresLedgerStore itself never applies migrations — see ledger/postgres/store.ts).
 *
 * Importing `postgres` and `openPostgresLedger` at the top of the file is safe even when the
 * Postgres branch below is skipped: `postgres(...)` is a lazy client factory (ADR-005 — no
 * connection is opened until the first query), so nothing here performs network I/O at import
 * or collection time, only inside the `beforeAll` that `describeOrSkip` may skip entirely.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe } from 'vitest';
import { defineLedgerConformanceSuite } from './conformance-suite.js';
import { openPostgresLedger } from './postgres/store.js';
import { openSqliteLedger } from './sqlite/store.js';

defineLedgerConformanceSuite('sqlite (in-memory)', () => openSqliteLedger(':memory:'));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    'ledger-conformance.test.ts: TEST_DATABASE_URL is not set — skipping the Postgres ledger ' +
      'conformance suite. See tasks/T-002.md for how to run it against a local cluster.',
  );
}

const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

describeOrSkip('postgres setup for the conformance suite', () => {
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
    // S-02: 005 is a hand-written delta (ALTER/CREATE IF NOT EXISTS) meant to run AFTER 001-003
    // on an already-migrated database; applying it here too (redundantly, since 001-003 already
    // fully regenerate the new tables/columns) is exactly what the real migration order does and
    // keeps this suite exercising 005's idempotence as a side effect (AC7 has its own dedicated
    // test — see migration-005.test.ts).
    await adminSql.unsafe(readMigration('005_sprint_ledger.sql'));
  });

  afterAll(async () => {
    await adminSql.end();
  });

  defineLedgerConformanceSuite('postgres', () => openPostgresLedger(databaseUrl));
});

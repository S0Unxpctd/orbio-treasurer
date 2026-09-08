/**
 * T-002 tester pass (PROCESS.md §2 step 3, tasks/T-002.md).
 *
 * These are tests the tester's independent AC/PRD-derived checklist called for that the
 * builder's schema.sqlite.test.ts / schema.postgres.test.ts / env.test.ts did not already
 * cover. Existing coverage is not duplicated here — see tasks/reports/T-002-test-1.md for the
 * full checklist and which items were already satisfied.
 *
 * Gaps closed:
 *   - AC4 (004_cron.sql schedule + no hard-coded secret/URL) was previously asserted only inside
 *     schema.postgres.test.ts's `describe.skip`-guarded block, so it never actually ran under
 *     the CI default (no TEST_DATABASE_URL). Re-asserted here unconditionally, no DB needed.
 *   - orders/agents mutable-column guard: existing tests prove "update only mutable columns"
 *     succeeds and "update only one immutable column" fails, but never prove that updating a
 *     mix of one mutable + one immutable column in the *same* statement is rejected as a whole
 *     (i.e. the guard isn't accidentally column-by-column / partially-applying).
 *   - env.ts: partial STAKE_CLIENT=uniswap env (some L2a vars set) names only the vars still
 *     missing, not the full fixed list — distinguishes "hard-coded full list" from "actually
 *     computed per-variable".
 *   - Postgres: money round-trips as an exact decimal (SQLite already proves this; Postgres
 *     side was only proven at the metadata level — numeric(18,6) — not at the value level).
 *   - Postgres: migrations 001-003 applied a second time to the same (non-empty) database are
 *     observed and the behaviour documented (idempotency is explicitly NOT required by AC1,
 *     which only requires "applies on an empty project").
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../env.js';

const SQLITE_SCHEMA_SQL = readFileSync(new URL('./sqlite/schema.sql', import.meta.url), 'utf8');
const MIGRATIONS_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
}

// ---------------------------------------------------------------------------------------------
// AC4 — cron.job schedule + no hard-coded secret/URL. Runs unconditionally (no DB required):
// this is a static assertion about a committed file, and must not be gated behind
// TEST_DATABASE_URL the way the builder's copy of this check is.
// ---------------------------------------------------------------------------------------------
describe('004_cron.sql (AC4) — static content, no DB required', () => {
  const cron = readMigration('004_cron.sql');

  it('schedules the tick at */15 * * * *', () => {
    expect(cron).toMatch(/'\*\/15 \* \* \* \*'/);
    expect(cron).toMatch(/cron\.schedule\s*\(/);
  });

  it('contains no hard-coded http(s) URL', () => {
    expect(cron).not.toMatch(/https?:\/\//);
  });

  it('contains no literal secret value (only current_setting(...) references)', () => {
    // The job must read the URL/secret from Postgres settings, never inline them.
    expect(cron).toMatch(/current_setting\(\s*'app\.tick_url'\s*\)/);
    expect(cron).toMatch(/current_setting\(\s*'app\.cron_secret'\s*\)/);
    // No JWT-shaped or connection-string-shaped literal anywhere in the file.
    expect(cron).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // JWT-looking literal
    expect(cron).not.toMatch(/postgres(ql)?:\/\//); // connection string
    expect(cron).not.toMatch(/sk-[A-Za-z0-9]/); // key-shaped literal
  });
});

// ---------------------------------------------------------------------------------------------
// SQLite: mutable-column guard rejects a *mixed* update (one mutable + one immutable column)
// as a whole, not just single-immutable-column updates.
// ---------------------------------------------------------------------------------------------
describe('sqlite — mutable-column guard rejects mixed mutable+immutable updates atomically', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbio-ledger-t002-'));
    db = new Database(join(dir, 'treasurer.db'));
    db.pragma('foreign_keys = ON');
    db.exec(SQLITE_SCHEMA_SQL);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertAgent(): string {
    const id = randomUUID();
    db.prepare(
      `insert into agents (id, slug, name, mode, public) values (?, ?, 'Agent', 'dry_run', 1)`,
    ).run(id, `agent-${id.slice(0, 8)}`);
    return id;
  }
  function insertDecision(agentId: string): string {
    const id = randomUUID();
    db.prepare(
      `insert into decisions (id, agent_id, at, type, public) values (?, ?, ?, 'ROUTE', 1)`,
    ).run(id, agentId, new Date().toISOString());
    return id;
  }

  it('orders: updating status alone succeeds and persists', () => {
    const agentId = insertAgent();
    const decisionId = insertDecision(agentId);
    const orderId = randomUUID();
    db.prepare(
      `insert into orders (id, agent_id, decision_id, side, usd, status, placed_at)
       values (?, ?, ?, 'buy', '10.000000', 'pending', ?)`,
    ).run(orderId, agentId, decisionId, new Date().toISOString());

    expect(() =>
      db.prepare("update orders set status = 'filled' where id = ?").run(orderId),
    ).not.toThrow();
    const row = db.prepare('select status, usd from orders where id = ?').get(orderId) as {
      status: string;
      usd: string;
    };
    expect(row.status).toBe('filled');
    expect(row.usd).toBe('10.000000');
  });

  it('orders: updating status AND usd together is rejected, and status is NOT partially applied', () => {
    const agentId = insertAgent();
    const decisionId = insertDecision(agentId);
    const orderId = randomUUID();
    db.prepare(
      `insert into orders (id, agent_id, decision_id, side, usd, status, placed_at)
       values (?, ?, ?, 'buy', '10.000000', 'pending', ?)`,
    ).run(orderId, agentId, decisionId, new Date().toISOString());

    expect(() =>
      db
        .prepare("update orders set status = 'filled', usd = '999.000000' where id = ?")
        .run(orderId),
    ).toThrow(/only status, filled_usd, fee_usd, resolved_at, external_id may be updated/);

    const row = db.prepare('select status, usd from orders where id = ?').get(orderId) as {
      status: string;
      usd: string;
    };
    // The whole statement must be rolled back — status must still be 'pending', not 'filled'.
    expect(row.status).toBe('pending');
    expect(row.usd).toBe('10.000000');
  });

  it('agents: updating name AND slug together is rejected, and name is NOT partially applied', () => {
    const agentId = insertAgent();
    expect(() =>
      db
        .prepare("update agents set name = 'New Name', slug = 'new-slug' where id = ?")
        .run(agentId),
    ).toThrow(/only name, repo_url, x_handle, template, last_seen_at may be updated/);

    const row = db.prepare('select name, slug from agents where id = ?').get(agentId) as {
      name: string;
      slug: string;
    };
    expect(row.name).toBe('Agent');
    expect(row.slug).not.toBe('new-slug');
  });
});

// ---------------------------------------------------------------------------------------------
// env.ts — partial credentials must name only what's still missing, not a hard-coded full list.
// ---------------------------------------------------------------------------------------------
describe('env.ts — missing-var lists are computed per variable, not a fixed template', () => {
  it('STAKE_CLIENT=uniswap with some L2a vars already set names only the rest', () => {
    let error: unknown;
    try {
      loadEnv({
        STAKE_CLIENT: 'uniswap',
        RH_RPC_URL: 'https://rpc.example',
        UNISWAP_ROUTER: '0xrouter',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const missing = (error as EnvValidationError).missing;
    expect(missing).toEqual(['UNISWAP_QUOTER', 'ORBIO_TOKEN', 'STABLE_TOKEN', 'AGENT_WALLET_PK']);
    expect(missing).not.toContain('RH_RPC_URL');
    expect(missing).not.toContain('UNISWAP_ROUTER');
  });

  it('BOOK_CLIENT=orbio with only ORBIO_BUY_URL set names only ORBIO_BUY_TOKEN', () => {
    let error: unknown;
    try {
      loadEnv({ BOOK_CLIENT: 'orbio', ORBIO_BUY_URL: 'https://buy.example' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(['ORBIO_BUY_TOKEN']);
  });

  it('a fully-satisfied STAKE_CLIENT=uniswap env does not throw', () => {
    expect(() =>
      loadEnv({
        STAKE_CLIENT: 'uniswap',
        RH_RPC_URL: 'https://rpc.example',
        UNISWAP_ROUTER: '0xrouter',
        UNISWAP_QUOTER: '0xquoter',
        ORBIO_TOKEN: '0xtoken',
        STABLE_TOKEN: '0xstable',
        AGENT_WALLET_PK: '0xpk',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Postgres-only additions (skipped without TEST_DATABASE_URL, same convention as the builder's
// schema.postgres.test.ts). See tasks/T-002.md Evidence for how to stand up a local cluster.
// ---------------------------------------------------------------------------------------------
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.error(
    't002.tester.test.ts: TEST_DATABASE_URL is not set — skipping the Postgres-only tester additions.',
  );
}

describeOrSkip('postgres — tester additions (TEST_DATABASE_URL set)', async () => {
  const postgres = (await import('postgres')).default;
  const sql = postgres(TEST_DATABASE_URL as string, { max: 1 });

  // This test file may run as a separate vitest worker/process from schema.postgres.test.ts,
  // so it cannot assume that file's beforeAll already applied the schema to this database —
  // apply it fresh here too (same drop-and-reapply pattern), independently.
  beforeAll(async () => {
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
  });

  it('money round-trips as an exact decimal value, never float-rounded (numeric(18,6))', async () => {
    // 18 significant digits, scale 6 — exactly fits numeric(18,6), so nothing should be lost
    // or rounded the way an IEEE-754 double would (0.1+0.2-style drift).
    const agentRows = await sql`
      insert into agents (slug, name, mode, public) values ('t002-money-agent', 'Agent', 'dry_run', true)
      returning id
    `;
    const agentId = agentRows[0]?.id as string;
    const decisionRows = await sql`
      insert into decisions (agent_id, at, type, public) values (${agentId}, now(), 'ROUTE', true) returning id
    `;
    const decisionId = decisionRows[0]?.id as string;

    const usd = '123456789012.100200';
    const rows = await sql`
      insert into orders (agent_id, decision_id, side, usd, status, placed_at)
      values (${agentId}, ${decisionId}, 'stake', ${usd}, 'pending', now())
      returning usd
    `;
    // postgres.js returns numeric as a string by default — assert the exact decimal string,
    // not a coerced/rounded JS number.
    expect(String(rows[0]?.usd)).toBe(usd);
  });

  it('orders: updating status AND usd together is rejected as a whole (mixed guard)', async () => {
    const agentRows = await sql`
      insert into agents (slug, name, mode, public) values ('t002-mixed-agent', 'Agent', 'dry_run', true)
      returning id
    `;
    const agentId = agentRows[0]?.id as string;
    const decisionRows = await sql`
      insert into decisions (agent_id, at, type, public) values (${agentId}, now(), 'ROUTE', true) returning id
    `;
    const decisionId = decisionRows[0]?.id as string;
    const orderRows = await sql`
      insert into orders (agent_id, decision_id, side, usd, status, placed_at)
      values (${agentId}, ${decisionId}, 'buy', 10, 'pending', now())
      returning id
    `;
    const orderId = orderRows[0]?.id as string;

    await expect(
      sql`update orders set status = 'filled', usd = 999 where id = ${orderId}`,
    ).rejects.toThrow(/only status, filled_usd, fee_usd, resolved_at, external_id may be updated/);

    const after = await sql`select status, usd from orders where id = ${orderId}`;
    expect(after[0]?.status).toBe('pending'); // not partially applied
  });

  it('documents behaviour: re-applying 001-003 to a non-empty database (idempotency NOT required by AC1)', async () => {
    // AC1 only requires "applies on an empty project" — this is purely observational, per the
    // tester brief ("idempotency is NOT required — just note behaviour"). We expect this to
    // fail (CREATE TRIGGER / CREATE POLICY have no IF NOT EXISTS in 002/003), and record that.
    await expect(
      sql.unsafe(readMigration('002_rls.sql') + readMigration('003_append_only.sql')),
    ).rejects.toThrow(/already exists/i);
  });
});

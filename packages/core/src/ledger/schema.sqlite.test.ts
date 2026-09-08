/**
 * T-002 acceptance criteria against SQLite (ADR-002's kit ledger).
 *   1. schema.sql applies cleanly to an empty file.
 *   2. UPDATE/DELETE on each append-only table throws.
 *   3. orders: updating `status` succeeds; updating an immutable column is rejected.
 *   4. agents: updating a mutable ("display") column succeeds; an immutable column is rejected.
 *   5. Money round-trips as an exact decimal string (never a float).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCHEMA_SQL = readFileSync(new URL('./sqlite/schema.sql', import.meta.url), 'utf8');

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbio-ledger-sqlite-'));
  dbPath = join(dir, 'treasurer.db');
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function applySchema() {
  db.exec(SCHEMA_SQL);
}

function insertAgent(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = randomUUID();
  db.prepare(
    `insert into agents (id, slug, name, mode, public)
     values (@id, @slug, @name, @mode, @public)`,
  ).run({
    id,
    slug: overrides.slug ?? `agent-${id.slice(0, 8)}`,
    name: overrides.name ?? 'Test Agent',
    mode: overrides.mode ?? 'dry_run',
    public: overrides.public ?? 1,
  });
  return id;
}

function insertDecision(agentId: string): string {
  const id = randomUUID();
  db.prepare(
    `insert into decisions (id, agent_id, at, type, public)
     values (@id, @agentId, @at, @type, 1)`,
  ).run({ id, agentId, at: new Date().toISOString(), type: 'ROUTE' });
  return id;
}

describe('sqlite ledger schema — applies cleanly (AC1)', () => {
  it('applies to an empty file with no errors', () => {
    expect(() => applySchema()).not.toThrow();
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
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

  it('is idempotent (IF NOT EXISTS everywhere)', () => {
    applySchema();
    expect(() => applySchema()).not.toThrow();
  });
});

describe('sqlite ledger schema — append-only tables (AC2, FR-1.1)', () => {
  const appendOnlyTables = [
    'treasury_snapshots',
    'usage_events',
    'decisions',
    'book_snapshots',
  ] as const;

  beforeEach(() => applySchema());

  it.each(appendOnlyTables)('%s: UPDATE is rejected', (table) => {
    const agentId = insertAgent();
    let id: string;
    if (table === 'treasury_snapshots') {
      id = randomUUID();
      db.prepare(
        `insert into treasury_snapshots (id, agent_id, as_of, state, balance_source) values (?, ?, ?, ?, ?)`,
      ).run(id, agentId, new Date().toISOString(), 'COMFORTABLE', 'mcp');
      expect(() =>
        db.prepare('update treasury_snapshots set state = ? where id = ?').run('TIGHT', id),
      ).toThrow(/append-only/i);
    } else if (table === 'usage_events') {
      id = randomUUID();
      db.prepare(
        `insert into usage_events (id, agent_id, at, model, status) values (?, ?, ?, ?, ?)`,
      ).run(id, agentId, new Date().toISOString(), 'gpt', 'ok');
      expect(() =>
        db.prepare('update usage_events set status = ? where id = ?').run('error', id),
      ).toThrow(/append-only/i);
    } else if (table === 'decisions') {
      id = insertDecision(agentId);
      expect(() =>
        db.prepare('update decisions set type = ? where id = ?').run('ALERT', id),
      ).toThrow(/append-only/i);
    } else {
      id = randomUUID();
      db.prepare(`insert into book_snapshots (id, at, source) values (?, ?, ?)`).run(
        id,
        new Date().toISOString(),
        'api',
      );
      expect(() =>
        db.prepare("update book_snapshots set source = 'page' where id = ?").run(id),
      ).toThrow(/append-only/i);
    }
  });

  it.each(appendOnlyTables)('%s: DELETE is rejected', (table) => {
    const agentId = insertAgent();
    let id: string;
    if (table === 'treasury_snapshots') {
      id = randomUUID();
      db.prepare(
        `insert into treasury_snapshots (id, agent_id, as_of, state, balance_source) values (?, ?, ?, ?, ?)`,
      ).run(id, agentId, new Date().toISOString(), 'COMFORTABLE', 'mcp');
    } else if (table === 'usage_events') {
      id = randomUUID();
      db.prepare(
        `insert into usage_events (id, agent_id, at, model, status) values (?, ?, ?, ?, ?)`,
      ).run(id, agentId, new Date().toISOString(), 'gpt', 'ok');
    } else if (table === 'decisions') {
      id = insertDecision(agentId);
    } else {
      id = randomUUID();
      db.prepare(`insert into book_snapshots (id, at, source) values (?, ?, ?)`).run(
        id,
        new Date().toISOString(),
        'api',
      );
    }
    expect(() => db.prepare(`delete from ${table} where id = ?`).run(id)).toThrow(/append-only/i);
  });
});

describe('sqlite ledger schema — orders mutable-column guard (AC2, FR-1.1)', () => {
  beforeEach(() => applySchema());

  it('allows updating status (and the other listed settlement columns)', () => {
    const agentId = insertAgent();
    const decisionId = insertDecision(agentId);
    const orderId = randomUUID();
    db.prepare(
      `insert into orders (id, agent_id, decision_id, side, usd, status, placed_at)
       values (?, ?, ?, 'buy', '10.000000', 'pending', ?)`,
    ).run(orderId, agentId, decisionId, new Date().toISOString());

    expect(() =>
      db
        .prepare(
          `update orders set status = 'filled', filled_usd = '10.000000', fee_usd = '0.100000',
             resolved_at = ?, external_id = 'tx-123' where id = ?`,
        )
        .run(new Date().toISOString(), orderId),
    ).not.toThrow();

    const row = db.prepare('select status, filled_usd from orders where id = ?').get(orderId) as {
      status: string;
      filled_usd: string;
    };
    expect(row.status).toBe('filled');
    expect(row.filled_usd).toBe('10.000000');
  });

  it('rejects updating an immutable column (e.g. usd)', () => {
    const agentId = insertAgent();
    const decisionId = insertDecision(agentId);
    const orderId = randomUUID();
    db.prepare(
      `insert into orders (id, agent_id, decision_id, side, usd, status, placed_at)
       values (?, ?, ?, 'buy', '10.000000', 'pending', ?)`,
    ).run(orderId, agentId, decisionId, new Date().toISOString());

    expect(() =>
      db.prepare("update orders set usd = '999.000000' where id = ?").run(orderId),
    ).toThrow(/only status, filled_usd, fee_usd, resolved_at, external_id may be updated/);
  });

  it('rejects DELETE', () => {
    const agentId = insertAgent();
    const decisionId = insertDecision(agentId);
    const orderId = randomUUID();
    db.prepare(
      `insert into orders (id, agent_id, decision_id, side, usd, status, placed_at)
       values (?, ?, ?, 'buy', '10.000000', 'pending', ?)`,
    ).run(orderId, agentId, decisionId, new Date().toISOString());

    expect(() => db.prepare('delete from orders where id = ?').run(orderId)).toThrow(
      /orders rows cannot be deleted/,
    );
  });
});

describe('sqlite ledger schema — agents mutable-column guard', () => {
  beforeEach(() => applySchema());

  it('allows updating a display field and last_seen_at', () => {
    const agentId = insertAgent();
    expect(() =>
      db
        .prepare('update agents set name = ?, last_seen_at = ? where id = ?')
        .run('Renamed Agent', new Date().toISOString(), agentId),
    ).not.toThrow();
    const row = db.prepare('select name from agents where id = ?').get(agentId) as { name: string };
    expect(row.name).toBe('Renamed Agent');
  });

  it('rejects updating an immutable column (e.g. mode)', () => {
    const agentId = insertAgent();
    expect(() => db.prepare("update agents set mode = 'live' where id = ?").run(agentId)).toThrow(
      /only name, repo_url, x_handle, template, last_seen_at may be updated/,
    );
  });

  it('rejects DELETE', () => {
    const agentId = insertAgent();
    expect(() => db.prepare('delete from agents where id = ?').run(agentId)).toThrow(
      /agents rows cannot be deleted/,
    );
  });
});

describe('sqlite ledger schema — money round-trips as an exact decimal string', () => {
  beforeEach(() => applySchema());

  it('never becomes a float, even for values that are lossy in IEEE-754', () => {
    const agentId = insertAgent();
    const decisionId = insertDecision(agentId);
    const orderId = randomUUID();
    // 0.1 + 0.2 !== 0.3 in float; a value like this stored as REAL would drift.
    const usd = '123456789012.100200';
    db.prepare(
      `insert into orders (id, agent_id, decision_id, side, usd, status, placed_at)
       values (?, ?, ?, 'stake', ?, 'pending', ?)`,
    ).run(orderId, agentId, decisionId, usd, new Date().toISOString());

    const row = db
      .prepare('select usd, typeof(usd) as t from orders where id = ?')
      .get(orderId) as {
      usd: string;
      t: string;
    };
    expect(row.t).toBe('text');
    expect(row.usd).toBe(usd);
  });

  it('token_amount columns round-trip a 30-digit integer string exactly', () => {
    const agentId = insertAgent();
    const id = randomUUID();
    const tokens = '123456789012345678901234567890'; // 30 digits
    db.prepare(
      `insert into treasury_snapshots (id, agent_id, as_of, state, balance_source, orbio_balance_tokens)
       values (?, ?, ?, 'COMFORTABLE', 'mcp', ?)`,
    ).run(id, agentId, new Date().toISOString(), tokens);

    const row = db
      .prepare(
        'select orbio_balance_tokens as t, typeof(orbio_balance_tokens) as ty from treasury_snapshots where id = ?',
      )
      .get(id) as { t: string; ty: string };
    expect(row.ty).toBe('text');
    expect(row.t).toBe(tokens);
  });
});

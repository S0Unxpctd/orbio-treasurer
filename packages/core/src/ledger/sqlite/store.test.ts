/**
 * SqliteLedgerStore-specific tests (T-011).
 *
 * The shared behaviour (insert/read/update round-trips across both dialects) lives in
 * conformance-suite.ts / ledger-conformance.test.ts. This file covers what's specific to the
 * SQLite implementation: schema-on-first-open, foreign_keys pragma, and the ticket's AC4
 * ("the kit must boot with LEDGER=sqlite and no SUPABASE_* variables").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from './store.js';

describe('openSqliteLedger', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('creates the ledger file and its parent directory on first open (FR-7.1)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orbio-sqlite-boot-'));
    const dbPath = join(dir, 'nested', 'treasurer.db');
    const store = openSqliteLedger(dbPath);
    const agent = await store.insertAgent({ slug: 'boot-agent', name: 'Boot', mode: 'dry_run' });
    expect(agent.id).toBeTruthy();
    await store.close();
  });

  it('is idempotent to open twice against the same file (schema.sql is IF NOT EXISTS)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orbio-sqlite-boot-'));
    const dbPath = join(dir, 'treasurer.db');
    const first = openSqliteLedger(dbPath);
    await first.insertAgent({ slug: 'reopen-agent', name: 'Reopen', mode: 'dry_run' });
    await first.close();

    const second = openSqliteLedger(dbPath);
    const found = await second.getAgentBySlug('reopen-agent');
    expect(found?.name).toBe('Reopen');
    await second.close();
  });

  it('enforces foreign keys (PRAGMA foreign_keys = ON is set on open, per sqlite/schema.sql)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orbio-sqlite-boot-'));
    const store = openSqliteLedger(join(dir, 'treasurer.db'));
    await expect(
      store.insertKeyMeta({ agentId: 'no-such-agent', keyPrefix: 'sk-or', keyLast4: '0000' }),
    ).rejects.toThrow();
    await store.close();
  });
});

/**
 * Regression test for the S-05 pass-2 audit Major: a previous version of `withAgentLock`
 * wrapped `fn` in a DB-level `BEGIN IMMEDIATE … COMMIT/ROLLBACK` whenever the shared
 * better-sqlite3 connection was idle, as a best-effort cross-process lock. Because that
 * connection is a single shared one, any OTHER write that ran while the wrap was open —
 * including a genuinely different agent's write that this store never wraps in its own
 * transaction — silently became part of the SAME open transaction and was erased if the
 * lock-holder's `fn` later threw and the code rolled back. This test reproduces the auditor's
 * exact scenario: agent A's `withAgentLock` call inserts, yields (so agent B's write can
 * interleave on the shared connection), then throws; agent B's concurrent, unwrapped insert
 * must survive regardless of what happens to A.
 *
 * Fails on the pre-fix code (agent B's row is rolled back along with agent A's transaction).
 * Passes on the current code, which never opens a DB-level transaction in `withAgentLock` —
 * only the per-agentId in-process FIFO chain serializes same-agent calls; every write is a
 * plain, independently-committed statement.
 */
describe('withAgentLock: SQLite has no DB-level transaction wrapping (S-05 audit pass 2)', () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("agent B's concurrent unwrapped insert survives agent A's lock-held fn throwing", async () => {
    const store = openSqliteLedger(':memory:');
    try {
      const agentA = await store.insertAgent({
        slug: 'regression-lock-a',
        name: 'Lock Holder A',
        mode: 'dry_run',
      });

      const lockCall = store.withAgentLock(agentA.id, async () => {
        // A's own write, landing before it later throws.
        await store.insertAgent({
          slug: 'regression-lock-a-side-effect',
          name: 'A side effect',
          mode: 'dry_run',
        });
        // Yield the event loop so agent B's unwrapped write below has a real window to run
        // on the shared connection before A's transaction (pre-fix) would close.
        await sleep(20);
        throw new Error('boom-A');
      });

      // Give A's fn a chance to actually start and land its insert before B's call fires.
      await sleep(5);

      // Agent B's write is deliberately NOT wrapped in withAgentLock — a different agent's
      // call that never queues behind A's chain.
      await store.insertAgent({
        slug: 'regression-lock-b',
        name: 'Unwrapped B',
        mode: 'dry_run',
      });

      await expect(lockCall).rejects.toThrow('boom-A');

      const survivedB = await store.getAgentBySlug('regression-lock-b');
      expect(survivedB).not.toBeNull();
      expect(survivedB?.name).toBe('Unwrapped B');
    } finally {
      await store.close();
    }
  });
});

describe('AC4: the kit boots with LEDGER=sqlite and no SUPABASE_* variable', () => {
  it('opens a sqlite ledger and completes an insert with zero SUPABASE_* vars in the environment', async () => {
    const removed: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SUPABASE_')) {
        removed[key] = process.env[key] as string;
        delete process.env[key];
      }
    }
    let dir = '';
    try {
      expect(Object.keys(process.env).some((k) => k.startsWith('SUPABASE_'))).toBe(false);
      dir = mkdtempSync(join(tmpdir(), 'orbio-ac4-'));
      const store = openSqliteLedger(join(dir, 'treasurer.db'));
      const agent = await store.insertAgent({ slug: 'ac4-agent', name: 'AC4', mode: 'dry_run' });
      expect(agent.id).toBeTruthy();
      await store.close();
    } finally {
      for (const [key, value] of Object.entries(removed)) process.env[key] = value;
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
});

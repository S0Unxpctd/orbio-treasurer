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

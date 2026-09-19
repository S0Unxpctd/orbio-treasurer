/**
 * `pnpm seed:agent` (S-10, tasks/S-10.md AC4). Drives the script as a real child process against
 * a fresh, temp-path SQLite ledger — the ticket's own "Test on SQLite" — and confirms the row
 * count independently afterward via `@orbio-treasurer/core`'s own `listPublicAgents()`, not by
 * re-parsing the CLI's stdout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteLedger } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'seed-reference-agent.ts');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'seed-reference-agent-'));
  dbPath = join(workDir, 'treasurer.db');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runSeed(args: string[] = []): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX_BIN, [SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LEDGER: 'sqlite',
      LEDGER_SQLITE_PATH: dbPath,
      REFERENCE_AGENT_SLUG: 'treasurer',
      // Every other env.ts variable is optional/has-a-default for LEDGER=sqlite — no other var
      // needs setting for this script to run (CLAUDE.md 5c: the kit path never needs a DB
      // account; this script's SQLite path follows the same discipline).
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('pnpm seed:agent — creates the reference agent row (AC4)', () => {
  it('creates the agent on a fresh SQLite ledger, printing its slug', () => {
    const result = runSeed();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Created reference agent "treasurer"');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('running it twice leaves exactly one agent row (idempotent)', async () => {
    const first = runSeed();
    expect(first.status, first.stderr).toBe(0);
    const second = runSeed();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('already exists');
    expect(second.stdout).not.toContain('Created reference agent');

    // Independent check, not derived from either run's stdout: reopen the same SQLite file
    // directly through the ledger package and count public agents with this slug.
    const store = openSqliteLedger(dbPath);
    try {
      const agents = await store.listPublicAgents();
      const matching = agents.filter((a) => a.slug === 'treasurer');
      expect(matching).toHaveLength(1);
      expect(matching[0]?.name).toBe('Orbio Treasurer (reference)');
    } finally {
      await store.close();
    }
  });

  it('--with-key --label demo prints exactly one otk_ key, never stored in clear', () => {
    const result = runSeed(['--with-key', '--label', 'demo']);
    expect(result.status, result.stderr).toBe(0);

    const keyMatches = result.stdout.match(/otk_[0-9a-f]{32}/g) ?? [];
    expect(keyMatches).toHaveLength(1);
    const rawKey = keyMatches[0] as string;

    // The raw key must never land in the ledger file itself, in clear — read it as a binary
    // buffer (SQLite is a binary format) and search for the literal string, same discipline as
    // packages/create-orbio-agent's own secret-scan tests.
    const dbBuf = readFileSync(dbPath);
    expect(dbBuf.toString('latin1').includes(rawKey)).toBe(false);
  });

  it('rejects --with-key without --label', () => {
    const result = runSeed(['--with-key']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('usage:');
  });

  it('works with no flags at all (no --with-key) — no key is printed', () => {
    const result = runSeed();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/otk_[0-9a-f]{32}/);
  });
});

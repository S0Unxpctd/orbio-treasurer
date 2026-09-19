/**
 * Integration test for `/api/agents` (S-08 AC4) against a temp SQLite ledger.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteLedger } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetLedgerStoreForTesting } from '../../_ledger.js';
import { GET, POST } from './route.js';

const VALID_KEY = `otk_${'c'.repeat(32)}`;

const ENV_KEYS = ['LEDGER', 'LEDGER_SQLITE_PATH', 'GATEWAY_KEYS'] as const;
const savedEnv: Record<string, string | undefined> = {};

let dir: string;
let dbPath: string;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), 's08-agents-'));
  dbPath = join(dir, 'treasurer.db');
  process.env.LEDGER = 'sqlite';
  process.env.LEDGER_SQLITE_PATH = dbPath;
  process.env.GATEWAY_KEYS = VALID_KEY;
  resetLedgerStoreForTesting();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetLedgerStoreForTesting();
  rmSync(dir, { recursive: true, force: true });
});

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/agents — auth', () => {
  it('401s without an Authorization header', async () => {
    const res = await POST(postRequest({ name: 'My Agent' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('auth');
  });

  it('401s with a well-shaped but unregistered key', async () => {
    const res = await POST(
      postRequest({ name: 'My Agent' }, { authorization: `Bearer otk_${'f'.repeat(32)}` }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/agents — body validation', () => {
  it('400s on malformed JSON', async () => {
    const res = await POST(postRequest('{not json', { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.status).toBe(400);
  });

  it('400s when name is missing', async () => {
    const res = await POST(
      postRequest({ url: 'https://example.com' }, { authorization: `Bearer ${VALID_KEY}` }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on a body over 2 KB', async () => {
    const res = await POST(
      postRequest({ name: 'x'.repeat(3000) }, { authorization: `Bearer ${VALID_KEY}` }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/agents — success', () => {
  it('creates a row for a valid key + body, and it is idempotently readable back', async () => {
    const res = await POST(
      postRequest(
        { name: 'Daily Digest', url: 'https://github.com/example/daily-digest' },
        { authorization: `Bearer ${VALID_KEY}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Daily Digest');
    expect(body.slug).toMatch(/^daily-digest-[0-9a-f]{4}$/);
    // `url` is accepted as an alias for `repoUrl` (Discovered — see route.ts's doc comment).
    expect(body.repoUrl).toBe('https://github.com/example/daily-digest');

    const store = openSqliteLedger(dbPath);
    const row = await store.getAgentBySlug(body.slug);
    expect(row?.name).toBe('Daily Digest');
    expect(row?.public).toBe(true);
    await store.close();
  });

  it('an explicit repoUrl wins over url when both are sent', async () => {
    const res = await POST(
      postRequest(
        {
          name: 'Both Fields',
          url: 'https://example.com/site',
          repoUrl: 'https://github.com/example/repo',
        },
        { authorization: `Bearer ${VALID_KEY}` },
      ),
    );
    const body = await res.json();
    expect(body.repoUrl).toBe('https://github.com/example/repo');
  });
});

describe('GET /api/agents', () => {
  it('lists only public agents', async () => {
    const store = openSqliteLedger(dbPath);
    await store.insertAgent({
      slug: 'public-one',
      name: 'Public One',
      mode: 'dry_run',
      public: true,
    });
    await store.insertAgent({
      slug: 'private-one',
      name: 'Private One',
      mode: 'dry_run',
      public: false,
    });
    await store.close();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].slug).toBe('public-one');
  });

  it('requires no authentication', async () => {
    const res = await GET();
    expect(res.status).not.toBe(401);
  });
});

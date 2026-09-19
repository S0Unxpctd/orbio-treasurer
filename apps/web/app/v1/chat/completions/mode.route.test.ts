/**
 * S-06 AC4: "Router reads mode from the ledger: seed a snapshot with mode `critical` →
 * `POST /v1/chat/completions` with `model:"auto:L"` is served by tier S (cap over floor) and the
 * reason says so." Also covers the ticket's own "env still wins if set (for tests)" clause and
 * the 60s mode cache (audit focus: "mode cache staleness on the router").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryCallRecorder, openSqliteLedger } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FakeUpstream, startFakeUpstream } from '../../../../test/fake-upstream.js';
import { resetLedgerStoreForTesting } from '../../../_ledger.js';
import {
  resetCatalogCacheForTesting,
  resetModeCacheForTesting,
  setRecorderForTesting,
} from '../../_gateway.js';
import { POST } from './route.js';

const VALID_KEY = `otk_${'d'.repeat(32)}`;
const REFERENCE_SLUG = 's06-mode-agent';

const ENV_KEYS = [
  'ORBIO_GATEWAY_BASE_URL',
  'ORBIO_KEY',
  'GATEWAY_KEYS',
  'ROUTER_ALLOW',
  'TREASURER_MODE',
  'LEDGER',
  'LEDGER_SQLITE_PATH',
  'REFERENCE_AGENT_SLUG',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let upstream: FakeUpstream;
let dir: string;
let dbPath: string;

async function seedChainSnapshotMode(mode: string): Promise<void> {
  const store = openSqliteLedger(dbPath);
  let agent = await store.getAgentBySlug(REFERENCE_SLUG);
  if (!agent) {
    agent = await store.insertAgent({
      slug: REFERENCE_SLUG,
      name: 'Mode test agent',
      mode: 'dry_run',
    });
  }
  await store.insertChainSnapshot({ agentId: agent.id, asOf: new Date().toISOString(), mode });
  await store.close();
}

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const L_MODEL_BODY = { model: 'auto:L', messages: [{ role: 'user', content: 'hi' }] };

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GATEWAY_KEYS = VALID_KEY;
  delete process.env.ROUTER_ALLOW;
  delete process.env.TREASURER_MODE; // unset — the ledger-driven mode must be free to take over
  process.env.REFERENCE_AGENT_SLUG = REFERENCE_SLUG;
  dir = mkdtempSync(join(tmpdir(), 's06-mode-'));
  dbPath = join(dir, 'treasurer.db');
  process.env.LEDGER = 'sqlite';
  process.env.LEDGER_SQLITE_PATH = dbPath;
  resetLedgerStoreForTesting();
  resetModeCacheForTesting();
  resetCatalogCacheForTesting();
  setRecorderForTesting(new InMemoryCallRecorder());
  upstream = await startFakeUpstream('ok');
  process.env.ORBIO_KEY = 'sk-or-v1-TESTONLYS06MODESECRET00000000';
  process.env.ORBIO_GATEWAY_BASE_URL = upstream.baseUrl;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setRecorderForTesting(null);
  resetLedgerStoreForTesting();
  resetModeCacheForTesting();
  resetCatalogCacheForTesting();
  await upstream.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('POST /v1/chat/completions — router mode from the ledger (S-06 AC4)', () => {
  it('mode critical caps model:"auto:L" down to tier S, and the reason says so', async () => {
    await seedChainSnapshotMode('critical');
    const res = await POST(postRequest(L_MODEL_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-treasurer-tier')).toBe('S');
    expect(res.headers.get('x-treasurer-reason')).toContain('cap:critical');
  });

  it('mode normal (no snapshot yet) leaves model:"auto:L" uncapped at tier L', async () => {
    const res = await POST(postRequest(L_MODEL_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-treasurer-tier')).toBe('L');
  });

  it('an explicitly-set TREASURER_MODE env still wins over the ledger snapshot', async () => {
    await seedChainSnapshotMode('critical');
    process.env.TREASURER_MODE = 'normal';
    const res = await POST(postRequest(L_MODEL_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-treasurer-tier')).toBe('L'); // env override wins -> no cap
  });

  it('the mode is cached for 60s: a snapshot written AFTER the first read is not seen immediately', async () => {
    await seedChainSnapshotMode('normal');
    const first = await POST(postRequest(L_MODEL_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(first.headers.get('x-treasurer-tier')).toBe('L');

    await seedChainSnapshotMode('critical'); // a newer snapshot row, same agent
    const second = await POST(postRequest(L_MODEL_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(second.headers.get('x-treasurer-tier')).toBe('L'); // still the cached 'normal'

    resetModeCacheForTesting(); // simulate the 60s TTL having elapsed
    const third = await POST(postRequest(L_MODEL_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(third.headers.get('x-treasurer-tier')).toBe('S'); // now sees 'critical'
  });
});

/**
 * S-06 AC5: "`LedgerCallRecorder` receives every gateway call (integration test through the
 * route: one call → one `usage_events` row with `cost_usd`, `baseline_cost_usd`, `caller_key_id`
 * set when the key came from the ledger)." No `setRecorderForTesting()` override here — this is
 * the one test suite that exercises `getRecorder()`'s real ledger-backed path end to end.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashKey, openSqliteLedger } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FakeUpstream,
  NONSTREAM_FIXTURE,
  startFakeUpstream,
} from '../../../../test/fake-upstream.js';
import { resetLedgerStoreForTesting } from '../../../_ledger.js';
import { resetCatalogCacheForTesting, resetModeCacheForTesting } from '../../_gateway.js';
import { POST } from './route.js';

const LEDGER_KEY = `otk_${'e'.repeat(32)}`;
const REFERENCE_SLUG = 's06-recorder-agent';

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
let agentId: string;
let callerKeyId: string;

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.GATEWAY_KEYS; // the key under test exists ONLY in the ledger
  delete process.env.ROUTER_ALLOW;
  process.env.TREASURER_MODE = 'normal';
  process.env.REFERENCE_AGENT_SLUG = REFERENCE_SLUG;
  dir = mkdtempSync(join(tmpdir(), 's06-recorder-'));
  dbPath = join(dir, 'treasurer.db');
  process.env.LEDGER = 'sqlite';
  process.env.LEDGER_SQLITE_PATH = dbPath;
  resetLedgerStoreForTesting();
  resetModeCacheForTesting();
  resetCatalogCacheForTesting();

  const seedStore = openSqliteLedger(dbPath);
  const agent = await seedStore.insertAgent({
    slug: REFERENCE_SLUG,
    name: 'Recorder test agent',
    mode: 'dry_run',
  });
  agentId = agent.id;
  const callerKey = await seedStore.insertCallerKey({
    agentId: agent.id,
    keyHash: hashKey(LEDGER_KEY),
    keyPrefix: LEDGER_KEY.slice(0, 10),
    label: 's06-test',
  });
  callerKeyId = callerKey.id;
  await seedStore.close();

  upstream = await startFakeUpstream('ok');
  process.env.ORBIO_KEY = 'sk-or-v1-TESTONLYS06RECORDERSECRET0000';
  process.env.ORBIO_GATEWAY_BASE_URL = upstream.baseUrl;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetLedgerStoreForTesting();
  resetModeCacheForTesting();
  resetCatalogCacheForTesting();
  await upstream.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/chat/completions — LedgerCallRecorder integration (S-06 AC5)', () => {
  it('one call -> one usage_events row with cost_usd, baseline_cost_usd and the real caller_key_id set', async () => {
    const res = await POST(
      postRequest(
        { model: 'auto', messages: [{ role: 'user', content: 'summarize this in five words' }] },
        { authorization: `Bearer ${LEDGER_KEY}` },
      ),
    );
    expect(res.status).toBe(200);

    const readStore = openSqliteLedger(dbPath);
    const events = await readStore.listUsageEvents(agentId);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.status).toBe('ok');
    expect(event?.costUsd).toBe(
      (NONSTREAM_FIXTURE as { usage: { cost: number } }).usage.cost.toFixed(6),
    );
    expect(event?.baselineCostUsd).not.toBeNull();
    expect(event?.callerKeyId).toBe(callerKeyId);
    await readStore.close();
  });
});

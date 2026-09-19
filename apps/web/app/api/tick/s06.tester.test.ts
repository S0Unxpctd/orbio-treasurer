/**
 * Tester pass for S-06 (tasks/S-06.md) — the web-level acceptance criteria (PROCESS.md §3:
 * independent of the builder's own `apps/web/app/api/tick/route.test.ts`,
 * `apps/web/app/v1/chat/completions/mode.route.test.ts` and `ledger-recorder.route.test.ts`, own
 * fixtures throughout). The core-level ACs (decide() table, runTick, executors, recorder-adapter,
 * migration 006) live in `packages/core/src/tick/s06.tester.test.ts`.
 *
 * Covers:
 *  - AC6: `POST /api/tick` 401 without the secret, 405 on GET, and the 200 + summary happy path
 *    THROUGH the route. `apps/web/app/api/tick/route.ts` hard-codes a REAL `createRobinhoodClient`
 *    when no `client` is injected (`runTick()`'s own `params.client` seam exists only in
 *    `packages/core`, `route.ts` never exposes it) — so there is no way to reach a genuine 200
 *    through the route without either a live RPC/gateway or mocking `runTick()` itself at the
 *    module boundary. This file uses `vi.mock('@orbio-treasurer/core', ...)` (keeping every other
 *    export real via `importActual`) as that seam — a legitimate test-only injection point, not a
 *    change to any source file.
 *  - AC4: router reads mode from the ledger (`POST /v1/chat/completions`).
 *  - AC5: `LedgerCallRecorder` integration through the route — one `usage_events` row with
 *    `cost_usd`/`baseline_cost_usd`/`caller_key_id` set.
 *  - AC8: no secret in the tick summary, in `console.error` lines, or in the recorded usage_events
 *    row, at the web boundary.
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
} from '../../../test/fake-upstream.js';
import { resetLedgerStoreForTesting } from '../../_ledger.js';
import {
  resetCatalogCacheForTesting,
  resetModeCacheForTesting,
  setRecorderForTesting,
} from '../../v1/_gateway.js';
import { POST as postChatCompletions } from '../../v1/chat/completions/route.js';

// `runTick` is the ONE export this file replaces — every other `@orbio-treasurer/core` export
// (redact, openSqliteLedger, hashKey, LedgerCallRecorder, ...) stays real, so the chat-completions
// tests below (AC4, AC5) exercise the genuine ledger-backed code paths untouched by this mock.
vi.mock('@orbio-treasurer/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orbio-treasurer/core')>();
  return { ...actual, runTick: vi.fn() };
});

// Imported AFTER vi.mock (hoisted anyway, but this ordering documents the intent) — `mockRunTick`
// is the same function reference `apps/web/app/api/tick/route.ts` calls internally.
const core = await import('@orbio-treasurer/core');
const mockRunTick = core.runTick as unknown as ReturnType<typeof vi.fn>;

// The tick route module itself must be imported dynamically, AFTER the mock is registered, so its
// top-level `import { runTick } from '@orbio-treasurer/core'` binds to the mocked function.
const { GET: tickGet, POST: tickPost } = await import('./route.js');

const TICK_ENV_KEYS = [
  'LEDGER',
  'LEDGER_SQLITE_PATH',
  'TICK_SECRET',
  'REFERENCE_AGENT_SLUG',
] as const;
const GATEWAY_ENV_KEYS = [
  'ORBIO_GATEWAY_BASE_URL',
  'ORBIO_KEY',
  'GATEWAY_KEYS',
  'ROUTER_ALLOW',
  'TREASURER_MODE',
] as const;
const ALL_ENV_KEYS = [...TICK_ENV_KEYS, ...GATEWAY_ENV_KEYS] as const;
const savedEnv: Record<string, string | undefined> = {};

const TESTER_TICK_SECRET = 'tester-s06-tick-secret-fedcba9876543210';
let dir: string;
let dbPath: string;

beforeEach(() => {
  for (const key of ALL_ENV_KEYS) savedEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), 's06-tester-tick-'));
  dbPath = join(dir, 'treasurer.db');
  process.env.LEDGER = 'sqlite';
  process.env.LEDGER_SQLITE_PATH = dbPath;
  process.env.TICK_SECRET = TESTER_TICK_SECRET;
  process.env.REFERENCE_AGENT_SLUG = `s06-tester-tick-${Math.random().toString(36).slice(2)}`;
  delete process.env.ROUTER_ALLOW;
  delete process.env.TREASURER_MODE;
  resetLedgerStoreForTesting();
  resetModeCacheForTesting();
  resetCatalogCacheForTesting();
  mockRunTick.mockReset();
});

afterEach(() => {
  for (const key of ALL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setRecorderForTesting(null);
  resetLedgerStoreForTesting();
  resetModeCacheForTesting();
  resetCatalogCacheForTesting();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tickRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/tick', { method: 'POST', headers });
}

// =================================================================================================
// AC6 — POST /api/tick auth + method + the 200 happy path (via the vi.mock seam above)
// =================================================================================================

describe('POST /api/tick — S-06 AC6', () => {
  it('401s with no x-tick-secret header', async () => {
    const res = await tickPost(tickRequest());
    expect(res.status).toBe(401);
    expect(mockRunTick).not.toHaveBeenCalled(); // auth checked before runTick is ever reached
  });

  it('401s with a wrong secret', async () => {
    const res = await tickPost(tickRequest({ 'x-tick-secret': 'definitely-not-it' }));
    expect(res.status).toBe(401);
  });

  it('GET returns 405', async () => {
    const res = await tickGet();
    expect(res.status).toBe(405);
  });

  it('the correct secret + a successful runTick() -> 200 with the summary as the response body', async () => {
    const summary = {
      bucket: '2026-09-19T09:00',
      agentId: 'tester-agent-id-0001',
      mode: 'eco' as const,
      previousMode: 'normal',
      modeChanged: true,
      runwayDays: '1.750000',
      actions: [{ kind: 'claim_activate', outcome: 'ok' }],
    };
    mockRunTick.mockResolvedValueOnce(summary);

    const res = await tickPost(tickRequest({ 'x-tick-secret': TESTER_TICK_SECRET }));
    expect(res.status).toBe(200);
    expect(mockRunTick).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual(summary);
  });

  it('the correct secret + a duplicate-bucket skip -> 200 with {skipped:"duplicate"}', async () => {
    mockRunTick.mockResolvedValueOnce({ skipped: 'duplicate' });
    const res = await tickPost(tickRequest({ 'x-tick-secret': TESTER_TICK_SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 'duplicate' });
  });

  it('the correct secret + a thrown config error -> 500, never a 401/405', async () => {
    mockRunTick.mockRejectedValueOnce(new Error('ChainEnvValidationError: missing CREDIT_ADDRESS'));
    const res = await tickPost(tickRequest({ 'x-tick-secret': TESTER_TICK_SECRET }));
    expect(res.status).toBe(500);
  });
});

// =================================================================================================
// AC8 — no secret in the tick summary / logs (web boundary)
// =================================================================================================

describe('POST /api/tick — S-06 AC8 (no secret leaks)', () => {
  it('a successful summary response never contains TICK_SECRET', async () => {
    mockRunTick.mockResolvedValueOnce({
      bucket: '2026-09-19T09:00',
      agentId: 'tester-agent-id-0002',
      mode: 'normal' as const,
      previousMode: null,
      modeChanged: false,
      runwayDays: '999.000000',
      actions: [],
    });
    const res = await tickPost(tickRequest({ 'x-tick-secret': TESTER_TICK_SECRET }));
    const text = await res.text();
    expect(text).not.toContain(TESTER_TICK_SECRET);
  });

  it('an error path never logs TICK_SECRET via console.error', async () => {
    mockRunTick.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await tickPost(tickRequest({ 'x-tick-secret': TESTER_TICK_SECRET }));
    for (const call of errorSpy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(TESTER_TICK_SECRET);
    }
  });

  it('a WRONG secret is never echoed back or logged either', async () => {
    const wrongSecret = 'tester-wrong-secret-value-xyz123';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await tickPost(tickRequest({ 'x-tick-secret': wrongSecret }));
    const text = await res.text();
    expect(text).not.toContain(wrongSecret);
    for (const call of errorSpy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(wrongSecret);
    }
    expect(res.status).toBe(401);
  });
});

// =================================================================================================
// AC4 — router reads mode from the ledger (POST /v1/chat/completions)
// =================================================================================================

const MODE_TEST_KEY = `otk_${'9'.repeat(32)}`;
const MODE_REFERENCE_SLUG_PREFIX = 's06-tester-mode-';

function chatRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/chat/completions — S-06 AC4 (mode from the ledger)', () => {
  let upstream: FakeUpstream;
  let referenceSlug: string;

  beforeEach(async () => {
    referenceSlug = `${MODE_REFERENCE_SLUG_PREFIX}${Math.random().toString(36).slice(2)}`;
    process.env.REFERENCE_AGENT_SLUG = referenceSlug;
    process.env.GATEWAY_KEYS = MODE_TEST_KEY;
    upstream = await startFakeUpstream('ok');
    process.env.ORBIO_KEY = 'sk-or-v1-TESTONLYS06TESTERMODESECRET000';
    process.env.ORBIO_GATEWAY_BASE_URL = upstream.baseUrl;
  });

  afterEach(async () => {
    await upstream.close();
  });

  async function seedMode(mode: string): Promise<void> {
    const store = openSqliteLedger(dbPath);
    let agent = await store.getAgentBySlug(referenceSlug);
    if (!agent) {
      agent = await store.insertAgent({
        slug: referenceSlug,
        name: 'Tester mode agent',
        mode: 'dry_run',
      });
    }
    await store.insertChainSnapshot({ agentId: agent.id, asOf: new Date().toISOString(), mode });
    await store.close();
  }

  it('a snapshot with mode "critical" caps model:"auto:L" down to tier S, and the reason mentions the cap', async () => {
    await seedMode('critical');
    const res = await postChatCompletions(
      chatRequest(
        { model: 'auto:L', messages: [{ role: 'user', content: 'hello' }] },
        { authorization: `Bearer ${MODE_TEST_KEY}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-treasurer-tier')).toBe('S');
    expect(res.headers.get('x-treasurer-reason')).toContain('critical');
  });

  it('no snapshot yet (mode defaults to normal) leaves model:"auto:L" uncapped at tier L', async () => {
    const res = await postChatCompletions(
      chatRequest(
        { model: 'auto:L', messages: [{ role: 'user', content: 'hello' }] },
        { authorization: `Bearer ${MODE_TEST_KEY}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-treasurer-tier')).toBe('L');
  });
});

// =================================================================================================
// AC5 — LedgerCallRecorder integration through the route
// =================================================================================================

describe('POST /v1/chat/completions — S-06 AC5 (LedgerCallRecorder integration)', () => {
  const LEDGER_ONLY_KEY = `otk_${'7'.repeat(32)}`;
  let upstream: FakeUpstream;
  let referenceSlug: string;
  let agentId: string;
  let callerKeyId: string;

  beforeEach(async () => {
    referenceSlug = `s06-tester-recorder-${Math.random().toString(36).slice(2)}`;
    process.env.REFERENCE_AGENT_SLUG = referenceSlug;
    delete process.env.GATEWAY_KEYS; // the key under test exists ONLY in the ledger
    process.env.TREASURER_MODE = 'normal';

    const seedStore = openSqliteLedger(dbPath);
    const agent = await seedStore.insertAgent({
      slug: referenceSlug,
      name: 'Tester recorder agent',
      mode: 'dry_run',
    });
    agentId = agent.id;
    const callerKey = await seedStore.insertCallerKey({
      agentId: agent.id,
      keyHash: hashKey(LEDGER_ONLY_KEY),
      keyPrefix: LEDGER_ONLY_KEY.slice(0, 10),
      label: 's06-tester',
    });
    callerKeyId = callerKey.id;
    await seedStore.close();

    upstream = await startFakeUpstream('ok');
    process.env.ORBIO_KEY = 'sk-or-v1-TESTONLYS06TESTERRECORDER0000';
    process.env.ORBIO_GATEWAY_BASE_URL = upstream.baseUrl;
  });

  afterEach(async () => {
    await upstream.close();
  });

  it('one gateway call -> exactly one usage_events row, cost_usd/baseline_cost_usd/caller_key_id all set', async () => {
    const res = await postChatCompletions(
      chatRequest(
        { model: 'auto', messages: [{ role: 'user', content: 'five word summary please' }] },
        { authorization: `Bearer ${LEDGER_ONLY_KEY}` },
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

    // AC8, at this same integration point: the row never contains the raw ledger key, its hash,
    // or the upstream ORBIO_KEY secret used to reach the fake gateway.
    const serializedEvent = JSON.stringify(event);
    expect(serializedEvent).not.toContain(LEDGER_ONLY_KEY);
    expect(serializedEvent).not.toContain(hashKey(LEDGER_ONLY_KEY));
    expect(serializedEvent).not.toContain('sk-or-v1-TESTONLYS06TESTERRECORDER0000');
    await readStore.close();
  });
});

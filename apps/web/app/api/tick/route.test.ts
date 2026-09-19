/**
 * `POST /api/tick` (S-06 AC6, AC8) against a temp SQLite ledger — same isolation pattern as
 * `apps/web/app/api/agents/route.test.ts` (S-08).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetLedgerStoreForTesting } from '../../_ledger.js';
import { GET, POST } from './route.js';

const ENV_KEYS = [
  'LEDGER',
  'LEDGER_SQLITE_PATH',
  'TICK_SECRET',
  'REFERENCE_AGENT_SLUG',
  'RH_RPC_URLS',
  'CREDIT_ADDRESS',
  'STAKING_ADDRESS',
  'EXCHANGE_ADDRESS',
  'ORBIO_ADDRESS',
  'USDG_ADDRESS',
  'NVDA_ADDRESS',
  'PAYOUT_ADDRESS',
] as const;
const savedEnv: Record<string, string | undefined> = {};

const TICK_SECRET = 'test-tick-secret-0123456789abcdef';
let dir: string;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), 's06-tick-route-'));
  process.env.LEDGER = 'sqlite';
  process.env.LEDGER_SQLITE_PATH = join(dir, 'treasurer.db');
  process.env.TICK_SECRET = TICK_SECRET;
  process.env.REFERENCE_AGENT_SLUG = `s06-tick-route-${Math.random().toString(36).slice(2)}`;
  // No real chain config -> ChainEnvValidationError inside runTick() -> the route's own 500 path
  // (AC6/AC8 don't need a successful tick to be proven; a config error still must never leak the
  // secret, and still isn't a 401/405). Deliberately deleted, not set, so `loadChainAddresses()`
  // throws by name only.
  delete process.env.CREDIT_ADDRESS;
  delete process.env.STAKING_ADDRESS;
  delete process.env.EXCHANGE_ADDRESS;
  delete process.env.ORBIO_ADDRESS;
  delete process.env.USDG_ADDRESS;
  delete process.env.NVDA_ADDRESS;
  delete process.env.PAYOUT_ADDRESS;
  resetLedgerStoreForTesting();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetLedgerStoreForTesting();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tickRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/tick', { method: 'POST', headers });
}

describe('POST /api/tick — auth (S-06 AC6)', () => {
  it('401s with no x-tick-secret header at all', async () => {
    const res = await POST(tickRequest());
    expect(res.status).toBe(401);
  });

  it('401s with the wrong secret', async () => {
    const res = await POST(tickRequest({ 'x-tick-secret': 'wrong-secret' }));
    expect(res.status).toBe(401);
  });

  it('401s when TICK_SECRET itself is unset, even if a header is sent (never treated as "no secret required")', async () => {
    delete process.env.TICK_SECRET;
    const res = await POST(tickRequest({ 'x-tick-secret': 'anything' }));
    expect(res.status).toBe(401);
  });

  it('the correct secret passes auth (a downstream config error still 500s, never a 401)', async () => {
    const res = await POST(tickRequest({ 'x-tick-secret': TICK_SECRET }));
    expect(res.status).toBe(500); // no chain addresses configured in this test env
    const body = await res.json();
    expect(body.error.type).toBe('tick_error');
  });

  it('GET returns 405', async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});

describe('POST /api/tick — no secret in the response (S-06 AC8)', () => {
  it('the error response body never contains TICK_SECRET', async () => {
    const res = await POST(tickRequest({ 'x-tick-secret': TICK_SECRET }));
    const text = await res.text();
    expect(text).not.toContain(TICK_SECRET);
  });

  it('no console.error line contains TICK_SECRET', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await POST(tickRequest({ 'x-tick-secret': TICK_SECRET }));
    for (const call of errorSpy.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line).not.toContain(TICK_SECRET);
    }
  });
});

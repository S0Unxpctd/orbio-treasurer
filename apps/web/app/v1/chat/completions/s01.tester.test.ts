/**
 * Tester pass for S-01 (tasks/S-01.md) — independent of the builder's own `route.test.ts` /
 * `models/route.test.ts`. Written from the ticket's Acceptance criteria and Tests-required
 * sections alone: AC2 (auth + tier S routing), AC3 (stream passthrough + recorder), AC4 (cost /
 * baseline headers), AC5 (`GET /v1/models`), AC6 (no secret in logs or responses). AC1 lives in
 * `packages/core/src/router/s01.tester.test.ts` (pure router). AC7 (live check) is untestable
 * here — see tasks/S-01.md Test report.
 *
 * Reuses the existing in-process fake upstream helper (`apps/web/test/fake-upstream.ts`, per the
 * Tester instructions) rather than hand-rolling a second one. Exact expected numbers below are
 * derived from that helper's fixtures (`packages/core/src/router/fixtures/*.2026-09-19.*`):
 *   catalog:  orbio/tiny-instruct  $0.10/M prompt  (cheapest S)
 *             orbio/small-chat    $0.30/M prompt  (S)
 *             orbio/mid-reasoner  $1.50/M prompt, $3.00/M completion (M)
 *             orbio/large-flagship $10.00/M prompt, $20.00/M completion (only L → tier-L default)
 *   non-stream usage: prompt_tokens=12, completion_tokens=34, cost=0.001234
 *   stream usage:     prompt_tokens=12, completion_tokens=8,  cost=0.000567
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryCallRecorder } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FakeUpstream,
  STREAM_FIXTURE_SSE,
  startFakeUpstream,
  waitFor,
} from '../../../../test/fake-upstream.js';
import { resetLedgerStoreForTesting } from '../../../_ledger.js';
import {
  resetCatalogCacheForTesting,
  resetModeCacheForTesting,
  setRecorderForTesting,
} from '../../_gateway.js';
import { GET as getModels } from '../../models/route.js';
import { POST } from './route.js';

// Distinct from the builder's own VALID_KEY value — this suite's independence from the builder's
// test data is part of the point (PROCESS.md §3: "catches the case where builder and auditor both
// misread an AC the same way").
const TESTER_VALID_KEY = `otk_${'c'.repeat(32)}`;
const TESTER_UPSTREAM_SECRET = 'sk-or-v1-TESTONLYS01TESTERSECRET00000';

const ENV_KEYS = [
  'ORBIO_GATEWAY_BASE_URL',
  'ORBIO_KEY',
  'GATEWAY_KEYS',
  'ROUTER_ALLOW',
  'TREASURER_MODE',
  'LEDGER',
  'LEDGER_SQLITE_PATH',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let upstream: FakeUpstream;
let recorder: InMemoryCallRecorder;
// S-06: see route.test.ts's own comment on the same isolation — `resolveCaller()`/`getMode()`
// (../../_gateway.js) always at least attempt the ledger, so a real, isolated temp sqlite path
// is required even though `setRecorderForTesting()` bypasses it for the recorder.
let dir: string;

async function setUpstream(mode: Parameters<typeof startFakeUpstream>[0] = 'ok') {
  upstream = await startFakeUpstream(mode);
  process.env.ORBIO_GATEWAY_BASE_URL = upstream.baseUrl;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ORBIO_KEY = TESTER_UPSTREAM_SECRET;
  process.env.GATEWAY_KEYS = TESTER_VALID_KEY;
  delete process.env.ROUTER_ALLOW;
  process.env.TREASURER_MODE = 'normal';
  dir = mkdtempSync(join(tmpdir(), 's06-gateway-tester-'));
  process.env.LEDGER = 'sqlite';
  process.env.LEDGER_SQLITE_PATH = join(dir, 'treasurer.db');
  resetLedgerStoreForTesting();
  resetModeCacheForTesting();
  resetCatalogCacheForTesting();
  recorder = new InMemoryCallRecorder();
  setRecorderForTesting(recorder);
  await setUpstream('ok');
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

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const FIVE_WORD_BODY = {
  model: 'auto',
  messages: [{ role: 'user', content: 'summarize this in five words' }],
};

describe('S-01 AC2 — auth', () => {
  it('401s with no Authorization header at all', async () => {
    const res = await POST(postRequest(FIVE_WORD_BODY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('auth');
  });

  it('401s with a well-shaped otk_ key that is not in GATEWAY_KEYS', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, { authorization: `Bearer otk_${'0'.repeat(32)}` }),
    );
    expect(res.status).toBe(401);
  });

  it('401s with a malformed Authorization header (not "Bearer otk_...")', async () => {
    const res = await POST(postRequest(FIVE_WORD_BODY, { authorization: 'Bearer not-a-key' }));
    expect(res.status).toBe(401);
  });
});

describe('S-01 AC2 — model:"auto" + 5-word prompt routes to tier S', () => {
  it('returns 200, x-treasurer-tier: S, and a valid OpenAI chat-completion body', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${TESTER_VALID_KEY}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-treasurer-tier')).toBe('S');

    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices.length).toBeGreaterThan(0);
    expect(typeof body.choices[0].message.content).toBe('string');
  });
});

describe('S-01 AC3 — stream:true passthrough and recorder', () => {
  it('passes the SSE body through unchanged and the recorder receives costUsd from the final usage chunk', async () => {
    const res = await POST(
      postRequest(
        { ...FIVE_WORD_BODY, stream: true },
        { authorization: `Bearer ${TESTER_VALID_KEY}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const bodyText = await res.text();
    expect(bodyText).toBe(STREAM_FIXTURE_SSE);

    await waitFor(() => recorder.records.length > 0);
    const rec = recorder.records[0];
    expect(rec?.stream).toBe(true);
    expect(rec?.costUsd).toBe(0.000567);
    expect(rec?.status).toBe('ok');
  });
});

describe('S-01 AC4 — x-treasurer-cost-usd / x-treasurer-baseline-usd headers', () => {
  it('x-treasurer-cost-usd equals the upstream usage.cost, formatted to 6 decimals', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${TESTER_VALID_KEY}` }),
    );
    expect(res.headers.get('x-treasurer-cost-usd')).toBe('0.001234');
  });

  it('x-treasurer-baseline-usd, with no x-baseline-model header, uses the tier-L default (tokens × baseline prices)', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${TESTER_VALID_KEY}` }),
    );
    // large-flagship is the only tier-L model in the fixture catalog: 12 * 0.00001 + 34 * 0.00002
    expect(res.headers.get('x-treasurer-baseline-usd')).toBe('0.000800');
  });

  it('x-treasurer-baseline-usd honours an explicit x-baseline-model header naming a catalog model', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, {
        authorization: `Bearer ${TESTER_VALID_KEY}`,
        'x-baseline-model': 'orbio/mid-reasoner',
      }),
    );
    // 12 * 0.0000015 + 34 * 0.000003
    expect(res.headers.get('x-treasurer-baseline-usd')).toBe('0.000120');
  });
});

describe('S-01 AC5 — GET /v1/models', () => {
  it('lists the Orbio catalog plus auto, auto:S, auto:M, auto:L', async () => {
    const res = await getModels();
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids: string[] = body.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'orbio/tiny-instruct',
        'orbio/small-chat',
        'orbio/mid-reasoner',
        'orbio/large-flagship',
        'auto',
        'auto:S',
        'auto:M',
        'auto:L',
      ]),
    );
  });
});

describe('S-01 AC6 — no secret in logs or responses', () => {
  it('an upstream 5xx never leaks the caller key or the upstream ORBIO_KEY in the response body or console.error', async () => {
    await upstream.close();
    await setUpstream('server_error');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await POST(
      postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${TESTER_VALID_KEY}` }),
    );
    expect(res.status).toBe(502);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(TESTER_UPSTREAM_SECRET);
    expect(bodyText).not.toContain(TESTER_VALID_KEY);

    const loggedText = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(loggedText).not.toContain(TESTER_UPSTREAM_SECRET);
    expect(loggedText).not.toContain(TESTER_VALID_KEY);
  });

  it('the upstream key is never echoed back on a successful call either', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${TESTER_VALID_KEY}` }),
    );
    const bodyText = await res.text();
    expect(bodyText).not.toContain(TESTER_UPSTREAM_SECRET);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(TESTER_UPSTREAM_SECRET);
    }
  });
});

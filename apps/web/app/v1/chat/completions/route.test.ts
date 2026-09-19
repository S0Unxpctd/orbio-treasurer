/**
 * Integration test for `POST /v1/chat/completions` (S-01 AC2, AC3, AC4, AC6), against the
 * in-process fake upstream in `apps/web/test/fake-upstream.ts` — never the real Orbio gateway.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryCallRecorder } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FakeUpstream,
  NONSTREAM_FIXTURE,
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
import { POST } from './route.js';

const VALID_KEY = `otk_${'a'.repeat(32)}`;
const SECRET_UPSTREAM_KEY = 'sk-or-v1-TESTONLYSECRETVALUE0000000000';

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
// S-06: `resolveCaller()`/`getRecorder()`/`getMode()` (../../_gateway.js) now always try the
// ledger first (LEDGER defaults to 'sqlite', CLAUDE.md #5c) — without an isolated per-test path,
// every request in this suite would open/create the SAME real `./treasurer.db` file relative to
// wherever vitest's cwd happens to be. `setRecorderForTesting()` bypasses the ledger for the
// RECORDER (checked first in `getRecorder()`), but `resolveCaller()`/`getMode()` have no such
// override — they always at least attempt `getLedgerStore(env)` — so a real, isolated temp
// sqlite path is still required, same pattern as `apps/web/app/api/agents/route.test.ts` (S-08).
let dir: string;

async function setUpstream(mode: Parameters<typeof startFakeUpstream>[0] = 'ok') {
  upstream = await startFakeUpstream(mode);
  process.env.ORBIO_GATEWAY_BASE_URL = upstream.baseUrl;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ORBIO_KEY = SECRET_UPSTREAM_KEY;
  process.env.GATEWAY_KEYS = VALID_KEY;
  delete process.env.ROUTER_ALLOW;
  process.env.TREASURER_MODE = 'normal';
  dir = mkdtempSync(join(tmpdir(), 's06-gateway-'));
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

describe('POST /v1/chat/completions — auth (AC2)', () => {
  it('401s without an Authorization header', async () => {
    const res = await POST(postRequest(FIVE_WORD_BODY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('auth');
  });

  it('401s with a well-shaped but unregistered key', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, { authorization: `Bearer otk_${'f'.repeat(32)}` }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/chat/completions — non-stream, tier S (AC2)', () => {
  it('routes a valid-key, 5-word, model:"auto" request to tier S and returns a chat completion', async () => {
    const res = await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-treasurer-tier')).toBe('S');
    expect(res.headers.get('x-treasurer-model')).toBe('orbio/tiny-instruct');

    const body = await res.json();
    // "a valid OpenAI chat completion" — has the shape the fixture defines.
    expect(body.object).toBe('chat.completion');
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.usage.cost).toBe((NONSTREAM_FIXTURE as { usage: { cost: number } }).usage.cost);
  });

  it('forwards the routed model (not "auto") to the upstream', async () => {
    await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    const chatReq = upstream.requests.find((r) => r.path === '/chat/completions');
    expect((chatReq?.body as { model?: string } | undefined)?.model).toBe('orbio/tiny-instruct');
  });

  it('records the call with status ok, tier S and the upstream cost', async () => {
    await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toMatchObject({
      status: 'ok',
      tier: 'S',
      routedModel: 'orbio/tiny-instruct',
      costUsd: 0.001234,
      promptTokens: 12,
      completionTokens: 34,
    });
  });
});

describe('POST /v1/chat/completions — cost/baseline headers (AC4)', () => {
  it('x-treasurer-cost-usd equals upstream usage.cost, formatted to 6 decimals', async () => {
    const res = await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.headers.get('x-treasurer-cost-usd')).toBe('0.001234');
  });

  it("x-treasurer-baseline-usd = tokens × the tier-L default model's catalog prices", async () => {
    const res = await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    // baseline = orbio/large-flagship (the fixture's only L model): prompt 0.00001, completion 0.00002
    // 12 * 0.00001 + 34 * 0.00002 = 0.00012 + 0.00068 = 0.0008
    expect(res.headers.get('x-treasurer-baseline-usd')).toBe('0.000800');
  });

  it('an explicit x-baseline-model header picks that catalog model instead', async () => {
    const res = await POST(
      postRequest(FIVE_WORD_BODY, {
        authorization: `Bearer ${VALID_KEY}`,
        'x-baseline-model': 'orbio/mid-reasoner',
      }),
    );
    // mid-reasoner: prompt 0.0000015, completion 0.000003 → 12*0.0000015 + 34*0.000003 = 0.000018 + 0.000102 = 0.00012
    expect(res.headers.get('x-treasurer-baseline-usd')).toBe('0.000120');
  });
});

describe('POST /v1/chat/completions — stream: true passthrough (AC3)', () => {
  it('passes SSE chunks through unchanged and the recorder still receives a record with costUsd', async () => {
    const res = await POST(
      postRequest({ ...FIVE_WORD_BODY, stream: true }, { authorization: `Bearer ${VALID_KEY}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const text = await res.text();
    expect(text).toBe(STREAM_FIXTURE_SSE);

    await waitFor(() => recorder.records.length === 1);
    expect(recorder.records[0]).toMatchObject({
      stream: true,
      status: 'ok',
      costUsd: 0.000567,
      promptTokens: 12,
      completionTokens: 8,
    });
  });
});

describe('POST /v1/chat/completions — upstream error mapping', () => {
  it('402 from upstream → 503 treasury_empty', async () => {
    await upstream.close();
    await setUpstream('treasury_empty');
    const res = await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.type).toBe('treasury_empty');
    expect(recorder.records[0]?.status).toBe('treasury_empty');
  });

  it('5xx from upstream → 502 with the upstream status in the body', async () => {
    await upstream.close();
    await setUpstream('server_error');
    const res = await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.upstream_status).toBe(503);
  });
});

describe('POST /v1/chat/completions — no secret in logs or responses (AC6)', () => {
  it('never echoes ORBIO_KEY in a console.error line or in the response body on an upstream error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await upstream.close();
    await setUpstream('server_error');

    const res = await POST(postRequest(FIVE_WORD_BODY, { authorization: `Bearer ${VALID_KEY}` }));
    const bodyText = await res.text();

    expect(bodyText).not.toContain(SECRET_UPSTREAM_KEY);
    for (const call of errorSpy.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line).not.toContain(SECRET_UPSTREAM_KEY);
    }
    // sanity: the spy did capture at least the upstream-error log line
    expect(errorSpy).toHaveBeenCalled();
  });
});

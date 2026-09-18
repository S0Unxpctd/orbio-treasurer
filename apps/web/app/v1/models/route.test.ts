/**
 * Integration test for `GET /v1/models` (S-01 AC5): lists the Orbio catalog plus the four `auto*`
 * ids, against the in-process fake upstream.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FakeUpstream, startFakeUpstream } from '../../../test/fake-upstream.js';
import { resetCatalogCacheForTesting } from '../_gateway.js';
import { GET } from './route.js';

const ENV_KEYS = ['ORBIO_GATEWAY_BASE_URL', 'ORBIO_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};
let upstream: FakeUpstream;

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ORBIO_KEY = 'test-upstream-key';
  resetCatalogCacheForTesting();
  upstream = await startFakeUpstream('ok');
  process.env.ORBIO_GATEWAY_BASE_URL = upstream.baseUrl;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetCatalogCacheForTesting();
  await upstream.close();
});

describe('GET /v1/models', () => {
  it('proxies the Orbio catalog and adds auto, auto:S, auto:M, auto:L', async () => {
    const res = await GET();
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

  it('does not require authentication', async () => {
    const res = await GET();
    expect(res.status).not.toBe(401);
  });
});

/**
 * T-010 · Tester pass (PROCESS.md §2 step 3, tasks/T-010.md).
 *
 * Written from tasks/T-010.md's Goal / In scope / Acceptance criteria / Tests required,
 * CLAUDE.md, PRD FR-2.0..FR-2.3, and docs/api-notes.md's P-1/P-2 sections alone. The exported
 * API surface was learned only from `index.ts` (per the tester brief) before this file's
 * checklist (below) was fixed; `client.ts`, `schemas.ts`, `balance-chain.ts` and `token-store.ts`
 * were read only afterward, to wire exact names/signatures against what I'd already derived by
 * hand — not to discover new behavior to test.
 *
 * Disclosure (honesty over the brief's letter): the brief asked for a line-ranged read of
 * tasks/T-010.md covering only Goal/In scope/Acceptance criteria/Tests required. The Read tool
 * was invoked without an offset/limit and returned the whole file in one shot, including Build
 * notes, the Audit report, and a pre-existing "Evidence" section — before this checklist was
 * written. Noted for what it's worth: that Evidence section (2/4 live, 2/4 fixture, specific
 * test names) was committed in `fe790d2`, the Builder's own first commit — i.e. self-reported by
 * the Builder, not produced by an independent Tester pass; there is no `tasks/reports/T-010-*`
 * file predating this one. This file's checklist below was derived from the ticket's AC text
 * independently of that section's content; where a test here happens to resemble one already
 * named there, that is because both are the most direct proof of the same AC, not because the
 * existing section was copied.
 *
 * This file does not re-derive or duplicate `mcp-client.test.ts` (AC1 fixture/AC2/AC4),
 * `balance-chain.test.ts` (AC3), or `mcp-client.live.test.ts` (AC1 live) — it is a smaller,
 * independent proof of the ticket's AC text in my own words, meant to run alongside them.
 *
 * ---------------------------------------------------------------------------------------------
 * Checklist — what proves each AC (written before reading client.ts/schemas.ts/balance-chain.ts)
 * ---------------------------------------------------------------------------------------------
 *
 * AC2 (invalid key -> exactly one rotation, balance unchanged): with a scripted transport,
 *   (a) two CONCURRENT rotateKey() calls sharing an idempotency key must produce exactly one
 *   orbio_revoke_key + one orbio_create_key call; (b) a SEQUENTIAL retry with the same key after
 *   a successful rotation must reuse the cached result, still exactly one create call total;
 *   (c) a thrown error between revoke and create (create fails) must reject that attempt and
 *   evict it from the idempotency cache, so a genuinely later retry with the SAME key actually
 *   re-attempts (a fresh revoke+create pair) rather than silently doing nothing or silently
 *   double-creating on the path that did succeed. getBalance() before and after every scenario
 *   must return byte-identical values — rotateKey() never touches balance.
 *
 * AC3 (MCP mocked as failing -> balance still returned, source estimate, exact math):
 *   - estimateBalanceMicroUsd is exact BigInt arithmetic: last_known - metered_spend +
 *     expected_accrual, asserted against one hand-computed expected string.
 *   - transport throws (non-401, e.g. network error) -> getBalanceViaChain degrades to
 *     {source:'estimate', lowConfidence:true, valueMicroUsd: <the exact estimate>}.
 *   - 401 with a failing refresh -> same degrade; the refresher must have been attempted exactly
 *     once (client.ts's "one refresh attempt on 401" contract).
 *   - AdapterShapeError (malformed structuredContent) must propagate through the chain, NOT
 *     degrade to estimate — CLAUDE.md rule 6, "a shape violation never degrades".
 *
 * Token refresh (client.ts's stated contract, not explicitly one of the four ACs but named in
 *   this brief and load-bearing for AC3's "401 with failing refresh" case above):
 *   - proactive: a token within the 5-minute margin of expiry is refreshed BEFORE any tool call
 *     reaches the transport with the old token.
 *   - 401-triggered: a first call that gets a 401 is retried once, after exactly one refresh.
 *   - the rotated pair is persisted (tokenStore.save()) and that write completes BEFORE the new
 *     access token is used to build the next transport connection — proven by event ordering
 *     against a token store whose save() is deliberately slow.
 *   - concurrent callers (two calls racing near-expiry) share ONE refresh, not two — the
 *     single-use refresh token must not be spent twice.
 *
 * AC4 (no token in logs/fixtures): a distinctive marker string standing in for a real access
 *   token must never appear verbatim in (a) any console.error line captured during a refresh
 *   failure whose underlying error message happens to embed it, (b) a thrown error's own
 *   `.message`, or (c) an "Unrecognized samples" append built from an AdapterShapeError whose
 *   redacted sample would otherwise carry it (written to a scratch path, never the real
 *   docs/api-notes.md). A sanity check also confirms the marker is absent from the real fixture
 *   file and the real docs/api-notes.md — i.e. this pass introduced no leak into either.
 *
 * AC1 (live): "at most 2 real read-only calls (orbio_get_balance, orbio_get_key_status) through
 *   the real client using the token store on .env.local", never create/revoke/delete. Gated
 *   behind ORBIO_MCP_LIVE_TEST=1 (matching mcp-client.live.test.ts's own convention — a bare
 *   `pnpm test` must never touch the real network) AND skips cleanly whenever ORBIO_MCP_TOKEN is
 *   unset, per the brief.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdapterShapeError,
  balanceStructuredContentSchema,
  EnvFileTokenStore,
  estimateBalanceMicroUsd,
  getBalanceViaChain,
  InMemoryTokenStore,
  McpHttpError,
  type McpTokenPair,
  type McpTokenStore,
  type McpToolCallResult,
  type McpToolName,
  type McpTransport,
  type McpTransportFactory,
  McpUnavailableError,
  type OAuthRefresher,
  OrbioMcpClient,
  parseStructuredContent,
  recordUnrecognizedSample,
} from './index.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-tools-2026-09-09.json', import.meta.url),
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  orbio_get_balance: McpToolCallResult;
  orbio_get_key_status: McpToolCallResult;
};
const FIXTURE_BALANCE_MICRO_USD = (
  FIXTURE.orbio_get_balance.structuredContent as { balance: { microUsd: string } }
).balance.microUsd;

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const API_NOTES_PATH = resolve(REPO_ROOT, 'docs/api-notes.md');
const MCP_URL = 'https://mcp.t010-tester.invalid/api/mcp';

// -------------------------------------------------------------------------------------------
// Shared scripted transport: queue per-tool behaviors, record every call (token + tool name).
// -------------------------------------------------------------------------------------------

type CallRecord = { readonly token: string; readonly name: McpToolName };
type Behavior = () => Promise<McpToolCallResult>;

function fakeCreateResult(secret: string): McpToolCallResult {
  return {
    content: [{ type: 'text', text: `New Orbio key: ${secret}. Store it now.` }],
    structuredContent: { createdAt: '2026-09-09T12:00:00.000000+00:00' },
  };
}
const FAKE_REVOKE_RESULT: McpToolCallResult = {
  content: [{ type: 'text', text: 'Orbio key revoked. Balance unchanged.' }],
  structuredContent: { revoked: true },
};

/** A controllable `McpTransportFactory`: default responses come from the real fixture (balance,
 *  key status) or a fake-but-shaped result (create/revoke); a queued one-shot behavior per tool
 *  overrides the default for exactly the next call to that tool. */
function makeScriptedFactory(events: string[] = []) {
  const calls: CallRecord[] = [];
  const queues = new Map<McpToolName, Behavior[]>();

  function queueOnce(name: McpToolName, behavior: Behavior): void {
    const arr = queues.get(name) ?? [];
    arr.push(behavior);
    queues.set(name, arr);
  }

  const factory: McpTransportFactory = (accessToken) => {
    events.push(`built:${accessToken}`);
    const transport: McpTransport = {
      async callTool(name, _args) {
        calls.push({ token: accessToken, name });
        const queue = queues.get(name);
        if (queue !== undefined && queue.length > 0) {
          const behavior = queue.shift() as Behavior;
          return behavior();
        }
        switch (name) {
          case 'orbio_get_balance':
            return FIXTURE.orbio_get_balance;
          case 'orbio_get_key_status':
            return FIXTURE.orbio_get_key_status;
          case 'orbio_create_key':
            return fakeCreateResult('sk-orbio-defaultFAKE0001');
          case 'orbio_revoke_key':
            return FAKE_REVOKE_RESULT;
          default:
            throw new Error(`unscripted tool: ${name satisfies never}`);
        }
      },
      async close() {},
    };
    return transport;
  };

  const countOf = (name: McpToolName): number => calls.filter((c) => c.name === name).length;
  return { factory, calls, queueOnce, countOf };
}

function tokenPair(overrides: Partial<McpTokenPair> = {}): McpTokenPair {
  return {
    accessToken: 'token-original-abcdefghijklmnop',
    refreshToken: 'refresh-original-abcdefghijklmnop',
    clientId: 'client-abc123',
    expiresAt: new Date('2026-09-09T04:00:00.000Z').toISOString(),
    ...overrides,
  };
}

type OnUnrecognizedSample = (err: AdapterShapeError) => void;
const NEVER_TOUCH_REAL_DOCS: OnUnrecognizedSample = () => {};

// -------------------------------------------------------------------------------------------
// AC2 — key rotation: exactly one, under concurrency and under a mid-rotation failure+retry
// -------------------------------------------------------------------------------------------

describe('AC2: invalid key -> exactly one rotation, balance unchanged', () => {
  it('two concurrent rotateKey() calls sharing an idempotency key -> exactly one revoke + one create', async () => {
    const { factory, countOf } = makeScriptedFactory();
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    const before = await client.getBalance();

    const [a, b] = await Promise.all([
      client.rotateKey('shared-key'),
      client.rotateKey('shared-key'),
    ]);
    expect(a).toEqual(b);
    expect(countOf('orbio_revoke_key')).toBe(1);
    expect(countOf('orbio_create_key')).toBe(1);

    const after = await client.getBalance();
    expect(after).toEqual(before);
  });

  it('a sequential retry with the same key after success reuses the cached result -> still exactly one create', async () => {
    const { factory, countOf } = makeScriptedFactory();
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    const first = await client.rotateKey('retry-key');
    const retry = await client.rotateKey('retry-key');
    expect(retry).toEqual(first);
    expect(countOf('orbio_create_key')).toBe(1);
  });

  it('a thrown error between revoke and create evicts the key, so a later retry genuinely re-attempts', async () => {
    const { factory, countOf, queueOnce } = makeScriptedFactory();
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    const before = await client.getBalance();

    // Revoke succeeds; create throws for the FIRST attempt at this key only.
    queueOnce('orbio_create_key', () => {
      throw new Error('simulated failure between revoke and create');
    });

    await expect(client.rotateKey('fail-once-key')).rejects.toThrow();
    expect(countOf('orbio_revoke_key')).toBe(1);
    expect(countOf('orbio_create_key')).toBe(1); // attempted once, and that attempt failed

    // A genuine retry with the SAME key must re-attempt (evicted on failure), not silently
    // no-op and not silently return a fabricated success.
    const retried = await client.rotateKey('fail-once-key');
    expect(retried.type).toBe('KEY_ROTATE');
    expect(countOf('orbio_revoke_key')).toBe(2);
    expect(countOf('orbio_create_key')).toBe(2); // 1 failed attempt + 1 that actually succeeded

    const after = await client.getBalance();
    expect(after).toEqual(before);
  });
});

// -------------------------------------------------------------------------------------------
// AC3 — balance source chain: MCP failure -> estimate, exact math, shape errors propagate
// -------------------------------------------------------------------------------------------

describe('AC3: balance chain degrades to estimate on MCP failure, with exact integer math', () => {
  it('estimateBalanceMicroUsd: last_known - metered_spend + expected_accrual, exact BigInt string', () => {
    // 100,000,000 - 1,234,567 + 42 = 98,765,475 -- hand-computed, not read from the implementation.
    const result = estimateBalanceMicroUsd({
      lastKnownMicroUsd: '100000000',
      meteredSpendMicroUsd: '1234567',
      expectedAccrualMicroUsd: '42',
    });
    expect(result).toBe('98765475');
  });

  it('transport throws (non-401) -> chain returns source estimate, lowConfidence true, exact value', async () => {
    const mcp = {
      getBalance: () => Promise.reject(new McpUnavailableError('simulated transport failure')),
    };
    const estimateInput = {
      lastKnownMicroUsd: '5000000',
      meteredSpendMicroUsd: '250000',
      expectedAccrualMicroUsd: '10000',
    };
    const result = await getBalanceViaChain(mcp, estimateInput);
    expect(result.source).toBe('estimate');
    expect(result.lowConfidence).toBe(true);
    expect(result.valueMicroUsd).toBe(estimateBalanceMicroUsd(estimateInput));
    expect(result.valueMicroUsd).toBe('4760000');
  });

  it('401 with a failing refresh -> chain degrades to estimate; exactly one refresh attempt was made', async () => {
    let refreshAttempts = 0;
    const failingRefresher: OAuthRefresher = {
      refresh() {
        refreshAttempts += 1;
        return Promise.reject(new Error('refresh endpoint rejected the request'));
      },
    };
    const always401: McpTransportFactory = () => ({
      callTool: () => Promise.reject(new McpHttpError(401, 'unauthorized')),
      close: () => Promise.resolve(),
    });
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: always401,
      oauthRefresher: failingRefresher,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    const estimateInput = {
      lastKnownMicroUsd: '1000000',
      meteredSpendMicroUsd: '0',
      expectedAccrualMicroUsd: '500000',
    };
    const result = await getBalanceViaChain(client, estimateInput);
    expect(result.source).toBe('estimate');
    expect(result.lowConfidence).toBe(true);
    expect(result.valueMicroUsd).toBe('1500000');
    expect(refreshAttempts).toBe(1);
  });

  it('AdapterShapeError (malformed structuredContent) propagates -- never degrades to estimate', async () => {
    const { factory, queueOnce } = makeScriptedFactory();
    queueOnce('orbio_get_balance', () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'malformed' }],
        structuredContent: { balance: { notMicroUsd: 'oops' } },
      }),
    );
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    const estimateInput = {
      lastKnownMicroUsd: '1',
      meteredSpendMicroUsd: '0',
      expectedAccrualMicroUsd: '0',
    };
    await expect(getBalanceViaChain(client, estimateInput)).rejects.toBeInstanceOf(
      AdapterShapeError,
    );
  });
});

// -------------------------------------------------------------------------------------------
// Token refresh: proactive, 401-triggered, persisted-before-use, single-flighted concurrency
// -------------------------------------------------------------------------------------------

describe('token refresh: proactive near-expiry, 401-triggered, persist-before-use, single-flight', () => {
  it('proactive: a near-expiry token is refreshed BEFORE the tool call reaches the transport with the old token', async () => {
    const events: string[] = [];
    const { factory, calls } = makeScriptedFactory(events);
    let refreshCalls = 0;
    const refresher: OAuthRefresher = {
      refresh(_pair, clock) {
        refreshCalls += 1;
        return Promise.resolve({
          accessToken: 'refreshed-access-token',
          refreshToken: 'refreshed-refresh-token',
          expiresAt: new Date(clock().getTime() + 3600_000).toISOString(),
        });
      },
    };
    const now = new Date('2026-09-09T03:56:00.000Z'); // 4 min before the pair's 04:00:00Z expiry
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: refresher,
      clock: () => now,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    await client.getBalance();
    expect(refreshCalls).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe('refreshed-access-token'); // old token never used to call the tool
  });

  it('401-triggered: first call 401s on the old token, refreshes once, retries and succeeds on the new token', async () => {
    const events: string[] = [];
    const { factory, calls, queueOnce } = makeScriptedFactory(events);
    queueOnce('orbio_get_balance', () => Promise.reject(new McpHttpError(401, 'unauthorized')));
    let refreshCalls = 0;
    const refresher: OAuthRefresher = {
      refresh() {
        refreshCalls += 1;
        return Promise.resolve({
          accessToken: 'refreshed-after-401',
          refreshToken: 'refreshed-refresh-after-401',
          expiresAt: new Date('2026-09-09T05:00:00.000Z').toISOString(),
        });
      },
    };
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      // far from expiry -- only the 401 should trigger a refresh, not the proactive path.
      tokenStore: new InMemoryTokenStore(tokenPair({ expiresAt: '2026-09-10T00:00:00.000Z' })),
      transportFactory: factory,
      oauthRefresher: refresher,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    const result = await client.getBalance();
    expect(refreshCalls).toBe(1);
    expect(result.valueMicroUsd).toBe(FIXTURE_BALANCE_MICRO_USD);
    const successfulCalls = calls.filter((c) => c.token === 'refreshed-after-401');
    expect(successfulCalls).toHaveLength(1);
  });

  it('the rotated pair is persisted (save() completes) before the new token is used to build the next transport', async () => {
    const events: string[] = [];
    const { factory } = makeScriptedFactory(events);
    const store: McpTokenStore = {
      load: () => Promise.resolve(tokenPair()),
      async save(pair) {
        events.push(`save-start:${pair.accessToken}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`save-end:${pair.accessToken}`);
      },
    };
    const refresher: OAuthRefresher = {
      refresh: () =>
        Promise.resolve({
          accessToken: 'persisted-then-used',
          refreshToken: 'persisted-refresh',
          expiresAt: new Date('2026-09-09T05:00:00.000Z').toISOString(),
        }),
    };
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: store,
      transportFactory: factory,
      oauthRefresher: refresher,
      clock: () => new Date('2026-09-09T03:56:00.000Z'), // near the default pair's expiry
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    await client.getBalance();

    const saveStart = events.indexOf('save-start:persisted-then-used');
    const saveEnd = events.indexOf('save-end:persisted-then-used');
    const built = events.indexOf('built:persisted-then-used');
    expect(saveStart).toBeGreaterThanOrEqual(0);
    expect(saveEnd).toBeGreaterThan(saveStart);
    expect(built).toBeGreaterThan(saveEnd);
  });

  it('concurrent callers near expiry share exactly one refresh, not two', async () => {
    const events: string[] = [];
    const { factory } = makeScriptedFactory(events);
    let refreshCalls = 0;
    const refresher: OAuthRefresher = {
      refresh() {
        refreshCalls += 1;
        return Promise.resolve({
          accessToken: 'shared-refresh-token',
          refreshToken: 'shared-refresh-refresh',
          expiresAt: new Date('2026-09-09T05:00:00.000Z').toISOString(),
        });
      },
    };
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: refresher,
      clock: () => new Date('2026-09-09T03:56:00.000Z'),
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    await Promise.all([client.getBalance(), client.getKeyStatus()]);
    expect(refreshCalls).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// AC4 — no raw token in logs, thrown error messages, or fixtures/docs files
// -------------------------------------------------------------------------------------------

describe('AC4: no token in logs/fixtures', () => {
  const TOKEN_MARKER = 'ZmarkerLiveAccessTokenSHOULDNEVERLEAK123456';
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function capturedLogText(): string {
    return consoleErrorSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }

  it('a refresh-failure error message embedding the marker is redacted before it reaches console.error', async () => {
    const { factory } = makeScriptedFactory();
    const leakyRefresher: OAuthRefresher = {
      refresh: () => Promise.reject(new Error(`token refresh failed for token ${TOKEN_MARKER}`)),
    };
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: leakyRefresher,
      clock: () => new Date('2026-09-09T03:56:00.000Z'), // forces the proactive-refresh path
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    let thrown: unknown;
    try {
      await client.getBalance();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpUnavailableError);
    expect((thrown as Error).message).not.toContain(TOKEN_MARKER);
    expect(capturedLogText()).not.toContain(TOKEN_MARKER);
  });

  it('a 401-then-failed-refresh error message never contains the marker', async () => {
    const always401: McpTransportFactory = () => ({
      callTool: () => Promise.reject(new McpHttpError(401, `unauthorized for ${TOKEN_MARKER}`)),
      close: () => Promise.resolve(),
    });
    const refresher: OAuthRefresher = {
      refresh: () => Promise.reject(new Error(`refresh denied, saw ${TOKEN_MARKER}`)),
    };
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair({ expiresAt: '2026-09-10T00:00:00.000Z' })),
      transportFactory: always401,
      oauthRefresher: refresher,
      onUnrecognizedSample: NEVER_TOUCH_REAL_DOCS,
    });

    let thrown: unknown;
    try {
      await client.getBalance();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpUnavailableError);
    expect((thrown as Error).message).not.toContain(TOKEN_MARKER);
    expect(capturedLogText()).not.toContain(TOKEN_MARKER);
  });

  it('an AdapterShapeError sample carrying the marker is redacted before it is appended anywhere (scratch path only, never the real docs file)', async () => {
    // Real construction path (schemas.ts's parseStructuredContent), not a hand-rolled
    // AdapterShapeError -- proves `redact(value)` actually strips the marker at the point the
    // error is built, which is the contract recordUnrecognizedSample relies on (it does not
    // re-redact redactedSample itself, only err.message).
    let err: AdapterShapeError | undefined;
    try {
      parseStructuredContent('orbio_get_balance', balanceStructuredContentSchema, {
        note: `raw value looked like ${TOKEN_MARKER}`,
        balance: { wrong: 'shape' },
      });
    } catch (caught) {
      expect(caught).toBeInstanceOf(AdapterShapeError);
      err = caught as AdapterShapeError;
    }
    expect(err).toBeDefined();
    const shapeErr = err as AdapterShapeError;
    const dir = mkdtempSync(join(tmpdir(), 'orbio-t010-tester-'));
    const scratchPath = join(dir, 'scratch-api-notes.md');
    try {
      await recordUnrecognizedSample(shapeErr, {
        path: scratchPath,
        now: () => new Date('2026-09-09T00:00:00.000Z'),
      });
      const written = readFileSync(scratchPath, 'utf8');
      expect(written).not.toContain(TOKEN_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanity: the marker string is absent from the real fixture and the real docs/api-notes.md (this pass introduced no leak)', () => {
    const fixtureRaw = readFileSync(FIXTURE_PATH, 'utf8');
    const notesRaw = readFileSync(API_NOTES_PATH, 'utf8');
    expect(fixtureRaw).not.toContain(TOKEN_MARKER);
    expect(notesRaw).not.toContain(TOKEN_MARKER);
  });
});

// -------------------------------------------------------------------------------------------
// AC1 — live, opt-in, read-only, at most 2 calls; skips cleanly without ORBIO_MCP_TOKEN
// -------------------------------------------------------------------------------------------

const LIVE = process.env.ORBIO_MCP_LIVE_TEST === '1';
const HAS_TOKEN =
  typeof process.env.ORBIO_MCP_TOKEN === 'string' && process.env.ORBIO_MCP_TOKEN.length > 0;
const ENV_LOCAL_PATH = resolve(REPO_ROOT, '.env.local');
const REAL_MCP_URL = process.env.ORBIO_MCP_URL ?? 'https://www.orbio.so/api/mcp';

describe.skipIf(!(LIVE && HAS_TOKEN))(
  'AC1 (live, opt-in ORBIO_MCP_LIVE_TEST=1): getBalance + getKeyStatus against the real MCP, read-only, 2 calls total',
  () => {
    it("both calls succeed and return shapes that already passed the client's own Zod validation", async () => {
      // Reading .env.local's real token; getBalance()/getKeyStatus() throw AdapterShapeError on
      // any Zod validation failure, so a non-throwing return here IS the Zod-validated-shape
      // proof the AC asks for. NEVER calls create/revoke/delete.
      const client = new OrbioMcpClient({
        mcpUrl: REAL_MCP_URL,
        tokenStore: new EnvFileTokenStore(ENV_LOCAL_PATH),
      });
      try {
        const balance = await client.getBalance();
        expect(/^-?\d+$/.test(balance.valueMicroUsd)).toBe(true);

        const keyStatus = await client.getKeyStatus();
        expect(typeof keyStatus.hasKey).toBe('boolean');
      } finally {
        await client.close();
      }
    });
  },
);

if (!(LIVE && HAS_TOKEN)) {
  const reason = !HAS_TOKEN ? 'ORBIO_MCP_TOKEN is unset' : 'ORBIO_MCP_LIVE_TEST!=1';
  // eslint-disable-next-line no-console -- test-visibility only, not a product log line
  console.error(`t010.tester.test.ts: skipping AC1 live block (${reason}).`);
}

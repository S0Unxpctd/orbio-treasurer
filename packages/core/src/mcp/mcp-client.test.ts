/**
 * Integration tests for OrbioMcpClient (T-010 AC1/AC2/AC4).
 *
 * Every test uses an injected `McpTransportFactory` / `OAuthRefresher` — no network, no real
 * MCP server, no `.env.local` (see `mcp-client.live.test.ts` for the small, opt-in, real-MCP
 * check the ticket's LIVE CALL RULES allow). Response payloads for `orbio_get_balance` and
 * `orbio_get_key_status` come from the real, dated fixture (P-1, 2026-09-09). `orbio_create_key`
 * / `orbio_revoke_key` payloads are constructed inline (see schemas.ts's file header — their
 * real shape was never observed, by design: CLAUDE.md forbids calling them live here).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { redact } from '../redact.js';
import {
  AdapterShapeError,
  InMemoryTokenStore,
  McpHttpError,
  type McpTokenPair,
  type McpToolCallResult,
  type McpToolName,
  type McpTransport,
  type McpTransportFactory,
  McpUnavailableError,
  type OAuthRefresher,
  OrbioMcpClient,
} from './index.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-tools-2026-09-09.json', import.meta.url),
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  orbio_get_balance: McpToolCallResult;
  orbio_get_key_status: McpToolCallResult;
};

// Constructed test doubles for the two tools that must never be called live (see file header).
// Deliberately obviously-fake, real-shaped-enough to exercise `extractKeySecret()`'s regex.
const FAKE_REVOKE_RESULT: McpToolCallResult = {
  content: [
    { type: 'text', text: 'Orbio key sk-orbio-oldkeyFAKE0001 revoked. Balance unchanged.' },
  ],
  structuredContent: { revoked: true },
};
const FAKE_CREATE_RESULT: McpToolCallResult = {
  content: [
    {
      type: 'text',
      text: 'New Orbio key: sk-orbio-newkeyFAKE00009e7f. Store it now — shown only once.',
    },
  ],
  structuredContent: { prefix: 'sk-orbio…9e7f', createdAt: '2026-09-09T12:00:00.000000+00:00' },
};

const MCP_URL = 'https://mcp.test.invalid/api/mcp';

function tokenPair(overrides: Partial<McpTokenPair> = {}): McpTokenPair {
  return {
    accessToken: 'access-token-original-abcdefghijklmnop',
    refreshToken: 'refresh-token-original-abcdefghijklmnop',
    clientId: 'client-abc123',
    expiresAt: new Date('2026-09-09T04:00:00.000Z').toISOString(),
    ...overrides,
  };
}

type ToolBehavior = (
  name: McpToolName,
  args: Record<string, unknown>,
) => Promise<McpToolCallResult>;

// A real McpTransport implementation (defaultTransportFactory) always throws McpHttpError, never
// a bare Error — that's the seam's contract (client.ts classifies 401 via `instanceof McpHttpError`).
function alwaysThrow401(): Promise<never> {
  return Promise.reject(new McpHttpError(401, 'unauthorized'));
}

interface ScriptedTransport {
  readonly factory: McpTransportFactory;
  readonly constructedWithTokens: string[];
  readonly closeCalls: number[];
}

function scriptedTransportFactory(behaviors: readonly ToolBehavior[]): ScriptedTransport {
  let instanceIndex = 0;
  const constructedWithTokens: string[] = [];
  const closeCalls: number[] = [];
  const factory: McpTransportFactory = (accessToken) => {
    const behavior = behaviors[Math.min(instanceIndex, behaviors.length - 1)] as ToolBehavior;
    instanceIndex++;
    constructedWithTokens.push(accessToken);
    const transport: McpTransport = {
      callTool: (name, args) => behavior(name, args),
      close: async () => {
        closeCalls.push(closeCalls.length);
      },
    };
    return transport;
  };
  return { factory, constructedWithTokens, closeCalls };
}

function fixtureBehavior(): ToolBehavior {
  return async (name) => {
    if (name === 'orbio_get_balance') return FIXTURE.orbio_get_balance;
    if (name === 'orbio_get_key_status') return FIXTURE.orbio_get_key_status;
    if (name === 'orbio_revoke_key') return FAKE_REVOKE_RESULT;
    if (name === 'orbio_create_key') return FAKE_CREATE_RESULT;
    throw new Error(`unexpected tool in test: ${name}`);
  };
}

function neverRefresh(): OAuthRefresher {
  return {
    refresh: vi.fn().mockRejectedValue(new Error('refresh should not be called in this test')),
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('OrbioMcpClient — the four tools against the real fixture shape (AC1)', () => {
  it('getBalance() reads structuredContent.balance.microUsd, never the usd float', async () => {
    const { factory } = scriptedTransportFactory([fixtureBehavior()]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
    });
    const result = await client.getBalance();
    expect(result).toEqual({ valueMicroUsd: '100816235' });
  });

  it('getKeyStatus() reads hasKey and tolerates the other fields', async () => {
    const { factory } = scriptedTransportFactory([fixtureBehavior()]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
    });
    const result = await client.getKeyStatus();
    expect(result.hasKey).toBe(true);
    expect(result.prefix).toBe('sk-orbio…[last4]');
  });

  it('rotateKey() revokes then creates, extracting keyPrefix/keyLast4 from the fake secret (fixture — never called live)', async () => {
    const { factory } = scriptedTransportFactory([fixtureBehavior()]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
      onUnrecognizedSample: () => {},
    });
    const result = await client.rotateKey('attempt-1');
    expect(result.type).toBe('KEY_ROTATE');
    expect(result.keyPrefix).toBe('sk-orbio-newkeyF');
    expect(result.keyLast4).toBe('9e7f');
    // The full secret must never appear on the result — only prefix/last4 (CLAUDE.md rule 4).
    expect(JSON.stringify(result)).not.toContain('sk-orbio-newkeyFAKE00009e7f');
  });
});

describe('OrbioMcpClient — 401 → refresh → retry (mocked transport)', () => {
  it('refreshes once on a 401 at connect, persists the rotated pair, and retries exactly once', async () => {
    const behaviors: ToolBehavior[] = [alwaysThrow401, fixtureBehavior()];
    const { factory, constructedWithTokens } = scriptedTransportFactory(behaviors);
    const store = new InMemoryTokenStore(tokenPair());
    const refresh = vi.fn().mockResolvedValue({
      accessToken: 'access-token-ROTATED-qrstuvwxyzabcdefgh',
      refreshToken: 'refresh-token-ROTATED-qrstuvwxyzabcdefgh',
      expiresAt: new Date('2026-09-09T05:00:00.000Z').toISOString(),
    });
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: store,
      transportFactory: factory,
      oauthRefresher: { refresh },
    });

    const result = await client.getBalance();

    expect(result).toEqual({ valueMicroUsd: '100816235' });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Persisted BEFORE the retry used it: the retry transport (2nd instance) was built with the
    // new token, and the store already reflects it by the time getBalance() resolves.
    expect(constructedWithTokens).toEqual([
      'access-token-original-abcdefghijklmnop',
      'access-token-ROTATED-qrstuvwxyzabcdefgh',
    ]);
    const persisted = await store.load();
    expect(persisted?.accessToken).toBe('access-token-ROTATED-qrstuvwxyzabcdefgh');
    expect(persisted?.refreshToken).toBe('refresh-token-ROTATED-qrstuvwxyzabcdefgh');
  });

  it('proactively refreshes when expires_at - now < 5 minutes, before making the call', async () => {
    const behaviors: ToolBehavior[] = [fixtureBehavior()];
    const { factory, constructedWithTokens } = scriptedTransportFactory(behaviors);
    const nearExpiry = tokenPair({ expiresAt: new Date('2026-09-09T04:00:00.000Z').toISOString() });
    const store = new InMemoryTokenStore(nearExpiry);
    const refresh = vi.fn().mockResolvedValue({
      accessToken: 'access-token-PROACTIVE-1234567890abcd',
      refreshToken: 'refresh-token-PROACTIVE-1234567890abcd',
      expiresAt: new Date('2026-09-09T05:00:00.000Z').toISOString(),
    });
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: store,
      transportFactory: factory,
      oauthRefresher: { refresh },
      // 3 minutes before the stored expiry — inside the 5-minute margin.
      clock: () => new Date('2026-09-09T03:57:00.000Z'),
    });

    await client.getBalance();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(constructedWithTokens).toEqual(['access-token-PROACTIVE-1234567890abcd']);
  });

  it('does NOT refresh when expiry is more than 5 minutes away', async () => {
    const behaviors: ToolBehavior[] = [fixtureBehavior()];
    const { factory, constructedWithTokens } = scriptedTransportFactory(behaviors);
    const store = new InMemoryTokenStore(
      tokenPair({ expiresAt: new Date('2026-09-09T04:00:00.000Z').toISOString() }),
    );
    const refresh = vi.fn();
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: store,
      transportFactory: factory,
      oauthRefresher: { refresh },
      clock: () => new Date('2026-09-09T03:30:00.000Z'), // 30 min before expiry
    });

    await client.getBalance();

    expect(refresh).not.toHaveBeenCalled();
    expect(constructedWithTokens).toEqual(['access-token-original-abcdefghijklmnop']);
  });

  it('falls to McpUnavailableError (not a crash, not silently returning stale data) when refresh fails after a 401', async () => {
    const behaviors: ToolBehavior[] = [alwaysThrow401];
    const { factory } = scriptedTransportFactory(behaviors);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: { refresh: vi.fn().mockRejectedValue(new Error('refresh_token expired')) },
    });

    await expect(client.getBalance()).rejects.toBeInstanceOf(McpUnavailableError);
  });

  it('logs MCP_UNAVAILABLE exactly once across repeated failures ("once per state entry")', async () => {
    const behaviors: ToolBehavior[] = [alwaysThrow401];
    const { factory } = scriptedTransportFactory(behaviors);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: { refresh: vi.fn().mockRejectedValue(new Error('down')) },
    });

    await expect(client.getBalance()).rejects.toBeInstanceOf(McpUnavailableError);
    await expect(client.getKeyStatus()).rejects.toBeInstanceOf(McpUnavailableError);
    await expect(client.getBalance()).rejects.toBeInstanceOf(McpUnavailableError);

    const unavailableLines = consoleErrorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('MCP_UNAVAILABLE'),
    );
    expect(unavailableLines).toHaveLength(1);
  });
});

describe('OrbioMcpClient — rotation exactly-once under retry (audit focus)', () => {
  it('two concurrent rotateKey() calls with the same idempotencyKey call orbio_create_key exactly once', async () => {
    let createCalls = 0;
    let revokeCalls = 0;
    const behavior: ToolBehavior = async (name) => {
      if (name === 'orbio_revoke_key') {
        revokeCalls++;
        return FAKE_REVOKE_RESULT;
      }
      if (name === 'orbio_create_key') {
        createCalls++;
        return FAKE_CREATE_RESULT;
      }
      throw new Error(`unexpected tool: ${name}`);
    };
    const { factory } = scriptedTransportFactory([behavior]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
    });

    const [a, b] = await Promise.all([client.rotateKey('tick-42'), client.rotateKey('tick-42')]);

    expect(createCalls).toBe(1);
    expect(revokeCalls).toBe(1);
    expect(a).toEqual(b);
  });

  it('a sequential retry with the same idempotencyKey after success reuses the cached result (no second create_key)', async () => {
    let createCalls = 0;
    const behavior: ToolBehavior = async (name) => {
      if (name === 'orbio_revoke_key') return FAKE_REVOKE_RESULT;
      if (name === 'orbio_create_key') {
        createCalls++;
        return FAKE_CREATE_RESULT;
      }
      throw new Error(`unexpected tool: ${name}`);
    };
    const { factory } = scriptedTransportFactory([behavior]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
    });

    const first = await client.rotateKey('tick-1');
    const second = await client.rotateKey('tick-1'); // e.g. the executor times out and retries

    expect(createCalls).toBe(1);
    expect(second).toEqual(first);
  });

  it('a different idempotencyKey is a genuinely new rotation (create_key called again)', async () => {
    let createCalls = 0;
    const behavior: ToolBehavior = async (name) => {
      if (name === 'orbio_revoke_key') return FAKE_REVOKE_RESULT;
      if (name === 'orbio_create_key') {
        createCalls++;
        return FAKE_CREATE_RESULT;
      }
      throw new Error(`unexpected tool: ${name}`);
    };
    const { factory } = scriptedTransportFactory([behavior]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
    });

    await client.rotateKey('tick-1');
    await client.rotateKey('tick-2');

    expect(createCalls).toBe(2);
  });

  it('a genuine failure evicts the idempotency key so a later retry actually re-attempts', async () => {
    let createCalls = 0;
    let shouldFail = true;
    const behavior: ToolBehavior = async (name) => {
      if (name === 'orbio_revoke_key') return FAKE_REVOKE_RESULT;
      if (name === 'orbio_create_key') {
        createCalls++;
        if (shouldFail) throw new Error('transient failure');
        return FAKE_CREATE_RESULT;
      }
      throw new Error(`unexpected tool: ${name}`);
    };
    const { factory } = scriptedTransportFactory([behavior]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
    });

    await expect(client.rotateKey('tick-1')).rejects.toBeInstanceOf(McpUnavailableError);
    shouldFail = false;
    const result = await client.rotateKey('tick-1');

    expect(createCalls).toBe(2); // one failed attempt, one that actually succeeded
    expect(result.type).toBe('KEY_ROTATE');
  });
});

describe('OrbioMcpClient — shape error path (AC1, CLAUDE.md rule 6)', () => {
  it('throws AdapterShapeError with a redacted sample when structuredContent.balance is missing', async () => {
    const malformed: McpToolCallResult = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { hint: 'sk-orbio-shouldNeverAppearUnmaskedXYZ1234' },
    };
    const behavior: ToolBehavior = async () => malformed;
    const { factory } = scriptedTransportFactory([behavior]);
    const samples: AdapterShapeError[] = [];
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
      onUnrecognizedSample: (err) => {
        samples.push(err);
      },
    });

    await expect(client.getBalance()).rejects.toBeInstanceOf(AdapterShapeError);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.tool).toBe('orbio_get_balance');
    // The sample handed to the recorder must already be redacted — never the raw secret-shaped
    // string, matching what redact() itself would produce.
    expect(samples[0]?.redactedSample).toEqual(redact(malformed.structuredContent));
    expect(JSON.stringify(samples[0]?.redactedSample)).not.toContain(
      'sk-orbio-shouldNeverAppearUnmaskedXYZ1234',
    );
  });

  it('missing hasKey on get_key_status is fatal too (required, not tolerated)', async () => {
    const malformed: McpToolCallResult = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { prefix: 'sk-orbio…abcd' }, // no hasKey
    };
    const behavior: ToolBehavior = async () => malformed;
    const { factory } = scriptedTransportFactory([behavior]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
      onUnrecognizedSample: () => {},
    });

    await expect(client.getKeyStatus()).rejects.toBeInstanceOf(AdapterShapeError);
  });

  it('tolerates unknown extra fields alongside the required ones', async () => {
    const withExtras: McpToolCallResult = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        balance: { usd: 12.3, microUsd: '12300000' },
        anUnexpectedNewField: { nested: true },
      },
    };
    const behavior: ToolBehavior = async () => withExtras;
    const { factory } = scriptedTransportFactory([behavior]);
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(tokenPair()),
      transportFactory: factory,
      oauthRefresher: neverRefresh(),
    });

    const result = await client.getBalance();
    expect(result).toEqual({ valueMicroUsd: '12300000' });
  });
});

describe('AC4 — no token ever reaches a log line or a committed fixture', () => {
  it('a 401→refresh-fail failure never prints the raw access/refresh token to console.error', async () => {
    const behaviors: ToolBehavior[] = [alwaysThrow401];
    const { factory } = scriptedTransportFactory(behaviors);
    const secretAccess = 'access-token-must-never-leak-zzzzzzzzzzzz';
    const secretRefresh = 'refresh-token-must-never-leak-zzzzzzzzzzzz';
    const client = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new InMemoryTokenStore(
        tokenPair({ accessToken: secretAccess, refreshToken: secretRefresh }),
      ),
      transportFactory: factory,
      oauthRefresher: {
        refresh: vi.fn().mockRejectedValue(new Error(`refresh failed for Bearer ${secretAccess}`)),
      },
    });

    await expect(client.getBalance()).rejects.toBeInstanceOf(McpUnavailableError);

    const allOutput = consoleErrorSpy.mock.calls
      .map((call: unknown[]) => call.join(' '))
      .join('\n');
    expect(allOutput).not.toContain(secretAccess);
    expect(allOutput).not.toContain(secretRefresh);
  });

  it('every file under mcp/fixtures/ is already redact-stable (redact() is a no-op on it)', () => {
    const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
    for (const name of readdirSync(fixturesDir)) {
      const raw = readFileSync(`${fixturesDir}${name}`, 'utf8');
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // non-JSON fixture — compare the raw text instead
      }
      const redacted = typeof parsed === 'string' ? redact(parsed) : redact(parsed);
      const redactedText =
        typeof parsed === 'string' ? (redacted as string) : JSON.stringify(redacted);
      const originalText = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      expect(redactedText, `${name} contains an unmasked token-shaped value`).toBe(originalText);
    }
  });
});

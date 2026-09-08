import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOW_TX_HASH_KEYS, REDACTION_PATTERNS, redact } from './redact.js';

// Fake / well-known test-only secrets. Never real credentials.
const OR_KEY = 'sk-or-v1-TESTONLYabcdef1234';
const GENERIC_KEY = 'sk-TESTONLYabcdefghijklmnop1234';
// Hardhat's well-known default account #0 private key (public fixture, not a real secret).
const HARDHAT_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ETH_ADDRESS = '0x00000000000000000000000000000000deadbeef'; // 40 hex chars, public
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.4Adcj3UFYzPUVaVF43FmMab6RlaQD8A9V8wFzzht-KQ';
const OPAQUE_BLOB = 'aGVsbG9UaGlzSXNBTG9uZ09wYXF1ZUJsb2JWYWx1ZTEyMzQ1Njc4OTA';
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ISO_DATE = '2026-09-08T12:34:56.789Z';

describe('REDACTION_PATTERNS', () => {
  it('is exported for direct pattern-level testing', () => {
    expect(REDACTION_PATTERNS.openRouterKey).toBeInstanceOf(RegExp);
    expect(REDACTION_PATTERNS.genericSecretKey).toBeInstanceOf(RegExp);
    expect(REDACTION_PATTERNS.bearerToken).toBeInstanceOf(RegExp);
    expect(REDACTION_PATTERNS.jwt).toBeInstanceOf(RegExp);
    expect(REDACTION_PATTERNS.privateKeyHex).toBeInstanceOf(RegExp);
    expect(REDACTION_PATTERNS.opaqueBlob).toBeInstanceOf(RegExp);
    expect(REDACTION_PATTERNS.sensitiveKeyName).toBeInstanceOf(RegExp);
  });
});

describe('redact() — positive cases (must mask)', () => {
  it('masks an OpenRouter/Orbio key to prefix + last4 (ticket AC1)', () => {
    expect(redact(OR_KEY)).toBe('sk-or-…1234');
  });

  it('masks a generic sk-... key to sk-…last4', () => {
    const out = redact(GENERIC_KEY) as string;
    expect(out.startsWith('sk-…')).toBe(true);
    expect(out).not.toContain(GENERIC_KEY.slice(3, -4));
  });

  it('fully masks a 0x-prefixed 64-hex private key to 0x…last4 (ticket AC1)', () => {
    const out = redact(HARDHAT_PK) as string;
    expect(out).toBe(`0x…${HARDHAT_PK.slice(-4)}`);
    expect(out).not.toContain(HARDHAT_PK.slice(2, -4));
  });

  it('masks the token in a Bearer header, keeping the scheme word', () => {
    const out = redact(`Authorization: Bearer ${OR_KEY}`) as string;
    expect(out.startsWith('Authorization: Bearer ')).toBe(true);
    expect(out).not.toContain(OR_KEY);
  });

  it('masks a Bearer token that is a long opaque blob', () => {
    const out = redact(`Bearer ${OPAQUE_BLOB}`) as string;
    expect(out).not.toContain(OPAQUE_BLOB);
    expect(out.startsWith('Bearer ')).toBe(true);
  });

  it('masks a JWT-looking triple to first4…last4', () => {
    const out = redact(JWT) as string;
    expect(out).not.toContain(JWT);
    expect(out).toMatch(/^.{4}….{4}$/);
  });

  it('masks a long opaque blob (>=32 chars) to first4…last4', () => {
    const out = redact(OPAQUE_BLOB) as string;
    expect(out).toBe(`${OPAQUE_BLOB.slice(0, 4)}…${OPAQUE_BLOB.slice(-4)}`);
  });

  it('masks a secret embedded in a URL query string', () => {
    const url = `https://api.orbio.dev/v1/status?api_key=${OR_KEY}&x=1`;
    const out = redact(url) as string;
    expect(out).not.toContain(OR_KEY);
    expect(out).toContain('sk-or-…1234');
    expect(out).toContain('&x=1');
  });

  it('masks a secret used as basic-auth userinfo in a URL', () => {
    const url = `postgres://user:${OPAQUE_BLOB}@db.internal:5432/app`;
    const out = redact(url) as string;
    expect(out).not.toContain(OPAQUE_BLOB);
    expect(out).toContain('user:');
    expect(out).toContain('@db.internal:5432/app');
  });

  it('masks a key embedded inside an error message', () => {
    const err = new Error(`upstream rejected key ${OR_KEY}`);
    const out = redact(err) as { message: string };
    expect(out.message).not.toContain(OR_KEY);
    expect(out.message).toContain('sk-or-…1234');
  });

  it('redacts an Error stack trace too', () => {
    const err = new Error(`bad token ${GENERIC_KEY}`);
    const out = redact(err) as { message: string; stack?: string; name: string };
    expect(out.name).toBe('Error');
    expect(out.stack).toBeDefined();
    expect(out.stack as string).not.toContain(GENERIC_KEY);
  });

  it('masks nested object values recursively', () => {
    const input = {
      user: { id: 'u1', auth: { header: `Bearer ${OR_KEY}` } },
      list: [OR_KEY, 'plain-word'],
    };
    const out = redact(input) as typeof input;
    expect(out.user.auth.header).toBe(`Bearer sk-or-…1234`);
    expect(out.list[0]).toBe('sk-or-…1234');
    expect(out.list[1]).toBe('plain-word');
  });

  it('masks values inside arrays', () => {
    const out = redact([OR_KEY, HARDHAT_PK]) as string[];
    expect(out[0]).toBe('sk-or-…1234');
    expect(out[1]).toBe(`0x…${HARDHAT_PK.slice(-4)}`);
  });

  it('masks any value under a key ending in _KEY regardless of shape', () => {
    const out = redact({ WALLET_PK: HARDHAT_PK }) as Record<string, unknown>;
    expect(out.WALLET_PK).not.toBe(HARDHAT_PK);
    expect(String(out.WALLET_PK)).not.toContain(HARDHAT_PK.slice(2, -4));
  });

  it('masks a short, otherwise-unrecognized value under _SECRET', () => {
    const out = redact({ CI_SECRET: 'short' }) as Record<string, unknown>;
    expect(out.CI_SECRET).not.toBe('short');
  });

  it('masks a nested object placed under a _TOKEN key entirely', () => {
    const out = redact({ SESSION_TOKEN: { raw: 'abc', exp: 123 } }) as Record<string, unknown>;
    expect(out.SESSION_TOKEN).toBe('[REDACTED]');
  });

  it('masks a value under a _PASSWORD key', () => {
    const out = redact({ DB_PASSWORD: 'hunter2rocks' }) as Record<string, unknown>;
    expect(out.DB_PASSWORD).not.toBe('hunter2rocks');
  });

  it('masks a value under an _API_KEY-suffixed key (still ends in _KEY)', () => {
    const out = redact({ OPENROUTER_API_KEY: OR_KEY }) as Record<string, unknown>;
    expect(out.OPENROUTER_API_KEY).toBe('sk-or-…1234');
  });
});

describe('redact() — negative cases (must NOT mask)', () => {
  it('leaves normal words untouched', () => {
    expect(redact('hello world, this is a normal log message')).toBe(
      'hello world, this is a normal log message',
    );
  });

  it('leaves short ids untouched', () => {
    expect(redact('agent-42')).toBe('agent-42');
    expect(redact('tick-7')).toBe('tick-7');
  });

  it('leaves a 0x…40-hex public address untouched', () => {
    expect(redact(ETH_ADDRESS)).toBe(ETH_ADDRESS);
  });

  it('leaves a UUID untouched', () => {
    expect(redact(UUID)).toBe(UUID);
  });

  it('leaves an ISO date untouched', () => {
    expect(redact(ISO_DATE)).toBe(ISO_DATE);
  });

  it('leaves plain numbers untouched', () => {
    expect(redact(123456789)).toBe(123456789);
    expect(redact({ amount_usd: 42.5 })).toEqual({ amount_usd: 42.5 });
  });

  it('leaves booleans, null and undefined untouched', () => {
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('does not mask a normal object key that merely contains, but does not end with, KEY', () => {
    const out = redact({ keyboard: 'plain-word' }) as Record<string, unknown>;
    expect(out.keyboard).toBe('plain-word');
  });
});

// --- Adversarial inputs from tasks/reports/T-003-audit-1.md (pass 1). Every one of
// these reproduced a leak or an uncaught throw against the pre-fix implementation;
// they must all pass now. ---

class WalletKeyHolder {
  constructor(public privateKey: string) {}
}

describe('redact() — adversarial cases from audit pass 1 (Blockers)', () => {
  it.each([
    ['SK-OR-V1-TESTONLYabcdef1234', 'mixed-case OpenRouter key (Blocker: case-sensitive patterns)'],
    ['Sk-Or-v1-TESTONLYabcdef1234', 'title-case OpenRouter key'],
  ])('masks a differently-cased sk-or key: %s (%s)', (input) => {
    const out = redact(input) as string;
    expect(out).not.toBe(input);
    expect(out).not.toContain('TESTONLYabcdef1234');
  });

  it('mixed-case key survives log-line round trip (not just redact() in isolation)', () => {
    // The audit's own repro (a 27-char fixture) is too short for the opaque-blob
    // fallback (>=32 chars) to save it — only case-insensitive pattern matching does.
    const fixture = 'SK-OR-V1-TESTONLYabcdef1234';
    expect(fixture.length).toBeLessThan(32);
    const out = redact({ rawHeader: fixture }) as Record<string, unknown>;
    expect(out.rawHeader).not.toBe(fixture);
    expect(String(out.rawHeader)).not.toContain('TESTONLYabcdef1234');
  });

  it('masks a class instance holding a private key (walks own enumerable props)', () => {
    const out = redact({ wallet: new WalletKeyHolder(OR_KEY) }) as {
      wallet: { privateKey: string };
    };
    expect(out.wallet.privateKey).toBe('sk-or-…1234');
  });

  it('replaces a Buffer with <bytes:N>, never the raw bytes', () => {
    const buf = Buffer.from(HARDHAT_PK);
    const out = redact({ keyBytes: buf }) as Record<string, unknown>;
    expect(out.keyBytes).toBe(`<bytes:${buf.byteLength}>`);
    expect(JSON.stringify(out)).not.toContain(HARDHAT_PK.slice(2, -4));
  });

  it('replaces a Uint8Array with <bytes:N>', () => {
    const bytes = new TextEncoder().encode(HARDHAT_PK);
    const out = redact(bytes) as string;
    expect(out).toBe(`<bytes:${bytes.byteLength}>`);
  });

  it('replaces a raw ArrayBuffer with <bytes:N>', () => {
    const ab = new ArrayBuffer(16);
    expect(redact(ab)).toBe('<bytes:16>');
  });

  it.each([
    ['apiKey', 'apiKey'],
    ['clientSecret', 'clientSecret'],
    ['dbPassword', 'dbPassword'],
    ['refreshToken', 'refreshToken'],
    ['walletMnemonic', 'mnemonic'],
    ['walletSeed', 'seed'],
    ['privateKey', 'privateKey'],
    ['pk', 'pk'],
  ])('masks a camelCase %s field regardless of value shape', (key) => {
    const value = 'short-secret-1234';
    const out = redact({ [key]: value }) as Record<string, unknown>;
    expect(out[key]).not.toBe(value);
  });

  it('camelCase key masking works case-insensitively too (APIKEY, ApiKey)', () => {
    expect((redact({ APIKEY: 'x-secret-value' }) as Record<string, unknown>).APIKEY).not.toBe(
      'x-secret-value',
    );
    expect((redact({ ApiKey: 'x-secret-value' }) as Record<string, unknown>).ApiKey).not.toBe(
      'x-secret-value',
    );
  });
});

describe('redact() — adversarial cases from audit pass 1 (Majors)', () => {
  it('replaces a circular reference with <circular> instead of throwing', () => {
    const circular: Record<string, unknown> = { agent: 'a1' };
    circular.self = circular;
    let out: unknown;
    expect(() => {
      out = redact(circular);
    }).not.toThrow();
    expect((out as Record<string, unknown>).self).toBe('<circular>');
  });

  it('handles a circular reference reached via an array too', () => {
    const arr: unknown[] = ['a1'];
    arr.push(arr);
    const out = redact(arr) as unknown[];
    expect(out[1]).toBe('<circular>');
  });

  it('stringifies BigInt instead of throwing', () => {
    expect(redact(123456789012345678901234567890n)).toBe('123456789012345678901234567890');
    const out = redact({ balanceWei: 123n }) as Record<string, unknown>;
    expect(out.balanceWei).toBe('123');
  });

  it('walks Error.cause, including a secret nested inside it', () => {
    const err = new Error('wrapper failed', {
      cause: new Error(`root cause leaked key ${OR_KEY}`),
    });
    const out = redact(err) as { cause: { message: string } };
    expect(out.cause).toBeDefined();
    expect(out.cause.message).not.toContain(OR_KEY);
    expect(out.cause.message).toContain('sk-or-…1234');
  });

  it('0x+64-hex is masked by default even under a hash-shaped key (fails closed)', () => {
    const out = redact({ txHash: HARDHAT_PK }) as Record<string, unknown>;
    expect(out.txHash).not.toBe(HARDHAT_PK);
  });

  it('allowTxHashKeys opts a key out of masking entirely, by name', () => {
    const out = redact(
      { txHash: HARDHAT_PK },
      { allowTxHashKeys: DEFAULT_ALLOW_TX_HASH_KEYS },
    ) as Record<string, unknown>;
    expect(out.txHash).toBe(HARDHAT_PK);
  });

  it('allowTxHashKeys matches case-insensitively and only the listed keys', () => {
    const out = redact(
      { TxHash: HARDHAT_PK, otherField: HARDHAT_PK },
      { allowTxHashKeys: DEFAULT_ALLOW_TX_HASH_KEYS },
    ) as Record<string, unknown>;
    expect(out.TxHash).toBe(HARDHAT_PK);
    expect(out.otherField).not.toBe(HARDHAT_PK);
  });
});

describe('redact() — other non-plain values (belt and braces)', () => {
  it('walks Map entries', () => {
    const out = redact(new Map([['apiKey', OR_KEY]])) as unknown[];
    expect(out).toEqual([['apiKey', 'sk-or-…1234']]);
  });

  it('walks Set values', () => {
    const out = redact(new Set([OR_KEY, 'plain'])) as unknown[];
    expect(out).toEqual(['sk-or-…1234', 'plain']);
  });

  it('converts a Date to its ISO string (not treated as a secret)', () => {
    const d = new Date('2026-09-08T12:00:00.000Z');
    expect(redact(d)).toBe('2026-09-08T12:00:00.000Z');
  });

  it('replaces a function with <fn>', () => {
    expect(redact(() => 'x')).toBe('<fn>');
  });

  it('replaces a symbol with <fn>', () => {
    expect(redact(Symbol('x'))).toBe('<fn>');
  });
});

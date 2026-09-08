/**
 * T-003 · Tester pass (PROCESS.md §2 step 3).
 *
 * Written from tasks/T-003.md's Goal / In scope / Acceptance criteria and PRD §11 /
 * FR-2.1 alone, attacker-style: try to get a fake secret into a log line via every
 * vector I can think of (msg, ctx at depth, URLs, Error message/stack/cause,
 * Map/Set/class/Buffer, mixed case, JSON-string blobs), plus robustness (circular,
 * BigInt, throwing getter, 1MB/200ms) and false positives that must survive
 * (address, UUID, ISO date, txHash). Read redact.ts/log.ts and redact.test.ts/
 * log.test.ts only after drafting this list — most of it was already covered there;
 * this file adds only what wasn't: log()-level round trips for Bearer/JWT/Hardhat-PK,
 * deep nesting, JSON-string-embedded secrets, a path-segment URL, a numeric-blob false
 * positive, a combined "kitchen sink" grep, and the 1MB/200ms perf budget.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from './log.js';
import { redact } from './redact.js';

// Fake / well-known test-only secrets — never real credentials.
const OR_KEY = 'sk-or-v1-TESTONLYabcdef1234';
const HARDHAT_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FAKE_BEARER = 'Bearer sk-or-v1-TESTONLYabcdef1234';
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.4Adcj3UFYzPUVaVF43FmMab6RlaQD8A9V8wFzzht-KQ';

function withStderrSpy(fn: (raw: () => string) => void): void {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    fn(() => spy.mock.calls.map((c) => c[0] as string).join('\n'));
  } finally {
    spy.mockRestore();
  }
}

describe('T-003 tester — log() round trips for each fixture secret type (AC3)', () => {
  it('a Hardhat #0 private key never survives a log() call, via ctx', () => {
    withStderrSpy((raw) => {
      log('error', 'signing failed', { wallet: HARDHAT_PK });
      expect(raw()).not.toContain(HARDHAT_PK);
      expect(raw()).not.toContain(HARDHAT_PK.slice(2, -4)); // no partial leak either
      expect(() => JSON.parse(raw())).not.toThrow();
    });
  });

  it('a Hardhat #0 private key never survives a log() call, interpolated into msg', () => {
    withStderrSpy((raw) => {
      log('error', `refusing to sign with ${HARDHAT_PK}`);
      expect(raw()).not.toContain(HARDHAT_PK);
      const parsed = JSON.parse(raw());
      expect(parsed.msg).not.toContain(HARDHAT_PK);
    });
  });

  it('a fake Bearer token never survives a log() call (scheme word kept, token masked)', () => {
    withStderrSpy((raw) => {
      log('info', 'calling upstream', { authHeader: FAKE_BEARER });
      expect(raw()).not.toContain(OR_KEY);
      const parsed = JSON.parse(raw());
      expect(parsed.authHeader).toContain('Bearer');
      expect(parsed.authHeader).not.toContain(OR_KEY);
    });
  });

  it('a fake JWT never survives a log() call', () => {
    withStderrSpy((raw) => {
      log('info', 'session established', { sessionToken: FAKE_JWT });
      expect(raw()).not.toContain(FAKE_JWT);
      const parsed = JSON.parse(raw());
      expect(parsed.sessionToken).not.toBe(FAKE_JWT);
      expect(parsed.sessionToken).not.toContain(FAKE_JWT.slice(0, 20));
    });
  });

  it('a fake JWT embedded directly in msg never survives a log() call', () => {
    withStderrSpy((raw) => {
      log('warn', `rejected stale session ${FAKE_JWT}`);
      expect(raw()).not.toContain(FAKE_JWT);
    });
  });
});

describe('T-003 tester — nesting depth and container combinations', () => {
  it('masks a secret nested 5 levels deep in ctx', () => {
    const ctx = { a: { b: { c: { d: { e: OR_KEY } } } } };
    const out = redact(ctx) as {
      a: { b: { c: { d: { e: string } } } };
    };
    expect(out.a.b.c.d.e).toBe('sk-or-…1234');
  });

  it('masks a secret nested 5 levels deep through a real log() call', () => {
    withStderrSpy((raw) => {
      log('info', 'deep ctx', { a: { b: { c: { d: { e: OR_KEY } } } } });
      expect(raw()).not.toContain(OR_KEY);
    });
  });

  it('kitchen sink: Map + Set + class instance + array + Buffer + Error, four secret types together, none leak', () => {
    class WalletKeyHolder {
      constructor(public privateKey: string) {}
    }
    const payload = {
      keys: new Map([['primary', OR_KEY]]),
      seen: new Set([HARDHAT_PK]),
      wallet: new WalletKeyHolder(HARDHAT_PK),
      history: [FAKE_BEARER, FAKE_JWT],
      raw: Buffer.from(HARDHAT_PK),
      failure: new Error(`upstream said ${OR_KEY}`, { cause: new Error(`root: ${FAKE_JWT}`) }),
    };
    withStderrSpy((raw) => {
      log('error', 'catastrophic dump', payload);
      const text = raw();
      expect(text).not.toContain(OR_KEY);
      expect(text).not.toContain(HARDHAT_PK);
      expect(text).not.toContain(HARDHAT_PK.slice(2, -4));
      expect(text).not.toContain(FAKE_JWT);
      expect(() => JSON.parse(text)).not.toThrow();
    });
  });
});

describe('T-003 tester — secrets in URLs and JSON-string blobs', () => {
  it('masks a private-key-shaped value inside a URL path segment (not just query/userinfo)', () => {
    const url = `https://explorer.example/tx/${HARDHAT_PK}/confirm`;
    const out = redact(url) as string;
    expect(out).not.toContain(HARDHAT_PK);
    expect(out).toContain('/confirm');
  });

  it('masks a secret embedded inside a JSON.stringify()-ed blob passed as a log string', () => {
    const blob = JSON.stringify({ apiKey: OR_KEY, note: 'rotate soon' });
    withStderrSpy((raw) => {
      log('info', 'received webhook payload', { body: blob });
      expect(raw()).not.toContain(OR_KEY);
    });
  });

  it('masks a Bearer-prefixed secret buried inside a larger JSON-string ctx value', () => {
    const blob = JSON.stringify({ headers: { authorization: FAKE_BEARER }, ok: true });
    const out = redact({ debugDump: blob }) as Record<string, unknown>;
    expect(String(out.debugDump)).not.toContain(OR_KEY);
  });
});

describe('T-003 tester — false positives that must survive (attacker cannot use these to hide real leaks under noise)', () => {
  it('does not mask a 0x + 40-hex public address, including through log()', () => {
    const address = '0x00000000000000000000000000000000deadbeef';
    withStderrSpy((raw) => {
      log('info', 'transfer to', { to: address });
      const parsed = JSON.parse(raw());
      expect(parsed.to).toBe(address);
    });
  });

  it('does not mask a UUID', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(redact({ requestId: id })).toEqual({ requestId: id });
  });

  it('does not mask an ISO date string', () => {
    const iso = '2026-09-08T12:34:56.789Z';
    expect(redact({ as_of: iso })).toEqual({ as_of: iso });
  });

  it('does not mask a long all-digit blob (e.g. an invoice/order number), 32+ digits', () => {
    const invoice = '12345678901234567890123456789012';
    expect(invoice.length).toBeGreaterThanOrEqual(32);
    expect(redact(invoice)).toBe(invoice);
  });

  it('does not mask a tx hash under an allow-listed key name, via a real log() call', () => {
    withStderrSpy((raw) => {
      log('info', 'stake confirmed', { txHash: HARDHAT_PK });
      const parsed = JSON.parse(raw());
      expect(parsed.txHash).toBe(HARDHAT_PK);
    });
  });

  it('does not mask a tx hash under a non-default key name that merely contains "hash"', () => {
    // `transactionHash` is on the default allow-list; a lookalike key that isn't
    // should still fail closed (masked), proving the allow-list is exact-match, not fuzzy.
    const out = redact(
      { transactionHashish: HARDHAT_PK },
      { allowTxHashKeys: ['txHash', 'hash', 'transactionHash'] },
    ) as Record<string, unknown>;
    expect(out.transactionHashish).not.toBe(HARDHAT_PK);
  });
});

describe('T-003 tester — robustness budget', () => {
  it('redacts a 1MB string containing an embedded secret in under 200ms', () => {
    const padding = 'x'.repeat(1_000_000);
    const input = `${padding} ${OR_KEY} ${padding}`;
    const start = performance.now();
    const out = redact(input) as string;
    const elapsed = performance.now() - start;
    expect(out).not.toContain(OR_KEY);
    expect(elapsed).toBeLessThan(200);
  });

  it('a 1MB ctx value logs in under 200ms and does not leak the embedded secret', () => {
    withStderrSpy((raw) => {
      const big = 'y'.repeat(1_000_000);
      const start = performance.now();
      log('info', 'large payload', { blob: `${big}${OR_KEY}${big}` });
      const elapsed = performance.now() - start;
      expect(raw()).not.toContain(OR_KEY);
      expect(elapsed).toBeLessThan(200);
    });
  });
});

describe('T-003 tester — FR-2.1: grep across many log() calls finds no secret material', () => {
  it('none of four distinct fixture secret shapes appear anywhere in accumulated stderr output', () => {
    withStderrSpy((raw) => {
      log('info', 'created key', { key: OR_KEY });
      log('warn', `refusing raw signer ${HARDHAT_PK}`);
      log('error', 'auth failed', { header: FAKE_BEARER });
      log('info', 'session', { token: FAKE_JWT });
      const combined = raw();
      for (const secret of [OR_KEY, HARDHAT_PK, FAKE_JWT]) {
        expect(combined).not.toContain(secret);
      }
      expect(combined).not.toContain(OR_KEY); // FAKE_BEARER's token half
      for (const line of combined.split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});

/**
 * Tests for caller auth (S-01, ticket: `Authorization: Bearer otk_<32 hex>`, `GATEWAY_KEYS`,
 * sha256-hashed at boot, compared by hash).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { authenticateBearer, EnvCallerKeyStore, hashKey, isValidKeyShape } from './keys.js';

const VALID_KEY_A = `otk_${'a'.repeat(32)}`;
const VALID_KEY_B = `otk_${'b'.repeat(32)}`;

describe('isValidKeyShape()', () => {
  it('accepts otk_ + exactly 32 hex chars', () => {
    expect(isValidKeyShape(VALID_KEY_A)).toBe(true);
  });

  it('rejects a short key, a long key, and a non-hex key', () => {
    expect(isValidKeyShape('otk_abc')).toBe(false);
    expect(isValidKeyShape(`otk_${'a'.repeat(33)}`)).toBe(false);
    expect(isValidKeyShape(`otk_${'z'.repeat(32)}`)).toBe(false);
  });

  it('rejects a key missing the otk_ prefix', () => {
    expect(isValidKeyShape('a'.repeat(32))).toBe(false);
  });
});

describe('hashKey()', () => {
  it('is a plain sha256 hex digest', () => {
    expect(hashKey(VALID_KEY_A)).toBe(
      createHash('sha256').update(VALID_KEY_A, 'utf8').digest('hex'),
    );
  });

  it('two different keys hash differently', () => {
    expect(hashKey(VALID_KEY_A)).not.toBe(hashKey(VALID_KEY_B));
  });
});

describe('EnvCallerKeyStore', () => {
  it('looks a registered key up by its hash', () => {
    const store = new EnvCallerKeyStore(VALID_KEY_A);
    const found = store.lookup(hashKey(VALID_KEY_A));
    expect(found).not.toBeNull();
    expect(found?.agentId).toBeNull();
    expect(found?.keyId).toMatch(/^key_[0-9a-f]{16}$/);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    const store = new EnvCallerKeyStore(` ${VALID_KEY_A} , ${VALID_KEY_B} `);
    expect(store.lookup(hashKey(VALID_KEY_A))).not.toBeNull();
    expect(store.lookup(hashKey(VALID_KEY_B))).not.toBeNull();
  });

  it('returns null for a key hash it was never given', () => {
    const store = new EnvCallerKeyStore(VALID_KEY_A);
    expect(store.lookup(hashKey(VALID_KEY_B))).toBeNull();
  });

  it('skips a malformed entry instead of throwing at boot', () => {
    expect(() => new EnvCallerKeyStore(`not-a-key,${VALID_KEY_A}`)).not.toThrow();
    const store = new EnvCallerKeyStore(`not-a-key,${VALID_KEY_A}`);
    expect(store.lookup(hashKey(VALID_KEY_A))).not.toBeNull();
  });

  it('boots empty (every lookup null) for undefined/empty GATEWAY_KEYS', () => {
    expect(new EnvCallerKeyStore(undefined).lookup(hashKey(VALID_KEY_A))).toBeNull();
    expect(new EnvCallerKeyStore('').lookup(hashKey(VALID_KEY_A))).toBeNull();
  });

  it('two distinct valid keys get two distinct keyIds', () => {
    const store = new EnvCallerKeyStore(`${VALID_KEY_A},${VALID_KEY_B}`);
    const a = store.lookup(hashKey(VALID_KEY_A));
    const b = store.lookup(hashKey(VALID_KEY_B));
    expect(a?.keyId).not.toBe(b?.keyId);
  });
});

describe('authenticateBearer()', () => {
  const store = new EnvCallerKeyStore(VALID_KEY_A);

  it('authenticates a well-formed, registered Bearer header', () => {
    const result = authenticateBearer(`Bearer ${VALID_KEY_A}`, store);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBeNull();
  });

  it('returns null for a missing header', () => {
    expect(authenticateBearer(null, store)).toBeNull();
    expect(authenticateBearer(undefined, store)).toBeNull();
  });

  it('returns null for a header missing the Bearer scheme', () => {
    expect(authenticateBearer(VALID_KEY_A, store)).toBeNull();
  });

  it('returns null for a well-shaped but unregistered key', () => {
    expect(authenticateBearer(`Bearer ${VALID_KEY_B}`, store)).toBeNull();
  });

  it('returns null for a malformed token after Bearer', () => {
    expect(authenticateBearer('Bearer not-a-key', store)).toBeNull();
  });
});

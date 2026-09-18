/**
 * Caller auth (S-01, ticket: `Authorization: Bearer otk_<32 hex>`, valid keys from env
 * `GATEWAY_KEYS`, hashed with sha256 at boot and compared by hash).
 *
 * `CallerKeyStore` is the seam: this ticket ships `EnvCallerKeyStore` (`GATEWAY_KEYS`); the DB
 * implementation lands in S-02/S-06 behind the same interface. Only the sha256 hash of a key is
 * ever kept in memory or compared — the raw key never reaches a log line or a data structure that
 * outlives the request (CLAUDE.md #4).
 */
import { createHash } from 'node:crypto';

/** `otk_` followed by exactly 32 hex characters. */
const OTK_SHAPE_RE = /^otk_[0-9a-fA-F]{32}$/;
const BEARER_RE = /^Bearer\s+(\S+)$/;

export interface CallerKeyLookup {
  readonly keyId: string;
  readonly agentId: string | null;
}

export interface CallerKeyStore {
  lookup(hash: string): CallerKeyLookup | null;
}

/** sha256 hex digest of `key`, used both to build the store and to look a caller's key up in it. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** True only for the exact `otk_<32 hex>` shape — this is checked before any hashing/lookup so a
 *  malformed `Authorization` header never even reaches the key store. */
export function isValidKeyShape(key: string): boolean {
  return OTK_SHAPE_RE.test(key);
}

/**
 * `GATEWAY_KEYS`-backed `CallerKeyStore`. Parses the comma-separated list once at construction
 * ("hashed with sha256 at boot"); entries that don't match the `otk_<32 hex>` shape are skipped
 * (never included, never logged) rather than causing a boot-time throw — a hackathon operator
 * typo in one key shouldn't take every other key down with it.
 *
 * `keyId` is the key's own hash, truncated to 16 hex chars — stable, derivable from the key alone
 * (no separate id needed for an env-sourced store), and never long enough to be mistaken for the
 * key itself. `agentId` is always `null` here; per-key agent association is a DB-store feature
 * (S-02/S-06).
 */
export class EnvCallerKeyStore implements CallerKeyStore {
  private readonly byHash: ReadonlyMap<string, CallerKeyLookup>;

  constructor(gatewayKeys: string | undefined | null) {
    const map = new Map<string, CallerKeyLookup>();
    for (const raw of (gatewayKeys ?? '').split(',')) {
      const key = raw.trim();
      if (!key || !isValidKeyShape(key)) continue;
      const hash = hashKey(key);
      map.set(hash, { keyId: `key_${hash.slice(0, 16)}`, agentId: null });
    }
    this.byHash = map;
  }

  lookup(hash: string): CallerKeyLookup | null {
    return this.byHash.get(hash) ?? null;
  }
}

/**
 * Authenticates one request's `Authorization` header against `store`. Returns `null` for a
 * missing header, a header that isn't `Bearer otk_<32 hex>`, or a well-shaped key the store
 * doesn't recognise — the route handler maps every `null` to the same 401, so a caller can't
 * distinguish "malformed" from "unknown" (CLAUDE.md #4: don't leak which keys almost worked).
 */
export function authenticateBearer(
  authorizationHeader: string | null | undefined,
  store: CallerKeyStore,
): CallerKeyLookup | null {
  if (!authorizationHeader) return null;
  const match = BEARER_RE.exec(authorizationHeader);
  if (!match) return null;
  const token = match[1] as string;
  if (!isValidKeyShape(token)) return null;
  return store.lookup(hashKey(token));
}

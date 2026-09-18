/**
 * Small helpers shared by both LedgerStore implementations (T-011).
 *
 * IDs are generated here, client-side, for *both* dialects — even though Postgres could default
 * `id` to `gen_random_uuid()` itself (see supabase/migrations/001_schema.sql). Generating them
 * identically in both stores means "how the id was produced" never becomes a dialect-specific
 * behaviour that could leak above the LedgerStore interface (T-011 Audit focus).
 */
import { randomUUID } from 'node:crypto';
import type { Id } from './types.js';
import { InvalidTxHashError } from './types.js';

export function newId(): Id {
  return randomUUID();
}

const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Throws unless `value` is a UTC ISO-8601 timestamp (must end in "Z" — no bare offsets, no
 * local time). Ledger business timestamps (`as_of`, `at`, `placed_at`, ...) are an input
 * supplied by the caller, never read from a clock inside the store — this just guards that
 * whatever was supplied is actually UTC, per CLAUDE.md / audit focus "UTC everywhere".
 */
export function assertUtcIso(value: string, field: string): void {
  if (!UTC_ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${field} must be a UTC ISO-8601 timestamp ending in "Z", got: ${JSON.stringify(value)}`,
    );
  }
}

const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * S-02 AC4: `treasury_events.tx_hash` is validated at the store boundary (both dialects), not by
 * a DB CHECK — a regex CHECK isn't portable between Postgres (`~`) and SQLite. Throws
 * InvalidTxHashError on anything that isn't exactly `^0x[0-9a-f]{64}$` (lowercase hex only —
 * matches how api-notes.md and every recorded fixture format a Robinhood Chain tx hash).
 */
export function assertTxHash(value: string): void {
  if (!TX_HASH_RE.test(value)) {
    throw new InvalidTxHashError(value);
  }
}

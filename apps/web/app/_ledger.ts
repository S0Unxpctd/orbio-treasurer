/**
 * Shared `LedgerStore` wiring for the public page and `/api/stats`, `/api/agents` (S-08). Not a
 * route itself — leading underscore, same convention as `app/v1/_gateway.ts`.
 *
 * One store per distinct connection descriptor, cached across requests in this process (same
 * pattern as `_gateway.ts`'s `getKeyStore`/`getCatalog`), so a warm serverless instance doesn't
 * re-open a SQLite file or a Postgres pool on every request. Tests reset the cache explicitly.
 */
import {
  type Env,
  type LedgerStore,
  openPostgresLedger,
  openSqliteLedger,
} from '@orbio-treasurer/core';

let cached: { readonly key: string; readonly store: LedgerStore } | null = null;

/**
 * Throws a plain `Error` (name only, never a value — CLAUDE.md #4) when `LEDGER=postgres` but
 * neither `DATABASE_URL` is set — `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` alone describe a
 * Supabase project, not a `postgres://` connection string `PostgresLedgerStore` can open (see
 * tasks/S-08.md Discovered). The route handlers turn this into a safe 500, never a crash.
 */
export function getLedgerStore(env: Env): LedgerStore {
  if (env.LEDGER === 'postgres') {
    if (!env.DATABASE_URL) {
      throw new Error(
        'LEDGER=postgres requires DATABASE_URL (a postgres:// connection string) — ' +
          'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY alone are not enough for this store',
      );
    }
    const key = `postgres:${env.DATABASE_URL}`;
    if (cached?.key === key) return cached.store;
    const store = openPostgresLedger(env.DATABASE_URL);
    cached = { key, store };
    return store;
  }

  const key = `sqlite:${env.LEDGER_SQLITE_PATH}`;
  if (cached?.key === key) return cached.store;
  const store = openSqliteLedger(env.LEDGER_SQLITE_PATH);
  cached = { key, store };
  return store;
}

/** Test-only: drops the cached store so a test using a fresh temp path/env doesn't see a stale
 *  one (same role as `_gateway.ts`'s `resetCatalogCacheForTesting`). */
export function resetLedgerStoreForTesting(): void {
  cached = null;
}

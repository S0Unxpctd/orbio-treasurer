/**
 * Shared wiring for the `/v1/*` gateway route handlers (S-01). Not a route itself — the leading
 * underscore keeps Next's App Router from treating this directory entry as one.
 *
 * Everything here is a small, request-agnostic singleton built from `loadEnv()`: the caller key
 * store (env `GATEWAY_KEYS`), the call recorder, and a per-base-URL cached catalog fetcher
 * (ticket: "the model catalog ... cached ≤10 min by the route handler"). `route()` itself stays
 * pure in `@orbio-treasurer/core`; everything in this file is the I/O apps/web is responsible for.
 */
import {
  authenticateBearer,
  type CallerKeyLookup,
  type CallerKeyStore,
  type CallRecorder,
  createCachedCatalogFetcher,
  type Env,
  EnvCallerKeyStore,
  type FetchedCatalog,
  fetchModelCatalog,
  getUpstreamKey,
  hashKey,
  isValidKeyShape,
  JsonlStdoutCallRecorder,
  LedgerCallRecorder,
  type LedgerStore,
  loadEnv,
  MODES,
  type Mode,
  RouterToLedgerCallRecorder,
} from '@orbio-treasurer/core';

import { getLedgerStore } from '../_ledger.js';

export function getEnv(): Env {
  return loadEnv();
}

/** Resolves (creating if missing, same convention as `tick/tick.ts`'s `runTick()`) the reference
 *  Treasurer agent's row — the one `getMode()`/`getRecorder()`/`resolveCaller()` below all key
 *  off. Cached per store (a `WeakMap`, so a fresh store from `resetLedgerStoreForTesting()` never
 *  sees a stale agent id from a previous test's store instance). */
const referenceAgentIdByStore = new WeakMap<LedgerStore, string>();
async function getReferenceAgentId(env: Env, store: LedgerStore): Promise<string> {
  const cached = referenceAgentIdByStore.get(store);
  if (cached) return cached;
  let agent = await store.getAgentBySlug(env.REFERENCE_AGENT_SLUG);
  if (!agent) {
    agent = await store.insertAgent({
      slug: env.REFERENCE_AGENT_SLUG,
      name: 'Orbio Treasurer',
      mode: 'dry_run',
    });
  }
  referenceAgentIdByStore.set(store, agent.id);
  return agent.id;
}

// Test-only override so `apps/web/app/v1/**/route.test.ts` can inspect the records a request
// produced with an `InMemoryCallRecorder`, instead of scraping stdout for JSONL lines. Checked
// FIRST in `getRecorder()`, before anything ledger-related — a test that sets this override never
// causes a ledger store to even be opened (S-01's existing test suites never set `LEDGER_*`, so
// they must never touch the ledger path at all; see tasks/S-06.md Build notes).
let recorderOverride: CallRecorder | null = null;
export function setRecorderForTesting(recorder: CallRecorder | null): void {
  recorderOverride = recorder;
}

let defaultRecorder: CallRecorder | null = null;
const ledgerRecordersByStore = new WeakMap<LedgerStore, CallRecorder>();

/**
 * S-06 (tasks/S-06.md "In scope"): "replace the JSONL/in-memory recorder with S-02's
 * `LedgerCallRecorder` when a ledger is configured". The kit's ledger is *always* configured
 * (LEDGER defaults to `sqlite`, CLAUDE.md #5c — no DB account needed) — so this is the recorder
 * for every real deployment; `JsonlStdoutCallRecorder` remains only as the fallback for a
 * genuinely broken ledger config (`LEDGER=postgres` with no `DATABASE_URL`), so a misconfigured
 * env degrades to "logged, not persisted" rather than 500ing every gateway call.
 */
export async function getRecorder(env: Env): Promise<CallRecorder> {
  if (recorderOverride) return recorderOverride;
  try {
    const store = getLedgerStore(env);
    let recorder = ledgerRecordersByStore.get(store);
    if (!recorder) {
      const fallbackAgentId = await getReferenceAgentId(env, store);
      recorder = new RouterToLedgerCallRecorder(new LedgerCallRecorder(store), fallbackAgentId);
      ledgerRecordersByStore.set(store, recorder);
    }
    return recorder;
  } catch {
    if (!defaultRecorder) defaultRecorder = new JsonlStdoutCallRecorder();
    return defaultRecorder;
  }
}

const keyStoresByGatewayKeys = new Map<string, CallerKeyStore>();
export function getKeyStore(env: Env): CallerKeyStore {
  const raw = env.GATEWAY_KEYS ?? '';
  let store = keyStoresByGatewayKeys.get(raw);
  if (!store) {
    store = new EnvCallerKeyStore(env.GATEWAY_KEYS);
    keyStoresByGatewayKeys.set(raw, store);
  }
  return store;
}

/**
 * S-06 (tasks/S-06.md "In scope"): "Caller keys: `CallerKeyStore` backed by S-02's
 * `getCallerKeyByHash` when a ledger is configured, env keys still accepted as a fallback."
 *
 * `router/keys.ts`'s `CallerKeyStore.lookup()` is deliberately synchronous (S-01, unchanged by
 * this ticket — every existing S-01 test calls it directly and expects a plain value back, not a
 * `Promise`); a ledger lookup is necessarily async, so this is a NEW function, not a change to
 * that interface or to `authenticateBearer()`. It tries the ledger's real `caller_keys` row
 * first (a real UUID `keyId` — required for `recorder-adapter.ts`'s `isLedgerRowId()` gate to
 * forward it as `usage_events.caller_key_id`), then falls back to the unchanged
 * `authenticateBearer()`/`EnvCallerKeyStore` path for a `GATEWAY_KEYS`-issued key that was never
 * inserted into the ledger. Audit focus: "caller-key lookup timing (hash compare, no key
 * logged)" — `hashKey()` is the same sha256 S-01 already uses, and neither the raw key nor its
 * hash is ever logged here (only the resolved `keyId`, in the router's own recorder).
 */
export async function resolveCaller(
  env: Env,
  authorizationHeader: string | null,
): Promise<CallerKeyLookup | null> {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(\S+)$/.exec(authorizationHeader);
  if (!match) return null;
  const token = match[1] as string;
  if (!isValidKeyShape(token)) return null;
  const hash = hashKey(token);

  try {
    const store = getLedgerStore(env);
    const row = await store.getCallerKeyByHash(hash);
    // `getCallerKeyByHash()` returns a revoked row unfiltered (it's a plain lookup by hash, not
    // an auth check) — a revoked key must 401 exactly like an unknown one (CLAUDE.md #4 spirit:
    // revocation that doesn't actually stop the key from working is worse than no revocation).
    if (row && row.revokedAt === null) return { keyId: row.id, agentId: row.agentId };
  } catch {
    // Ledger unavailable/misconfigured — fall through to the env-backed store below rather than
    // failing the whole request; `getRecorder()`/`getMode()` degrade the same way.
  }

  return authenticateBearer(authorizationHeader, getKeyStore(env));
}

const MODE_CACHE_TTL_MS = 60_000;
let modeCache: { readonly mode: Mode; readonly at: number } | null = null;

/** Test-only: drops the 60s mode cache so a test that seeds a new `chain_snapshots` row doesn't
 *  have to wait out the TTL (same role as `resetCatalogCacheForTesting()`). */
export function resetModeCacheForTesting(): void {
  modeCache = null;
}

/**
 * S-06 (tasks/S-06.md "In scope"): "`_gateway.ts` reads the current mode from
 * `latestChainSnapshot(referenceAgent).mode` (cached 60s) instead of `TREASURER_MODE` env; env
 * still wins if set (for tests)." `TREASURER_MODE` has a schema default (`'normal'`, `env.ts`),
 * so "set" here means set in the actual process environment, not merely present on the parsed
 * `Env` — checked against `process.env` directly (the same source `getEnv()`/`loadEnv()` read)
 * so a value that only exists because of the zod default never masks the ledger-driven mode.
 * Audit focus: "mode cache staleness on the router" — the cache is keyed on wall-clock time only
 * (60s TTL), not on any request identity, exactly per the ticket's own wording.
 */
export async function getMode(env: Env): Promise<Mode> {
  if (process.env.TREASURER_MODE) return env.TREASURER_MODE;

  const now = Date.now();
  if (modeCache && now - modeCache.at < MODE_CACHE_TTL_MS) return modeCache.mode;

  try {
    const store = getLedgerStore(env);
    const agentId = await getReferenceAgentId(env, store);
    const snapshot = await store.latestChainSnapshot(agentId);
    const storedMode = snapshot?.mode;
    // Defensive: only a `Mode` value from `MODES` is ever trusted off a stored row — a
    // corrupted/foreign value falls back to the schema default rather than being cast blindly.
    const mode = (MODES as readonly string[]).includes(storedMode ?? '')
      ? (storedMode as Mode)
      : env.TREASURER_MODE;
    modeCache = { mode, at: now };
    return mode;
  } catch {
    // Ledger unavailable/misconfigured — fall back to the schema default rather than failing the
    // request; never cached, so a transient failure doesn't pin the router to 'normal' for 60s.
    return env.TREASURER_MODE;
  }
}

export function getRouterAllowList(env: Env): readonly string[] | undefined {
  const raw = env.ROUTER_ALLOW;
  if (!raw) return undefined;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/** Throws a plain `Error` (never logged with a value) if `ORBIO_GATEWAY_BASE_URL` isn't set — the
 *  route handlers turn that into a safe 500 config error. */
export function getGatewayBaseUrl(env: Env): string {
  if (!env.ORBIO_GATEWAY_BASE_URL) {
    throw new Error('ORBIO_GATEWAY_BASE_URL is not set');
  }
  return env.ORBIO_GATEWAY_BASE_URL;
}

const catalogFetchersByBaseUrl = new Map<string, () => Promise<FetchedCatalog>>();

/** ≤10 min TTL cache, one entry per distinct `ORBIO_GATEWAY_BASE_URL` seen so far (in practice,
 *  one — but tests spin up a fresh fake upstream per test and must not share a cached catalog
 *  across them). */
export function getCatalog(env: Env): Promise<FetchedCatalog> {
  const baseUrl = getGatewayBaseUrl(env);
  let fetcher = catalogFetchersByBaseUrl.get(baseUrl);
  if (!fetcher) {
    fetcher = createCachedCatalogFetcher(async () =>
      fetchModelCatalog(baseUrl, await getUpstreamKey(env)),
    );
    catalogFetchersByBaseUrl.set(baseUrl, fetcher);
  }
  return fetcher();
}

/** Test-only: drops every cached catalog fetcher so a test that reuses a base URL (or restarts a
 *  fake upstream on the same port) doesn't see a stale one. */
export function resetCatalogCacheForTesting(): void {
  catalogFetchersByBaseUrl.clear();
}

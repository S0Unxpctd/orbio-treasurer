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
  type CallerKeyStore,
  type CallRecorder,
  createCachedCatalogFetcher,
  type Env,
  EnvCallerKeyStore,
  type FetchedCatalog,
  fetchModelCatalog,
  getUpstreamKey,
  JsonlStdoutCallRecorder,
  loadEnv,
} from '@orbio-treasurer/core';

export function getEnv(): Env {
  return loadEnv();
}

// Test-only override so `apps/web/app/v1/**/route.test.ts` can inspect the records a request
// produced with an `InMemoryCallRecorder`, instead of scraping stdout for JSONL lines.
let recorderOverride: CallRecorder | null = null;
export function setRecorderForTesting(recorder: CallRecorder | null): void {
  recorderOverride = recorder;
}

let defaultRecorder: CallRecorder | null = null;
export function getRecorder(): CallRecorder {
  if (recorderOverride) return recorderOverride;
  if (!defaultRecorder) defaultRecorder = new JsonlStdoutCallRecorder();
  return defaultRecorder;
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
    fetcher = createCachedCatalogFetcher(() => fetchModelCatalog(baseUrl, getUpstreamKey(env)));
    catalogFetchersByBaseUrl.set(baseUrl, fetcher);
  }
  return fetcher();
}

/** Test-only: drops every cached catalog fetcher so a test that reuses a base URL (or restarts a
 *  fake upstream on the same port) doesn't see a stale one. */
export function resetCatalogCacheForTesting(): void {
  catalogFetchersByBaseUrl.clear();
}

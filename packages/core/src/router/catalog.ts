/**
 * The Orbio model catalog (S-01, ticket: "the model catalog (from `/models`, cached ≤10 min by
 * the route handler)"). Fetches `${ORBIO_GATEWAY_BASE_URL}/models`, validates it with Zod
 * (CLAUDE.md #6), and exposes a small TTL cache the route handlers share.
 *
 * Not part of `route.ts`'s pure surface — this file does real I/O (fetch, and, for the cache, the
 * clock) — but every value `route()` reads (a `ModelCatalogEntry[]`) is produced here from a
 * validated upstream shape.
 */
import { z } from 'zod';

import { AdapterShapeError } from './errors.js';
import type { ModelCatalogEntry } from './types.js';

/** Tolerant of every extra field a real Orbio catalog entry carries — only `id` and the two
 *  per-token prices this router depends on are required (CLAUDE.md #6: unknown fields tolerated,
 *  missing required fields fatal). */
const modelCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    pricing: z
      .object({
        prompt: z.coerce.number(),
        completion: z.coerce.number(),
      })
      .passthrough(),
  })
  .passthrough();

const modelsResponseSchema = z
  .object({
    data: z.array(modelCatalogEntrySchema),
  })
  .passthrough();

export type ModelsResponse = z.infer<typeof modelsResponseSchema>;

export interface FetchedCatalog {
  /** The full, validated `/models` body — `/v1/models` proxies this, plus the `auto*` entries. */
  readonly raw: ModelsResponse;
  /** Just the fields `route()`/`baseline.ts` need. */
  readonly entries: readonly ModelCatalogEntry[];
}

/**
 * `GET ${baseUrl}/models` with `Authorization: Bearer ${upstreamKey}`. Throws `AdapterShapeError`
 * (source `"models_catalog"`) if the body doesn't parse — a catalog the router can't read is a
 * fatal boot/refresh condition, per CLAUDE.md #6 ("tick fails loudly"), not a degraded-but-servable
 * one like a single call's missing `usage`.
 */
export async function fetchModelCatalog(
  baseUrl: string,
  upstreamKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedCatalog> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${upstreamKey}` },
  });
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = modelsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AdapterShapeError(
      'models_catalog',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      redactSample(body),
    );
  }
  const entries: ModelCatalogEntry[] = parsed.data.data.map((d) => ({
    id: d.id,
    pricing: { prompt: d.pricing.prompt, completion: d.pricing.completion },
  }));
  return { raw: parsed.data, entries };
}

// Local, minimal redaction for the shape-error sample — avoids a hard dependency of this fetch
// path on the full `redact()` tree while still never logging an upstream body verbatim raw. The
// route handler's own logging goes through the real `redact()` from `../redact.js`; this is only
// the fallback attached to the thrown error itself when parsing fails before that point.
function redactSample(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) =>
        typeof v === 'string' && v.length > 64 ? `${v.slice(0, 8)}…` : v,
      ),
    );
  } catch {
    return '<unserializable>';
  }
}

/** The four synthetic entries `/v1/models` adds on top of the proxied Orbio catalog. */
export function buildAutoModelEntries(): Array<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const describe = (id: string, description: string) => ({
    id,
    object: 'model',
    created: now,
    owned_by: 'orbio-treasurer',
    description,
  });
  return [
    describe('auto', 'Routes to the cheapest model that fits the request (S/M/L classification).'),
    describe(
      'auto:S',
      'Routes within tier S (≤ $0.40 / M input tokens) or above if the request needs it.',
    ),
    describe(
      'auto:M',
      'Routes within tier M (≤ $3 / M input tokens) or above if the request needs it.',
    ),
    describe('auto:L', 'Routes within tier L (> $3 / M input tokens).'),
  ];
}

/**
 * Wraps `fetchCatalog` with a TTL cache (default ≤10 min, per the ticket). `clock` is injectable
 * for tests; defaults to the real `Date.now`. A fetch failure is not cached — the next call tries
 * again rather than pinning the route handler to a transient error for the full TTL.
 */
export function createCachedCatalogFetcher(
  fetchCatalog: () => Promise<FetchedCatalog>,
  ttlMs = 10 * 60 * 1000,
  clock: () => number = Date.now,
): () => Promise<FetchedCatalog> {
  let cached: { at: number; value: FetchedCatalog } | null = null;
  let inFlight: Promise<FetchedCatalog> | null = null;

  return async () => {
    const now = clock();
    if (cached && now - cached.at < ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = fetchCatalog()
      .then((value) => {
        cached = { at: clock(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

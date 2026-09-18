/**
 * Price-tier math shared by `route.ts` and `baseline.ts` (S-01, ticket "Tiers from per-token
 * input price in the catalog"). Pure — no I/O, no Date — used by both the strictly-pure `route()`
 * and the baseline selector.
 */
import { type ModelCatalogEntry, TIERS, type Tier } from './types.js';

/** S ≤ $0.40 / M input tokens. */
export const TIER_S_MAX_USD_PER_MILLION = 0.4;
/** M ≤ $3 / M input tokens (above this is L). */
export const TIER_M_MAX_USD_PER_MILLION = 3;

const TIER_RANK: Record<Tier, number> = { S: 0, M: 1, L: 2 };

export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

export function minTier(a: Tier, b: Tier): Tier {
  return tierRank(a) <= tierRank(b) ? a : b;
}

/** Price bucket for one catalog entry, from its per-token input price. */
export function priceTier(entry: ModelCatalogEntry): Tier {
  const perMillion = entry.pricing.prompt * 1_000_000;
  if (perMillion <= TIER_S_MAX_USD_PER_MILLION) return 'S';
  if (perMillion <= TIER_M_MAX_USD_PER_MILLION) return 'M';
  return 'L';
}

/** True when `id` is in `allowList`, or `allowList` is unset/empty (meaning "every id allowed" —
 *  ROUTER_ALLOW's documented default). */
export function isAllowed(id: string, allowList: readonly string[] | undefined): boolean {
  return !allowList || allowList.length === 0 || allowList.includes(id);
}

/** The catalog entries in `tier`, filtered by `allowList`. */
export function candidatesForTier(
  catalog: readonly ModelCatalogEntry[],
  tier: Tier,
  allowList: readonly string[] | undefined,
): ModelCatalogEntry[] {
  return catalog.filter((e) => priceTier(e) === tier && isAllowed(e.id, allowList));
}

/** The cheapest (lowest `pricing.prompt`, ties broken by id) allowed entry in `tier`, or `null` if
 *  none. This is the ticket's "Defaults per tier = cheapest model in the tier". */
export function cheapestInTier(
  catalog: readonly ModelCatalogEntry[],
  tier: Tier,
  allowList: readonly string[] | undefined,
): ModelCatalogEntry | null {
  const candidates = candidatesForTier(catalog, tier, allowList);
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => a.pricing.prompt - b.pricing.prompt || a.id.localeCompare(b.id),
  )[0] as ModelCatalogEntry;
}

/** Search order for the nearest non-empty tier when `tier` itself has no allowed model, preferring
 *  the cheaper direction first (routing to the cheapest model that fits is the whole point). */
function fallbackOrder(tier: Tier): readonly Tier[] {
  if (tier === 'S') return ['M', 'L'];
  if (tier === 'M') return ['S', 'L'];
  return ['M', 'S'];
}

/**
 * The model to use for `tier`: the cheapest allowed model in `tier` itself, or — if that tier has
 * no allowed model at all — the cheapest allowed model in the nearest non-empty tier. Returns
 * `null` only when the whole allowed catalog is empty.
 */
export function selectModelForTier(
  catalog: readonly ModelCatalogEntry[],
  tier: Tier,
  allowList: readonly string[] | undefined,
): { entry: ModelCatalogEntry; tier: Tier } | null {
  const direct = cheapestInTier(catalog, tier, allowList);
  if (direct) return { entry: direct, tier };
  for (const candidate of fallbackOrder(tier)) {
    const entry = cheapestInTier(catalog, candidate, allowList);
    if (entry) return { entry, tier: candidate };
  }
  return null;
}

/** All three tiers, in order, for callers that need to enumerate them (e.g. `/v1/models`). */
export const ALL_TIERS: readonly Tier[] = TIERS;

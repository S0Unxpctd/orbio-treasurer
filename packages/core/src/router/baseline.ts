/**
 * Baseline model selection and cost, for the savings comparison (S-01, ticket: "Baseline model
 * for savings: header `x-baseline-model` if present in the catalog, else tier-L default.
 * `baselineCostUsd = tokens × baseline prices`."). Pure — no I/O, no Date.
 */
import { cheapestInTier } from './pricing.js';
import type { ModelCatalogEntry } from './types.js';

/**
 * `x-baseline-model` if it names a catalog entry, else the cheapest allowed (`ROUTER_ALLOW`)
 * tier-L model — the ticket's "tier-L default", using the same "cheapest in tier" rule as a
 * router tier default. Returns `null` only when neither the header nor any tier-L model resolves
 * (e.g. an all-cheap catalog with no L-priced model and no header).
 */
export function selectBaselineModel(
  catalog: readonly ModelCatalogEntry[],
  allowList: readonly string[] | undefined,
  headerModel: string | undefined | null,
): ModelCatalogEntry | null {
  if (headerModel) {
    const found = catalog.find((e) => e.id === headerModel);
    if (found) return found;
  }
  return cheapestInTier(catalog, 'L', allowList);
}

/** `tokens × baseline prices` — `promptTokens × pricing.prompt + completionTokens ×
 *  pricing.completion`, both already USD-per-token (see `types.ts`). */
export function computeBaselineCostUsd(
  baseline: ModelCatalogEntry,
  promptTokens: number,
  completionTokens: number,
): number {
  return promptTokens * baseline.pricing.prompt + completionTokens * baseline.pricing.completion;
}

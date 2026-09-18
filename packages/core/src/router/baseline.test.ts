/**
 * Table-driven tests for baseline model selection and cost (S-01, ticket: "Baseline model for
 * savings: header `x-baseline-model` if present in the catalog, else tier-L default.
 * `baselineCostUsd = tokens × baseline prices`.").
 */
import { describe, expect, it } from 'vitest';

import { computeBaselineCostUsd, selectBaselineModel } from './baseline.js';
import type { ModelCatalogEntry } from './types.js';

const CATALOG: ModelCatalogEntry[] = [
  { id: 'tiny-s', pricing: { prompt: 0.0000001, completion: 0.0000002 } }, // S
  { id: 'mid-m', pricing: { prompt: 0.0000015, completion: 0.000003 } }, // M
  { id: 'big-l', pricing: { prompt: 0.00001, completion: 0.00002 } }, // L, cheaper of the two L
  { id: 'big2-l', pricing: { prompt: 0.00002, completion: 0.00004 } }, // L, more expensive
];

describe('selectBaselineModel()', () => {
  it('uses x-baseline-model when it names a catalog entry', () => {
    const result = selectBaselineModel(CATALOG, undefined, 'mid-m');
    expect(result?.id).toBe('mid-m');
  });

  it('falls back to the tier-L default when no header is given', () => {
    const result = selectBaselineModel(CATALOG, undefined, undefined);
    expect(result?.id).toBe('big-l'); // cheapest of the two L models
  });

  it('falls back to the tier-L default when the header names an id not in the catalog', () => {
    const result = selectBaselineModel(CATALOG, undefined, 'not-a-real-model');
    expect(result?.id).toBe('big-l');
  });

  it('falls back to the tier-L default when the header is an empty string', () => {
    const result = selectBaselineModel(CATALOG, undefined, '');
    expect(result?.id).toBe('big-l');
  });

  it('respects ROUTER_ALLOW for the tier-L default', () => {
    const result = selectBaselineModel(CATALOG, ['big2-l'], undefined);
    expect(result?.id).toBe('big2-l');
  });

  it('the header wins even over a non-allow-listed model (an explicit baseline is not tier-gated)', () => {
    const result = selectBaselineModel(CATALOG, ['big2-l'], 'tiny-s');
    expect(result?.id).toBe('tiny-s');
  });

  it('returns null when there is no header and no tier-L model exists at all', () => {
    const noL: ModelCatalogEntry[] = [
      CATALOG[0] as ModelCatalogEntry,
      CATALOG[1] as ModelCatalogEntry,
    ];
    const result = selectBaselineModel(noL, undefined, undefined);
    expect(result).toBeNull();
  });
});

describe('computeBaselineCostUsd()', () => {
  it("multiplies prompt and completion tokens by the baseline model's per-token prices", () => {
    const baseline = CATALOG[2] as ModelCatalogEntry; // big-l: prompt 0.00001, completion 0.00002
    const cost = computeBaselineCostUsd(baseline, 1000, 500);
    expect(cost).toBeCloseTo(1000 * 0.00001 + 500 * 0.00002, 12);
  });

  it('is zero for zero tokens', () => {
    const baseline = CATALOG[2] as ModelCatalogEntry;
    expect(computeBaselineCostUsd(baseline, 0, 0)).toBe(0);
  });
});

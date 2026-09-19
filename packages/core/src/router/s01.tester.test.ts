/**
 * Tester pass for S-01 (tasks/S-01.md), AC1 — independent of the builder's own `route.test.ts` /
 * `baseline.test.ts`. Written from the Acceptance criteria and Tests-required sections alone,
 * against a catalog fixture defined fresh in this file (not shared with the builder's tests),
 * before this session read `route.ts` / `baseline.ts` to wire the imports up.
 *
 * AC1: "`route()` is pure (no imports of fs/net/Date) and has table-driven tests covering: S/M/L
 * classification from prices, each rule, floor, cap-over-floor, explicit model pass-through,
 * unknown explicit model → error, baseline selection. ≥ 12 cases."
 */
import { describe, expect, it } from 'vitest';

import { computeBaselineCostUsd, selectBaselineModel } from './baseline.js';
import { route } from './route.js';
import type { ModelCatalogEntry, RouteInput } from './types.js';
import { RouterError } from './types.js';

// Fresh catalog, independent of route.test.ts's CATALOG. Prices are USD-per-token; tier math is
// per-million (×1e6). Ticket thresholds: S ≤ $0.40/M, M ≤ $3/M, L above.
const CATALOG: ModelCatalogEntry[] = [
  { id: 'tester-s-cheap', pricing: { prompt: 0.0000001, completion: 0.0000002 } }, // $0.10/M
  { id: 'tester-s-boundary', pricing: { prompt: 0.0000004, completion: 0.0000004 } }, // $0.40/M (S boundary, inclusive)
  { id: 'tester-m-just-above', pricing: { prompt: 0.00000040001, completion: 0.0000004 } }, // >$0.40/M → M
  { id: 'tester-m-cheap', pricing: { prompt: 0.000001, completion: 0.000002 } }, // $1.00/M
  { id: 'tester-m-boundary', pricing: { prompt: 0.000003, completion: 0.000003 } }, // $3.00/M (M boundary, inclusive)
  { id: 'tester-l-just-above', pricing: { prompt: 0.0000030001, completion: 0.000003 } }, // >$3.00/M → L
  { id: 'tester-l-expensive', pricing: { prompt: 0.00001, completion: 0.00002 } }, // $10.00/M
];

function msg(role: string, content: unknown) {
  return { role, content };
}

function shortInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    requestedModel: 'auto',
    messages: [msg('user', 'summarize this in five words')],
    ...overrides,
  };
}

describe('S-01 AC1 — route() purity', () => {
  it('imports nothing from node:fs, node:net, or a bare Date constructor (source scan)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./route.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:fs/);
    expect(src).not.toMatch(/from\s+['"]node:net/);
    expect(src).not.toMatch(/\bnew Date\(/);
    expect(src).not.toMatch(/Date\.now\(/);
  });
});

describe('S-01 AC1 — S/M/L classification from prices (explicit pass-through)', () => {
  // Explicit-model requests derive `tier` straight from the catalog price, with no rule/floor/cap
  // involved — the cleanest way to pin down the price-tier boundaries themselves.
  it('a model at exactly $0.10/M is tier S', () => {
    const r = route({ requestedModel: 'tester-s-cheap', messages: [] }, CATALOG);
    expect(r).toEqual({ model: 'tester-s-cheap', tier: 'S', reason: 'explicit' });
  });

  it('a model at exactly the $0.40/M boundary is still tier S (inclusive)', () => {
    const r = route({ requestedModel: 'tester-s-boundary', messages: [] }, CATALOG);
    expect(r.tier).toBe('S');
  });

  it('a model just above $0.40/M is tier M', () => {
    const r = route({ requestedModel: 'tester-m-just-above', messages: [] }, CATALOG);
    expect(r.tier).toBe('M');
  });

  it('a model at exactly the $3.00/M boundary is still tier M (inclusive)', () => {
    const r = route({ requestedModel: 'tester-m-boundary', messages: [] }, CATALOG);
    expect(r.tier).toBe('M');
  });

  it('a model just above $3.00/M is tier L', () => {
    const r = route({ requestedModel: 'tester-l-just-above', messages: [] }, CATALOG);
    expect(r.tier).toBe('L');
  });
});

describe('S-01 AC1 — explicit model pass-through / unknown explicit model', () => {
  it('an exact catalog model id passes through untouched with reason "explicit"', () => {
    const r = route({ requestedModel: 'tester-l-expensive', messages: [] }, CATALOG);
    expect(r.model).toBe('tester-l-expensive');
    expect(r.reason).toBe('explicit');
  });

  it('an unknown explicit model id throws RouterError("unknown_model")', () => {
    expect(() => route({ requestedModel: 'not-a-real-model', messages: [] }, CATALOG)).toThrow(
      RouterError,
    );
    try {
      route({ requestedModel: 'not-a-real-model', messages: [] }, CATALOG);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).code).toBe('unknown_model');
    }
  });
});

describe('S-01 AC1 — each classification rule (auto, default mode)', () => {
  it('default: a short prompt with no tools/json/keywords routes to tier S', () => {
    const r = route(shortInput(), CATALOG);
    expect(r.tier).toBe('S');
  });

  it('rule: tools present → at least tier M', () => {
    const r = route(
      shortInput({ tools: [{ type: 'function', function: { name: 'f' } }] }),
      CATALOG,
    );
    expect(r.tier).toBe('M');
  });

  it('rule: response_format json → at least tier M', () => {
    const r = route(shortInput({ responseFormat: { type: 'json_object' } }), CATALOG);
    expect(r.tier).toBe('M');
  });

  it('rule: response_format "text" (not json) does NOT trigger the rule', () => {
    const r = route(shortInput({ responseFormat: { type: 'text' } }), CATALOG);
    expect(r.tier).toBe('S');
  });

  it('rule: total prompt chars > 24000 → at least tier M', () => {
    const longContent = 'x'.repeat(24_001);
    const r = route(shortInput({ messages: [msg('user', longContent)] }), CATALOG);
    expect(r.tier).toBe('M');
  });

  it('rule: prompt at exactly 24000 chars does NOT trigger the length rule', () => {
    const exactContent = 'x'.repeat(24_000);
    const r = route(shortInput({ messages: [msg('user', exactContent)] }), CATALOG);
    expect(r.tier).toBe('S');
  });

  it('rule: system prompt matching /reason|analy|code|plan/i → at least tier M', () => {
    const r = route(
      shortInput({
        messages: [msg('system', 'You must reason step by step.'), msg('user', 'hi')],
      }),
      CATALOG,
    );
    expect(r.tier).toBe('M');
  });

  it('rule: system prompt with no keyword match stays tier S', () => {
    const r = route(
      shortInput({
        messages: [msg('system', 'You are a friendly assistant.'), msg('user', 'hi')],
      }),
      CATALOG,
    );
    expect(r.tier).toBe('S');
  });
});

describe('S-01 AC1 — floor (auto:X)', () => {
  it('auto:M raises an otherwise-S request to tier M', () => {
    const r = route(shortInput({ requestedModel: 'auto:M' }), CATALOG);
    expect(r.tier).toBe('M');
  });

  it('auto:S does not lower a request the rules already classified as M', () => {
    const r = route(
      shortInput({
        requestedModel: 'auto:S',
        tools: [{ type: 'function', function: { name: 'f' } }],
      }),
      CATALOG,
    );
    expect(r.tier).toBe('M');
  });
});

describe('S-01 AC1 — cap-over-floor (policy mode)', () => {
  it('mode "eco" caps a tools-request at M (no floor involved)', () => {
    const r = route(
      shortInput({ tools: [{ type: 'function', function: { name: 'f' } }] }),
      CATALOG,
      { mode: 'eco' },
    );
    expect(r.tier).toBe('M');
  });

  it('mode "critical" caps a tools-request (would be M) down to S', () => {
    const r = route(
      shortInput({ tools: [{ type: 'function', function: { name: 'f' } }] }),
      CATALOG,
      { mode: 'critical' },
    );
    expect(r.tier).toBe('S');
  });

  it('cap wins over floor: auto:L floor + mode "critical" resolves to tier S, not L', () => {
    const r = route(shortInput({ requestedModel: 'auto:L' }), CATALOG, { mode: 'critical' });
    expect(r.tier).toBe('S');
  });
});

describe('S-01 AC1 — baseline selection', () => {
  it('x-baseline-model header naming a real catalog entry is used as-is', () => {
    const baseline = selectBaselineModel(CATALOG, undefined, 'tester-m-cheap');
    expect(baseline?.id).toBe('tester-m-cheap');
  });

  it('an unrecognised x-baseline-model header falls back to the tier-L default', () => {
    const baseline = selectBaselineModel(CATALOG, undefined, 'no-such-model');
    // Cheapest tier-L model in CATALOG is tester-l-just-above ($3.0001/M) vs tester-l-expensive
    // ($10/M) — cheapest wins.
    expect(baseline?.id).toBe('tester-l-just-above');
  });

  it('no header at all falls back to the tier-L default', () => {
    const baseline = selectBaselineModel(CATALOG, undefined, undefined);
    expect(baseline?.id).toBe('tester-l-just-above');
  });

  it('computeBaselineCostUsd multiplies tokens by the baseline model prices', () => {
    const baseline = CATALOG.find((e) => e.id === 'tester-m-cheap');
    if (!baseline) throw new Error('fixture setup error');
    const cost = computeBaselineCostUsd(baseline, 100, 50);
    // 100 * 0.000001 + 50 * 0.000002 = 0.0001 + 0.0001 = 0.0002
    expect(cost).toBeCloseTo(0.0002, 10);
  });
});

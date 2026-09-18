/**
 * Table-driven tests for `route()` (S-01 AC1): S/M/L classification from prices, each rule, floor,
 * cap-over-floor, explicit model pass-through, unknown explicit model → error, baseline selection
 * uses this same catalog fixture (see `baseline.test.ts`). ≥ 12 cases.
 */
import { describe, expect, it } from 'vitest';
import { classifyTier, route } from './route.js';
import type { ModelCatalogEntry, RouteInput } from './types.js';
import { RouterError } from './types.js';

// A synthetic, self-consistent catalog spanning all three tiers plus a couple of ties, used
// across every case below. Prices are USD-per-token (types.ts); tier math multiplies by 1e6.
const CATALOG: ModelCatalogEntry[] = [
  { id: 'tiny-s', pricing: { prompt: 0.0000001, completion: 0.0000002 } }, // $0.10/M — S
  { id: 'small-s', pricing: { prompt: 0.0000004, completion: 0.0000008 } }, // $0.40/M — S (boundary)
  { id: 'mid-m', pricing: { prompt: 0.0000015, completion: 0.000003 } }, // $1.50/M — M
  { id: 'mid2-m', pricing: { prompt: 0.000003, completion: 0.000006 } }, // $3.00/M — M (boundary)
  { id: 'big-l', pricing: { prompt: 0.00001, completion: 0.00002 } }, // $10/M — L
  { id: 'big2-l', pricing: { prompt: 0.00002, completion: 0.00004 } }, // $20/M — L (more expensive)
];

function msg(role: string, content: unknown) {
  return { role, content };
}

function baseInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    requestedModel: 'auto',
    messages: [msg('user', 'hello there')],
    ...overrides,
  };
}

describe('route() — pure surface', () => {
  it('imports nothing from node:fs, node:net or a Date constructor (source scan)', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./route.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/from\s+['"]node:fs/);
    expect(src).not.toMatch(/from\s+['"]node:net/);
    expect(src).not.toMatch(/\bnew Date\(/);
    expect(src).not.toMatch(/Date\.now\(/);
  });
});

describe('route() — S/M/L classification from prices', () => {
  it('buckets the cheapest model as S for a plain short prompt', () => {
    const result = route(baseInput(), CATALOG);
    expect(result.tier).toBe('S');
    expect(result.model).toBe('tiny-s');
  });

  it('boundary: exactly $0.40/M is still S', () => {
    // Force selection into the S tier only, so we can see which S model wins: cheapest.
    const result = route(baseInput({ requestedModel: 'auto:S' }), CATALOG, {
      allowList: ['small-s'],
    });
    expect(result.tier).toBe('S');
    expect(result.model).toBe('small-s');
  });

  it('boundary: exactly $3/M is still M, not L', () => {
    const result = route(baseInput({ tools: [{ type: 'function' }] }), CATALOG, {
      allowList: ['mid2-m', 'big-l'],
    });
    expect(result.tier).toBe('M');
    expect(result.model).toBe('mid2-m');
  });

  it('above $3/M is L', () => {
    const result = route(baseInput({ requestedModel: 'auto:L' }), CATALOG);
    expect(result.tier).toBe('L');
    expect(result.model).toBe('big-l'); // cheapest of the two L models
  });
});

describe('route() — classification rules, each in isolation', () => {
  it('rule: tools present → ≥ M', () => {
    const { tier, ruleId } = classifyTier(baseInput({ tools: [{ type: 'function', name: 'x' }] }));
    expect(tier).toBe('M');
    expect(ruleId).toBe('rule:tools');
    expect(route(baseInput({ tools: [{ type: 'function' }] }), CATALOG).tier).toBe('M');
  });

  it('an empty tools array does NOT trigger the tools rule', () => {
    const { tier, ruleId } = classifyTier(baseInput({ tools: [] }));
    expect(tier).toBe('S');
    expect(ruleId).toBe('rule:default');
  });

  it('rule: response_format json → ≥ M', () => {
    const { tier, ruleId } = classifyTier(baseInput({ responseFormat: { type: 'json_object' } }));
    expect(tier).toBe('M');
    expect(ruleId).toBe('rule:response_format_json');
    expect(route(baseInput({ responseFormat: { type: 'json_object' } }), CATALOG).tier).toBe('M');
  });

  it('response_format type "text" does NOT trigger the json rule', () => {
    const { tier } = classifyTier(baseInput({ responseFormat: { type: 'text' } }));
    expect(tier).toBe('S');
  });

  it('rule: prompt > 24 000 chars → ≥ M', () => {
    const longPrompt = 'x'.repeat(24_001);
    const { tier, ruleId } = classifyTier(baseInput({ messages: [msg('user', longPrompt)] }));
    expect(tier).toBe('M');
    expect(ruleId).toBe('rule:prompt_length');
  });

  it('exactly 24 000 chars does NOT trigger the length rule', () => {
    const prompt = 'x'.repeat(24_000);
    const { tier } = classifyTier(baseInput({ messages: [msg('user', prompt)] }));
    expect(tier).toBe('S');
  });

  it('rule: system prompt matches /reason|analy|code|plan/i → ≥ M', () => {
    const { tier, ruleId } = classifyTier(
      baseInput({ messages: [msg('system', 'You must reason carefully.'), msg('user', 'hi')] }),
    );
    expect(tier).toBe('M');
    expect(ruleId).toBe('rule:system_keyword');
  });

  it('system keyword rule matches "analy", "code" and "plan" too', () => {
    for (const word of ['analyze this', 'write code', 'make a plan']) {
      const { tier } = classifyTier(
        baseInput({ messages: [msg('system', word), msg('user', 'hi')] }),
      );
      expect(tier).toBe('M');
    }
  });

  it('a keyword in a USER message (not system) does not trigger the system-keyword rule', () => {
    const { tier, ruleId } = classifyTier(baseInput({ messages: [msg('user', 'please reason')] }));
    expect(tier).toBe('S');
    expect(ruleId).toBe('rule:default');
  });

  it('none of the rules fire → S (default)', () => {
    const { tier, ruleId } = classifyTier(baseInput());
    expect(tier).toBe('S');
    expect(ruleId).toBe('rule:default');
  });
});

describe('route() — floor from auto:S|M|L', () => {
  it('"auto" (bare) has no floor: a plain prompt still routes to S', () => {
    expect(route(baseInput({ requestedModel: 'auto' }), CATALOG).tier).toBe('S');
  });

  it('auto:M raises a plain (would-be-S) prompt to M', () => {
    const result = route(baseInput({ requestedModel: 'auto:M' }), CATALOG);
    expect(result.tier).toBe('M');
    expect(result.reason).toContain('floor:auto:M');
  });

  it('auto:S does not lower a request that rules already push to M', () => {
    const result = route(
      baseInput({ requestedModel: 'auto:S', tools: [{ type: 'function' }] }),
      CATALOG,
    );
    expect(result.tier).toBe('M');
    expect(result.reason).not.toContain('floor:'); // floor never raised anything here
  });
});

describe('route() — cap wins over floor', () => {
  it('critical mode caps an auto:L floor down to S, and reason says the cap overrode the floor', () => {
    const result = route(baseInput({ requestedModel: 'auto:L' }), CATALOG, { mode: 'critical' });
    expect(result.tier).toBe('S');
    expect(result.reason).toContain('floor:auto:L');
    expect(result.reason).toContain('cap:critical');
    expect(result.reason).toContain('cap-overrides-floor');
  });

  it('eco mode caps a tools-triggered M... at M (no-op cap, still recorded once lowered from higher)', () => {
    // tools alone only reaches M; auto:L floor pushes it to L, eco then caps back to M.
    const result = route(
      baseInput({ requestedModel: 'auto:L', tools: [{ type: 'function' }] }),
      CATALOG,
      { mode: 'eco' },
    );
    expect(result.tier).toBe('M');
    expect(result.reason).toContain('cap:eco');
    expect(result.reason).toContain('cap-overrides-floor');
  });

  it('normal mode applies no cap: auto:L floor is honored', () => {
    const result = route(baseInput({ requestedModel: 'auto:L' }), CATALOG, { mode: 'normal' });
    expect(result.tier).toBe('L');
    expect(result.reason).not.toContain('cap:');
  });
});

describe('route() — explicit model pass-through', () => {
  it('an exact catalog model id is passed through untouched, reason "explicit"', () => {
    const result = route(baseInput({ requestedModel: 'big-l' }), CATALOG);
    expect(result).toEqual({ model: 'big-l', tier: 'L', reason: 'explicit' });
  });

  it('explicit pass-through ignores floor/cap entirely (mode critical does not touch it)', () => {
    const result = route(baseInput({ requestedModel: 'big-l' }), CATALOG, { mode: 'critical' });
    expect(result.model).toBe('big-l');
    expect(result.tier).toBe('L');
  });

  it('unknown explicit model → RouterError("unknown_model")', () => {
    expect(() => route(baseInput({ requestedModel: 'not-a-real-model' }), CATALOG)).toThrow(
      RouterError,
    );
    try {
      route(baseInput({ requestedModel: 'not-a-real-model' }), CATALOG);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as InstanceType<typeof RouterError>).code).toBe('unknown_model');
    }
  });
});

describe('route() — ROUTER_ALLOW allow-list', () => {
  it('restricts the tier default to the allowed ids only', () => {
    const result = route(baseInput(), CATALOG, { allowList: ['small-s'] });
    expect(result.model).toBe('small-s');
  });

  it('falls back to the nearest non-empty tier when the target tier has no allowed model', () => {
    // Only an M model allowed; a plain S-classified prompt must fall back to it.
    const result = route(baseInput(), CATALOG, { allowList: ['mid-m'] });
    expect(result.model).toBe('mid-m');
    expect(result.tier).toBe('M');
    expect(result.reason).toContain('fallback:M');
  });

  it('throws no_model_in_tier when the allow-list matches nothing in the catalog at all', () => {
    expect(() => route(baseInput(), CATALOG, { allowList: ['does-not-exist'] })).toThrow(
      RouterError,
    );
  });
});

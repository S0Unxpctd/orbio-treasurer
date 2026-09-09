/**
 * T-015 · AC3 property test: re-evaluating a decision's stored inputs reproduces the decision
 * (FR-4.6). 200 random snapshots, seeded PRNG (mulberry32 — ~10 lines, no new dependency per
 * the builder brief: "write 20 lines rather than add fast-check").
 *
 * Fixed seed so a failure is reproducible; the seed is logged on failure via the it.each label.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './defaults.js';
import { evaluate } from './evaluate.js';
import type { EvaluateInput, PolicyState } from './types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMoney(rng: () => number, maxInt = 200): string {
  const sign = rng() < 0.1 ? '-' : '';
  const intPart = Math.floor(rng() * maxInt);
  const fracDigits = Math.floor(rng() * 7); // 0..6
  let frac = '';
  for (let i = 0; i < fracDigits; i++) frac += Math.floor(rng() * 10).toString();
  return frac ? `${sign}${intPart}.${frac}` : `${sign}${intPart}`;
}

function randomMoneyOrNull(rng: () => number, maxInt = 200): string | null {
  return rng() < 0.3 ? null : randomMoney(rng, maxInt);
}

function pick<T>(rng: () => number, options: readonly T[]): T {
  const value = options[Math.floor(rng() * options.length)];
  if (value === undefined) throw new Error('pick: empty options');
  return value;
}

const STATES: readonly (PolicyState | null)[] = [null, 'COMFORTABLE', 'TIGHT', 'DEFICIT'];

function randomInput(rng: () => number): EvaluateInput {
  const mcpReachable = rng() < 0.85;
  return {
    creditsAvailableUsd: randomMoney(rng),
    accrualRateUsdPerDay: randomMoney(rng, 20),
    burnRateUsdPerDay: randomMoney(rng, 20),
    book: {
      buyAvailable: rng() < 0.5,
      bestDiscountPct: randomMoneyOrNull(rng, 100),
      depthAtBestUsd: randomMoneyOrNull(rng, 100),
    },
    stake: {
      available: rng() < 0.5,
      stableBalanceUsd: randomMoney(rng, 50),
      orbioPriceUsd: randomMoney(rng, 10),
      yieldPerTokenPerDay: randomMoney(rng, 1),
      yieldLowConfidence: rng() < 0.5,
    },
    caps: {
      boughtTodayUsd: randomMoney(rng, 15),
      stakedTodayUsd: randomMoney(rng, 15),
    },
    keyStatus: { valid: rng() < 0.9 },
    tick: {
      gapMinutes: rng() < 0.1 ? null : Math.floor(rng() * 120),
      mcpReachable,
      mcpPreviouslyReachable: rng() < 0.15 ? null : rng() < 0.7,
    },
    hysteresis: {
      previousEffectiveState: pick(rng, STATES),
      consecutiveRawTicks: Math.floor(rng() * 4),
    },
    prebuy: {
      forecastUsdNextWindow: randomMoneyOrNull(rng, 50),
      windowDeadlineLabel: rng() < 0.5 ? null : 'Monday 06:00',
    },
    policy: DEFAULT_POLICY,
  };
}

const SEED = 20260909;
const rng = mulberry32(SEED);
const cases = Array.from({ length: 200 }, (_, i) => ({ i, input: randomInput(rng) }));

describe(`AC3 property: evaluate(decision.inputs) reproduces the decision (seed ${SEED}, 200 cases)`, () => {
  it.each(cases.map(({ i, input }) => [i, input] as const))('case #%s', (_i, input) => {
    const first = evaluate(input);

    // Deep-clone through JSON so the replay input is a genuinely independent object, not the
    // same reference — a byte-for-byte reproduction must not depend on object identity.
    const clone = JSON.parse(JSON.stringify(input)) as EvaluateInput;
    const replayed = evaluate(clone);
    expect(replayed).toEqual(first);

    // And specifically: re-evaluating what a stored Decision itself carries as `inputs`
    // reproduces that same decision (FR-4.6's actual claim, not just determinism-in-general).
    for (const decision of first) {
      expect(evaluate(decision.inputs)).toEqual(first);
    }
  });
});

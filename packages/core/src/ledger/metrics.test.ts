/**
 * computeSnapshotMetrics — table-driven unit tests (T-011, PRD FR-1.3, FR-3.3).
 * AC2: "Table tests: zero burn, zero accrual, accrual>burn (runway null=∞), ε floor,
 * low_confidence < 6h."
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  burnDaily,
  computeSnapshotMetrics,
  DEFAULT_EPSILON_USD_PER_DAY,
  savings,
} from './metrics.js';
import { openSqliteLedger } from './sqlite/store.js';
import type { LedgerStore } from './types.js';

describe('computeSnapshotMetrics — runway_days (FR-1.3)', () => {
  it('zero burn, zero accrual: infinite runway regardless of credits available', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '100.000000',
      accruedLast24hUsd: '0',
      spentLast24hUsd: '0',
      burnRateUsdPerDay: '0',
      accrualRateUsdPerDay: '0',
      historyHours: 24,
    });
    expect(m.runwayDays).toBeNull();
  });

  it('zero accrual: runway = credits / burn', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '30.000000',
      accruedLast24hUsd: '0',
      spentLast24hUsd: '5.000000',
      burnRateUsdPerDay: '3.000000',
      accrualRateUsdPerDay: '0',
      historyHours: 24,
    });
    expect(m.runwayDays).toBe('10.000000');
  });

  it('accrual > burn: runway is null (displayed as ∞)', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '30.000000',
      accruedLast24hUsd: '10.000000',
      spentLast24hUsd: '5.000000',
      burnRateUsdPerDay: '3.000000',
      accrualRateUsdPerDay: '5.000000',
      historyHours: 24,
    });
    expect(m.runwayDays).toBeNull();
  });

  it('accrual == burn: runway is null (displayed as ∞) — "accrual ≥ burn" per FR-1.3', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '30.000000',
      accruedLast24hUsd: '4.000000',
      spentLast24hUsd: '4.000000',
      burnRateUsdPerDay: '4.000000',
      accrualRateUsdPerDay: '4.000000',
      historyHours: 24,
    });
    expect(m.runwayDays).toBeNull();
  });

  it('ε floor: a tiny positive net burn is floored at ε, not divided by near-zero', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '100.000000',
      accruedLast24hUsd: '0',
      spentLast24hUsd: '10.000000',
      // net burn = 0.000001, far smaller than the default ε (0.01) — flooring at ε keeps the
      // result bounded to 100 / 0.01 = 10000, instead of 100 / 0.000001 = 100,000,000.
      burnRateUsdPerDay: '5.000001',
      accrualRateUsdPerDay: '5.000000',
      historyHours: 24,
    });
    expect(m.runwayDays).toBe('10000.000000');
  });

  it('ε floor is overridable', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '1.000000',
      accruedLast24hUsd: '0',
      spentLast24hUsd: '1.000000',
      burnRateUsdPerDay: '1.000000',
      accrualRateUsdPerDay: '0.999999',
      historyHours: 24,
      epsilonUsdPerDay: '1.000000',
    });
    // net burn = 0.000001 < ε(1.0), so floored to 1.0 -> runway = 1/1 = 1
    expect(m.runwayDays).toBe('1.000000');
  });

  it('positive net burn above ε divides normally, not floored', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '9.000000',
      accruedLast24hUsd: '1.000000',
      spentLast24hUsd: '4.000000',
      burnRateUsdPerDay: '4.000000',
      accrualRateUsdPerDay: '1.000000',
      historyHours: 24,
    });
    // net burn = 3.0, well above the default ε -> runway = 9 / 3 = 3
    expect(m.runwayDays).toBe('3.000000');
  });
});

describe('computeSnapshotMetrics — coverage_ratio (FR-1.3)', () => {
  it('spent = 0: coverage_ratio is null (undefined ratio), never 0 or Infinity', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '10.000000',
      accruedLast24hUsd: '5.000000',
      spentLast24hUsd: '0',
      burnRateUsdPerDay: '0',
      accrualRateUsdPerDay: '5.000000',
      historyHours: 24,
    });
    expect(m.coverageRatio).toBeNull();
  });

  it('accrued = 0, spent > 0: coverage_ratio is exactly 0', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '10.000000',
      accruedLast24hUsd: '0',
      spentLast24hUsd: '5.000000',
      burnRateUsdPerDay: '5.000000',
      accrualRateUsdPerDay: '0',
      historyHours: 24,
    });
    expect(m.coverageRatio).toBe('0.000000');
  });

  it('accrued < spent: partial coverage', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '10.000000',
      accruedLast24hUsd: '2.500000',
      spentLast24hUsd: '10.000000',
      burnRateUsdPerDay: '10.000000',
      accrualRateUsdPerDay: '2.500000',
      historyHours: 24,
    });
    expect(m.coverageRatio).toBe('0.250000');
  });

  it('accrued == spent: fully covered, ratio 1', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '10.000000',
      accruedLast24hUsd: '8.000000',
      spentLast24hUsd: '8.000000',
      burnRateUsdPerDay: '8.000000',
      accrualRateUsdPerDay: '8.000000',
      historyHours: 24,
    });
    expect(m.coverageRatio).toBe('1.000000');
  });

  it('accrued > spent: over-covered, ratio > 1', () => {
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '10.000000',
      accruedLast24hUsd: '12.000000',
      spentLast24hUsd: '8.000000',
      burnRateUsdPerDay: '8.000000',
      accrualRateUsdPerDay: '12.000000',
      historyHours: 24,
    });
    expect(m.coverageRatio).toBe('1.500000');
  });
});

describe('computeSnapshotMetrics — burn_low_confidence (FR-3.3: "until 6 hours of data exist")', () => {
  const base = {
    creditsAvailableUsd: '10.000000',
    accruedLast24hUsd: '0',
    spentLast24hUsd: '1.000000',
    burnRateUsdPerDay: '1.000000',
    accrualRateUsdPerDay: '0',
  };

  it('0 hours of history: low confidence', () => {
    expect(computeSnapshotMetrics({ ...base, historyHours: 0 }).burnLowConfidence).toBe(true);
  });

  it('just under 6 hours: still low confidence', () => {
    expect(computeSnapshotMetrics({ ...base, historyHours: 5.99 }).burnLowConfidence).toBe(true);
  });

  it('exactly 6 hours: confidence established ("until 6 hours exist")', () => {
    expect(computeSnapshotMetrics({ ...base, historyHours: 6 }).burnLowConfidence).toBe(false);
  });

  it('well past 6 hours: not low confidence', () => {
    expect(computeSnapshotMetrics({ ...base, historyHours: 24 }).burnLowConfidence).toBe(false);
  });
});

describe('computeSnapshotMetrics — no floats, no I/O, deterministic', () => {
  it('a value lossy in IEEE-754 (0.1 + 0.2-style) round-trips exactly through the math', () => {
    // If this were computed with JS numbers, 100 - (33.333333 * 3) would show float drift.
    const m = computeSnapshotMetrics({
      creditsAvailableUsd: '100.000000',
      accruedLast24hUsd: '0',
      spentLast24hUsd: '99.999999',
      burnRateUsdPerDay: '99.999999',
      accrualRateUsdPerDay: '0',
      historyHours: 24,
    });
    expect(m.runwayDays).toBe('1.000000');
  });

  it('exposes the documented default epsilon so callers/tests can reason about the floor', () => {
    expect(DEFAULT_EPSILON_USD_PER_DAY).toBe('0.01');
  });

  it('is a pure function: identical inputs always produce identical outputs', () => {
    const input = {
      creditsAvailableUsd: '42.500000',
      accruedLast24hUsd: '3.000000',
      spentLast24hUsd: '6.000000',
      burnRateUsdPerDay: '6.000000',
      accrualRateUsdPerDay: '3.000000',
      historyHours: 12,
    };
    expect(computeSnapshotMetrics(input)).toEqual(computeSnapshotMetrics({ ...input }));
  });
});

// ---------------------------------------------------------------------------------------------
// S-02 (PRD 1.0 §4 T-2, §6): savings() / burnDaily() — table-driven over a hand-computed fixture
// of 10 usage events (AC5, AC6). `now` is fixed and passed in explicitly throughout — no clock.
// ---------------------------------------------------------------------------------------------

const NOW = '2026-01-10T00:00:00.000Z';

describe('savings() — S/M/L mix fixture (S-02, AC5)', () => {
  let store: LedgerStore;
  let agentId: string;

  beforeEach(async () => {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s02-${Math.random()}`,
      name: 'S-02',
      mode: 'dry_run',
    });
    agentId = agent.id;

    // Hand-computed fixture — see tasks/S-02.md Evidence for the by-hand arithmetic this mirrors.
    // #  at (relative to NOW)      tier   cost    baseline
    // 1  -12h                     S      0.10    0.20
    // 2  -4h                      S      0.15    0.20
    // 3  -1.5d                    M      0.50    1.00
    // 4  -2.5d                    M      0.60    1.20
    // 5  -3.5d                    L      2.00    2.00
    // 6  -4.5d                    L      1.50    3.00
    // 7  -5.5d                    S      0.05    0.10
    // 8  -6.5d                    M      0.40    0.80
    // 9  -7.5d (outside 7d window) L      3.00    3.00
    // 10 -8.5d (outside 7d window) (no tier) 0.20 0.20
    const fixture: Array<{
      at: string;
      tier?: 'S' | 'M' | 'L';
      cost: string;
      baseline: string;
    }> = [
      { at: '2026-01-09T12:00:00.000Z', tier: 'S', cost: '0.10', baseline: '0.20' },
      { at: '2026-01-09T20:00:00.000Z', tier: 'S', cost: '0.15', baseline: '0.20' },
      { at: '2026-01-08T12:00:00.000Z', tier: 'M', cost: '0.50', baseline: '1.00' },
      { at: '2026-01-07T12:00:00.000Z', tier: 'M', cost: '0.60', baseline: '1.20' },
      { at: '2026-01-06T12:00:00.000Z', tier: 'L', cost: '2.00', baseline: '2.00' },
      { at: '2026-01-05T12:00:00.000Z', tier: 'L', cost: '1.50', baseline: '3.00' },
      { at: '2026-01-04T12:00:00.000Z', tier: 'S', cost: '0.05', baseline: '0.10' },
      { at: '2026-01-03T12:00:00.000Z', tier: 'M', cost: '0.40', baseline: '0.80' },
      { at: '2026-01-02T12:00:00.000Z', tier: 'L', cost: '3.00', baseline: '3.00' },
      { at: '2026-01-01T12:00:00.000Z', cost: '0.20', baseline: '0.20' },
    ];
    for (const event of fixture) {
      await store.insertUsageEvent({
        agentId,
        at: event.at,
        model: 'x',
        tierServed: event.tier ?? null,
        costUsd: event.cost,
        baselineCostUsd: event.baseline,
        status: 'ok',
      });
    }
  });

  it('24h window: only events 1-2 (within the last 24h of NOW)', async () => {
    const result = await savings(store, agentId, '24h', NOW);
    expect(result.calls).toBe(2);
    expect(result.costUsd).toBe('0.250000');
    expect(result.baselineUsd).toBe('0.400000');
    expect(result.savedUsd).toBe('0.150000');
    expect(result.savedPct).toBe('0.3750');
    expect(result.byTier).toEqual({
      S: { calls: 2, costUsd: '0.250000' },
      M: { calls: 0, costUsd: '0.000000' },
      L: { calls: 0, costUsd: '0.000000' },
    });
  });

  it('7d window: events 1-8 (9 and 10 are older than 7 days)', async () => {
    const result = await savings(store, agentId, '7d', NOW);
    expect(result.calls).toBe(8);
    expect(result.costUsd).toBe('5.300000');
    expect(result.baselineUsd).toBe('8.500000');
    expect(result.savedUsd).toBe('3.200000');
    expect(result.savedPct).toBe('0.3765'); // 3.20 / 8.50 = 0.376470588... -> rounds up at 4dp
    expect(result.byTier).toEqual({
      S: { calls: 3, costUsd: '0.300000' },
      M: { calls: 3, costUsd: '1.500000' },
      L: { calls: 2, costUsd: '3.500000' },
    });
  });

  it('all window: every event, including the untiered one (counted in totals, not in byTier)', async () => {
    const result = await savings(store, agentId, 'all', NOW);
    expect(result.calls).toBe(10);
    expect(result.costUsd).toBe('8.500000');
    expect(result.baselineUsd).toBe('11.700000');
    expect(result.savedUsd).toBe('3.200000');
    expect(result.savedPct).toBe('0.2735'); // 3.20 / 11.70 = 0.273504... -> truncates at 4dp
    expect(result.byTier).toEqual({
      S: { calls: 3, costUsd: '0.300000' },
      M: { calls: 3, costUsd: '1.500000' },
      L: { calls: 3, costUsd: '6.500000' }, // event 9 (3.00) joins events 5/6
    });
  });

  it('savedPct is "0.0000" when baselineUsd is 0 (AC5)', async () => {
    const emptyStore = openSqliteLedger(':memory:');
    const emptyAgent = await emptyStore.insertAgent({
      slug: `s02-empty-${Math.random()}`,
      name: 'e',
      mode: 'dry_run',
    });
    const result = await savings(emptyStore, emptyAgent.id, 'all', NOW);
    expect(result.calls).toBe(0);
    expect(result.baselineUsd).toBe('0.000000');
    expect(result.savedPct).toBe('0.0000');
    await emptyStore.close();
  });

  it('rejects a non-UTC `now`', async () => {
    await expect(savings(store, agentId, 'all', '2026-01-10 00:00:00')).rejects.toThrow(
      /UTC ISO-8601/,
    );
  });
});

describe('burnDaily() — max(24h, 7d avg, ε) (S-02, AC6)', () => {
  it('empty history: floors at the default epsilon -> "0.010000"', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s02-b1-${Math.random()}`,
      name: 'b1',
      mode: 'dry_run',
    });
    const result = await burnDaily(store, agent.id, NOW);
    expect(result).toBe('0.010000');
    await store.close();
  });

  it('recent 24h spend dominates a lower 7-day average', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s02-b2-${Math.random()}`,
      name: 'b2',
      mode: 'dry_run',
    });
    // last 24h: 1.00 + 2.00 = 3.00; 7d total = 3.00 + 0.50 + 0.50 = 4.00 -> avg = 0.571429
    for (const [at, cost] of [
      ['2026-01-09T10:00:00.000Z', '1.00'],
      ['2026-01-09T20:00:00.000Z', '2.00'],
      ['2026-01-08T12:00:00.000Z', '0.50'],
      ['2026-01-07T12:00:00.000Z', '0.50'],
    ] as const) {
      await store.insertUsageEvent({
        agentId: agent.id,
        at,
        model: 'x',
        costUsd: cost,
        status: 'ok',
      });
    }
    const result = await burnDaily(store, agent.id, NOW);
    expect(result).toBe('3.000000'); // max(3.00, 0.571429, 0.01) = 3.00
    await store.close();
  });

  it('a higher 7-day average dominates when nothing was spent in the last 24h', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s02-b3-${Math.random()}`,
      name: 'b3',
      mode: 'dry_run',
    });
    // last 24h: nothing; 7d total = 0.70*3 = 2.10 -> avg = 0.300000
    for (const [at, cost] of [
      ['2026-01-08T00:00:00.000Z', '0.70'],
      ['2026-01-07T00:00:00.000Z', '0.70'],
      ['2026-01-06T00:00:00.000Z', '0.70'],
    ] as const) {
      await store.insertUsageEvent({
        agentId: agent.id,
        at,
        model: 'x',
        costUsd: cost,
        status: 'ok',
      });
    }
    const result = await burnDaily(store, agent.id, NOW);
    expect(result).toBe('0.300000'); // max(0, 0.3, 0.01) = 0.3
    await store.close();
  });

  it('history older than 7 days never counts (falls back to ε)', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s02-b4-${Math.random()}`,
      name: 'b4',
      mode: 'dry_run',
    });
    await store.insertUsageEvent({
      agentId: agent.id,
      at: '2025-12-20T00:00:00.000Z', // ~21 days before NOW
      model: 'x',
      costUsd: '999.00',
      status: 'ok',
    });
    const result = await burnDaily(store, agent.id, NOW);
    expect(result).toBe('0.010000');
    await store.close();
  });

  it('epsilon is overridable', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s02-b5-${Math.random()}`,
      name: 'b5',
      mode: 'dry_run',
    });
    const result = await burnDaily(store, agent.id, NOW, '5.000000');
    expect(result).toBe('5.000000');
    await store.close();
  });
});

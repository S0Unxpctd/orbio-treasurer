/**
 * computeSnapshotMetrics — table-driven unit tests (T-011, PRD FR-1.3, FR-3.3).
 * AC2: "Table tests: zero burn, zero accrual, accrual>burn (runway null=∞), ε floor,
 * low_confidence < 6h."
 */
import { describe, expect, it } from 'vitest';
import { computeSnapshotMetrics, DEFAULT_EPSILON_USD_PER_DAY } from './metrics.js';

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

/**
 * SCRATCH — T-015 audit pass 1. Hand-derived from PRD §10 + FR-4.7/4.8, DEFAULT_POLICY values.
 * Not part of the builder's suite. Deleted after the audit run; findings copied into
 * tasks/reports/T-015-audit-1.md. Does not modify any source file.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './defaults.js';
import { evaluate } from './evaluate.js';
import type { EvaluateInput } from './types.js';

const base: EvaluateInput = {
  creditsAvailableUsd: '100',
  accrualRateUsdPerDay: '5',
  burnRateUsdPerDay: '3',
  book: { buyAvailable: false, bestDiscountPct: null, depthAtBestUsd: null },
  stake: {
    available: false,
    stableBalanceUsd: '0',
    orbioPriceUsd: '1',
    yieldPerTokenPerDay: '0',
    yieldLowConfidence: false,
  },
  caps: { boughtTodayUsd: '0', stakedTodayUsd: '0' },
  keyStatus: { valid: true },
  tick: { gapMinutes: 5, mcpReachable: true, mcpPreviouslyReachable: true },
  hysteresis: { previousEffectiveState: null, consecutiveRawTicks: 1 },
  prebuy: { forecastUsdNextWindow: null, windowDeadlineLabel: null },
  policy: DEFAULT_POLICY,
};

describe('T-015 audit hand-derivations vs §10', () => {
  it('1. net_burn=0 (accrual>=burn) -> COMFORTABLE, ROUTE frontier', () => {
    const d = evaluate(base);
    expect(d).toHaveLength(1);
    expect(d[0]?.action).toEqual({ kind: 'ROUTE', tier: 'frontier' });
    expect(d[0]?.stateAfter).toBe('COMFORTABLE');
  });

  it('2. raw TIGHT but consecutiveRawTicks=1, prevEffective=COMFORTABLE -> hysteresis suppresses entry (stays COMFORTABLE, no ALERT_TIGHT)', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '15',
      accrualRateUsdPerDay: '1',
      burnRateUsdPerDay: '6', // net_burn=5, runway=15/5=3 = tight_days -> raw TIGHT
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    expect(d).toHaveLength(1);
    expect(d[0]?.stateAfter).toBe('COMFORTABLE');
    expect(d[0]?.action).toEqual({ kind: 'ROUTE', tier: 'frontier' });
  });

  it('3. same raw TIGHT, consecutiveRawTicks=2 -> entry confirmed, ALERT_TIGHT fires', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '15',
      accrualRateUsdPerDay: '1',
      burnRateUsdPerDay: '6',
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 2 },
    };
    const d = evaluate(input);
    expect(d.map((x) => x.type)).toEqual(['ROUTE', 'ALERT_TIGHT']);
    expect(d[0]?.stateAfter).toBe('TIGHT');
  });

  it('4. raw DEFICIT, consecutiveRawTicks=1, prevEffective=COMFORTABLE -> immediate entry (no debounce), need=25, no adapters -> SIGNAL_FUND + ALERT_DEFICIT_UNFUNDED', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '5',
      accrualRateUsdPerDay: '0',
      burnRateUsdPerDay: '10', // net_burn=10, runway=0.5 -> DEFICIT
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    expect(d[0]?.stateAfter).toBe('DEFICIT'); // immediate, unlike TIGHT
    const signal = d.find((x) => x.type === 'SIGNAL_FUND');
    // need = tight_days(3)*burn(10) - credits(5) = 25
    expect(signal?.action).toEqual({
      kind: 'SIGNAL_FUND',
      amountUsd: '25.000000',
      deadlineLabel: null,
      reason: 'deficit_unfunded',
    });
    expect(d.map((x) => x.type)).toContain('ALERT_DEFICIT_UNFUNDED');
  });

  it('5. DEFICIT with BUY_CREDIT available -> usd=min(need,budget), cost=1-discount', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '5',
      accrualRateUsdPerDay: '0',
      burnRateUsdPerDay: '10',
      book: { buyAvailable: true, bestDiscountPct: '40', depthAtBestUsd: '50' },
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    const buy = d.find((x) => x.type === 'BUY_CREDIT');
    // need=25, budget=maxBuyUsdPerDay(10)-bought(0)=10 -> usd=min(25,10)=10; cost=1-0.40=0.60
    expect(buy?.action).toEqual({ kind: 'BUY_CREDIT', usd: '10.000000', costPerUsd: '0.600000' });
    expect(buy?.ruleId).toBe('R-BUY-1');
  });

  it('6. DEFICIT, stake-only, payback_days > stake_payback_max_days -> STAKE_UP gated out, falls to SIGNAL_FUND', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '5',
      accrualRateUsdPerDay: '0',
      burnRateUsdPerDay: '10',
      stake: {
        available: true,
        stableBalanceUsd: '50',
        orbioPriceUsd: '2',
        yieldPerTokenPerDay: '0.05',
        yieldLowConfidence: false,
      },
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    // spendable=50-5(reserve)=45; capBudget=10-0=10; budget=min(10,45)=10 (>=minSwap5)
    // tokens=10/2=5; addedAccrual=5*0.05=0.25; payback=10/max(0.25,0.01)=40 > 30 -> rejected
    expect(d.find((x) => x.type === 'STAKE_UP')).toBeUndefined();
    expect(d.find((x) => x.type === 'SIGNAL_FUND')).toBeDefined();
  });

  it('7. same but yield high enough -> payback<=30 -> STAKE_UP chosen (book unavailable)', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '5',
      accrualRateUsdPerDay: '0',
      burnRateUsdPerDay: '10',
      stake: {
        available: true,
        stableBalanceUsd: '50',
        orbioPriceUsd: '2',
        yieldPerTokenPerDay: '0.5',
        yieldLowConfidence: false,
      },
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    // tokens=5; addedAccrual=5*0.5=2.5; payback=10/2.5=4
    const stake = d.find((x) => x.type === 'STAKE_UP');
    expect(stake?.action).toEqual({
      kind: 'STAKE_UP',
      usd: '10.000000',
      paybackDays: '4.000000',
      yieldLowConfidence: false,
    });
  });

  it('8. caps: bought_today already at cap -> BUY_CREDIT unavailable even though book present; STAKE_UP chosen instead', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '5',
      accrualRateUsdPerDay: '0',
      burnRateUsdPerDay: '10',
      book: { buyAvailable: true, bestDiscountPct: '40', depthAtBestUsd: '50' },
      caps: { boughtTodayUsd: '10', stakedTodayUsd: '0' }, // == maxBuyUsdPerDay -> budget=0
      stake: {
        available: true,
        stableBalanceUsd: '50',
        orbioPriceUsd: '2',
        yieldPerTokenPerDay: '0.5',
        yieldLowConfidence: false,
      },
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    expect(d.find((x) => x.type === 'BUY_CREDIT')).toBeUndefined();
    expect(d.find((x) => x.type === 'STAKE_UP')).toBeDefined();
  });

  it('9. FR-4.8 prebuy fires even in COMFORTABLE when forecast > credits-reserve and discount>=25%', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '5',
      accrualRateUsdPerDay: '2',
      burnRateUsdPerDay: '1', // net_burn=0 -> COMFORTABLE
      book: { buyAvailable: true, bestDiscountPct: '30', depthAtBestUsd: '50' },
      prebuy: { forecastUsdNextWindow: '20', windowDeadlineLabel: 'Monday 06:00' },
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    expect(d[0]?.stateAfter).toBe('COMFORTABLE');
    // available = credits(5) - reserve(0) = 5; shortfall = 20-5=15; budget=10-0=10; usd=min(15,10)=10
    const prebuy = d.find((x) => x.ruleId === 'R-PREBUY-1');
    expect(prebuy?.action).toEqual({ kind: 'BUY_CREDIT', usd: '10.000000', costPerUsd: '0.700000' });
  });

  it('10. FR-4.8: discount below prebuy_min_discount(25) -> no prebuy', () => {
    const input: EvaluateInput = {
      ...base,
      creditsAvailableUsd: '5',
      accrualRateUsdPerDay: '2',
      burnRateUsdPerDay: '1',
      book: { buyAvailable: true, bestDiscountPct: '24', depthAtBestUsd: '50' },
      prebuy: { forecastUsdNextWindow: '20', windowDeadlineLabel: 'Monday 06:00' },
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    };
    const d = evaluate(input);
    expect(d.find((x) => x.ruleId === 'R-PREBUY-1')).toBeUndefined();
  });
});

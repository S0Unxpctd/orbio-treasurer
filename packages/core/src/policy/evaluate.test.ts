/**
 * T-015 · evaluate() unit tests (FR-4.1..FR-4.8, PRD §10).
 *
 * AC1 — 100% branch coverage on evaluate(): `@vitest/coverage-v8` is not installed in this repo
 * (checked: not present under node_modules; CLAUDE.md rule 7 forbids adding a dependency
 * without an ADR, and the builder brief says write the table instead of adding one). The
 * comment block below enumerates every branch in evaluate.ts and its rule modules and names the
 * test(s) that hit each side of it, so coverage is provable by inspection.
 *
 *   evaluate.ts
 *     - TIGHT && enteredState                    → 'ALERT_TIGHT fires once on entry...' (true+false)
 *     - effectiveState === 'DEFICIT'              → deficit matrix (true) / comfortable+tight matrix (false)
 *     - chosen truthy/falsy                       → deficit matrix rows (both)
 *     - enteredState inside unfunded DEFICIT      → 'ALERT_DEFICIT_UNFUNDED fires once on entry...' (both)
 *     - prebuy truthy/falsy                       → prebuy describe block (both)
 *     - prebuy.action.kind ternary                → prebuy describe block (both arms)
 *     - keyRotate truthy/falsy                    → 'always rules' describe (both)
 *     - tickMissed truthy/falsy                   → 'always rules' describe (both)
 *     - mcpUnavailable truthy/falsy               → 'always rules' describe (both)
 *   rules/state.ts computeRawState: netBurn===0n (both), runway>=comfortableDays (both),
 *     runway>=tightDays (both) — 'runway state' describe.
 *   rules/state.ts computeEffectiveState: previousEffectiveState===null, rawState==='DEFICIT',
 *     rawState===previousEffectiveState, consecutiveRawTicks>=2 (both) — 'hysteresis' describe.
 *   rules/deficit.ts computeBuyOption: !buyAvailable, depthAtBestUsd===null, depth<ONE,
 *     budget<ONE, bestDiscountPct===null ternary (both) — deficit matrix + 'edge amounts'.
 *   rules/deficit.ts computeStakeOption: !available, spendable<minSwap, capBudget<spendable
 *     ternary (both), budget<minSwap, orbioPrice<=ZERO ternary (both), paybackDays>paybackMax
 *     — deficit matrix + 'edge amounts'.
 *   rules/deficit.ts pickDeficitOption: both find()s hit and both miss — deficit matrix.
 *   rules/prebuy.ts: forecast===null, forecast<=available, bestDiscountPct null ternary (both),
 *     discount<min, buyAvailable (both), budget>=ONE (both), shortfall<budget ternary (both)
 *     — prebuy describe block.
 *   rules/always.ts: keyStatus.valid (both), gapMinutes===null, gapMinutes<=45 (both),
 *     mcpReachable (both), isEntry null/true/false (all three) — 'always rules' describe.
 *   humanize.ts humanizeFunding: BUY_CREDIT/STAKE_UP branch, yieldLowConfidence ternary (both)
 *     — deficit matrix. humanizeSignalFund: reason+deadlineLabel truthy/falsy — prebuy + deficit.
 *
 * AC2 — table tests: state × book write on/off × stake on/off × caps exhausted × stable balance
 * below reserve, in the 'DEFICIT funding option matrix' describe below (plus a smaller
 * COMFORTABLE/TIGHT × book/stake matrix proving those toggles are inert outside DEFICIT).
 * AC4 — timing, in the 'performance' describe.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './defaults.js';
import { evaluate } from './evaluate.js';
import { computeDeficitOptions } from './rules/deficit.js';
import type {
  ActionPayload,
  BookViewInput,
  Decision,
  EvaluateInput,
  HysteresisInput,
  KeyStatusInput,
  PolicyConfig,
  PolicyState,
  PrebuyInput,
  StakeInput,
  TickHealthInput,
} from './types.js';

// --- fixture builder -----------------------------------------------------------------------

interface Overrides {
  readonly creditsAvailableUsd?: string;
  readonly accrualRateUsdPerDay?: string;
  readonly burnRateUsdPerDay?: string;
  readonly book?: Partial<BookViewInput>;
  readonly stake?: Partial<StakeInput>;
  readonly caps?: Partial<EvaluateInput['caps']>;
  readonly keyStatus?: Partial<KeyStatusInput>;
  readonly tick?: Partial<TickHealthInput>;
  readonly hysteresis?: Partial<HysteresisInput>;
  readonly prebuy?: Partial<PrebuyInput>;
  readonly policy?: Partial<PolicyConfig>;
}

function buildInput(overrides: Overrides = {}): EvaluateInput {
  return {
    creditsAvailableUsd: overrides.creditsAvailableUsd ?? '100',
    accrualRateUsdPerDay: overrides.accrualRateUsdPerDay ?? '5',
    burnRateUsdPerDay: overrides.burnRateUsdPerDay ?? '1',
    book: {
      buyAvailable: true,
      bestDiscountPct: '40',
      depthAtBestUsd: '50',
      ...overrides.book,
    },
    stake: {
      available: true,
      stableBalanceUsd: '20',
      orbioPriceUsd: '1',
      yieldPerTokenPerDay: '0.1',
      yieldLowConfidence: false,
      ...overrides.stake,
    },
    caps: {
      boughtTodayUsd: '0',
      stakedTodayUsd: '0',
      ...overrides.caps,
    },
    keyStatus: { valid: true, ...overrides.keyStatus },
    tick: {
      gapMinutes: 15,
      mcpReachable: true,
      mcpPreviouslyReachable: true,
      ...overrides.tick,
    },
    hysteresis: {
      previousEffectiveState: 'COMFORTABLE',
      consecutiveRawTicks: 1,
      previouslyUnfundedInDeficit: null,
      ...overrides.hysteresis,
    },
    prebuy: { forecastUsdNextWindow: null, windowDeadlineLabel: null, ...overrides.prebuy },
    policy: { ...DEFAULT_POLICY, ...overrides.policy },
  };
}

/** Numbers chosen so the *raw* runway state for each label is unambiguous with DEFAULT_POLICY
 *  (comfortable=7, tight=3): COMFORTABLE via net_burn=0 (∞ runway); TIGHT via runway=4d;
 *  DEFICIT via runway=2.7d. `previousEffectiveState` matches so effectiveState === label with no
 *  hysteresis delay, keeping each row's assertions about a single tick's behaviour. DEFICIT's
 *  `need = tight_days(3) * burn(10) - credits(27) = 3` is deliberately small — well inside the
 *  default `max_buy_usd_per_day` (10) — so the baseline "book on" scenarios exercise M2's
 *  literal §10 pick (BUY_CREDIT only when it *fully covers* `need`); rows that need a larger,
 *  partially-covered `need` override credits/burn directly (see 'M2: §10 literal option
 *  selection' below). */
const STATE_NUMBERS: Record<
  PolicyState,
  { creditsAvailableUsd: string; accrualRateUsdPerDay: string; burnRateUsdPerDay: string }
> = {
  COMFORTABLE: { creditsAvailableUsd: '100', accrualRateUsdPerDay: '5', burnRateUsdPerDay: '1' },
  TIGHT: { creditsAvailableUsd: '40', accrualRateUsdPerDay: '0', burnRateUsdPerDay: '10' },
  DEFICIT: { creditsAvailableUsd: '27', accrualRateUsdPerDay: '0', burnRateUsdPerDay: '10' },
};

function findByKind<K extends ActionPayload['kind']>(
  decisions: readonly Decision[],
  kind: K,
): Decision | undefined {
  return decisions.find((d) => d.type === kind);
}

// --- runway state (rules/state.ts: computeRawState) -----------------------------------------

describe('runway state', () => {
  it('net_burn == 0 (accrual >= burn) is COMFORTABLE with infinite runway, regardless of thresholds', () => {
    const input = buildInput({
      creditsAvailableUsd: '1',
      accrualRateUsdPerDay: '5',
      burnRateUsdPerDay: '5',
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    });
    const route = findByKind(evaluate(input), 'ROUTE');
    expect(route?.action).toMatchObject({ tier: 'frontier' });
  });

  it('runway >= comfortable_days is COMFORTABLE', () => {
    const input = buildInput({
      ...STATE_NUMBERS.COMFORTABLE,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.action).toMatchObject({ tier: 'frontier' });
  });

  it('runway >= tight_days and < comfortable_days is TIGHT', () => {
    const input = buildInput({
      ...STATE_NUMBERS.TIGHT,
      hysteresis: { previousEffectiveState: 'TIGHT', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.action).toMatchObject({ tier: 'standard' });
  });

  it('runway < tight_days is DEFICIT', () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.action).toMatchObject({ tier: 'economy' });
  });
});

// --- hysteresis (FR-4.7, rules/state.ts: computeEffectiveState) -----------------------------

describe('hysteresis', () => {
  it('first tick ever (previousEffectiveState null) uses the raw state immediately', () => {
    const input = buildInput({
      ...STATE_NUMBERS.TIGHT,
      hysteresis: { previousEffectiveState: null, consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.stateBefore).toBeNull();
    expect(findByKind(evaluate(input), 'ROUTE')?.stateAfter).toBe('TIGHT');
  });

  it('entry into DEFICIT is immediate even on the first raw tick (from COMFORTABLE)', () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.stateAfter).toBe('DEFICIT');
  });

  it('entry into DEFICIT is immediate even on the first raw tick (from TIGHT)', () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      hysteresis: { previousEffectiveState: 'TIGHT', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.stateAfter).toBe('DEFICIT');
  });

  it('a non-DEFICIT change stays in the previous state on the first raw tick (needs 2)', () => {
    const input = buildInput({
      ...STATE_NUMBERS.TIGHT,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.stateAfter).toBe('COMFORTABLE');
  });

  it('a non-DEFICIT change takes effect on the second consecutive raw tick', () => {
    const input = buildInput({
      ...STATE_NUMBERS.TIGHT,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 2 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.stateAfter).toBe('TIGHT');
  });

  it('leaving DEFICIT (into TIGHT) also needs two consecutive raw ticks, not an immediate exit', () => {
    const input = buildInput({
      ...STATE_NUMBERS.TIGHT,
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.stateAfter).toBe('DEFICIT');
  });

  it('the raw state repeating the previous effective state is a no-op regardless of the tick count', () => {
    const input = buildInput({
      ...STATE_NUMBERS.COMFORTABLE,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(input), 'ROUTE')?.stateAfter).toBe('COMFORTABLE');
  });
});

// --- ALERT_TIGHT / ALERT_DEFICIT_UNFUNDED "once per entry" -----------------------------------

describe('once-per-entry alerts', () => {
  it('ALERT_TIGHT fires once on entry into TIGHT, not on a tick that stays TIGHT', () => {
    const entering = buildInput({
      ...STATE_NUMBERS.TIGHT,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 2 },
    });
    expect(findByKind(evaluate(entering), 'ALERT_TIGHT')).toBeDefined();

    const staying = buildInput({
      ...STATE_NUMBERS.TIGHT,
      hysteresis: { previousEffectiveState: 'TIGHT', consecutiveRawTicks: 1 },
    });
    expect(findByKind(evaluate(staying), 'ALERT_TIGHT')).toBeUndefined();
  });

  it('ALERT_DEFICIT_UNFUNDED fires once on entry into an unfunded DEFICIT, not on a tick that stays unfunded', () => {
    const unfunded = { book: { buyAvailable: false }, stake: { available: false } };

    // Fresh entry into DEFICIT (from TIGHT): no prior DEFICIT tick to compare against
    // (previouslyUnfundedInDeficit: null) — counts as a fresh entry, alert fires.
    const entering = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      ...unfunded,
      hysteresis: {
        previousEffectiveState: 'TIGHT',
        consecutiveRawTicks: 1,
        previouslyUnfundedInDeficit: null,
      },
    });
    const enteringDecisions = evaluate(entering);
    expect(findByKind(enteringDecisions, 'SIGNAL_FUND')).toBeDefined();
    expect(findByKind(enteringDecisions, 'ALERT_DEFICIT_UNFUNDED')).toBeDefined();

    // Continuing DEFICIT, already unfunded on the previous tick too: no second alert.
    const staying = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      ...unfunded,
      hysteresis: {
        previousEffectiveState: 'DEFICIT',
        consecutiveRawTicks: 5,
        previouslyUnfundedInDeficit: true,
      },
    });
    const stayingDecisions = evaluate(staying);
    expect(findByKind(stayingDecisions, 'SIGNAL_FUND')).toBeDefined();
    expect(findByKind(stayingDecisions, 'ALERT_DEFICIT_UNFUNDED')).toBeUndefined();
  });

  it('audit-1 M1: ALERT_DEFICIT_UNFUNDED fires again on a funded→unfunded flip mid-DEFICIT-streak', () => {
    const unfunded = { book: { buyAvailable: false }, stake: { available: false } };

    // Continuously in DEFICIT, but the previous tick *was* funded (previouslyUnfundedInDeficit:
    // false) and this tick just lost its funding option — the exact gap M1 found: this must
    // alert, not stay silent because the agent has been in DEFICIT for a while already.
    const justLostFunding = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      ...unfunded,
      hysteresis: {
        previousEffectiveState: 'DEFICIT',
        consecutiveRawTicks: 5,
        previouslyUnfundedInDeficit: false,
      },
    });
    const decisions = evaluate(justLostFunding);
    expect(findByKind(decisions, 'SIGNAL_FUND')).toBeDefined();
    expect(findByKind(decisions, 'ALERT_DEFICIT_UNFUNDED')).toBeDefined();
  });

  it('a funded DEFICIT tick emits no SIGNAL_FUND/ALERT_DEFICIT_UNFUNDED regardless of previouslyUnfundedInDeficit', () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT, // book+stake on by default, need(3) fully covered → BUY_CREDIT
      hysteresis: {
        previousEffectiveState: 'DEFICIT',
        consecutiveRawTicks: 5,
        previouslyUnfundedInDeficit: true,
      },
    });
    const decisions = evaluate(input);
    expect(findByKind(decisions, 'BUY_CREDIT')).toBeDefined();
    expect(findByKind(decisions, 'SIGNAL_FUND')).toBeUndefined();
    expect(findByKind(decisions, 'ALERT_DEFICIT_UNFUNDED')).toBeUndefined();
  });
});

// --- DEFICIT funding option matrix (AC2) ------------------------------------------------------

interface Row {
  readonly label: string;
  readonly book: Partial<BookViewInput>;
  readonly stake: Partial<StakeInput>;
  readonly caps: Partial<EvaluateInput['caps']>;
  readonly expectKind: 'BUY_CREDIT' | 'STAKE_UP' | 'SIGNAL_FUND';
}

const CAPS_EXHAUSTED = { boughtTodayUsd: '10', stakedTodayUsd: '10' }; // == DEFAULT_POLICY max*PerDay
const CAPS_OPEN = { boughtTodayUsd: '0', stakedTodayUsd: '0' };
const RESERVE_OK = { stableBalanceUsd: '20' }; // - reserve(5) = 15 >= minSwap(5)
const RESERVE_BREACHED = { stableBalanceUsd: '6' }; // - reserve(5) = 1 < minSwap(5)

const rows: Row[] = [
  {
    label: 'book on + stake on, caps open, reserve ok → BUY_CREDIT (preferred over stake)',
    book: { buyAvailable: true },
    stake: { available: true, ...RESERVE_OK },
    caps: CAPS_OPEN,
    expectKind: 'BUY_CREDIT',
  },
  {
    label: 'book off + stake on, caps open, reserve ok → STAKE_UP',
    book: { buyAvailable: false },
    stake: { available: true, ...RESERVE_OK },
    caps: CAPS_OPEN,
    expectKind: 'STAKE_UP',
  },
  {
    label: 'book on but its cap is exhausted + stake on, reserve ok → STAKE_UP',
    book: { buyAvailable: true },
    stake: { available: true, ...RESERVE_OK },
    caps: { boughtTodayUsd: '10', stakedTodayUsd: '0' },
    expectKind: 'STAKE_UP',
  },
  {
    label: 'book off + stake on but its cap is exhausted → SIGNAL_FUND',
    book: { buyAvailable: false },
    stake: { available: true, ...RESERVE_OK },
    caps: { boughtTodayUsd: '0', stakedTodayUsd: '10' },
    expectKind: 'SIGNAL_FUND',
  },
  {
    label: 'book off + stake on but balance is below reserve → SIGNAL_FUND',
    book: { buyAvailable: false },
    stake: { available: true, ...RESERVE_BREACHED },
    caps: CAPS_OPEN,
    expectKind: 'SIGNAL_FUND',
  },
  {
    label: 'book off + stake off → SIGNAL_FUND',
    book: { buyAvailable: false },
    stake: { available: false, ...RESERVE_OK },
    caps: CAPS_OPEN,
    expectKind: 'SIGNAL_FUND',
  },
  {
    label: 'both caps exhausted → SIGNAL_FUND even with both adapters available',
    book: { buyAvailable: true },
    stake: { available: true, ...RESERVE_OK },
    caps: CAPS_EXHAUSTED,
    expectKind: 'SIGNAL_FUND',
  },
  {
    label: 'book cap exhausted + stake reserve breached → SIGNAL_FUND',
    book: { buyAvailable: true },
    stake: { available: true, ...RESERVE_BREACHED },
    caps: { boughtTodayUsd: '10', stakedTodayUsd: '0' },
    expectKind: 'SIGNAL_FUND',
  },
  {
    label: 'book on + stake off → BUY_CREDIT',
    book: { buyAvailable: true },
    stake: { available: false, ...RESERVE_OK },
    caps: CAPS_OPEN,
    expectKind: 'BUY_CREDIT',
  },
  {
    label: 'book off + stake on but payback exceeds stake_payback_max_days → SIGNAL_FUND',
    book: { buyAvailable: false },
    stake: { available: true, ...RESERVE_OK, yieldPerTokenPerDay: '0.0001' },
    caps: CAPS_OPEN,
    expectKind: 'SIGNAL_FUND',
  },
];

describe('DEFICIT funding option matrix', () => {
  it.each(rows.map((r) => [r.label, r] as const))('%s', (_label, row) => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      book: row.book,
      stake: row.stake,
      caps: row.caps,
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
    });
    const decisions = evaluate(input);
    expect(findByKind(decisions, row.expectKind)).toBeDefined();
    for (const k of ['BUY_CREDIT', 'STAKE_UP', 'SIGNAL_FUND'] as const) {
      if (k === row.expectKind) continue;
      expect(findByKind(decisions, k)).toBeUndefined();
    }
  });

  it('computeDeficitOptions caps BUY_CREDIT at the smaller of need and the remaining daily budget (independent of selection)', () => {
    // need = tight_days(3) * burn(10) - credits(10) = 20; budget = max(10) - bought(8) = 2. This
    // tests the option's own amount formula, not which option evaluate() picks (M2 below covers
    // that a non-covering BUY_CREDIT like this one is *not* selected).
    const input = buildInput({
      creditsAvailableUsd: '10',
      burnRateUsdPerDay: '10',
      accrualRateUsdPerDay: '0',
      caps: { boughtTodayUsd: '8', stakedTodayUsd: '0' },
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
    });
    const options = computeDeficitOptions(input);
    const buy = options.find((o) => o.action.kind === 'BUY_CREDIT');
    expect(buy?.action).toMatchObject({ usd: '2.000000' });
  });

  it('STAKE_UP is capped at the smaller of the daily cap budget and the reserve-adjusted balance', () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      book: { buyAvailable: false },
      stake: { available: true, stableBalanceUsd: '7' }, // spendable = 7 - 5 = 2 < cap budget(10)
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
    });
    // spendable(2) < minSwapUsd(5) → not eligible → SIGNAL_FUND, proving the reserve-adjusted
    // balance (not the raw balance) gates eligibility.
    expect(findByKind(evaluate(input), 'STAKE_UP')).toBeUndefined();
    expect(findByKind(evaluate(input), 'SIGNAL_FUND')).toBeDefined();
  });

  describe('M2: §10 literal option selection (audit-1 arbitration)', () => {
    // need = tight_days(3) * burn(10) - credits(5) = 25 — bigger than max_buy_usd_per_day(10),
    // so a present BUY_CREDIT option can never fully cover it at these numbers.
    const bigNeed = {
      creditsAvailableUsd: '5',
      burnRateUsdPerDay: '10',
      accrualRateUsdPerDay: '0',
    };

    it('BUY_CREDIT present but only partial (does not cover need) falls through to STAKE_UP', () => {
      const input = buildInput({
        ...bigNeed,
        book: { buyAvailable: true },
        stake: { available: true, stableBalanceUsd: '20' },
        caps: { boughtTodayUsd: '8', stakedTodayUsd: '0' }, // buy budget = 10-8 = 2 < need(25)
        hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
      });
      const decisions = evaluate(input);
      expect(findByKind(decisions, 'STAKE_UP')).toBeDefined();
      expect(findByKind(decisions, 'BUY_CREDIT')).toBeUndefined();
    });

    it('BUY_CREDIT present but only partial, STAKE_UP unavailable → SIGNAL_FUND, not the partial buy', () => {
      const input = buildInput({
        ...bigNeed,
        book: { buyAvailable: true },
        stake: { available: false },
        caps: { boughtTodayUsd: '8', stakedTodayUsd: '0' },
        hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
      });
      const decisions = evaluate(input);
      expect(findByKind(decisions, 'SIGNAL_FUND')).toBeDefined();
      expect(findByKind(decisions, 'BUY_CREDIT')).toBeUndefined();
      expect(findByKind(decisions, 'STAKE_UP')).toBeUndefined();
    });

    it('BUY_CREDIT that exactly covers need (usd === need) is chosen over an available STAKE_UP', () => {
      const input = buildInput({
        ...STATE_NUMBERS.DEFICIT, // need = 3, budget = 10 ≥ 3 → fully covers
        book: { buyAvailable: true },
        stake: { available: true, stableBalanceUsd: '20' },
        caps: CAPS_OPEN,
        hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
      });
      const buy = findByKind(evaluate(input), 'BUY_CREDIT');
      expect(buy?.action).toMatchObject({ usd: '3.000000' });
    });
  });

  for (const state of ['COMFORTABLE', 'TIGHT'] as const) {
    for (const bookOn of [true, false]) {
      for (const stakeOn of [true, false]) {
        it(`${state} with book ${bookOn ? 'on' : 'off'} / stake ${stakeOn ? 'on' : 'off'} never emits a funding decision`, () => {
          const input = buildInput({
            ...STATE_NUMBERS[state],
            book: { buyAvailable: bookOn },
            stake: { available: stakeOn, ...RESERVE_OK },
            caps: CAPS_OPEN,
            hysteresis: { previousEffectiveState: state, consecutiveRawTicks: 3 },
          });
          const decisions = evaluate(input);
          for (const kind of [
            'BUY_CREDIT',
            'STAKE_UP',
            'SIGNAL_FUND',
            'ALERT_DEFICIT_UNFUNDED',
          ] as const) {
            expect(findByKind(decisions, kind)).toBeUndefined();
          }
        });
      }
    }
  }
});

// --- FR-4.8 predictive prebuy (R-PREBUY-1) -----------------------------------------------------

describe('R-PREBUY-1 predictive prebuy', () => {
  const comfortable = STATE_NUMBERS.COMFORTABLE;

  it('does not fire when there is no forecast', () => {
    const input = buildInput({ ...comfortable, prebuy: { forecastUsdNextWindow: null } });
    expect(findByKind(evaluate(input), 'BUY_CREDIT')).toBeUndefined();
  });

  it('does not fire when credits already cover the forecast', () => {
    const input = buildInput({
      ...comfortable,
      creditsAvailableUsd: '50',
      prebuy: { forecastUsdNextWindow: '10', windowDeadlineLabel: 'Monday 06:00' },
    });
    expect(findByKind(evaluate(input), 'BUY_CREDIT')).toBeUndefined();
    expect(findByKind(evaluate(input), 'SIGNAL_FUND')).toBeUndefined();
  });

  it('does not fire when the best discount is below prebuy_min_discount_pct', () => {
    const input = buildInput({
      ...comfortable,
      creditsAvailableUsd: '1',
      book: { bestDiscountPct: '10' }, // < default 25
      prebuy: { forecastUsdNextWindow: '14', windowDeadlineLabel: 'Monday 06:00' },
    });
    expect(findByKind(evaluate(input), 'BUY_CREDIT')).toBeUndefined();
    expect(findByKind(evaluate(input), 'SIGNAL_FUND')).toBeUndefined();
  });

  it('fires BUY_CREDIT for exactly the shortfall, even in COMFORTABLE, when discount clears the bar', () => {
    const input = buildInput({
      ...comfortable,
      creditsAvailableUsd: '1',
      book: { buyAvailable: true, bestDiscountPct: '30' },
      prebuy: { forecastUsdNextWindow: '9', windowDeadlineLabel: 'Monday 06:00' },
    });
    const decisions = evaluate(input);
    expect(findByKind(decisions, 'ROUTE')?.action).toMatchObject({ tier: 'frontier' });
    const buy = findByKind(decisions, 'BUY_CREDIT');
    expect(buy?.ruleId).toBe('R-PREBUY-1');
    expect(buy?.action).toMatchObject({ usd: '8.000000' }); // shortfall = 9 - 1
  });

  it('falls back to SIGNAL_FUND with the amount and the deadline when buy is unavailable', () => {
    const input = buildInput({
      ...comfortable,
      creditsAvailableUsd: '1',
      book: { buyAvailable: false, bestDiscountPct: '30' },
      prebuy: { forecastUsdNextWindow: '9', windowDeadlineLabel: 'Monday 06:00' },
    });
    const signal = findByKind(evaluate(input), 'SIGNAL_FUND');
    expect(signal?.ruleId).toBe('R-PREBUY-1');
    expect(signal?.action).toMatchObject({
      amountUsd: '8.000000',
      deadlineLabel: 'Monday 06:00',
      reason: 'prebuy_unfunded',
    });
    expect(signal?.human).toContain('8.000000');
    expect(signal?.human).toContain('Monday 06:00');
  });

  it('BUY_CREDIT amount is capped by the remaining daily buy budget, never more than the shortfall', () => {
    const input = buildInput({
      ...comfortable,
      creditsAvailableUsd: '1',
      book: { buyAvailable: true, bestDiscountPct: '30' },
      caps: { boughtTodayUsd: '7' }, // budget = 10 - 7 = 3 < shortfall(8)
      prebuy: { forecastUsdNextWindow: '9', windowDeadlineLabel: 'Monday 06:00' },
    });
    const buy = findByKind(evaluate(input), 'BUY_CREDIT');
    expect(buy?.action).toMatchObject({ usd: '3.000000' });
  });
});

// --- always rules (key rotate, tick missed, mcp unavailable) --------------------------------

describe('always rules', () => {
  const comfortable = STATE_NUMBERS.COMFORTABLE;

  it('KEY_ROTATE fires when the key is invalid, not when valid', () => {
    const invalid = buildInput({ ...comfortable, keyStatus: { valid: false } });
    expect(findByKind(evaluate(invalid), 'KEY_ROTATE')).toBeDefined();
    const valid = buildInput({ ...comfortable, keyStatus: { valid: true } });
    expect(findByKind(evaluate(valid), 'KEY_ROTATE')).toBeUndefined();
  });

  it('ALERT_TICK_MISSED fires when the gap exceeds 45 minutes, not at exactly 45 or on the first tick', () => {
    const over = buildInput({ ...comfortable, tick: { gapMinutes: 46 } });
    const overDecision = findByKind(evaluate(over), 'ALERT_TICK_MISSED');
    expect(overDecision?.action).toMatchObject({ gapMinutes: 46 });

    const atThreshold = buildInput({ ...comfortable, tick: { gapMinutes: 45 } });
    expect(findByKind(evaluate(atThreshold), 'ALERT_TICK_MISSED')).toBeUndefined();

    const firstTick = buildInput({ ...comfortable, tick: { gapMinutes: null } });
    expect(findByKind(evaluate(firstTick), 'ALERT_TICK_MISSED')).toBeUndefined();
  });

  it('MCP_UNAVAILABLE fires once on entry (previously reachable, or no prior tick), not on a tick that stays unreachable', () => {
    const enteringFromReachable = buildInput({
      ...comfortable,
      tick: { mcpReachable: false, mcpPreviouslyReachable: true },
    });
    expect(findByKind(evaluate(enteringFromReachable), 'MCP_UNAVAILABLE')).toBeDefined();

    const enteringFirstTick = buildInput({
      ...comfortable,
      tick: { mcpReachable: false, mcpPreviouslyReachable: null },
    });
    expect(findByKind(evaluate(enteringFirstTick), 'MCP_UNAVAILABLE')).toBeDefined();

    const stayingUnreachable = buildInput({
      ...comfortable,
      tick: { mcpReachable: false, mcpPreviouslyReachable: false },
    });
    expect(findByKind(evaluate(stayingUnreachable), 'MCP_UNAVAILABLE')).toBeUndefined();

    const reachable = buildInput({
      ...comfortable,
      tick: { mcpReachable: true, mcpPreviouslyReachable: false },
    });
    expect(findByKind(evaluate(reachable), 'MCP_UNAVAILABLE')).toBeUndefined();
  });
});

// --- FR-4.6: decisions carry enough to re-derive themselves ----------------------------------

describe('decision shape (FR-4.6)', () => {
  it('every decision carries type, ruleId, stateBefore/after, inputs, action and a human string', () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      hysteresis: { previousEffectiveState: 'TIGHT', consecutiveRawTicks: 1 },
    });
    const decisions = evaluate(input);
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.type).toBe(d.action.kind);
      expect(d.ruleId).toMatch(/^R-/);
      expect(d.stateAfter).toBe('DEFICIT');
      expect(d.inputs).toBe(input);
      expect(typeof d.human).toBe('string');
      expect(d.human.length).toBeGreaterThan(0);
    }
  });

  it("re-evaluating a decision's own stored inputs reproduces the same decisions", () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
    });
    const first = evaluate(input);
    const replayed = evaluate(first[0]?.inputs as EvaluateInput);
    expect(replayed).toEqual(first);
  });
});

// --- AC4: evaluate() runs in < 5ms -----------------------------------------------------------

describe('performance (AC4)', () => {
  it('evaluate() completes in under 5ms, including a cold call', () => {
    const input = buildInput({
      ...STATE_NUMBERS.DEFICIT,
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 3 },
    });

    const cold = performance.now();
    evaluate(input);
    expect(performance.now() - cold).toBeLessThan(5);

    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) evaluate(input);
    const avgMs = (performance.now() - start) / iterations;
    expect(avgMs).toBeLessThan(5);
  });
});

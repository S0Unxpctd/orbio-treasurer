/**
 * `decide()` — S-06, tasks/S-06.md "In scope"/AC1: "table-driven tests ≥ 15 rows": mode
 * thresholds at the exact boundaries; buy sizing (deficit → capped usdg, ceil); no buy when live
 * off (action still emitted); stakeup trigger; claim trigger from each of the three balances; ∞
 * runway.
 */
import { describe, expect, it } from 'vitest';
import type { ChainSnapshot } from '../chain/read.js';
import {
  computeMode,
  computeRunwayDays,
  DEFAULT_SPRINT_POLICY_CONFIG,
  decide,
  INFINITE_RUNWAY_DAYS,
  type SprintDecideInput,
  type SprintPolicyConfig,
} from './sprint.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');

const BASE_SNAPSHOT: ChainSnapshot = {
  asOf: NOW.toISOString(),
  stakedOrbio: '0',
  settledCredit: '0',
  creditWalletHot: '0',
  creditWalletStaker: '0',
  usdgBalanceHot: '0',
  ethBalanceHot: '0',
  quote: null,
  totalStaked: '0',
  minPosition: '1000000000000000000000',
  period: '3600',
  rpcUrlHost: null,
  usedMulticall: true,
};

function baseInput(overrides: Partial<SprintDecideInput> = {}): SprintDecideInput {
  return {
    snapshot: BASE_SNAPSHOT,
    apiBalance: { available: '10', used: '0' },
    burnDaily: '1',
    callsSinceLastStakeup: 0,
    buysToday: 0,
    activatedToday: '0',
    claimable: '0',
    now: NOW,
    live: false,
    ...overrides,
  };
}

const CONFIG: SprintPolicyConfig = DEFAULT_SPRINT_POLICY_CONFIG;

describe('computeRunwayDays', () => {
  it('divides available by burnDaily', () => {
    expect(computeRunwayDays('10', '2')).toBe('5.000000');
  });

  it('treats burn === ε (0.01) and available > 0 as infinite (999)', () => {
    expect(computeRunwayDays('5', '0.01')).toBe(INFINITE_RUNWAY_DAYS);
    expect(INFINITE_RUNWAY_DAYS).toBe('999.000000');
  });

  it('a zero burn is also treated as infinite (defensive — burnDaily() never actually returns 0)', () => {
    expect(computeRunwayDays('5', '0')).toBe(INFINITE_RUNWAY_DAYS);
  });

  it('burn === ε but available === 0 is NOT infinite (0 / 0.01 = 0)', () => {
    expect(computeRunwayDays('0', '0.01')).toBe('0.000000');
  });
});

describe('computeMode — thresholds at the exact boundaries', () => {
  const rows: readonly [runway: string, expected: 'normal' | 'eco' | 'critical'][] = [
    ['2', 'normal'], // exactly RUNWAY_ECO_DAYS -> normal
    ['1.999999', 'eco'], // just under -> eco
    ['0.5', 'eco'], // exactly RUNWAY_CRITICAL_DAYS -> eco, not critical
    ['0.499999', 'critical'], // just under -> critical
    ['0', 'critical'],
    ['999.000000', 'normal'], // the ∞ sentinel
    ['100', 'normal'],
    ['0.500001', 'eco'],
  ];
  it.each(rows)('runway=%s -> mode=%s', (runway, expected) => {
    expect(computeMode(runway, CONFIG)).toBe(expected);
  });
});

describe('decide() — mode + runwayDays on the returned Decision', () => {
  it('normal at runway exactly 2d (available=2, burn=1)', () => {
    const result = decide(
      baseInput({ apiBalance: { available: '2', used: '0' }, burnDaily: '1' }),
      CONFIG,
    );
    expect(result.runwayDays).toBe('2.000000');
    expect(result.mode).toBe('normal');
  });

  it('eco just under 2d', () => {
    const result = decide(
      baseInput({ apiBalance: { available: '1.999999', used: '0' }, burnDaily: '1' }),
      CONFIG,
    );
    expect(result.mode).toBe('eco');
  });

  it('critical just under 0.5d', () => {
    const result = decide(
      baseInput({ apiBalance: { available: '0.499999', used: '0' }, burnDaily: '1' }),
      CONFIG,
    );
    expect(result.mode).toBe('critical');
  });

  it('infinite runway (burn === ε, available > 0) reports mode normal', () => {
    const result = decide(
      baseInput({ apiBalance: { available: '5', used: '0' }, burnDaily: '0.01' }),
      CONFIG,
    );
    expect(result.runwayDays).toBe(INFINITE_RUNWAY_DAYS);
    expect(result.mode).toBe('normal');
  });
});

describe('decide() — claim_activate: each of the three triggers, independently and combined', () => {
  it('no trigger when claimable=0 and both CREDIT wallets are 0 -> no claim_activate action', () => {
    const result = decide(baseInput(), CONFIG);
    expect(result.actions.find((a) => a.kind === 'claim_activate')).toBeUndefined();
  });

  it('claimable > 0 alone triggers claim_activate', () => {
    const result = decide(baseInput({ claimable: '5' }), CONFIG);
    const action = result.actions.find((a) => a.kind === 'claim_activate');
    expect(action?.reason).toBe('claimable_settled');
  });

  it('staker CREDIT wallet > 0 alone triggers claim_activate', () => {
    const result = decide(
      baseInput({ snapshot: { ...BASE_SNAPSHOT, creditWalletStaker: '1000000' } }),
      CONFIG,
    );
    const action = result.actions.find((a) => a.kind === 'claim_activate');
    expect(action?.reason).toBe('staker_credit_balance');
  });

  it('hot CREDIT wallet > 0 alone triggers claim_activate', () => {
    const result = decide(
      baseInput({ snapshot: { ...BASE_SNAPSHOT, creditWalletHot: '2000000' } }),
      CONFIG,
    );
    const action = result.actions.find((a) => a.kind === 'claim_activate');
    expect(action?.reason).toBe('hot_credit_balance');
  });

  it('all three triggers combine into one action with a joined reason, in order', () => {
    const result = decide(
      baseInput({
        claimable: '5',
        snapshot: { ...BASE_SNAPSHOT, creditWalletStaker: '1000000', creditWalletHot: '2000000' },
      }),
      CONFIG,
    );
    const claimActions = result.actions.filter((a) => a.kind === 'claim_activate');
    expect(claimActions).toHaveLength(1);
    expect(claimActions[0]?.reason).toBe(
      'claimable_settled;staker_credit_balance;hot_credit_balance',
    );
  });
});

describe('decide() — buy: sizing, cap, and the two-part trigger condition', () => {
  it('no buy when runway >= RUNWAY_BUY_DAYS (1d) even with a real deficit shape', () => {
    // available=10, burn=1 -> runway=10d, well above the 1d trigger.
    const result = decide(
      baseInput({ apiBalance: { available: '10', used: '0' }, burnDaily: '1' }),
      CONFIG,
    );
    expect(result.actions.find((a) => a.kind === 'buy')).toBeUndefined();
  });

  it('no buy when runway < 1d but deficit <= 1 USDG (boundary: deficit must be > 1, not >=)', () => {
    // burnDaily=1, RUNWAY_BUY_DAYS=1 -> target=1; available=0 -> deficit=1 exactly -> not > 1.
    const result = decide(
      baseInput({ apiBalance: { available: '0', used: '0' }, burnDaily: '1' }),
      CONFIG,
    );
    expect(result.actions.find((a) => a.kind === 'buy')).toBeUndefined();
  });

  it('buy fires and sizes usdg = ceil(deficit) when under the per-tx cap', () => {
    // burnDaily=3 -> target=3; available=0.5 -> deficit=2.5 -> ceil=3 (under the $10 cap).
    const result = decide(
      baseInput({ apiBalance: { available: '0.5', used: '0' }, burnDaily: '3' }),
      CONFIG,
    );
    const action = result.actions.find((a) => a.kind === 'buy');
    expect(action?.reason).toBe('runway_below_buy_threshold');
    expect(action && 'usdg' in action ? action.usdg : null).toBe('3.000000');
  });

  it('buy is capped at BUY_MAX_USDG_PER_TX (10) when the ceiled deficit exceeds it', () => {
    // burnDaily=50 -> target=50; available=0 -> deficit=50 -> ceil=50, capped to 10.
    const result = decide(
      baseInput({ apiBalance: { available: '0', used: '0' }, burnDaily: '50' }),
      CONFIG,
    );
    const action = result.actions.find((a) => a.kind === 'buy');
    expect(action && 'usdg' in action ? action.usdg : null).toBe('10.000000');
  });

  it('a fractional deficit that is not a whole USDG still ceils up (never rounds down)', () => {
    // burnDaily=1.5 -> target=1.5; available=0 -> deficit=1.5 -> ceil=2.
    const result = decide(
      baseInput({ apiBalance: { available: '0', used: '0' }, burnDaily: '1.5' }),
      CONFIG,
    );
    const action = result.actions.find((a) => a.kind === 'buy');
    expect(action && 'usdg' in action ? action.usdg : null).toBe('2.000000');
  });

  it('decide() is live-agnostic: the buy action is emitted the same way regardless of input.live', () => {
    const liveOff = decide(
      baseInput({ apiBalance: { available: '0', used: '0' }, burnDaily: '3', live: false }),
      CONFIG,
    );
    const liveOn = decide(
      baseInput({ apiBalance: { available: '0', used: '0' }, burnDaily: '3', live: true }),
      CONFIG,
    );
    const offAction = liveOff.actions.find((a) => a.kind === 'buy');
    const onAction = liveOn.actions.find((a) => a.kind === 'buy');
    expect(offAction).toBeDefined();
    expect(onAction).toBeDefined();
    expect(offAction && 'usdg' in offAction ? offAction.usdg : null).toBe(
      onAction && 'usdg' in onAction ? onAction.usdg : null,
    );
    // `live` is still recorded, unbranched, on each action's own `inputs` echo.
    expect(offAction?.inputs.live).toBe(false);
    expect(onAction?.inputs.live).toBe(true);
  });
});

describe('decide() — stakeup: threshold trigger', () => {
  it('does not fire below STAKEUP_EVERY_CALLS (999 < 1000)', () => {
    const result = decide(baseInput({ callsSinceLastStakeup: 999 }), CONFIG);
    expect(result.actions.find((a) => a.kind === 'stakeup')).toBeUndefined();
  });

  it('fires exactly at STAKEUP_EVERY_CALLS (1000)', () => {
    const result = decide(baseInput({ callsSinceLastStakeup: 1000 }), CONFIG);
    const action = result.actions.find((a) => a.kind === 'stakeup');
    expect(action?.reason).toBe('stakeup_interval_reached');
    expect(action && 'usdg' in action ? action.usdg : null).toBe('1.000000');
  });

  it('fires above STAKEUP_EVERY_CALLS (1500)', () => {
    const result = decide(baseInput({ callsSinceLastStakeup: 1500 }), CONFIG);
    expect(result.actions.find((a) => a.kind === 'stakeup')).toBeDefined();
  });
});

describe('decide() — action order and re-derivability', () => {
  it('emits claim_activate, then buy, then stakeup, when all three trigger together', () => {
    const result = decide(
      baseInput({
        claimable: '5',
        apiBalance: { available: '0', used: '0' },
        burnDaily: '3',
        callsSinceLastStakeup: 1000,
      }),
      CONFIG,
    );
    expect(result.actions.map((a) => a.kind)).toEqual(['claim_activate', 'buy', 'stakeup']);
  });

  it("every action's inputs snapshot re-derives the identical decision when fed back into decide()", () => {
    const input = baseInput({ claimable: '5' });
    const first = decide(input, CONFIG);
    const action = first.actions[0];
    if (!action) throw new Error('test setup: expected at least one action');
    const rederiveInput: SprintDecideInput = {
      ...action.inputs,
      now: new Date(action.inputs.now),
    };
    const second = decide(rederiveInput, CONFIG);
    expect(second).toEqual(first);
  });

  it('no action fires at all when nothing is owed, runway is healthy and stakeup is far off', () => {
    const result = decide(baseInput(), CONFIG);
    expect(result.actions).toEqual([]);
    expect(result.mode).toBe('normal');
  });
});

/**
 * T-015 · Tester pass (PROCESS.md §2 step 3, tasks/T-015.md).
 *
 * Written from tasks/T-015.md's Goal / In scope / Acceptance criteria / Tests required,
 * CLAUDE.md, PRD FR-4.1..FR-4.8 / FR-11.3 / §10, and ADR-003 alone. Per the tester brief, the
 * exported API surface was learned only from `types.ts` (field names, `EvaluateInput`,
 * `Decision`, `PolicyConfig`, ...) and `defaults.ts` (`DEFAULT_POLICY`'s numbers) — plus the one
 * `evaluate(input: EvaluateInput): Decision[]` signature line grepped out of `evaluate.ts` —
 * before this file's checklist (below) was fixed. `evaluate.ts`, `rules/*.ts` and `humanize.ts`
 * were read only afterward, to wire names/rule ids and to check the arithmetic actually
 * implemented against what I'd already derived from §10 by hand. No accidental read of
 * `tasks/T-015.md`'s Build notes / Audit report / Evidence sections occurred this time (only
 * Goal/In scope/AC/Tests required/Status were requested via a line-ranged Read).
 *
 * This file does not re-derive or duplicate the builder's own `evaluate.test.ts` (716 lines) or
 * `property.test.ts` (105 lines); it is a smaller, independent proof of the ticket's AC text in
 * my own words, meant to run alongside them, not replace them.
 *
 * ---------------------------------------------------------------------------------------------
 * Checklist — what would prove each AC (written before reading evaluate.ts/rules/*.ts/humanize.ts)
 * ---------------------------------------------------------------------------------------------
 *
 * AC1 (100% branch coverage on evaluate()): only provable by actually running a coverage tool.
 *   `@vitest/coverage-v8` is not installed anywhere in this repo (checked: absent from every
 *   package.json and from node_modules) and CLAUDE.md rule 7 forbids adding a dependency beyond
 *   ARCHITECTURE.md §1 without an ADR — out of a tester's authority on this ticket.
 *   Verdict: untestable-as-stated. Documented, not silently skipped.
 *
 * AC2 (table tests, state × book-write on/off × stake on/off × caps exhausted × stable balance
 *   below reserve): from §10's DEFICIT branch, a `BUY_CREDIT` option requires
 *   `book.buyAvailable && depthAtBestUsd ≥ 1 && (maxBuyUsdPerDay - boughtTodayUsd) ≥ 1`; a
 *   `STAKE_UP` option requires `stake.available && (stableBalanceUsd - stableReserveUsd) ≥
 *   minSwapUsd && budget ≥ minSwapUsd && payback_days ≤ stakePaybackMaxDays`. With a small need
 *   fully covered by the buy budget, the 16-cell {bookOn, stakeOn, capsExhausted, belowReserve}
 *   matrix in DEFICIT resolves to: BUY_CREDIT whenever bookOn && !capsExhausted (buy wins the
 *   tie-break whenever it's present and covers `need`); else STAKE_UP whenever stakeOn &&
 *   !capsExhausted && !belowReserve; else SIGNAL_FUND (+ALERT_DEFICIT_UNFUNDED). The same
 *   16-cell matrix in COMFORTABLE/TIGHT must show none of these four toggles ever produces a
 *   funding action or alert — proving book/stake/caps/reserve are DEFICIT-only concerns.
 *   Two extra cases the matrix's "small need" choice can't reach on its own, both required by
 *   §10's literal tie-break line ("pick BUY_CREDIT if present and need can be covered today,
 *   else STAKE_UP"): a *big* need that exceeds the buy budget, with both options available
 *   (must pick STAKE_UP, not a partial buy), and the same big need with only BUY_CREDIT
 *   available (must fall through to SIGNAL_FUND, not emit a partial buy — nothing in §10 says
 *   to fall back to a partial buy when the only present option can't fully cover `need`). Also:
 *   `depth_at_best < 1` must exclude BUY_CREDIT even when `book.buyAvailable` is true and caps
 *   aren't exhausted (a fifth §10 condition on the option, orthogonal to the matrix's four).
 *
 * §10 edge maths:
 *   - ε floor: `payback_days = budget / max(added_accrual_per_day, ε)`. Zero measured accrual
 *     must not divide by zero / produce Infinity or NaN; under the default 30-day gate it must
 *     floor to a payback so large STAKE_UP is excluded (falls through, no crash). Under a raised
 *     gate, the exact floored value (`budget / epsilonUsdPerDay`) must appear verbatim.
 *   - ∞ runway: `net_burn = max(burn - accrual, 0)`; accrual ≥ burn ⇒ net_burn = 0 ⇒ runway = ∞
 *     ⇒ state is COMFORTABLE regardless of how low `credits_available` is (the division is never
 *     reached) — both accrual == burn and accrual > burn.
 *   - payback_days gate: `≤ stake_payback_max_days` is inclusive — exactly at the boundary
 *     STAKE_UP must still be offered; one unit past it, excluded.
 *   - hysteresis (FR-4.7): a state change needs two consecutive raw ticks, except entry into
 *     DEFICIT, which is immediate even on the first raw tick. Leaving DEFICIT is NOT exempt —
 *     it needs the same two ticks as any other change. `previousEffectiveState === null` (the
 *     agent's first tick ever) is immediate regardless of state, matching `mcpPreviouslyReachable
 *     === null`'s "always fresh" convention documented on `HysteresisInput`. No raw change at
 *     all short-circuits to "stay", regardless of tick count.
 *   - "once per entry" alerts: `ALERT_TIGHT` fires only on the tick `stateBefore !== stateAfter`
 *     into TIGHT, not on every tick spent in TIGHT. `ALERT_DEFICIT_UNFUNDED` fires whenever
 *     `previouslyUnfundedInDeficit !== true` (null *or* false), not only on state entry — per
 *     `HysteresisInput`'s own doc comment, a funded→unfunded flip mid-DEFICIT-streak must still
 *     alert once. `MCP_UNAVAILABLE` fires when unreachable now and (`mcpPreviouslyReachable` is
 *     `null` or `true`) — i.e. every *fresh* unreachable-entry, suppressed only while it stays
 *     unreachable tick over tick. By contrast §10's tail line gives `ALERT_TICK_MISSED` and
 *     `KEY_ROTATE` no "once per entry" qualifier at all — they must fire on *every* qualifying
 *     tick, proven by two independent calls with the same qualifying input both firing.
 *   - FR-4.8 prebuy (`R-PREBUY-1`): fires when `forecast_usd_next_window > credits_available −
 *     prebuy_reserve_usd` AND `book.best_discount ≥ prebuy_min_discount_pct` (inclusive), even
 *     in COMFORTABLE (and, since nothing in evaluate.ts's own header gates it to COMFORTABLE
 *     only, in TIGHT too) — as `BUY_CREDIT` for `min(shortfall, maxBuyUsdPerDay - boughtTodayUsd)`
 *     (capped, never more than the shortfall), or `SIGNAL_FUND` (reason `prebuy_unfunded`,
 *     carrying the amount and `windowDeadlineLabel`) when `buyAvailable` is false. No forecast,
 *     an already-covered forecast, or a discount under the threshold must all suppress it.
 *
 * AC3 (property test, 200 random snapshots, own seeded PRNG): generate 200 random
 *   `EvaluateInput` snapshots (a small xorshift32 PRNG, fixed seed, no new dependency) covering
 *   every field including the null-able ones; for each, `evaluate(input)` must be non-empty
 *   (ROUTE always fires) and every emitted decision's own `inputs` must equal the snapshot that
 *   produced it; re-running `evaluate(decisions[0].inputs)` must return an array byte-identical
 *   (`JSON.stringify` equal) to the first call's result.
 *
 * AC4 (evaluate() < 5ms): warm up, then time 100 individual calls with `performance.now()` and
 *   assert the median is under 5ms.
 *
 * Purity check (CLAUDE.md rule 3 / no I/O or clock in the policy loop): every `.ts` source file
 * under `packages/core/src/policy/**` (excluding tests) must not reference `node:`, a bare `fs`
 * import, `fetch(`, `process.env`, `Date.now(`, `new Date(`, or `Math.random(` — checked
 * statically by reading each file's text, not by executing it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './defaults.js';
import { evaluate } from './evaluate.js';
import type {
  ActionType,
  BookViewInput,
  DailyCapsInput,
  EvaluateInput,
  HysteresisInput,
  KeyStatusInput,
  PolicyConfig,
  PolicyState,
  PrebuyInput,
  StakeInput,
  TickHealthInput,
} from './types.js';

// -------------------------------------------------------------------------------------------
// Shared fixtures
// -------------------------------------------------------------------------------------------

interface InputOverrides {
  readonly creditsAvailableUsd?: string;
  readonly accrualRateUsdPerDay?: string;
  readonly burnRateUsdPerDay?: string;
  readonly book?: Partial<BookViewInput>;
  readonly stake?: Partial<StakeInput>;
  readonly caps?: Partial<DailyCapsInput>;
  readonly keyStatus?: Partial<KeyStatusInput>;
  readonly tick?: Partial<TickHealthInput>;
  readonly hysteresis?: Partial<HysteresisInput>;
  readonly prebuy?: Partial<PrebuyInput>;
  readonly policy?: PolicyConfig;
}

/**
 * Baseline: a stable, first-ever tick (no hysteresis dampening) with both funding adapters
 * available, plenty of headroom, a healthy key/MCP/tick, and no prebuy forecast — so a single
 * dimension can be flipped per test without unrelated decisions (alerts, prebuy) appearing.
 */
function makeInput(overrides: InputOverrides = {}): EvaluateInput {
  return {
    creditsAvailableUsd: overrides.creditsAvailableUsd ?? '0',
    accrualRateUsdPerDay: overrides.accrualRateUsdPerDay ?? '0',
    burnRateUsdPerDay: overrides.burnRateUsdPerDay ?? '0',
    book: {
      buyAvailable: true,
      bestDiscountPct: '20',
      depthAtBestUsd: '100',
      ...overrides.book,
    },
    stake: {
      available: true,
      stableBalanceUsd: '25',
      orbioPriceUsd: '1',
      yieldPerTokenPerDay: '1',
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
      gapMinutes: 10,
      mcpReachable: true,
      mcpPreviouslyReachable: true,
      ...overrides.tick,
    },
    hysteresis: {
      previousEffectiveState: null,
      consecutiveRawTicks: 2,
      previouslyUnfundedInDeficit: null,
      ...overrides.hysteresis,
    },
    prebuy: {
      forecastUsdNextWindow: null,
      windowDeadlineLabel: null,
      ...overrides.prebuy,
    },
    policy: overrides.policy ?? DEFAULT_POLICY,
  };
}

// runway = 100 >= comfortableDays(7)
const COMFORTABLE_BASE: InputOverrides = { burnRateUsdPerDay: '1', creditsAvailableUsd: '100' };
// netBurn=5, runway=4, in [tightDays(3), comfortableDays(7))
const TIGHT_BASE: InputOverrides = { burnRateUsdPerDay: '5', creditsAvailableUsd: '20' };
// runway=0 < tightDays(3); need = 3*1 - 0 = 3, fully covered by the default $10 buy budget
const DEFICIT_SMALL_NEED: InputOverrides = { burnRateUsdPerDay: '1', creditsAvailableUsd: '0' };
// need = 3*5 - 0 = 15, exceeds the default $10 buy budget
const DEFICIT_BIG_NEED: InputOverrides = { burnRateUsdPerDay: '5', creditsAvailableUsd: '0' };

function actionKinds(input: EvaluateInput): ActionType[] {
  return evaluate(input).map((d) => d.type);
}

const FUNDING_KINDS: readonly ActionType[] = ['BUY_CREDIT', 'STAKE_UP', 'SIGNAL_FUND'];

// -------------------------------------------------------------------------------------------
// AC1 — 100% branch coverage: untestable-as-stated
// -------------------------------------------------------------------------------------------

describe('AC1: 100% branch coverage on evaluate()', () => {
  it.skip(
    'untestable-as-stated: @vitest/coverage-v8 is not installed anywhere in this repo, and ' +
      'CLAUDE.md rule 7 forbids a tester adding a dependency beyond ARCHITECTURE.md §1 without ' +
      "an ADR — not this ticket/role's call to make",
    () => {},
  );
});

// -------------------------------------------------------------------------------------------
// Purity check — CLAUDE.md rule 3: no I/O, no clock, no LLM in packages/core/src/policy/**
// -------------------------------------------------------------------------------------------

describe('purity: no I/O/clock/random references under policy/** source', () => {
  const POLICY_DIR = dirname(fileURLToPath(import.meta.url));

  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listTsFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  const FORBIDDEN: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
    { label: 'node: import/require', re: /node:/ },
    { label: "bare 'fs' import", re: /from\s+['"]fs['"]/ },
    { label: 'fetch(', re: /\bfetch\s*\(/ },
    { label: 'process.env', re: /process\.env/ },
    { label: 'Date.now(', re: /Date\.now\s*\(/ },
    { label: 'new Date(', re: /new\s+Date\s*\(/ },
    { label: 'Math.random(', re: /Math\.random\s*\(/ },
  ];

  const files = listTsFiles(POLICY_DIR);

  it('found at least one source file to check (the check itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f] as const))(
    '%s references none of the forbidden patterns',
    (file) => {
      const content = readFileSync(file, 'utf8');
      for (const { label, re } of FORBIDDEN) {
        expect(re.test(content), `${file} unexpectedly matches "${label}"`).toBe(false);
      }
    },
  );
});

// -------------------------------------------------------------------------------------------
// AC2 — DEFICIT funding-option matrix: state × book on/off × stake on/off × caps exhausted ×
// stable balance below reserve
// -------------------------------------------------------------------------------------------

const BOOL = [true, false] as const;
const CELLS: ReadonlyArray<readonly [boolean, boolean, boolean, boolean]> = BOOL.flatMap((bookOn) =>
  BOOL.flatMap((stakeOn) =>
    BOOL.flatMap((capsExhausted) =>
      BOOL.map((belowReserve) => [bookOn, stakeOn, capsExhausted, belowReserve] as const),
    ),
  ),
);

function cellInput(
  base: InputOverrides,
  bookOn: boolean,
  stakeOn: boolean,
  capsExhausted: boolean,
  belowReserve: boolean,
  hysteresisState: PolicyState,
): EvaluateInput {
  return makeInput({
    ...base,
    book: { buyAvailable: bookOn },
    stake: { available: stakeOn, stableBalanceUsd: belowReserve ? '5' : '25' },
    caps: capsExhausted
      ? { boughtTodayUsd: '10', stakedTodayUsd: '10' }
      : { boughtTodayUsd: '0', stakedTodayUsd: '0' },
    // Stable prior state so hysteresis doesn't dampen — this matrix is about the DEFICIT
    // funding-selection dimensions, not about hysteresis (covered separately below).
    hysteresis: { previousEffectiveState: hysteresisState, consecutiveRawTicks: 2 },
  });
}

/** §10's DEFICIT branch, derived by hand (not from the implementation): with `need` fully
 *  covered by the buy budget, BUY_CREDIT wins whenever it's eligible; else STAKE_UP if
 *  eligible; else SIGNAL_FUND. */
function expectedSmallNeedOutcome(
  bookOn: boolean,
  stakeOn: boolean,
  capsExhausted: boolean,
  belowReserve: boolean,
): ActionType {
  const buyEligible = bookOn && !capsExhausted;
  const stakeEligible = stakeOn && !capsExhausted && !belowReserve;
  if (buyEligible) return 'BUY_CREDIT';
  if (stakeEligible) return 'STAKE_UP';
  return 'SIGNAL_FUND';
}

describe('AC2: DEFICIT funding matrix (16 cells)', () => {
  it.each(CELLS)(
    'bookOn=%s stakeOn=%s capsExhausted=%s belowReserve=%s',
    (bookOn, stakeOn, capsExhausted, belowReserve) => {
      const kinds = actionKinds(
        cellInput(DEFICIT_SMALL_NEED, bookOn, stakeOn, capsExhausted, belowReserve, 'DEFICIT'),
      );
      expect(kinds).toContain('ROUTE');

      const expected = expectedSmallNeedOutcome(bookOn, stakeOn, capsExhausted, belowReserve);
      const funding = kinds.filter((k) => FUNDING_KINDS.includes(k));
      expect(funding).toEqual([expected]);

      if (expected === 'SIGNAL_FUND') {
        // previouslyUnfundedInDeficit is null (first tick) -> always a fresh entry -> alerts.
        expect(kinds).toContain('ALERT_DEFICIT_UNFUNDED');
      } else {
        expect(kinds).not.toContain('ALERT_DEFICIT_UNFUNDED');
      }
    },
  );
});

describe('AC2: COMFORTABLE/TIGHT — the four DEFICIT-only toggles never produce a funding action', () => {
  it.each(CELLS)(
    'COMFORTABLE bookOn=%s stakeOn=%s capsExhausted=%s belowReserve=%s',
    (bookOn, stakeOn, capsExhausted, belowReserve) => {
      const kinds = actionKinds(
        cellInput(COMFORTABLE_BASE, bookOn, stakeOn, capsExhausted, belowReserve, 'COMFORTABLE'),
      );
      expect(kinds).toEqual(['ROUTE']);
    },
  );

  it.each(CELLS)(
    'TIGHT bookOn=%s stakeOn=%s capsExhausted=%s belowReserve=%s',
    (bookOn, stakeOn, capsExhausted, belowReserve) => {
      const kinds = actionKinds(
        cellInput(TIGHT_BASE, bookOn, stakeOn, capsExhausted, belowReserve, 'TIGHT'),
      );
      // previousEffectiveState is already TIGHT (stable) -> no entry -> no ALERT_TIGHT either.
      expect(kinds).toEqual(['ROUTE']);
      for (const kind of FUNDING_KINDS) expect(kinds).not.toContain(kind);
    },
  );
});

describe('AC2: §10 tie-break — "pick BUY_CREDIT if present and need can be covered today, else STAKE_UP"', () => {
  it('need exceeds the buy budget, both options present -> STAKE_UP (not a partial buy)', () => {
    const kinds = actionKinds(cellInput(DEFICIT_BIG_NEED, true, true, false, false, 'DEFICIT'));
    expect(kinds).toContain('STAKE_UP');
    expect(kinds).not.toContain('BUY_CREDIT');
  });

  it('need exceeds the buy budget, only BUY_CREDIT present -> SIGNAL_FUND (never a partial buy)', () => {
    const kinds = actionKinds(cellInput(DEFICIT_BIG_NEED, true, false, false, false, 'DEFICIT'));
    expect(kinds).toContain('SIGNAL_FUND');
    expect(kinds).not.toContain('BUY_CREDIT');
  });

  it('need exactly equals the buy budget (boundary) -> BUY_CREDIT (fully covers "today")', () => {
    // need = tightDays(3) * burn(10) - credits(20) = 10 = the default $10 buy budget exactly.
    const input = makeInput({
      burnRateUsdPerDay: '10',
      creditsAvailableUsd: '20',
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
    });
    const kinds = actionKinds(input);
    expect(kinds).toContain('BUY_CREDIT');
  });
});

describe('AC2: book depth_at_best < 1 excludes BUY_CREDIT even when buyAvailable and caps are open', () => {
  it('depthAtBestUsd = "0.5" -> BUY_CREDIT excluded', () => {
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: true, depthAtBestUsd: '0.5' },
      stake: { available: false },
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
    });
    expect(actionKinds(input)).toContain('SIGNAL_FUND');
    expect(actionKinds(input)).not.toContain('BUY_CREDIT');
  });

  it('depthAtBestUsd = null -> BUY_CREDIT excluded (no book data)', () => {
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: true, depthAtBestUsd: null },
      stake: { available: false },
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
    });
    expect(actionKinds(input)).toContain('SIGNAL_FUND');
    expect(actionKinds(input)).not.toContain('BUY_CREDIT');
  });
});

// -------------------------------------------------------------------------------------------
// §10 edge maths
// -------------------------------------------------------------------------------------------

describe('§10 edge maths: ε floor and the payback_days gate', () => {
  it('zero measured accrual does not divide by zero: floors to ε, excluded under the default 30-day gate (no crash, no partial funding)', () => {
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: false },
      stake: { available: true, stableBalanceUsd: '25', yieldPerTokenPerDay: '0' },
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
    });
    const kinds = actionKinds(input);
    expect(kinds).not.toContain('STAKE_UP');
    expect(kinds).toContain('SIGNAL_FUND');
  });

  it('ε floor exact value: payback_days = budget / epsilonUsdPerDay when added accrual is zero (raised gate)', () => {
    const policy: PolicyConfig = { ...DEFAULT_POLICY, stakePaybackMaxDays: '100000' };
    // stableBalance=25, reserve=5 -> spendable=20; cap=10-0=10; budget=min(10,20)=10.
    // epsilonUsdPerDay default '0.01' -> payback_days = 10 / 0.01 = 1000.000000.
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: false },
      stake: { available: true, stableBalanceUsd: '25', yieldPerTokenPerDay: '0' },
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
      policy,
    });
    const decision = evaluate(input).find((d) => d.type === 'STAKE_UP');
    expect(decision).toBeDefined();
    expect(decision?.action).toMatchObject({ kind: 'STAKE_UP', paybackDays: '1000.000000' });
  });

  it('payback_days at the boundary (== stake_payback_max_days) is still offered (inclusive ≤)', () => {
    // budget=50 (custom caps/reserve), yield chosen so payback_days = 10 exactly.
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      maxStakeUsdPerDay: '100',
      minSwapUsd: '5',
      stableReserveUsd: '0',
      stakePaybackMaxDays: '10',
    };
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: false },
      stake: {
        available: true,
        stableBalanceUsd: '50',
        orbioPriceUsd: '1',
        yieldPerTokenPerDay: '0.1',
      },
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
      policy,
    });
    const decision = evaluate(input).find((d) => d.type === 'STAKE_UP');
    expect(decision).toBeDefined();
    expect(decision?.action).toMatchObject({ paybackDays: '10.000000' });
  });

  it('payback_days just past the boundary is excluded', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      maxStakeUsdPerDay: '100',
      minSwapUsd: '5',
      stableReserveUsd: '0',
      stakePaybackMaxDays: '10',
    };
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: false },
      // yield slightly lower -> payback_days slightly above 10.
      stake: {
        available: true,
        stableBalanceUsd: '50',
        orbioPriceUsd: '1',
        yieldPerTokenPerDay: '0.099999',
      },
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
      policy,
    });
    const kinds = actionKinds(input);
    expect(kinds).not.toContain('STAKE_UP');
    expect(kinds).toContain('SIGNAL_FUND');
  });
});

describe('§10 edge maths: ∞ runway (accrual ≥ burn) is always COMFORTABLE, however low credits are', () => {
  it('accrual == burn -> net_burn = 0 -> COMFORTABLE even with zero credits', () => {
    const input = makeInput({
      burnRateUsdPerDay: '5',
      accrualRateUsdPerDay: '5',
      creditsAvailableUsd: '0',
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateAfter).toBe('COMFORTABLE');
    expect(route?.action).toMatchObject({ tier: 'frontier' });
  });

  it('accrual > burn -> net_burn = 0 -> COMFORTABLE even with zero credits', () => {
    const input = makeInput({
      burnRateUsdPerDay: '5',
      accrualRateUsdPerDay: '8',
      creditsAvailableUsd: '0',
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateAfter).toBe('COMFORTABLE');
  });
});

describe('§10 edge maths: hysteresis (FR-4.7) — two consecutive raw ticks, except immediate entry into DEFICIT', () => {
  it('COMFORTABLE -> TIGHT, 1st raw tick: stays COMFORTABLE (not yet debounced in)', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateBefore).toBe('COMFORTABLE');
    expect(route?.stateAfter).toBe('COMFORTABLE');
  });

  it('COMFORTABLE -> TIGHT, 2nd raw tick: flips to TIGHT', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 2 },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateAfter).toBe('TIGHT');
  });

  it('COMFORTABLE -> DEFICIT, 1st raw tick: immediate (the one exception)', () => {
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 1 },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateBefore).toBe('COMFORTABLE');
    expect(route?.stateAfter).toBe('DEFICIT');
  });

  it('DEFICIT -> TIGHT, 1st raw tick: stays DEFICIT (leaving DEFICIT is NOT exempt)', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 1 },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateAfter).toBe('DEFICIT');
  });

  it('DEFICIT -> TIGHT, 2nd raw tick: flips to TIGHT', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: 'DEFICIT', consecutiveRawTicks: 2 },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateAfter).toBe('TIGHT');
  });

  it('first tick ever (previousEffectiveState null): always immediate, any state, any tick count', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: null, consecutiveRawTicks: 1 },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateBefore).toBeNull();
    expect(route?.stateAfter).toBe('TIGHT');
  });

  it('no raw change at all: stays, regardless of consecutiveRawTicks', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: 'TIGHT', consecutiveRawTicks: 1 },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateAfter).toBe('TIGHT');
  });
});

describe('§10 edge maths: "once per entry" alerts vs. always-fires', () => {
  it('ALERT_TIGHT fires on entry into TIGHT (stateBefore !== TIGHT)', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: 'COMFORTABLE', consecutiveRawTicks: 2 },
    });
    expect(actionKinds(input)).toContain('ALERT_TIGHT');
  });

  it('ALERT_TIGHT does not repeat while staying in TIGHT', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      hysteresis: { previousEffectiveState: 'TIGHT', consecutiveRawTicks: 5 },
    });
    expect(actionKinds(input)).not.toContain('ALERT_TIGHT');
  });

  it('ALERT_DEFICIT_UNFUNDED fires when previouslyUnfundedInDeficit is null (first tick, fresh)', () => {
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: false },
      stake: { available: false },
      hysteresis: {
        previousEffectiveState: 'DEFICIT',
        consecutiveRawTicks: 2,
        previouslyUnfundedInDeficit: null,
      },
    });
    expect(actionKinds(input)).toContain('ALERT_DEFICIT_UNFUNDED');
  });

  it('ALERT_DEFICIT_UNFUNDED fires when previouslyUnfundedInDeficit is false (a funded->unfunded flip)', () => {
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: false },
      stake: { available: false },
      hysteresis: {
        previousEffectiveState: 'DEFICIT',
        consecutiveRawTicks: 2,
        previouslyUnfundedInDeficit: false,
      },
    });
    expect(actionKinds(input)).toContain('ALERT_DEFICIT_UNFUNDED');
  });

  it('ALERT_DEFICIT_UNFUNDED does not repeat when previouslyUnfundedInDeficit is true', () => {
    const input = makeInput({
      ...DEFICIT_SMALL_NEED,
      book: { buyAvailable: false },
      stake: { available: false },
      hysteresis: {
        previousEffectiveState: 'DEFICIT',
        consecutiveRawTicks: 2,
        previouslyUnfundedInDeficit: true,
      },
    });
    expect(actionKinds(input)).not.toContain('ALERT_DEFICIT_UNFUNDED');
  });

  it('MCP_UNAVAILABLE fires on a fresh unreachable entry (previously reachable)', () => {
    const input = makeInput({
      tick: { mcpReachable: false, mcpPreviouslyReachable: true, gapMinutes: 10 },
    });
    expect(actionKinds(input)).toContain('MCP_UNAVAILABLE');
  });

  it('MCP_UNAVAILABLE fires on the very first tick (mcpPreviouslyReachable null, always fresh)', () => {
    const input = makeInput({
      tick: { mcpReachable: false, mcpPreviouslyReachable: null, gapMinutes: 10 },
    });
    expect(actionKinds(input)).toContain('MCP_UNAVAILABLE');
  });

  it('MCP_UNAVAILABLE does not repeat while staying unreachable', () => {
    const input = makeInput({
      tick: { mcpReachable: false, mcpPreviouslyReachable: false, gapMinutes: 10 },
    });
    expect(actionKinds(input)).not.toContain('MCP_UNAVAILABLE');
  });

  it('ALERT_TICK_MISSED and KEY_ROTATE have no "once per entry" suppression: fire on every qualifying call', () => {
    const input = makeInput({
      tick: { gapMinutes: 46, mcpReachable: true, mcpPreviouslyReachable: true },
      keyStatus: { valid: false },
    });
    const first = actionKinds(input);
    const second = actionKinds(input); // independent call, identical qualifying input
    expect(first).toContain('ALERT_TICK_MISSED');
    expect(first).toContain('KEY_ROTATE');
    expect(second).toContain('ALERT_TICK_MISSED');
    expect(second).toContain('KEY_ROTATE');
  });

  it('ALERT_TICK_MISSED boundary: 45 min does not fire, 46 min does', () => {
    const at45 = makeInput({
      tick: { gapMinutes: 45, mcpReachable: true, mcpPreviouslyReachable: true },
    });
    const at46 = makeInput({
      tick: { gapMinutes: 46, mcpReachable: true, mcpPreviouslyReachable: true },
    });
    expect(actionKinds(at45)).not.toContain('ALERT_TICK_MISSED');
    expect(actionKinds(at46)).toContain('ALERT_TICK_MISSED');
  });
});

describe('FR-4.8: predictive prebuy (R-PREBUY-1) fires regardless of state, "even in COMFORTABLE"', () => {
  it('COMFORTABLE, forecast exceeds credits, discount clears threshold -> BUY_CREDIT for the shortfall', () => {
    // credits(20) small enough, relative to forecast(30), that a shortfall exists; runway =
    // 20/1 = 20 >= comfortableDays(7) so this snapshot is COMFORTABLE (sanity-checked below).
    const input = makeInput({
      burnRateUsdPerDay: '1',
      creditsAvailableUsd: '20',
      book: { buyAvailable: true, bestDiscountPct: '25' },
      prebuy: { forecastUsdNextWindow: '30', windowDeadlineLabel: 'Monday 06:00' },
    });
    const decisions = evaluate(input);
    expect(decisions.find((d) => d.type === 'ROUTE')?.stateAfter).toBe('COMFORTABLE');

    const prebuyDecision = decisions.find((d) => d.ruleId === 'R-PREBUY-1');
    expect(prebuyDecision).toBeDefined();
    // shortfall = forecast(30) - (credits(20) - reserve(0)) = 10, capped at the $10/day budget.
    expect(prebuyDecision?.action).toMatchObject({ kind: 'BUY_CREDIT', usd: '10.000000' });
  });

  it('discount below prebuyMinDiscountPct(25) -> no prebuy', () => {
    const input = makeInput({
      burnRateUsdPerDay: '1',
      creditsAvailableUsd: '20',
      book: { buyAvailable: true, bestDiscountPct: '24' },
      prebuy: { forecastUsdNextWindow: '30', windowDeadlineLabel: 'Monday 06:00' },
    });
    expect(evaluate(input).find((d) => d.ruleId === 'R-PREBUY-1')).toBeUndefined();
  });

  it('discount exactly at prebuyMinDiscountPct(25) -> prebuy fires (inclusive ≥)', () => {
    const input = makeInput({
      burnRateUsdPerDay: '1',
      creditsAvailableUsd: '20',
      book: { buyAvailable: true, bestDiscountPct: '25' },
      prebuy: { forecastUsdNextWindow: '30', windowDeadlineLabel: 'Monday 06:00' },
    });
    expect(evaluate(input).find((d) => d.ruleId === 'R-PREBUY-1')).toBeDefined();
  });

  it('forecast already covered by credits (no shortfall) -> no prebuy', () => {
    const input = makeInput({
      burnRateUsdPerDay: '1',
      creditsAvailableUsd: '50',
      book: { buyAvailable: true, bestDiscountPct: '25' },
      prebuy: { forecastUsdNextWindow: '30', windowDeadlineLabel: 'Monday 06:00' },
    });
    expect(evaluate(input).find((d) => d.ruleId === 'R-PREBUY-1')).toBeUndefined();
  });

  it('no forecast at all -> no prebuy', () => {
    const input = makeInput({
      burnRateUsdPerDay: '1',
      creditsAvailableUsd: '0',
      book: { buyAvailable: true, bestDiscountPct: '25' },
      prebuy: { forecastUsdNextWindow: null, windowDeadlineLabel: null },
    });
    expect(evaluate(input).find((d) => d.ruleId === 'R-PREBUY-1')).toBeUndefined();
  });

  it('shortfall larger than the daily buy budget is capped at the budget, never more', () => {
    const input = makeInput({
      burnRateUsdPerDay: '1',
      creditsAvailableUsd: '0',
      book: { buyAvailable: true, bestDiscountPct: '25' },
      caps: { boughtTodayUsd: '0' },
      prebuy: { forecastUsdNextWindow: '1000', windowDeadlineLabel: 'Monday 06:00' }, // shortfall=1000
    });
    const decision = evaluate(input).find((d) => d.ruleId === 'R-PREBUY-1');
    expect(decision?.action).toMatchObject({ kind: 'BUY_CREDIT', usd: '10.000000' }); // maxBuyUsdPerDay default
  });

  it('buy unavailable -> SIGNAL_FUND with the uncapped shortfall amount and the deadline label', () => {
    const input = makeInput({
      burnRateUsdPerDay: '1',
      creditsAvailableUsd: '20',
      book: { buyAvailable: false, bestDiscountPct: '25' },
      prebuy: { forecastUsdNextWindow: '30', windowDeadlineLabel: 'Monday 06:00' },
    });
    const decision = evaluate(input).find((d) => d.ruleId === 'R-PREBUY-1');
    expect(decision?.action).toMatchObject({
      kind: 'SIGNAL_FUND',
      amountUsd: '10.000000',
      deadlineLabel: 'Monday 06:00',
      reason: 'prebuy_unfunded',
    });
    expect(decision?.human).toContain('10.000000');
    expect(decision?.human).toContain('Monday 06:00');
  });

  it('fires in TIGHT too, not only COMFORTABLE ("even in COMFORTABLE" is the notable case, not the only one)', () => {
    const input = makeInput({
      ...TIGHT_BASE,
      book: { buyAvailable: true, bestDiscountPct: '25' },
      prebuy: { forecastUsdNextWindow: '30', windowDeadlineLabel: 'Monday 06:00' },
    });
    const route = evaluate(input).find((d) => d.type === 'ROUTE');
    expect(route?.stateAfter).toBe('TIGHT');
    expect(evaluate(input).find((d) => d.ruleId === 'R-PREBUY-1')).toBeDefined();
  });
});

// -------------------------------------------------------------------------------------------
// AC3 — property test: re-evaluating a decision's stored inputs reproduces the decision
// -------------------------------------------------------------------------------------------

/** A small seeded xorshift32 PRNG — no new dependency, deterministic for a reproducible run. */
function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

function randomMoney(rng: () => number, maxInt: number, allowNegative = false): string {
  const sign = allowNegative && rng() < 0.1 ? '-' : '';
  const intPart = Math.floor(rng() * maxInt);
  const fracDigits = Math.floor(rng() * 7);
  let frac = '';
  for (let i = 0; i < fracDigits; i++) frac += Math.floor(rng() * 10).toString();
  return frac ? `${sign}${intPart}.${frac}` : `${sign}${intPart}`;
}

function randomMoneyOrNull(rng: () => number, maxInt: number): string | null {
  return rng() < 0.25 ? null : randomMoney(rng, maxInt);
}

function pick<T>(rng: () => number, options: readonly T[]): T {
  const value = options[Math.floor(rng() * options.length)];
  if (value === undefined) throw new Error('pick: empty options');
  return value;
}

function randomInput(rng: () => number): EvaluateInput {
  return {
    creditsAvailableUsd: randomMoney(rng, 500),
    accrualRateUsdPerDay: randomMoney(rng, 50),
    burnRateUsdPerDay: randomMoney(rng, 50),
    book: {
      buyAvailable: rng() < 0.5,
      bestDiscountPct: randomMoneyOrNull(rng, 100),
      depthAtBestUsd: randomMoneyOrNull(rng, 200),
    },
    stake: {
      available: rng() < 0.5,
      stableBalanceUsd: randomMoney(rng, 100),
      orbioPriceUsd: rng() < 0.05 ? '0' : randomMoney(rng, 10),
      yieldPerTokenPerDay: randomMoney(rng, 5),
      yieldLowConfidence: rng() < 0.5,
    },
    caps: {
      boughtTodayUsd: randomMoney(rng, 20),
      stakedTodayUsd: randomMoney(rng, 20),
    },
    keyStatus: { valid: rng() < 0.9 },
    tick: {
      gapMinutes: rng() < 0.1 ? null : Math.floor(rng() * 120),
      mcpReachable: rng() < 0.9,
      mcpPreviouslyReachable: rng() < 0.2 ? null : rng() < 0.5,
    },
    hysteresis: {
      previousEffectiveState:
        rng() < 0.15 ? null : pick(rng, ['COMFORTABLE', 'TIGHT', 'DEFICIT'] as const),
      consecutiveRawTicks: 1 + Math.floor(rng() * 5),
      previouslyUnfundedInDeficit: rng() < 0.2 ? null : rng() < 0.5,
    },
    prebuy: {
      forecastUsdNextWindow: randomMoneyOrNull(rng, 100),
      windowDeadlineLabel: rng() < 0.5 ? null : 'Monday 06:00',
    },
    policy: DEFAULT_POLICY,
  };
}

const PROPERTY_SEED = 0xc0ffee;
const propertyRng = xorshift32(PROPERTY_SEED);
const PROPERTY_INPUTS: EvaluateInput[] = Array.from({ length: 200 }, () =>
  randomInput(propertyRng),
);

describe('AC3: property — evaluate(decision.inputs) reproduces evaluate(inputs) byte-identically', () => {
  it.each(PROPERTY_INPUTS.map((input, i) => [i, input] as const))(
    'seed %i / case %i',
    (_i, input) => {
      const decisions = evaluate(input);
      expect(decisions.length).toBeGreaterThan(0); // ROUTE always fires

      for (const decision of decisions) {
        expect(JSON.stringify(decision.inputs)).toBe(JSON.stringify(input));
      }

      const replay = evaluate(decisions[0]?.inputs as EvaluateInput);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(decisions));
    },
  );
});

// -------------------------------------------------------------------------------------------
// AC4 — evaluate() < 5ms, median of 100 runs
// -------------------------------------------------------------------------------------------

describe('AC4: evaluate() runs in under 5ms (median of 100 runs)', () => {
  it('median duration < 5ms', () => {
    const input = cellInput(DEFICIT_SMALL_NEED, true, true, false, false, 'DEFICIT');

    for (let i = 0; i < 10; i++) evaluate(input); // warm up

    const durations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      evaluate(input);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    expect(median).toBeLessThan(5);
  });
});

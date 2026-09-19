/**
 * claim.ts — `planClaim()` (pure, table-driven, AC1), `executeClaim()`/
 * `executeActivateFromHot()` against a fake viem client (AC2), and the period-discovery
 * functions against a fake read-only client (S-04, tasks/S-04.md "Tests required":
 * "chain/claim.test.ts"). No real network call, no real private key anywhere in this file —
 * `TREASURER_LIVE` stays unset in this sandbox (CLAUDE.md #5).
 */
import type { Address, Hex, TransactionReceipt } from 'viem';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type {
  ClaimCaps,
  ClaimExecClient,
  ClaimReadClient,
  HotActivatePlan,
  ManualAlertPlan,
  NoOpClaimPlan,
  SettleClaimActivatePlan,
} from './claim.js';
import {
  ClaimExecutionError,
  discoverLatestPeriodId,
  discoverPeriodsToSettle,
  executeActivateFromHot,
  executeClaim,
  planClaim,
  resolveClaimCaps,
  resolveMaxFeeGweiCap,
} from './claim.js';
import { creditAbi } from './contracts.js';

const HOT: Address = '0x1111111111111111111111111111111111111111';
const STAKER: Address = '0x2222222222222222222222222222222222222222';
const CREDIT: Address = '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C';
const STAKING: Address = '0xE0710011278BFb63E57C5f227E5980984B1EDDca';

const ADDRESSES = {
  credit: CREDIT,
  staking: STAKING,
  exchange: '0x6951fFd32630b05e06F50062AEA801625A58eBC0' as Address,
  orbio: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3' as Address,
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address,
  payout: '0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5' as Address,
};

const NOW = new Date('2026-09-19T12:00:00.000Z');

function caps(overrides: Partial<ClaimCaps> = {}): ClaimCaps {
  return {
    treasurerLive: false,
    activateMaxPerDayAtoms: 50_000_000n, // 50 CREDIT
    minGasWeiHot: 500_000_000_000_000n, // 0.0005 ETH
    minGasWeiStaker: 1_500_000_000_000_000n, // 0.0015 ETH
    ...overrides,
  };
}

function expectSettlePlan(
  result: SettleClaimActivatePlan | NoOpClaimPlan | { kind: 'refusal' },
): SettleClaimActivatePlan {
  if (result.kind !== 'settle_claim_activate') {
    throw new Error(`expected a settle_claim_activate plan, got ${JSON.stringify(result)}`);
  }
  return result;
}
function expectNoOp(
  result:
    | SettleClaimActivatePlan
    | NoOpClaimPlan
    | { kind: 'refusal' }
    | ManualAlertPlan
    | HotActivatePlan,
): NoOpClaimPlan {
  if (result.kind !== 'no_op') throw new Error(`expected no_op, got ${JSON.stringify(result)}`);
  return result;
}
function expectRefusal(result: { kind: string; reason?: string; detail?: string }): {
  kind: 'refusal';
  reason: string;
  detail: string;
} {
  if (result.kind !== 'refusal')
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result as { kind: 'refusal'; reason: string; detail: string };
}
function expectManualAlert(result: ManualAlertPlan | NoOpClaimPlan): ManualAlertPlan {
  if (result.kind !== 'manual_alert') {
    throw new Error(`expected a manual_alert plan, got ${JSON.stringify(result)}`);
  }
  return result;
}
function expectHotActivate(
  result: HotActivatePlan | NoOpClaimPlan | { kind: 'refusal' },
): HotActivatePlan {
  if (result.kind !== 'hot_activate') {
    throw new Error(`expected a hot_activate plan, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe('planClaim — staker_key flow (AC1: dry-run / no-op / capped / gas floor)', () => {
  it('1. dry-run plan when live is off, something claimable', () => {
    const plan = expectSettlePlan(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 10_000_000n,
        creditBalanceStaker: 0n,
        stakerEthWei: 10n ** 18n,
        caps: caps({ treasurerLive: false }),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.dryRun).toBe(true);
    expect(plan.activateAmount).toBe(10_000_000n);
    expect(plan.remainderAmount).toBe(0n);
  });

  it('2. live plan (dryRun: false) when live is on and something claimable', () => {
    const plan = expectSettlePlan(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [5n, 6n],
        settledCredit: 10_000_000n,
        creditBalanceStaker: 2_000_000n,
        stakerEthWei: 10n ** 18n,
        caps: caps({ treasurerLive: true }),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.dryRun).toBe(false);
    expect(plan.periodIds).toEqual([5n, 6n]);
    expect(plan.claimAmount).toBe(10_000_000n);
    expect(plan.activateAmount).toBe(12_000_000n); // creditBalanceStaker + settledCredit
  });

  it('3. nothing claimable and no periods to settle -> no_op', () => {
    const plan = expectNoOp(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 0n,
        creditBalanceStaker: 0n,
        stakerEthWei: 10n ** 18n,
        caps: caps(),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.detail).toMatch(/nothing claimable/);
  });

  it('4. periods to settle but nothing claimable YET -> still a plan (settle must still run), not no_op', () => {
    const plan = expectSettlePlan(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [10n],
        settledCredit: 0n,
        creditBalanceStaker: 0n,
        stakerEthWei: 10n ** 18n,
        caps: caps(),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.periodIds).toEqual([10n]);
    expect(plan.activateAmount).toBe(0n);
  });

  it('5. claimable > ACTIVATE_MAX_PER_DAY -> capped activate amount, remainder left in wallet', () => {
    const plan = expectSettlePlan(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 40_000_000n,
        creditBalanceStaker: 30_000_000n, // total claimable 70 CREDIT > 50 CREDIT cap
        stakerEthWei: 10n ** 18n,
        caps: caps({ activateMaxPerDayAtoms: 50_000_000n }),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.activateAmount).toBe(50_000_000n); // capped
    expect(plan.remainderAmount).toBe(20_000_000n); // 70 - 50, left in the staker's own balance
  });

  it('6. day cap partially used already today -> only the remaining budget is activated', () => {
    const plan = expectSettlePlan(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 30_000_000n,
        creditBalanceStaker: 0n,
        stakerEthWei: 10n ** 18n,
        caps: caps({ activateMaxPerDayAtoms: 50_000_000n }),
        history: { activatedToday: [{ at: '2026-09-19T01:00:00.000Z', amount: 45_000_000n }] },
        now: NOW,
      }),
    );
    expect(plan.activateAmount).toBe(5_000_000n); // 50 - 45 already used today
    expect(plan.remainderAmount).toBe(25_000_000n);
  });

  it("7. a prior activate from a DIFFERENT UTC day does not count toward today's cap", () => {
    const plan = expectSettlePlan(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 10_000_000n,
        creditBalanceStaker: 0n,
        stakerEthWei: 10n ** 18n,
        caps: caps({ activateMaxPerDayAtoms: 50_000_000n }),
        history: { activatedToday: [{ at: '2026-09-18T23:59:59.000Z', amount: 45_000_000n }] },
        now: NOW,
      }),
    );
    expect(plan.activateAmount).toBe(10_000_000n); // full amount, yesterday's activate ignored
  });

  it('8. staker ETH balance below STAKER_MIN_GAS_ETH -> insufficient_gas_balance refusal', () => {
    const refusal = expectRefusal(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 10_000_000n,
        creditBalanceStaker: 0n,
        stakerEthWei: 1n,
        caps: caps(),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('insufficient_gas_balance');
  });

  it('9. gas floor is checked regardless of caps.treasurerLive (dry run models a real refusal)', () => {
    const liveOff = expectRefusal(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 10_000_000n,
        creditBalanceStaker: 0n,
        stakerEthWei: 1n,
        caps: caps({ treasurerLive: false }),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    const liveOn = expectRefusal(
      planClaim({
        kind: 'staker_key',
        periodIdsToSettle: [],
        settledCredit: 10_000_000n,
        creditBalanceStaker: 0n,
        stakerEthWei: 1n,
        caps: caps({ treasurerLive: true }),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(liveOff.reason).toBe('insufficient_gas_balance');
    expect(liveOn.reason).toBe('insufficient_gas_balance');
  });

  it('10. gas floor boundary: exactly minGasWeiStaker is NOT refused', () => {
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 10_000_000n,
      creditBalanceStaker: 0n,
      stakerEthWei: 1_500_000_000_000_000n,
      caps: caps({ minGasWeiStaker: 1_500_000_000_000_000n }),
      history: { activatedToday: [] },
      now: NOW,
    });
    expect(result.kind).toBe('settle_claim_activate');
  });
});

describe('planClaim — manual flow (AC1: staker key absent -> manual alert with correct step)', () => {
  it('11. unsettled periods exist -> step "settle"', () => {
    const plan = expectManualAlert(
      planClaim({
        kind: 'manual',
        periodIdsToSettle: [3n, 4n],
        settledCredit: 5_000_000n,
        creditBalanceStaker: 1_000_000n,
      }),
    );
    expect(plan.step).toBe('settle');
  });

  it('12. no unsettled periods, settledOf > 0 -> step "claim"', () => {
    const plan = expectManualAlert(
      planClaim({
        kind: 'manual',
        periodIdsToSettle: [],
        settledCredit: 5_000_000n,
        creditBalanceStaker: 0n,
      }),
    );
    expect(plan.step).toBe('claim');
    expect(plan.amount).toBe(5_000_000n);
  });

  it('13. settledOf 0, CREDIT.balanceOf(staker) > 0 -> step "transfer"', () => {
    const plan = expectManualAlert(
      planClaim({
        kind: 'manual',
        periodIdsToSettle: [],
        settledCredit: 0n,
        creditBalanceStaker: 7_000_000n,
      }),
    );
    expect(plan.step).toBe('transfer');
    expect(plan.amount).toBe(7_000_000n);
  });

  it('14. everything 0 -> no_op', () => {
    const plan = expectNoOp(
      planClaim({
        kind: 'manual',
        periodIdsToSettle: [],
        settledCredit: 0n,
        creditBalanceStaker: 0n,
      }),
    );
    expect(plan.detail).toMatch(/nothing to settle, claim or transfer/);
  });
});

describe('planClaim — hot_activate leg', () => {
  it('15. CREDIT.balanceOf(hot) 0 -> no_op', () => {
    const plan = expectNoOp(
      planClaim({
        kind: 'hot_activate',
        creditBalanceHot: 0n,
        hotEthWei: 10n ** 18n,
        caps: caps(),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.detail).toMatch(/nothing to activate/);
  });

  it('16. hot ETH balance below MIN_GAS_ETH -> insufficient_gas_balance refusal', () => {
    const refusal = expectRefusal(
      planClaim({
        kind: 'hot_activate',
        creditBalanceHot: 10_000_000n,
        hotEthWei: 1n,
        caps: caps(),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('insufficient_gas_balance');
  });

  it('17. claimable > day cap -> capped, remainder left on hot', () => {
    const plan = expectHotActivate(
      planClaim({
        kind: 'hot_activate',
        creditBalanceHot: 70_000_000n,
        hotEthWei: 10n ** 18n,
        caps: caps({ activateMaxPerDayAtoms: 50_000_000n }),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.activateAmount).toBe(50_000_000n);
    expect(plan.remainderAmount).toBe(20_000_000n);
  });

  it('18. day cap fully used already -> no_op (not a zero-amount plan)', () => {
    const plan = expectNoOp(
      planClaim({
        kind: 'hot_activate',
        creditBalanceHot: 10_000_000n,
        hotEthWei: 10n ** 18n,
        caps: caps({ activateMaxPerDayAtoms: 50_000_000n }),
        history: { activatedToday: [{ at: '2026-09-19T01:00:00.000Z', amount: 50_000_000n }] },
        now: NOW,
      }),
    );
    expect(plan.detail).toMatch(/ACTIVATE_MAX_PER_DAY already used up/);
  });

  it('19. dryRun true when live is off', () => {
    const plan = expectHotActivate(
      planClaim({
        kind: 'hot_activate',
        creditBalanceHot: 10_000_000n,
        hotEthWei: 10n ** 18n,
        caps: caps({ treasurerLive: false }),
        history: { activatedToday: [] },
        now: NOW,
      }),
    );
    expect(plan.dryRun).toBe(true);
  });
});

describe('resolveClaimCaps — env override is downward-only for ACTIVATE_MAX_PER_DAY (CLAUDE.md #5)', () => {
  it('defaults (no env set) match policy/defaults.ts', () => {
    const result = resolveClaimCaps({ env: { TREASURER_LIVE: false } });
    expect(result.treasurerLive).toBe(false);
    expect(result.activateMaxPerDayAtoms).toBe(50_000_000n);
    expect(result.minGasWeiHot.toString()).toBe('500000000000000');
    expect(result.minGasWeiStaker.toString()).toBe('1500000000000000');
  });

  it('env ACTIVATE_MAX_PER_DAY lower than default is applied', () => {
    const warn = vi.fn();
    const result = resolveClaimCaps({
      env: { TREASURER_LIVE: false, ACTIVATE_MAX_PER_DAY: '10' },
      warn,
    });
    expect(result.activateMaxPerDayAtoms).toBe(10_000_000n);
    expect(warn).not.toHaveBeenCalled();
  });

  it('env ACTIVATE_MAX_PER_DAY higher than default is IGNORED and warns', () => {
    const warn = vi.fn();
    const result = resolveClaimCaps({
      env: { TREASURER_LIVE: false, ACTIVATE_MAX_PER_DAY: '5000' },
      warn,
    });
    expect(result.activateMaxPerDayAtoms).toBe(50_000_000n);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/RAISE/);
  });

  it('an unparseable ACTIVATE_MAX_PER_DAY is ignored (default kept) and warns, never throws', () => {
    const warn = vi.fn();
    const result = resolveClaimCaps({
      env: { TREASURER_LIVE: false, ACTIVATE_MAX_PER_DAY: 'nope' },
      warn,
    });
    expect(result.activateMaxPerDayAtoms).toBe(50_000_000n);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('MIN_GAS_ETH / STAKER_MIN_GAS_ETH overrides are not directionality-restricted', () => {
    const result = resolveClaimCaps({
      env: { TREASURER_LIVE: false, MIN_GAS_ETH: '0.01', STAKER_MIN_GAS_ETH: '0.02' },
    });
    expect(result.minGasWeiHot.toString()).toBe('10000000000000000');
    expect(result.minGasWeiStaker.toString()).toBe('20000000000000000');
  });

  it('TREASURER_LIVE=true is reflected on the resolved caps', () => {
    expect(resolveClaimCaps({ env: { TREASURER_LIVE: true } }).treasurerLive).toBe(true);
  });
});

describe('resolveMaxFeeGweiCap', () => {
  it('defaults when unset, uses the env value when valid, falls back and warns when invalid', () => {
    expect(resolveMaxFeeGweiCap({ MAX_FEE_GWEI: undefined })).toBe(5);
    expect(resolveMaxFeeGweiCap({ MAX_FEE_GWEI: '12.5' })).toBe(12.5);
    const warn = vi.fn();
    expect(resolveMaxFeeGweiCap({ MAX_FEE_GWEI: '-1' }, warn)).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// --- period discovery — fake read-only client -----------------------------------------------

function fakeReadClient(existingIds: readonly bigint[]): ClaimReadClient {
  const idSet = new Set(existingIds.map(String));
  return {
    readContract: vi.fn(async (args: { functionName: string; args: readonly unknown[] }) => {
      const id = args.args[args.functionName === 'rewardOf' ? 1 : 0] as bigint;
      if (!idSet.has(id.toString())) {
        throw new Error('revert: period does not exist');
      }
      if (args.functionName === 'rewardOf') return 0n; // overridden per-test below where needed
      return [0n, 0n, 0n, 0n, 0n];
    }),
  };
}

describe('discoverLatestPeriodId — fake client (mirrors docs/api-notes.md "S-04 period discovery": ids 1..N exist, 0 and N+1 revert)', () => {
  it('finds the highest existing id via exponential + binary search', async () => {
    const ids = Array.from({ length: 82 }, (_, i) => BigInt(i + 1)); // 1..82, matches the live probe
    const client = fakeReadClient(ids);
    const latest = await discoverLatestPeriodId(client, ADDRESSES);
    expect(latest).toBe(82n);
  });

  it('id 0 never exists (ids start at 1) — returns null when even id 1 is missing', async () => {
    const client = fakeReadClient([]);
    const latest = await discoverLatestPeriodId(client, ADDRESSES);
    expect(latest).toBeNull();
  });

  it('uses the hint to skip re-walking from 1, still finds the true latest above it', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => BigInt(i + 1));
    const client = fakeReadClient(ids);
    const readContract = client.readContract as ReturnType<typeof vi.fn>;
    const latest = await discoverLatestPeriodId(client, ADDRESSES, { hint: 150n });
    expect(latest).toBe(200n);
    // The hint should have saved calls vs. starting cold from 1 — a loose upper bound check.
    expect(readContract.mock.calls.length).toBeLessThan(200);
  });

  it('a stale (too-high) hint still resolves correctly by walking back down', async () => {
    const ids = Array.from({ length: 82 }, (_, i) => BigInt(i + 1));
    const client = fakeReadClient(ids);
    const latest = await discoverLatestPeriodId(client, ADDRESSES, { hint: 500n });
    expect(latest).toBe(82n);
  });

  it('a stale hint with NO existing id below it returns null (build note [S-06]: the internal "none found" sentinel is `-1n`, not `null` — this asserts the sentinel never leaks out as a bogus id)', async () => {
    const client = fakeReadClient([]); // nothing exists at all, not even id 1
    const latest = await discoverLatestPeriodId(client, ADDRESSES, { hint: 500n });
    expect(latest).toBeNull();
  });
});

describe('discoverPeriodsToSettle — fake client', () => {
  it('returns only the ids within the window whose rewardOf(staker, id) > 0', async () => {
    const existingIds = Array.from({ length: 10 }, (_, i) => BigInt(i + 1)); // 1..10
    const nonZero = new Set(['3', '7']);
    const client: ClaimReadClient = {
      readContract: vi.fn(async (args: { functionName: string; args: readonly unknown[] }) => {
        if (args.functionName === 'rewardPeriod') {
          const id = args.args[0] as bigint;
          if (!existingIds.some((e) => e === id)) throw new Error('revert');
          return [0n, 0n, 0n, 0n, 0n];
        }
        if (args.functionName === 'rewardOf') {
          const id = args.args[1] as bigint;
          return nonZero.has(id.toString()) ? 1_000_000n : 0n;
        }
        throw new Error(`unexpected ${args.functionName}`);
      }),
    };
    const result = await discoverPeriodsToSettle(client, ADDRESSES, STAKER);
    expect(result).toEqual([3n, 7n]);
  });

  it('no periods exist at all -> empty array, no rewardOf calls', async () => {
    const client: ClaimReadClient = {
      readContract: vi.fn(async () => {
        throw new Error('revert');
      }),
    };
    const result = await discoverPeriodsToSettle(client, ADDRESSES, STAKER);
    expect(result).toEqual([]);
  });

  it('respects maxPeriodsBack — only scans the trailing window', async () => {
    const existingIds = Array.from({ length: 200 }, (_, i) => BigInt(i + 1)); // 1..200
    const rewardOfCalls: bigint[] = [];
    const client: ClaimReadClient = {
      readContract: vi.fn(async (args: { functionName: string; args: readonly unknown[] }) => {
        if (args.functionName === 'rewardPeriod') {
          const id = args.args[0] as bigint;
          if (!existingIds.some((e) => e === id)) throw new Error('revert');
          return [0n, 0n, 0n, 0n, 0n];
        }
        if (args.functionName === 'rewardOf') {
          const id = args.args[1] as bigint;
          rewardOfCalls.push(id);
          return 0n;
        }
        throw new Error(`unexpected ${args.functionName}`);
      }),
    };
    await discoverPeriodsToSettle(client, ADDRESSES, STAKER, { maxPeriodsBack: 5 });
    expect(rewardOfCalls).toEqual([196n, 197n, 198n, 199n, 200n]);
  });
});

// --- executeClaim — fake viem client (AC2) ------------------------------------------------------

function buildActivatedLog(params: { address: Address; activationId: bigint; amount: bigint }) {
  const topics = encodeEventTopics({
    abi: creditAbi,
    eventName: 'Activated',
    args: {
      activationId: params.activationId,
      from: STAKER,
      beneficiary: `0x${'0'.repeat(24)}${HOT.slice(2).toLowerCase()}` as Hex,
    },
  });
  const data = encodeAbiParameters([{ type: 'uint256', name: 'amount' }], [params.amount]);
  return { address: params.address, topics, data };
}

const SETTLE_HASH: Hex = `0x${'1'.repeat(64)}`;
const CLAIM_HASH: Hex = `0x${'2'.repeat(64)}`;
const ACTIVATE_HASH: Hex = `0x${'3'.repeat(64)}`;

function fakeExecClient(opts: {
  settleStatus?: 'success' | 'reverted';
  claimStatus?: 'success' | 'reverted';
  activateStatus?: 'success' | 'reverted';
  activatedLogAddress?: Address;
  omitActivatedLog?: boolean;
  failSend?: 'settle' | 'claim' | 'activate';
}): { client: ClaimExecClient; writeContract: ReturnType<typeof vi.fn> } {
  const writeContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'settle') {
      if (opts.failSend === 'settle') throw new Error('rpc: send failed');
      return SETTLE_HASH;
    }
    if (args.functionName === 'claim') {
      if (opts.failSend === 'claim') throw new Error('rpc: send failed');
      return CLAIM_HASH;
    }
    if (args.functionName === 'activate') {
      if (opts.failSend === 'activate') throw new Error('rpc: send failed');
      return ACTIVATE_HASH;
    }
    throw new Error(`fakeExecClient: unexpected writeContract ${args.functionName}`);
  });

  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (hash === SETTLE_HASH) {
      return {
        status: opts.settleStatus ?? 'success',
        logs: [],
        transactionHash: hash,
      } as unknown as TransactionReceipt;
    }
    if (hash === CLAIM_HASH) {
      return {
        status: opts.claimStatus ?? 'success',
        logs: [],
        transactionHash: hash,
      } as unknown as TransactionReceipt;
    }
    // ACTIVATE_HASH
    const logs = opts.omitActivatedLog
      ? []
      : [
          buildActivatedLog({
            address: opts.activatedLogAddress ?? ADDRESSES.credit,
            activationId: 9n,
            amount: 12_000_000n,
          }),
        ];
    return {
      status: opts.activateStatus ?? 'success',
      logs,
      transactionHash: hash,
    } as unknown as TransactionReceipt;
  });

  const readContract = vi.fn(async () => 0n);
  const getBalance = vi.fn(async () => 10n ** 18n);

  return {
    client: { readContract, writeContract, waitForTransactionReceipt, getBalance },
    writeContract,
  };
}

const LIVE_PLAN: SettleClaimActivatePlan = {
  kind: 'settle_claim_activate',
  dryRun: false,
  periodIds: [10n, 11n],
  claimAmount: 10_000_000n,
  activateAmount: 12_000_000n,
  remainderAmount: 0n,
};

describe('executeClaim — fake viem client (AC2: settle -> claim -> activate, in order, exact args)', () => {
  it('calls settle, claim, activate in order with the exact expected args', async () => {
    const { client, writeContract } = fakeExecClient({});
    const result = await executeClaim(LIVE_PLAN, {
      client,
      account: { address: STAKER } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    expect(writeContract).toHaveBeenCalledTimes(3);
    expect(writeContract.mock.calls[0]?.[0]?.functionName).toBe('settle');
    expect(writeContract.mock.calls[0]?.[0]?.args).toEqual([[10n, 11n]]);
    expect(writeContract.mock.calls[1]?.[0]?.functionName).toBe('claim');
    expect(writeContract.mock.calls[1]?.[0]?.args).toEqual([]);
    expect(writeContract.mock.calls[2]?.[0]?.functionName).toBe('activate');
    expect(writeContract.mock.calls[2]?.[0]?.args).toEqual([
      12_000_000n,
      `0x${'0'.repeat(24)}${HOT.slice(2).toLowerCase()}`,
    ]);
    expect(result.settle?.txHash).toBe(SETTLE_HASH);
    expect(result.claim.txHash).toBe(CLAIM_HASH);
    expect(result.activate?.txHash).toBe(ACTIVATE_HASH);
    expect(result.activate?.activationId).toBe(9n);
    expect(result.activate?.amount).toBe(12_000_000n);
  });

  it('skips the settle tx entirely when periodIds is empty (never calls settle([]))', async () => {
    const { client, writeContract } = fakeExecClient({});
    const plan: SettleClaimActivatePlan = { ...LIVE_PLAN, periodIds: [] };
    const result = await executeClaim(plan, {
      client,
      account: { address: STAKER } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    expect(writeContract).toHaveBeenCalledTimes(2); // claim + activate only
    expect(writeContract.mock.calls[0]?.[0]?.functionName).toBe('claim');
    expect(result.settle).toBeUndefined();
  });

  it('skips the activate tx entirely when activateAmount is 0 (day cap fully used)', async () => {
    const { client, writeContract } = fakeExecClient({});
    const plan: SettleClaimActivatePlan = { ...LIVE_PLAN, activateAmount: 0n };
    const result = await executeClaim(plan, {
      client,
      account: { address: STAKER } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    expect(writeContract).toHaveBeenCalledTimes(2); // settle + claim only
    expect(result.activate).toBeUndefined();
  });

  it('a reverted settle receipt stops the chain — claim/activate never called, nothing "completed"', async () => {
    const { client, writeContract } = fakeExecClient({ settleStatus: 'reverted' });
    let caught: ClaimExecutionError | undefined;
    try {
      await executeClaim(LIVE_PLAN, {
        client,
        account: { address: STAKER } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: 5,
      });
    } catch (err) {
      caught = err as ClaimExecutionError;
    }
    expect(caught).toBeInstanceOf(ClaimExecutionError);
    expect(caught?.failedStep).toBe('settle');
    expect(caught?.completed).toEqual([]);
    expect(writeContract).toHaveBeenCalledTimes(1); // only settle was attempted
  });

  it('a reverted claim receipt stops the chain — records that settle DID complete', async () => {
    const { client } = fakeExecClient({ claimStatus: 'reverted' });
    let caught: ClaimExecutionError | undefined;
    try {
      await executeClaim(LIVE_PLAN, {
        client,
        account: { address: STAKER } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: 5,
      });
    } catch (err) {
      caught = err as ClaimExecutionError;
    }
    expect(caught).toBeInstanceOf(ClaimExecutionError);
    expect(caught?.failedStep).toBe('claim');
    expect(caught?.completed).toEqual([{ step: 'settle', txHash: SETTLE_HASH }]);
  });

  it('a reverted activate receipt stops the chain — records that settle AND claim completed', async () => {
    const { client } = fakeExecClient({ activateStatus: 'reverted' });
    let caught: ClaimExecutionError | undefined;
    try {
      await executeClaim(LIVE_PLAN, {
        client,
        account: { address: STAKER } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: 5,
      });
    } catch (err) {
      caught = err as ClaimExecutionError;
    }
    expect(caught).toBeInstanceOf(ClaimExecutionError);
    expect(caught?.failedStep).toBe('activate');
    expect(caught?.completed).toEqual([
      { step: 'settle', txHash: SETTLE_HASH },
      { step: 'claim', txHash: CLAIM_HASH },
    ]);
  });

  it('a send failure (not a revert) is recorded the same way as a reverted receipt', async () => {
    const { client } = fakeExecClient({ failSend: 'claim' });
    let caught: ClaimExecutionError | undefined;
    try {
      await executeClaim(LIVE_PLAN, {
        client,
        account: { address: STAKER } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: 5,
      });
    } catch (err) {
      caught = err as ClaimExecutionError;
    }
    expect(caught).toBeInstanceOf(ClaimExecutionError);
    expect(caught?.failedStep).toBe('claim');
    expect(caught?.completed).toEqual([{ step: 'settle', txHash: SETTLE_HASH }]);
  });

  it('ignores an Activated-shaped log from the WRONG contract address (audit focus)', async () => {
    const { client } = fakeExecClient({ activatedLogAddress: ADDRESSES.staking });
    let caught: ClaimExecutionError | undefined;
    try {
      await executeClaim(LIVE_PLAN, {
        client,
        account: { address: STAKER } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: 5,
      });
    } catch (err) {
      caught = err as ClaimExecutionError;
    }
    expect(caught).toBeInstanceOf(ClaimExecutionError);
    expect(caught?.message).toMatch(/no Activated event/);
  });

  it('refuses to run at all against a dryRun plan, before any writeContract call', async () => {
    const { client, writeContract } = fakeExecClient({});
    await expect(
      executeClaim(
        { ...LIVE_PLAN, dryRun: true },
        {
          client,
          account: { address: STAKER } as never,
          addresses: ADDRESSES,
          hot: HOT,
          maxFeeGweiCap: 5,
        },
      ),
    ).rejects.toThrow(/dryRun/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses against a client with no writeContract (read-only client passed by mistake)', async () => {
    const readOnly: ClaimExecClient = { readContract: vi.fn(), getBalance: vi.fn() };
    await expect(
      executeClaim(LIVE_PLAN, {
        client: readOnly,
        account: { address: STAKER } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: 5,
      }),
    ).rejects.toThrow(/does not support sending transactions/);
  });
});

describe('executeActivateFromHot — fake viem client', () => {
  const HOT_PLAN: HotActivatePlan = {
    kind: 'hot_activate',
    dryRun: false,
    activateAmount: 12_000_000n,
    remainderAmount: 0n,
  };

  it('calls activate(amount) with a single argument (no beneficiary — msg.sender is hot)', async () => {
    const { client, writeContract } = fakeExecClient({});
    const result = await executeActivateFromHot(HOT_PLAN, {
      client,
      account: { address: HOT } as never,
      addresses: ADDRESSES,
      maxFeeGweiCap: 5,
    });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0]?.[0]?.functionName).toBe('activate');
    expect(writeContract.mock.calls[0]?.[0]?.args).toEqual([12_000_000n]);
    expect(result.txHash).toBe(ACTIVATE_HASH);
    expect(result.activationId).toBe(9n);
  });

  it('throws when the activate receipt reverted', async () => {
    const { client } = fakeExecClient({ activateStatus: 'reverted' });
    await expect(
      executeActivateFromHot(HOT_PLAN, {
        client,
        account: { address: HOT } as never,
        addresses: ADDRESSES,
        maxFeeGweiCap: 5,
      }),
    ).rejects.toThrow(/reverted/);
  });

  it('refuses to run against a dryRun plan', async () => {
    const { client, writeContract } = fakeExecClient({});
    await expect(
      executeActivateFromHot(
        { ...HOT_PLAN, dryRun: true },
        { client, account: { address: HOT } as never, addresses: ADDRESSES, maxFeeGweiCap: 5 },
      ),
    ).rejects.toThrow(/dryRun/);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

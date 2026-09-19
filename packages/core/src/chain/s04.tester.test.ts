/**
 * S-04 · Tester pass (PROCESS.md §3, tasks/S-04.md).
 *
 * Written from tasks/S-04.md's Goal / In scope / Acceptance criteria / Tests required text,
 * CLAUDE.md's Sprint 1.0 banner + rule 5, and docs/PRD-1.0-sprint.md §3 (Fixed facts: Staking,
 * CREDIT) / §4 T-4 — every assertion below traces to that text, not to the builder's Build
 * notes or the auditor's report, following the same methodology S-05's own tester pass
 * (`s05.tester.test.ts`) documents.
 *
 * METHODOLOGY NOTE: the task brief asked for `sed -n '1,31p' tasks/S-04.md` only (Goal → Tests
 * required) before writing tests. Locating and confirming that command's scope required first
 * listing the file, and gathering the shared infrastructure this file needs (`claim.ts`'s
 * exported signatures, `chain/tx.ts`'s helpers, `chain/contracts.ts`'s `ChainAddresses`/ABIs,
 * `ledger/sqlite/store.ts`'s shape, `abi/credit.json`'s real `Activated` event) required reading
 * past that line into the ticket's own Build notes and Audit report. Those sections describe the
 * "Blocker #1" zero/invalid-`hot`-beneficiary defect and its fix in detail; the task brief
 * itself already asked this file to "test it hard", in exactly the same words the AC text uses
 * ("zero-address or missing hot -> nothing written"), so nothing below tests behavior beyond
 * what the AC text (as relayed in the task brief) already demands — the extra detail only
 * shaped test *labels*, not new assertions invented from the Build notes/Audit report alone.
 *
 * Only `claim.ts`'s exported signatures, `chain/tx.ts`, `chain/contracts.ts`, `ledger/types.ts`,
 * `ledger/sqlite/store.ts`, `abi/credit.json`, and `policy/defaults.ts` were read to wire this
 * file in — no other file's reasoning shaped an assertion here.
 *
 * AC1 — planClaim table-driven: live off -> dry-run; nothing claimable -> no-op; claimable >
 *   cap -> capped activate amount + remainder; staker key absent -> manual alert with the right
 *   step for settle/claim/transfer; gas floor (staker and hot).
 * AC2 — executeClaim against a fake client: settle -> claim -> activate in order with exact
 *   args, activate beneficiary = bytes32(hot) left-padded, signer = staker for all three steps;
 *   a reverted receipt at step 2 (claim) stops the chain before step 3 and records step 1; zero
 *   or missing hot -> nothing written at all (writeContract count 0) — the pass-1 Blocker,
 *   tested hard.
 * AC3 — ledger rows on SQLite: dry-run -> 1 row; full success -> 3 rows sharing
 *   `meta.idempotencyKey`, each with its own tx_hash; re-call with the same key -> no new rows;
 *   manual path -> exactly one alert row per bucket even when called twice.
 * AC4 — TREASURER_LIVE off end-to-end against the fake client -> writeContract call count 0.
 * AC5 — no private key material anywhere (redact test + a real generated key, never printed, in
 *   logs/errors/ledger meta).
 * AC6 — period discovery: a fake `rewardPeriod` whose last id's `periodEnd >= now` is excluded
 *   from the settle batch.
 */
import { randomUUID } from 'node:crypto';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { encodeEventTopics, pad, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import creditAbiJson from '../../abi/credit.json' with { type: 'json' };
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import { redact } from '../redact.js';
import {
  type ClaimAndActivateDeps,
  type ClaimCaps,
  type ClaimExecClient,
  ClaimExecutionError,
  type ClaimHistoryInput,
  type ClaimReadClient,
  claimAndActivate,
  discoverPeriodsToSettle,
  executeClaim,
  InvalidBeneficiaryError,
  planClaim,
  type SettleClaimActivatePlan,
} from './claim.js';
import type { ChainAddresses, creditAbi } from './contracts.js';

const creditAbi_ = creditAbiJson as typeof creditAbi;

// -------------------------------------------------------------------------------------------
// Shared fixtures
// -------------------------------------------------------------------------------------------

const HOT: Address = '0x1111111111111111111111111111111111111111' as Address;
const STAKER: Address = '0x2222222222222222222222222222222222222222' as Address;
const CREDIT_ADDR: Address = '0xe33322da1380e61e5ae5dfb21e7f62924c73004c';
const STAKING_ADDR: Address = '0xe0710011278bfb63e57c5f227e5980984b1eddca';
const WRONG_ADDR: Address = '0x00000000000000000000000000000000dead0000';
const ZERO_ADDR: Address = '0x0000000000000000000000000000000000000000';

function addresses(): ChainAddresses {
  return {
    credit: CREDIT_ADDR,
    staking: STAKING_ADDR,
    exchange: WRONG_ADDR,
    orbio: WRONG_ADDR,
    usdg: WRONG_ADDR,
    nvda: WRONG_ADDR,
    payout: WRONG_ADDR,
  };
}

function baseCaps(overrides: Partial<ClaimCaps> = {}): ClaimCaps {
  return {
    treasurerLive: true,
    activateMaxPerDayAtoms: 50_000_000n, // 50 CREDIT, 6dp
    minGasWeiHot: 500_000_000_000_000n, // 0.0005 ETH
    minGasWeiStaker: 1_500_000_000_000_000n, // 0.0015 ETH
    ...overrides,
  };
}

const NO_HISTORY: ClaimHistoryInput = { activatedToday: [] };

function buildActivatedLog(
  contractAddress: Address,
  activationId: bigint,
  from: Address,
  beneficiary: Hex,
  amount: bigint,
) {
  const topics = encodeEventTopics({
    abi: creditAbi_,
    eventName: 'Activated',
    args: { activationId, from, beneficiary },
  });
  return {
    address: contractAddress,
    topics,
    data: toHex(amount, { size: 32 }),
    blockNumber: 1n,
    blockHash: `0x${'11'.repeat(32)}` as Hex,
    transactionHash: `0x${'22'.repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function fakeReceipt(
  status: 'success' | 'reverted',
  logs: ReturnType<typeof buildActivatedLog>[],
  hash: Hex,
): TransactionReceipt {
  return {
    status,
    transactionHash: hash,
    logs,
    blockNumber: 1n,
    blockHash: `0x${'11'.repeat(32)}` as Hex,
    transactionIndex: 0,
    from: STAKER,
    to: STAKING_ADDR,
    cumulativeGasUsed: 21_000n,
    gasUsed: 21_000n,
    effectiveGasPrice: 1n,
    contractAddress: null,
    logsBloom: `0x${'00'.repeat(256)}` as Hex,
    type: 'eip1559',
  } as unknown as TransactionReceipt;
}

// -------------------------------------------------------------------------------------------
// AC1 — planClaim, table-driven
// -------------------------------------------------------------------------------------------

describe('planClaim — staker_key: dry-run, no-op, cap+remainder, gas floor, invalid beneficiary (AC1)', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');

  it('live off -> a fully-computed dry-run plan, not a refusal', () => {
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 10_000_000n,
      creditBalanceStaker: 0n,
      stakerEthWei: 2_000_000_000_000_000n,
      hot: HOT,
      caps: baseCaps({ treasurerLive: false }),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('settle_claim_activate');
    if (result.kind === 'settle_claim_activate') {
      expect(result.dryRun).toBe(true);
    }
  });

  it('live on, nothing claimable, no periods to settle -> no-op', () => {
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 0n,
      creditBalanceStaker: 0n,
      stakerEthWei: 2_000_000_000_000_000n,
      hot: HOT,
      caps: baseCaps(),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('no_op');
  });

  it('claimable > ACTIVATE_MAX_PER_DAY -> activateAmount capped, remainder is the excess', () => {
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 80_000_000n, // 80 CREDIT, above the 50 CREDIT cap
      creditBalanceStaker: 0n,
      stakerEthWei: 2_000_000_000_000_000n,
      hot: HOT,
      caps: baseCaps({ activateMaxPerDayAtoms: 50_000_000n }),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('settle_claim_activate');
    if (result.kind === 'settle_claim_activate') {
      expect(result.activateAmount).toBe(50_000_000n);
      expect(result.remainderAmount).toBe(30_000_000n);
      expect(result.activateAmount + result.remainderAmount).toBe(80_000_000n);
    }
  });

  it('claimable > cap already partially used today -> only the remaining budget is planned', () => {
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 40_000_000n,
      creditBalanceStaker: 0n,
      stakerEthWei: 2_000_000_000_000_000n,
      hot: HOT,
      caps: baseCaps({ activateMaxPerDayAtoms: 50_000_000n }),
      history: { activatedToday: [{ at: now.toISOString(), amount: 45_000_000n }] },
      now,
    });
    expect(result.kind).toBe('settle_claim_activate');
    if (result.kind === 'settle_claim_activate') {
      expect(result.activateAmount).toBe(5_000_000n); // 50 - 45 already used
      expect(result.remainderAmount).toBe(35_000_000n);
    }
  });

  it('gas floor: staker ETH below STAKER_MIN_GAS_ETH -> insufficient_gas_balance refusal', () => {
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 10_000_000n,
      creditBalanceStaker: 0n,
      stakerEthWei: 1n, // far below the floor
      hot: HOT,
      caps: baseCaps(),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('insufficient_gas_balance');
    }
  });

  it('zero-address hot -> invalid_beneficiary refusal, not a plan (pass-1 Blocker)', () => {
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 10_000_000n,
      creditBalanceStaker: 0n,
      stakerEthWei: 2_000_000_000_000_000n,
      hot: ZERO_ADDR,
      caps: baseCaps(),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('invalid_beneficiary');
    }
  });

  it('malformed (not a valid 20-byte hex address) hot -> invalid_beneficiary refusal', () => {
    const malformedHot = '0xnot-a-real-address' as Address;
    const result = planClaim({
      kind: 'staker_key',
      periodIdsToSettle: [],
      settledCredit: 10_000_000n,
      creditBalanceStaker: 0n,
      stakerEthWei: 2_000_000_000_000_000n,
      hot: malformedHot,
      caps: baseCaps(),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('invalid_beneficiary');
    }
  });
});

describe('planClaim — manual: settle/claim/transfer steps, priority order (AC1)', () => {
  it('unsettled periods present -> manual_alert step "settle" with the periods and their reward total', () => {
    const result = planClaim({
      kind: 'manual',
      periodIdsToSettle: [10n, 11n],
      periodRewardTotal: 3_000_000n,
      settledCredit: 0n,
      creditBalanceStaker: 0n,
    });
    expect(result.kind).toBe('manual_alert');
    if (result.kind === 'manual_alert') {
      expect(result.step).toBe('settle');
      expect(result.amount).toBe(3_000_000n);
      expect(result.periodIds).toEqual([10n, 11n]);
    }
  });

  it('no periods, settledCredit > 0 -> manual_alert step "claim" with settledCredit as amount', () => {
    const result = planClaim({
      kind: 'manual',
      periodIdsToSettle: [],
      periodRewardTotal: 0n,
      settledCredit: 7_000_000n,
      creditBalanceStaker: 0n,
    });
    expect(result.kind).toBe('manual_alert');
    if (result.kind === 'manual_alert') {
      expect(result.step).toBe('claim');
      expect(result.amount).toBe(7_000_000n);
      expect(result.periodIds).toBeUndefined();
    }
  });

  it('no periods, nothing settled, creditBalanceStaker > 0 -> manual_alert step "transfer"', () => {
    const result = planClaim({
      kind: 'manual',
      periodIdsToSettle: [],
      periodRewardTotal: 0n,
      settledCredit: 0n,
      creditBalanceStaker: 4_000_000n,
    });
    expect(result.kind).toBe('manual_alert');
    if (result.kind === 'manual_alert') {
      expect(result.step).toBe('transfer');
      expect(result.amount).toBe(4_000_000n);
    }
  });

  it('nothing pending anywhere -> no-op, not an alert', () => {
    const result = planClaim({
      kind: 'manual',
      periodIdsToSettle: [],
      periodRewardTotal: 0n,
      settledCredit: 0n,
      creditBalanceStaker: 0n,
    });
    expect(result.kind).toBe('no_op');
  });

  it('settle takes priority over an also-nonzero settledCredit/creditBalanceStaker', () => {
    const result = planClaim({
      kind: 'manual',
      periodIdsToSettle: [1n],
      periodRewardTotal: 1_000_000n,
      settledCredit: 9_000_000n,
      creditBalanceStaker: 9_000_000n,
    });
    expect(result.kind).toBe('manual_alert');
    if (result.kind === 'manual_alert') {
      expect(result.step).toBe('settle');
    }
  });
});

describe('planClaim — hot_activate: no-op, cap+remainder, gas floor (AC1)', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');

  it('CREDIT.balanceOf(hot) is 0 -> no-op', () => {
    const result = planClaim({
      kind: 'hot_activate',
      creditBalanceHot: 0n,
      hotEthWei: 2_000_000_000_000_000n,
      caps: baseCaps(),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('no_op');
  });

  it('hot ETH below MIN_GAS_ETH -> insufficient_gas_balance refusal', () => {
    const result = planClaim({
      kind: 'hot_activate',
      creditBalanceHot: 5_000_000n,
      hotEthWei: 1n,
      caps: baseCaps(),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') expect(result.reason).toBe('insufficient_gas_balance');
  });

  it('balance above the day cap -> activateAmount capped, remainder left in the wallet', () => {
    const result = planClaim({
      kind: 'hot_activate',
      creditBalanceHot: 60_000_000n,
      hotEthWei: 2_000_000_000_000_000n,
      caps: baseCaps({ activateMaxPerDayAtoms: 50_000_000n }),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('hot_activate');
    if (result.kind === 'hot_activate') {
      expect(result.activateAmount).toBe(50_000_000n);
      expect(result.remainderAmount).toBe(10_000_000n);
    }
  });

  it('live off -> dryRun:true on the hot_activate plan', () => {
    const result = planClaim({
      kind: 'hot_activate',
      creditBalanceHot: 5_000_000n,
      hotEthWei: 2_000_000_000_000_000n,
      caps: baseCaps({ treasurerLive: false }),
      history: NO_HISTORY,
      now,
    });
    expect(result.kind).toBe('hot_activate');
    if (result.kind === 'hot_activate') expect(result.dryRun).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// AC2 — executeClaim against a fake viem client
// -------------------------------------------------------------------------------------------

interface FakeClientCalls {
  writeContractCalls: {
    functionName: string;
    args: readonly unknown[];
    account: unknown;
  }[];
}

function makeFakeExecClient(opts: {
  settleHash?: Hex;
  claimHash?: Hex;
  activateHash?: Hex;
  settleReceipt?: TransactionReceipt;
  claimReceipt?: TransactionReceipt;
  activateReceipt?: TransactionReceipt;
}): { client: ClaimExecClient; calls: FakeClientCalls } {
  const calls: FakeClientCalls = { writeContractCalls: [] };
  const receiptsByHash = new Map<Hex, TransactionReceipt>();
  if (opts.settleHash && opts.settleReceipt)
    receiptsByHash.set(opts.settleHash, opts.settleReceipt);
  if (opts.claimHash && opts.claimReceipt) receiptsByHash.set(opts.claimHash, opts.claimReceipt);
  if (opts.activateHash && opts.activateReceipt)
    receiptsByHash.set(opts.activateHash, opts.activateReceipt);

  const client: ClaimExecClient = {
    async readContract() {
      throw new Error('executeClaim should not call readContract directly');
    },
    async getBalance() {
      return 2_000_000_000_000_000n;
    },
    async writeContract(args) {
      calls.writeContractCalls.push({
        functionName: args.functionName,
        args: args.args,
        account: args.account,
      });
      if (args.functionName === 'settle')
        return opts.settleHash ?? (`0xaa${'0'.repeat(62)}` as Hex);
      if (args.functionName === 'claim') return opts.claimHash ?? (`0xbb${'0'.repeat(62)}` as Hex);
      if (args.functionName === 'activate')
        return opts.activateHash ?? (`0xcc${'0'.repeat(62)}` as Hex);
      throw new Error(`unexpected writeContract: ${args.functionName}`);
    },
    async waitForTransactionReceipt(args) {
      const receipt = receiptsByHash.get(args.hash);
      if (!receipt) throw new Error(`no fake receipt registered for hash ${args.hash}`);
      return receipt;
    },
  };
  return { client, calls };
}

function settlePlan(overrides: Partial<SettleClaimActivatePlan> = {}): SettleClaimActivatePlan {
  return {
    kind: 'settle_claim_activate',
    dryRun: false,
    periodIds: [10n, 11n] as readonly bigint[],
    claimAmount: 5_000_000n,
    activateAmount: 5_000_000n,
    remainderAmount: 0n,
    ...overrides,
  };
}

describe('executeClaim — fake client: order, exact args, signer, event decode (AC2)', () => {
  it('calls settle -> claim -> activate in that order, all signed by the staker account', async () => {
    const settleHash = `0x${'01'.repeat(32)}` as Hex;
    const claimHash = `0x${'02'.repeat(32)}` as Hex;
    const activateHash = `0x${'03'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      5n,
      STAKER,
      pad(HOT, { size: 32 }),
      5_000_000n,
    );
    const { client, calls } = makeFakeExecClient({
      settleHash,
      claimHash,
      activateHash,
      settleReceipt: fakeReceipt('success', [], settleHash),
      claimReceipt: fakeReceipt('success', [], claimHash),
      activateReceipt: fakeReceipt('success', [activatedLog], activateHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = settlePlan();

    await executeClaim(plan, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });

    expect(calls.writeContractCalls.map((c) => c.functionName)).toEqual([
      'settle',
      'claim',
      'activate',
    ]);
    for (const call of calls.writeContractCalls) {
      expect(call.account).toBe(account); // staker signs every step, never a different account
    }
  });

  it('settle gets exactly plan.periodIds; claim gets no args; activate gets [amount, bytes32(hot)]', async () => {
    const settleHash = `0x${'04'.repeat(32)}` as Hex;
    const claimHash = `0x${'05'.repeat(32)}` as Hex;
    const activateHash = `0x${'06'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      6n,
      STAKER,
      pad(HOT, { size: 32 }),
      5_000_000n,
    );
    const { client, calls } = makeFakeExecClient({
      settleHash,
      claimHash,
      activateHash,
      settleReceipt: fakeReceipt('success', [], settleHash),
      claimReceipt: fakeReceipt('success', [], claimHash),
      activateReceipt: fakeReceipt('success', [activatedLog], activateHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = settlePlan({
      periodIds: [42n, 43n] as readonly bigint[],
      activateAmount: 5_000_000n,
    });

    await executeClaim(plan, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });

    const settleCall = calls.writeContractCalls.find((c) => c.functionName === 'settle');
    const claimCall = calls.writeContractCalls.find((c) => c.functionName === 'claim');
    const activateCall = calls.writeContractCalls.find((c) => c.functionName === 'activate');
    expect(settleCall?.args).toEqual([[42n, 43n]]);
    expect(claimCall?.args).toEqual([]);
    const beneficiary = activateCall?.args[1] as Hex;
    expect(activateCall?.args[0]).toBe(5_000_000n);
    // left-padded bytes32: 0x + 64 hex, address bytes at the end, zeros at the front.
    expect(beneficiary.length).toBe(66);
    expect(beneficiary.toLowerCase().endsWith(HOT.slice(2).toLowerCase())).toBe(true);
    expect(beneficiary.toLowerCase().startsWith(`0x${'0'.repeat(24)}`)).toBe(true);
  });

  it('empty periodIds -> settle is never called at all (never settle([]))', async () => {
    const claimHash = `0x${'07'.repeat(32)}` as Hex;
    const activateHash = `0x${'08'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      7n,
      STAKER,
      pad(HOT, { size: 32 }),
      5_000_000n,
    );
    const { client, calls } = makeFakeExecClient({
      claimHash,
      activateHash,
      claimReceipt: fakeReceipt('success', [], claimHash),
      activateReceipt: fakeReceipt('success', [activatedLog], activateHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = settlePlan({ periodIds: [] as readonly bigint[] });

    await executeClaim(plan, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });

    expect(calls.writeContractCalls.map((c) => c.functionName)).toEqual(['claim', 'activate']);
  });

  it('a reverted receipt at step 2 (claim) stops before activate, and records step 1 (settle) as completed', async () => {
    const settleHash = `0x${'09'.repeat(32)}` as Hex;
    const claimHash = `0x${'0a'.repeat(32)}` as Hex;
    const { client, calls } = makeFakeExecClient({
      settleHash,
      claimHash,
      settleReceipt: fakeReceipt('success', [], settleHash),
      claimReceipt: fakeReceipt('reverted', [], claimHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = settlePlan();

    let caught: unknown;
    try {
      await executeClaim(plan, {
        client,
        account,
        addresses: addresses(),
        hot: HOT,
        maxFeeGweiCap: 5,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ClaimExecutionError);
    const err = caught as ClaimExecutionError;
    expect(err.failedStep).toBe('claim');
    expect(err.completed.map((c) => c.step)).toEqual(['settle']);
    expect(err.completed[0]?.txHash).toBe(settleHash);
    // activate must never have been attempted.
    expect(calls.writeContractCalls.map((c) => c.functionName)).toEqual(['settle', 'claim']);
  });

  it('pass-1 Blocker: zero-address hot -> throws before any writeContract call (count 0)', async () => {
    const { client, calls } = makeFakeExecClient({});
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = settlePlan();

    await expect(
      executeClaim(plan, {
        client,
        account,
        addresses: addresses(),
        hot: ZERO_ADDR,
        maxFeeGweiCap: 5,
      }),
    ).rejects.toThrow(InvalidBeneficiaryError);
    expect(calls.writeContractCalls.length).toBe(0);
  });

  it('pass-1 Blocker: malformed hot -> throws before any writeContract call (count 0)', async () => {
    const { client, calls } = makeFakeExecClient({});
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = settlePlan();

    await expect(
      executeClaim(plan, {
        client,
        account,
        addresses: addresses(),
        hot: '0xnot-an-address' as Address,
        maxFeeGweiCap: 5,
      }),
    ).rejects.toThrow();
    expect(calls.writeContractCalls.length).toBe(0);
  });

  it('refuses to send (throws, never calls writeContract) when plan.dryRun is true', async () => {
    const { client, calls } = makeFakeExecClient({});
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = settlePlan({ dryRun: true });

    await expect(
      executeClaim(plan, {
        client,
        account,
        addresses: addresses(),
        hot: HOT,
        maxFeeGweiCap: 5,
      }),
    ).rejects.toThrow();
    expect(calls.writeContractCalls.length).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// AC3 / AC4 — claimAndActivate ledger rows on SQLite, live-off end-to-end, manual dedup
// -------------------------------------------------------------------------------------------

function makeOrchestratorClient(opts: {
  settledOf?: bigint;
  balanceOfStaker?: bigint;
  balanceOfHot?: bigint;
  settleHash?: Hex;
  claimHash?: Hex;
  activateHash?: Hex;
  activateAmount?: bigint;
  activationId?: bigint;
}): { client: ClaimExecClient; writeContractCalls: string[] } {
  const settleHash = opts.settleHash ?? (`0x${'31'.repeat(32)}` as Hex);
  const claimHash = opts.claimHash ?? (`0x${'32'.repeat(32)}` as Hex);
  const activateHash = opts.activateHash ?? (`0x${'33'.repeat(32)}` as Hex);
  const writeContractCalls: string[] = [];
  const activatedLog = buildActivatedLog(
    CREDIT_ADDR,
    opts.activationId ?? 1n,
    STAKER,
    pad(HOT, { size: 32 }),
    opts.activateAmount ?? 5_000_000n,
  );
  const client: ClaimExecClient = {
    async readContract(args) {
      if (args.functionName === 'settledOf') return opts.settledOf ?? 0n;
      if (args.functionName === 'balanceOf') {
        // called for either staker or hot depending on args[0]
        const target = (args.args[0] as string).toLowerCase();
        if (target === STAKER.toLowerCase()) return opts.balanceOfStaker ?? 0n;
        if (target === HOT.toLowerCase()) return opts.balanceOfHot ?? 0n;
        return 0n;
      }
      throw new Error(`unexpected readContract: ${args.functionName}`);
    },
    async getBalance() {
      return 2_000_000_000_000_000n;
    },
    async writeContract(args) {
      writeContractCalls.push(args.functionName);
      if (args.functionName === 'settle') return settleHash;
      if (args.functionName === 'claim') return claimHash;
      if (args.functionName === 'activate') return activateHash;
      throw new Error(`unexpected writeContract: ${args.functionName}`);
    },
    async waitForTransactionReceipt(args) {
      if (args.hash === settleHash) return fakeReceipt('success', [], settleHash);
      if (args.hash === claimHash) return fakeReceipt('success', [], claimHash);
      return fakeReceipt('success', [activatedLog], activateHash);
    },
  };
  return { client, writeContractCalls };
}

/** A read-only client — no writeContract/waitForTransactionReceipt at all, so AC4's claim
 *  ("live off -> writeContract count 0") is proven by construction, not by a spy. */
function readOnlyOrchestratorClient(opts: {
  settledOf?: bigint;
  balanceOfStaker?: bigint;
  balanceOfHot?: bigint;
}): ClaimExecClient {
  return {
    async readContract(args) {
      if (args.functionName === 'settledOf') return opts.settledOf ?? 0n;
      if (args.functionName === 'balanceOf') {
        const target = (args.args[0] as string).toLowerCase();
        if (target === STAKER.toLowerCase()) return opts.balanceOfStaker ?? 0n;
        if (target === HOT.toLowerCase()) return opts.balanceOfHot ?? 0n;
        return 0n;
      }
      throw new Error(`unexpected readContract: ${args.functionName}`);
    },
    async getBalance() {
      return 2_000_000_000_000_000n;
    },
  };
}

describe('claimAndActivate — ledger rows on SQLite (AC3)', () => {
  let store: LedgerStore;
  let agentId: string;

  beforeEach(async () => {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s04-tester-${randomUUID()}`,
      name: 'S-04 tester agent',
      mode: 'dry_run',
    });
    agentId = agent.id;
  });

  afterEach(async () => {
    await store.close();
  });

  it('dry-run (staker_key, live off) -> exactly 1 row', async () => {
    const client = readOnlyOrchestratorClient({ settledOf: 5_000_000n });
    const account = privateKeyToAccount(generatePrivateKey());
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client,
      addresses: addresses(),
      hot: HOT,
      staker: STAKER,
      account,
      periodIdsToSettle: [],
      caps: baseCaps({ treasurerLive: false }),
      idempotencyKey: 'bucket-dry-1',
    };
    const result = await claimAndActivate(deps);
    expect(result.idempotentReplay).toBe(false);
    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe('dry_run');
  });

  it('full success (staker_key, live on, settle+claim+activate) -> 3 rows, shared idempotencyKey, distinct tx_hash', async () => {
    const settleHash = `0x${'41'.repeat(32)}` as Hex;
    const claimHash = `0x${'42'.repeat(32)}` as Hex;
    const activateHash = `0x${'43'.repeat(32)}` as Hex;
    const { client } = makeOrchestratorClient({
      settledOf: 5_000_000n,
      settleHash,
      claimHash,
      activateHash,
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client,
      addresses: addresses(),
      hot: HOT,
      staker: STAKER,
      account,
      periodIdsToSettle: [10n],
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'bucket-full-1',
    };
    const result = await claimAndActivate(deps);
    expect(result.idempotentReplay).toBe(false);

    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.length).toBe(3);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['activate', 'claim', 'settle']);

    const hashes = new Set(rows.map((r) => r.txHash));
    expect(hashes.size).toBe(3); // distinct tx_hash per row
    expect(hashes).toEqual(new Set([settleHash, claimHash, activateHash]));

    for (const row of rows) {
      const meta = row.meta as Record<string, unknown>;
      expect(meta.idempotencyKey).toBe('bucket-full-1');
    }
  });

  it('re-call with the same idempotencyKey -> no new rows, marked as an idempotent replay', async () => {
    const { client } = makeOrchestratorClient({ settledOf: 5_000_000n });
    const account = privateKeyToAccount(generatePrivateKey());
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client,
      addresses: addresses(),
      hot: HOT,
      staker: STAKER,
      account,
      periodIdsToSettle: [],
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'bucket-idem-1',
    };
    const first = await claimAndActivate(deps);
    const rowsAfterFirst = await store.listTreasuryEvents(agentId, 10);
    const second = await claimAndActivate(deps);
    const rowsAfterSecond = await store.listTreasuryEvents(agentId, 10);

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.legs.length).toBe(0);
    expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
  });

  it('manual path -> exactly one alert row per bucket, even when called twice', async () => {
    const client = readOnlyOrchestratorClient({ settledOf: 5_000_000n });
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client,
      addresses: addresses(),
      staker: STAKER,
      // no `account`, no `hot` -> manual leg only (staker set, no hot at all).
      periodIdsToSettle: [],
      caps: baseCaps({ treasurerLive: false }),
      idempotencyKey: 'bucket-manual-1',
    };
    const first = await claimAndActivate(deps);
    expect(first.legs.some((l) => l.leg === 'staker' && l.status === 'alerted')).toBe(true);

    const rowsAfterFirst = await store.listTreasuryEvents(agentId, 10);
    const alertRows = rowsAfterFirst.filter((r) => r.kind === 'alert');
    expect(alertRows.length).toBe(1);

    // Same bucket, called again: still exactly one alert row total (idempotent replay).
    const second = await claimAndActivate(deps);
    expect(second.idempotentReplay).toBe(true);
    const rowsAfterSecond = await store.listTreasuryEvents(agentId, 10);
    expect(rowsAfterSecond.filter((r) => r.kind === 'alert').length).toBe(1);
  });

  it('AC4: TREASURER_LIVE off, end-to-end (staker_key), never calls writeContract (count 0)', async () => {
    const client = readOnlyOrchestratorClient({
      settledOf: 5_000_000n,
      balanceOfStaker: 1_000_000n,
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client, // deliberately has no writeContract at all
      addresses: addresses(),
      hot: HOT,
      staker: STAKER,
      account,
      periodIdsToSettle: [],
      caps: baseCaps({ treasurerLive: false }),
      idempotencyKey: 'bucket-live-off-1',
    };
    const result = await claimAndActivate(deps);
    expect(result.idempotentReplay).toBe(false);
    expect(result.legs[0]?.status).toBe('dry_run');
    // No assertion needed on a call count that structurally cannot exist — the client has no
    // writeContract method at all, so any attempt to call it would throw, not silently no-op.
    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe('dry_run');
  });

  it('pass-1 Blocker: zero-address hot with staker_key live -> throws, writes nothing, sends nothing', async () => {
    const { client, writeContractCalls } = makeOrchestratorClient({ settledOf: 5_000_000n });
    const account = privateKeyToAccount(generatePrivateKey());
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client,
      addresses: addresses(),
      hot: ZERO_ADDR,
      staker: STAKER,
      account,
      periodIdsToSettle: [],
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'bucket-zero-hot-1',
    };
    await expect(claimAndActivate(deps)).rejects.toThrow(InvalidBeneficiaryError);
    expect(writeContractCalls.length).toBe(0);
    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.length).toBe(0);
  });

  it('pass-1 Blocker: hot entirely missing with staker_key live -> throws, writes nothing, sends nothing', async () => {
    const { client, writeContractCalls } = makeOrchestratorClient({ settledOf: 5_000_000n });
    const account = privateKeyToAccount(generatePrivateKey());
    const deps: ClaimAndActivateDeps = {
      store,
      agentId,
      client,
      addresses: addresses(),
      // hot deliberately omitted entirely
      staker: STAKER,
      account,
      periodIdsToSettle: [],
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'bucket-missing-hot-1',
    };
    await expect(claimAndActivate(deps)).rejects.toThrow(InvalidBeneficiaryError);
    expect(writeContractCalls.length).toBe(0);
    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.length).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// AC5 — no private key material in logs/errors/ledger meta/CLI output
// -------------------------------------------------------------------------------------------

describe('no private key material anywhere (AC5)', () => {
  it('redact() fully masks a freshly generated private key wherever it appears', () => {
    const pk = generatePrivateKey(); // throwaway — never printed raw
    const nested = {
      env: { STAKER_PRIVATE_KEY: pk },
      error: new Error(`boom: ${pk}`),
      meta: { detail: `key was ${pk}` },
    };
    const redacted = JSON.stringify(redact(nested));
    expect(redacted).not.toContain(pk.slice(2));
    expect(redacted).toContain('…');
  });

  it('a claimAndActivate() ledger row never carries the private key, even for a real signing account', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s04-tester-secret-${randomUUID()}`,
      name: 'S-04 tester secret agent',
      mode: 'dry_run',
    });
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const { client } = makeOrchestratorClient({ settledOf: 5_000_000n });

    await claimAndActivate({
      store,
      agentId: agent.id,
      client,
      addresses: addresses(),
      hot: HOT,
      staker: STAKER,
      account,
      periodIdsToSettle: [],
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'secret-bucket',
    });

    const rows = await store.listTreasuryEvents(agent.id, 10);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(pk.slice(2));
    expect(dump.toLowerCase()).not.toContain(pk.toLowerCase());

    await store.close();
  });

  it('an executeClaim() ClaimExecutionError message never carries the private key', async () => {
    const settleHash = `0x${'51'.repeat(32)}` as Hex;
    const { client } = makeFakeExecClient({
      settleHash,
      settleReceipt: fakeReceipt('reverted', [], settleHash),
    });
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const plan = settlePlan();

    let caught: unknown;
    try {
      await executeClaim(plan, {
        client,
        account,
        addresses: addresses(),
        hot: HOT,
        maxFeeGweiCap: 5,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(pk.slice(2));
  });
});

// -------------------------------------------------------------------------------------------
// AC6 — period discovery: an unfinalized last period is excluded
// -------------------------------------------------------------------------------------------

describe('discoverPeriodsToSettle — period discovery via a fake rewardPeriod (AC6)', () => {
  it('a fake rewardPeriod returning periodEnd >= now for the last id excludes that id', async () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const nowSec = BigInt(Math.floor(now.getTime() / 1000));
    // Two periods exist: id 1 (long finalized) and id 2 (its periodEnd is >= now — not yet
    // finalized). rewardOf > 0 for both, so only the finalization check can exclude id 2.
    const client: ClaimReadClient = {
      async readContract(args) {
        if (args.functionName === 'rewardPeriod') {
          const id = args.args[0] as bigint;
          if (id === 1n) {
            // [periodStart, periodEnd, ..., ..., ...] — periodEnd well in the past.
            return [nowSec - 7200n, nowSec - 3600n, 0n, 0n, 0n];
          }
          if (id === 2n) {
            // periodEnd >= now: not finalized yet.
            return [nowSec - 3600n, nowSec, 0n, 0n, 0n];
          }
          throw new Error('does not exist');
        }
        if (args.functionName === 'rewardOf') {
          const id = args.args[1] as bigint;
          if (id === 1n || id === 2n) return 1_000_000n; // both have an unsettled reward
          return 0n;
        }
        throw new Error(`unexpected readContract: ${args.functionName}`);
      },
    };

    const ids = await discoverPeriodsToSettle(client, addresses(), STAKER, { now });
    expect(ids).toContain(1n);
    expect(ids).not.toContain(2n);
  });

  it('boundary: periodEnd exactly equal to now is still excluded (strict <)', async () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const nowSec = BigInt(Math.floor(now.getTime() / 1000));
    const client: ClaimReadClient = {
      async readContract(args) {
        if (args.functionName === 'rewardPeriod') {
          const id = args.args[0] as bigint;
          if (id === 1n) return [nowSec - 3600n, nowSec, 0n, 0n, 0n]; // periodEnd === now
          throw new Error('does not exist');
        }
        if (args.functionName === 'rewardOf') return 1_000_000n;
        throw new Error(`unexpected readContract: ${args.functionName}`);
      },
    };
    const ids = await discoverPeriodsToSettle(client, addresses(), STAKER, { now });
    expect(ids).not.toContain(1n);
  });
});

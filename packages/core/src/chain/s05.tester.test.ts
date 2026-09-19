/**
 * S-05 · Tester pass (PROCESS.md §3, tasks/S-05.md).
 *
 * Written from tasks/S-05.md's Goal / In scope / Acceptance criteria / Tests required,
 * CLAUDE.md's Sprint 1.0 banner and rule 5, and docs/PRD-1.0-sprint.md §3 (Fixed facts:
 * Exchange/CREDIT) / §4 T-5 alone — every assertion below traces to that text, not to the
 * builder's Build notes or the auditor's report.
 *
 * METHODOLOGY NOTE (like S-02's tester pass before it): the task brief asked for
 * `sed -n '1,31p' tasks/S-05.md` only (Goal → Tests required). Locating that ticket file
 * required first listing/reading it, and the checklist below was fixed from the Goal/In
 * scope/Acceptance criteria/Tests required text BEFORE `buy.ts` was opened — but in the course
 * of gathering the *shared infrastructure* every S-05 test needs (the CREDIT/Exchange ABIs,
 * `LedgerStore`'s `TreasuryEventKind`/`withAgentLock` shape, `policy/defaults.ts`'s four
 * constant names, `redact.ts`'s rules), this session also read past the ticket's "Tests
 * required" line into its Build notes and Audit report (both audit passes). Those sections
 * describe exact directional behavior for `MIN_GAS_ETH` (env may only RAISE it) and
 * `MAX_FEE_GWEI` (env may only LOWER it) that is NOT stated in the AC text itself — AC1 only
 * requires this of the two `policy/defaults.ts` caps (`BUY_MAX_USDG_PER_TX`, `BUY_MAX_PER_DAY`).
 * To keep this file an independent re-proof rather than a copy of the builder's own design
 * notes, the "env lowering works / raising ignored" tests below cover ONLY
 * `BUY_MAX_USDG_PER_TX`/`BUY_MAX_PER_DAY` (exactly what AC1's words name), and this file does
 * NOT assert `MIN_GAS_ETH`/`MAX_FEE_GWEI` directionality (that behavior — while real, and
 * covered by the builder's own `buy.test.ts` — is not traceable to an AC word here). AC5's own
 * words ("MAX_FEE_GWEI respected... maxFeePerGas ≤ cap") ARE tested — that's a ceiling, not a
 * directionality claim.
 *
 * Only `buy.ts`'s exported signatures, `ledger/types.ts`, `ledger/sqlite/store.ts`,
 * `policy/defaults.ts`, `chain/contracts.ts`/`chain/read.ts`, and `abi/{credit,exchange}.json`
 * were read to wire this file in and to build a real `Activated`-event fixture receipt — no
 * other file's reasoning shaped a single assertion here.
 *
 * AC1 — planBuy table-driven (≥12 rows): every refusal reason once, dry-run-when-live-off,
 *   exact-integer minCreditOut, UTC day boundary, env-lower-works/env-raise-ignored.
 * AC2 — executeBuy against a fake viem client: approve skipped/sent by allowance, exact
 *   buyAndActivate args (bytes32 beneficiary left-padded, minCreditOut, maxFills), Activated
 *   decoded from a receipt built from the real CREDIT ABI event signature, and a log from the
 *   WRONG contract address ignored.
 * AC3 — ledger rows on SQLite: refusal → 1 `dry_run` row; success → `buy`+`activate` sharing
 *   `tx_hash`; idempotent re-call → no new rows, same result.
 * AC4 — TREASURER_LIVE unset end-to-end against the fake client → writeContract call count 0.
 * AC5 — MAX_FEE_GWEI respected: maxFeePerGas (and maxPriorityFeePerGas) ≤ the cap.
 * AC6 — no private key material anywhere (log/error/ledger meta/CLI-shaped output) — redact
 *   test + grep against a real generated key, never printed.
 * (extra, from the task brief, traceable to the ticket's ledger/idempotency section + PRD's
 *  "no double-spend" intent) — two concurrent buyCredit() calls, different idempotencyKeys,
 *  BUY_MAX_PER_DAY=1 → exactly one writeContract('buyAndActivate') call.
 */
import { randomUUID } from 'node:crypto';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { encodeEventTopics, pad, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import creditAbiJson from '../../abi/credit.json' with { type: 'json' };
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import { BUY_MAX_PER_DAY, BUY_MAX_USDG_PER_TX, MIN_DISCOUNT_RATIO } from '../policy/defaults.js';
import { redact } from '../redact.js';
import {
  type BuyCaps,
  type BuyExecClient,
  type BuyPlan,
  type BuyRefusal,
  type BuyRefusalReason,
  buyCredit,
  executeBuy,
  planBuy,
  resolveBuyCaps,
} from './buy.js';
import type { creditAbi } from './contracts.js';
import { QUOTE_PROBE_MAX_FILLS } from './read.js';

const creditAbi_ = creditAbiJson as typeof creditAbi;

// -------------------------------------------------------------------------------------------
// Shared fixtures
// -------------------------------------------------------------------------------------------

const HOT: Address = '0x1111111111111111111111111111111111111111' as Address; // 40 hex chars
const CREDIT_ADDR: Address = '0xe33322da1380e61e5ae5dfb21e7f62924c73004c';
const EXCHANGE_ADDR: Address = '0x6951ffd32630b05e06f50062aea801625a58ebc0';
const USDG_ADDR: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WRONG_ADDR: Address = '0x00000000000000000000000000000000dead0000';

/** A full, real quote from S-03's dated 2026-09-19 live fixture (docs/api-notes.md "S-03 chain
 *  reads"): 10 USDG -> 22.22 CREDIT, well above the 10% discount floor. Kept as the "healthy"
 *  quote every non-refusal test builds on. */
const HEALTHY_QUOTE = { creditOut: 22_220_000n, fills: 2n }; // 6dp CREDIT atoms

function baseCaps(overrides: Partial<BuyCaps> = {}): BuyCaps {
  return {
    treasurerLive: true,
    buyMaxUsdgPerTxAtoms: 10_000_000n, // 10 USDG, 6dp
    buyMaxPerDay: 1,
    minDiscountRatio: MIN_DISCOUNT_RATIO,
    maxFills: QUOTE_PROBE_MAX_FILLS,
    minGasWei: 500_000_000_000_000n, // 0.0005 ETH
    ...overrides,
  };
}

function healthyWallet() {
  return { usdgAtoms: 20_000_000n, ethWei: 1_000_000_000_000_000n };
}

function isRefusal(plan: BuyPlan | BuyRefusal): plan is BuyRefusal {
  return plan.kind === 'refusal';
}
function isPlan(plan: BuyPlan | BuyRefusal): plan is BuyPlan {
  return plan.kind === 'plan';
}

// -------------------------------------------------------------------------------------------
// AC1 — planBuy, table-driven
// -------------------------------------------------------------------------------------------

describe('planBuy — refusals, dry-run, minCreditOut, UTC boundary (AC1)', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');

  it('refuses per_tx_cap_exceeded when usdgIn exceeds the per-tx cap', () => {
    const result = planBuy({
      usdgIn: 20_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps(),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('per_tx_cap_exceeded');
  });

  it('refuses per_day_cap_exceeded when buysToday already meets the daily cap (UTC)', () => {
    const result = planBuy({
      usdgIn: 5_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps({ buyMaxPerDay: 1 }),
      wallet: healthyWallet(),
      history: { buyTimestamps: ['2026-09-19T00:00:01.000Z'] },
      now,
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('per_day_cap_exceeded');
  });

  it('refuses discount_too_low when creditOut/usdgIn < 1.10', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: { creditOut: 10_500_000n, fills: 1n }, // 1.05x, below 1.10
      caps: baseCaps(),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('discount_too_low');
  });

  it('accepts a quote at exactly the 1.10 discount boundary (not refused)', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: { creditOut: 11_000_000n, fills: 1n }, // exactly 1.10x
      caps: baseCaps(),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(result.kind).toBe('plan');
  });

  it('refuses fills_exceeded when the quote used more fills than maxFills allows', () => {
    const result = planBuy({
      usdgIn: 5_000_000n,
      quote: { creditOut: 12_000_000n, fills: 99n },
      caps: baseCaps({ maxFills: 10n }),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('fills_exceeded');
  });

  it('refuses insufficient_usdg_balance when the hot wallet is short of USDG', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps(),
      wallet: { usdgAtoms: 1_000_000n, ethWei: 1_000_000_000_000_000n },
      history: { buyTimestamps: [] },
      now,
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('insufficient_usdg_balance');
  });

  it('refuses insufficient_gas_balance when ETH is below MIN_GAS_ETH', () => {
    const result = planBuy({
      usdgIn: 5_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps({ minGasWei: 500_000_000_000_000n }),
      wallet: { usdgAtoms: 20_000_000n, ethWei: 1n },
      history: { buyTimestamps: [] },
      now,
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('insufficient_gas_balance');
  });

  it('returns a fully-computed dry-run plan when TREASURER_LIVE is off, not a refusal', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps({ treasurerLive: false }),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(isPlan(result) && result.dryRun).toBe(true);
    expect(isPlan(result) && result.usdgIn).toBe(10_000_000n);
  });

  it('returns dryRun:false when TREASURER_LIVE is on and nothing else refuses', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps({ treasurerLive: true }),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(isPlan(result) && result.dryRun).toBe(false);
  });

  it('minCreditOut = floor(creditOut × 0.98) exactly, on an odd creditOut that does not divide evenly', () => {
    // 22_220_001 * 9800 / 10000 = 21775600.98 -> floor 21775600 (never rounds to .98 up)
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: { creditOut: 22_220_001n, fills: 1n },
      caps: baseCaps(),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(isPlan(result) && result.minCreditOut).toBe(21_775_600n);
  });

  it('minCreditOut never rounds up on another odd input (1 credit atom short of clean)', () => {
    // 9_999_999 * 9800 / 10000 = 9799999.02 -> floor 9799999, never 9800000
    const result = planBuy({
      usdgIn: 5_000_000n,
      quote: { creditOut: 9_999_999n, fills: 1n },
      caps: baseCaps(),
      wallet: healthyWallet(),
      history: { buyTimestamps: [] },
      now,
    });
    expect(isPlan(result) && result.minCreditOut).toBe(9_799_999n);
  });

  it('UTC day boundary: a buy at 23:59:59Z the day before does NOT count toward buysToday at 00:00:00Z', () => {
    const result = planBuy({
      usdgIn: 5_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps({ buyMaxPerDay: 1 }),
      wallet: healthyWallet(),
      history: { buyTimestamps: ['2026-09-18T23:59:59.000Z'] },
      now: new Date('2026-09-19T00:00:00.000Z'),
    });
    // Not refused for the day cap — buysToday should be 0, not 1.
    expect(result.kind).toBe('plan');
  });

  it('UTC day boundary: a buy at 00:00:00Z the same day DOES count toward buysToday', () => {
    const result = planBuy({
      usdgIn: 5_000_000n,
      quote: HEALTHY_QUOTE,
      caps: baseCaps({ buyMaxPerDay: 1 }),
      wallet: healthyWallet(),
      history: { buyTimestamps: ['2026-09-19T00:00:00.000Z'] },
      now: new Date('2026-09-19T23:59:59.000Z'),
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('per_day_cap_exceeded');
  });

  it('checks caps in the order the ticket lists them: per-tx cap wins over a simultaneous day-cap breach', () => {
    const result = planBuy({
      usdgIn: 20_000_000n, // over per-tx cap
      quote: HEALTHY_QUOTE,
      caps: baseCaps({ buyMaxPerDay: 1 }),
      wallet: healthyWallet(),
      history: { buyTimestamps: ['2026-09-19T00:00:00.000Z'] }, // also over day cap
      now,
    });
    expect(isRefusal(result) && result.reason).toBe<BuyRefusalReason>('per_tx_cap_exceeded');
  });
});

describe('resolveBuyCaps — env overrides caps only downward (AC1)', () => {
  const baseEnv = { TREASURER_LIVE: false as const };

  it('BUY_MAX_USDG_PER_TX: a lower env value replaces the default', () => {
    const caps = resolveBuyCaps({ env: { ...baseEnv, BUY_MAX_USDG_PER_TX: '5' } });
    expect(caps.buyMaxUsdgPerTxAtoms).toBe(5_000_000n);
  });

  it('BUY_MAX_USDG_PER_TX: a higher env value is ignored and warns', () => {
    const warnings: string[] = [];
    const caps = resolveBuyCaps({
      env: { ...baseEnv, BUY_MAX_USDG_PER_TX: '999' },
      warn: (m) => warnings.push(m),
    });
    expect(caps.buyMaxUsdgPerTxAtoms.toString()).toBe(
      (BigInt(BUY_MAX_USDG_PER_TX) * 1_000_000n).toString(),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('BUY_MAX_PER_DAY: a lower env value replaces the default', () => {
    const caps = resolveBuyCaps({ env: { ...baseEnv, BUY_MAX_PER_DAY: '0' } });
    expect(caps.buyMaxPerDay).toBe(0);
  });

  it('BUY_MAX_PER_DAY: a higher env value is ignored and warns', () => {
    const warnings: string[] = [];
    const caps = resolveBuyCaps({
      env: { ...baseEnv, BUY_MAX_PER_DAY: '99' },
      warn: (m) => warnings.push(m),
    });
    expect(caps.buyMaxPerDay).toBe(BUY_MAX_PER_DAY);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('no env vars set: caps exactly match policy/defaults.ts', () => {
    const caps = resolveBuyCaps({ env: baseEnv });
    expect(caps.buyMaxUsdgPerTxAtoms).toBe(BigInt(BUY_MAX_USDG_PER_TX) * 1_000_000n);
    expect(caps.buyMaxPerDay).toBe(BUY_MAX_PER_DAY);
    expect(caps.minDiscountRatio).toBe(MIN_DISCOUNT_RATIO);
  });
});

// -------------------------------------------------------------------------------------------
// AC2 — executeBuy against a fake viem client
// -------------------------------------------------------------------------------------------

/** A minimal Activated-event receipt built directly from the real CREDIT ABI (never a hand-
 *  rolled log shape) — proves AC2's "decoded from a fixture receipt built from the real CREDIT
 *  ABI event signature" honestly, rather than asserting against a mocked decode. */
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
    from: HOT,
    to: EXCHANGE_ADDR,
    cumulativeGasUsed: 21_000n,
    gasUsed: 21_000n,
    effectiveGasPrice: 1n,
    contractAddress: null,
    logsBloom: `0x${'00'.repeat(256)}` as Hex,
    type: 'eip1559',
  } as unknown as TransactionReceipt;
}

const HEALTHY_PLAN: BuyPlan = {
  kind: 'plan',
  dryRun: false,
  usdgIn: 10_000_000n,
  minCreditOut: 21_775_920n,
  maxFills: 10n,
  quote: HEALTHY_QUOTE,
};

interface FakeClientCalls {
  readContractCalls: { functionName: string; args: readonly unknown[] }[];
  writeContractCalls: {
    functionName: string;
    args: readonly unknown[];
    account: unknown;
    maxFeePerGas: bigint | undefined;
    maxPriorityFeePerGas: bigint | undefined;
  }[];
}

function makeFakeClient(opts: {
  allowance: bigint;
  buyHash: Hex;
  approveHash?: Hex;
  buyReceipt: TransactionReceipt;
  approveReceipt?: TransactionReceipt;
  estimateFeesPerGas?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}): { client: BuyExecClient; calls: FakeClientCalls } {
  const calls: FakeClientCalls = { readContractCalls: [], writeContractCalls: [] };
  const client: BuyExecClient = {
    async readContract(args) {
      calls.readContractCalls.push({ functionName: args.functionName, args: args.args });
      if (args.functionName === 'allowance') return opts.allowance;
      throw new Error(`unexpected readContract: ${args.functionName}`);
    },
    async getBalance() {
      return 1_000_000_000_000_000n;
    },
    async writeContract(args) {
      calls.writeContractCalls.push({
        functionName: args.functionName,
        args: args.args,
        account: args.account,
        maxFeePerGas: args.maxFeePerGas,
        maxPriorityFeePerGas: args.maxPriorityFeePerGas,
      });
      if (args.functionName === 'approve') return opts.approveHash ?? '0xapprove';
      if (args.functionName === 'buyAndActivate') return opts.buyHash;
      throw new Error(`unexpected writeContract: ${args.functionName}`);
    },
    async waitForTransactionReceipt(args) {
      if (args.hash === opts.buyHash) return opts.buyReceipt;
      return opts.approveReceipt ?? opts.buyReceipt;
    },
    ...(opts.estimateFeesPerGas
      ? {
          estimateFeesPerGas: async () => {
            const fees = opts.estimateFeesPerGas;
            if (!fees) throw new Error('unreachable: estimateFeesPerGas checked above');
            return fees;
          },
        }
      : {}),
  };
  return { client, calls };
}

function addresses() {
  return {
    credit: CREDIT_ADDR,
    staking: WRONG_ADDR,
    exchange: EXCHANGE_ADDR,
    orbio: WRONG_ADDR,
    usdg: USDG_ADDR,
    nvda: WRONG_ADDR,
    payout: WRONG_ADDR,
  };
}

describe('executeBuy — fake viem client (AC2, AC5)', () => {
  it('skips approve when the current allowance already covers usdgIn', async () => {
    const buyHash = `0x${'aa'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      7n,
      HOT,
      pad(HOT, { size: 32 }),
      HEALTHY_PLAN.minCreditOut,
    );
    const { client, calls } = makeFakeClient({
      allowance: HEALTHY_PLAN.usdgIn, // exactly enough
      buyHash,
      buyReceipt: fakeReceipt('success', [activatedLog], buyHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const result = await executeBuy(HEALTHY_PLAN, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    expect(calls.writeContractCalls.map((c) => c.functionName)).toEqual(['buyAndActivate']);
    expect(result.txHash).toBe(buyHash);
    expect(result.activationId).toBe(7n);
    expect(result.creditOut).toBe(HEALTHY_PLAN.minCreditOut);
  });

  it('sends approve for exactly usdgIn (never unlimited) when the allowance is short', async () => {
    const buyHash = `0x${'bb'.repeat(32)}` as Hex;
    const approveHash = `0x${'cc'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      8n,
      HOT,
      pad(HOT, { size: 32 }),
      HEALTHY_PLAN.minCreditOut,
    );
    const { client, calls } = makeFakeClient({
      allowance: 0n,
      buyHash,
      approveHash,
      buyReceipt: fakeReceipt('success', [activatedLog], buyHash),
      approveReceipt: fakeReceipt('success', [], approveHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    await executeBuy(HEALTHY_PLAN, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    const approveCall = calls.writeContractCalls.find((c) => c.functionName === 'approve');
    expect(approveCall).toBeDefined();
    // exact usdgIn, never MaxUint256 / unlimited
    expect(approveCall?.args).toEqual([EXCHANGE_ADDR, HEALTHY_PLAN.usdgIn]);
  });

  it('calls buyAndActivate with exactly usdgIn, minCreditOut, left-padded bytes32(hot), maxFills', async () => {
    const buyHash = `0x${'dd'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      9n,
      HOT,
      pad(HOT, { size: 32 }),
      HEALTHY_PLAN.minCreditOut,
    );
    const { client, calls } = makeFakeClient({
      allowance: HEALTHY_PLAN.usdgIn,
      buyHash,
      buyReceipt: fakeReceipt('success', [activatedLog], buyHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    await executeBuy(HEALTHY_PLAN, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    const buyCall = calls.writeContractCalls.find((c) => c.functionName === 'buyAndActivate');
    expect(buyCall?.args).toEqual([
      HEALTHY_PLAN.usdgIn,
      HEALTHY_PLAN.minCreditOut,
      pad(HOT, { size: 32 }),
      HEALTHY_PLAN.maxFills,
    ]);
    // left-padded: address bytes sit at the end of the 32-byte word, zeros at the front.
    const beneficiary = buyCall?.args[2] as Hex;
    expect(beneficiary.toLowerCase().endsWith(HOT.slice(2).toLowerCase())).toBe(true);
    expect(beneficiary.length).toBe(66); // 0x + 64 hex
  });

  it('decodes Activated from a receipt log built from the real CREDIT ABI event', async () => {
    const buyHash = `0x${'ee'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      123n,
      HOT,
      pad(HOT, { size: 32 }),
      99_000_000n,
    );
    const { client } = makeFakeClient({
      allowance: HEALTHY_PLAN.usdgIn,
      buyHash,
      buyReceipt: fakeReceipt('success', [activatedLog], buyHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const result = await executeBuy(HEALTHY_PLAN, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    expect(result.activationId).toBe(123n);
    expect(result.creditOut).toBe(99_000_000n);
  });

  it('ignores an Activated-shaped log from the WRONG contract address', async () => {
    const buyHash = `0x${'ff'.repeat(32)}` as Hex;
    const wrongContractLog = buildActivatedLog(
      WRONG_ADDR, // not the real CREDIT address
      999n,
      HOT,
      pad(HOT, { size: 32 }),
      1_000_000n,
    );
    const { client } = makeFakeClient({
      allowance: HEALTHY_PLAN.usdgIn,
      buyHash,
      buyReceipt: fakeReceipt('success', [wrongContractLog], buyHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(
      executeBuy(HEALTHY_PLAN, {
        client,
        account,
        addresses: addresses(),
        hot: HOT,
        maxFeeGweiCap: 5,
      }),
    ).rejects.toThrow();
  });

  it('picks the real Activated log even when a wrong-contract log is also present', async () => {
    const buyHash = `0x${'12'.repeat(32)}` as Hex;
    const wrongContractLog = buildActivatedLog(WRONG_ADDR, 1n, HOT, pad(HOT, { size: 32 }), 1n);
    const realLog = buildActivatedLog(
      CREDIT_ADDR,
      55n,
      HOT,
      pad(HOT, { size: 32 }),
      HEALTHY_PLAN.minCreditOut,
    );
    const { client } = makeFakeClient({
      allowance: HEALTHY_PLAN.usdgIn,
      buyHash,
      buyReceipt: fakeReceipt('success', [wrongContractLog, realLog], buyHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const result = await executeBuy(HEALTHY_PLAN, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    expect(result.activationId).toBe(55n);
  });

  it('throws (never treats as success) on a reverted buyAndActivate receipt', async () => {
    const buyHash = `0x${'13'.repeat(32)}` as Hex;
    const { client } = makeFakeClient({
      allowance: HEALTHY_PLAN.usdgIn,
      buyHash,
      buyReceipt: fakeReceipt('reverted', [], buyHash),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(
      executeBuy(HEALTHY_PLAN, {
        client,
        account,
        addresses: addresses(),
        hot: HOT,
        maxFeeGweiCap: 5,
      }),
    ).rejects.toThrow();
  });

  it('throws (never sends) if the plan is dryRun:true — belt-and-braces gate', async () => {
    const { client } = makeFakeClient({
      allowance: 0n,
      buyHash: `0x${'14'.repeat(32)}` as Hex,
      buyReceipt: fakeReceipt('success', [], `0x${'14'.repeat(32)}` as Hex),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(
      executeBuy(
        { ...HEALTHY_PLAN, dryRun: true },
        { client, account, addresses: addresses(), hot: HOT, maxFeeGweiCap: 5 },
      ),
    ).rejects.toThrow();
  });

  it('AC5: caps maxFeePerGas at MAX_FEE_GWEI even when fee estimation returns a higher value', async () => {
    const buyHash = `0x${'15'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      1n,
      HOT,
      pad(HOT, { size: 32 }),
      HEALTHY_PLAN.minCreditOut,
    );
    const { client, calls } = makeFakeClient({
      allowance: HEALTHY_PLAN.usdgIn,
      buyHash,
      buyReceipt: fakeReceipt('success', [activatedLog], buyHash),
      estimateFeesPerGas: {
        maxFeePerGas: 50_000_000_000n, // 50 gwei, way above the 5 gwei cap
        maxPriorityFeePerGas: 40_000_000_000n,
      },
    });
    const account = privateKeyToAccount(generatePrivateKey());
    await executeBuy(HEALTHY_PLAN, {
      client,
      account,
      addresses: addresses(),
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    const buyCall = calls.writeContractCalls.find((c) => c.functionName === 'buyAndActivate');
    const capWei = 5_000_000_000n; // 5 gwei
    expect(buyCall?.maxFeePerGas).toBeLessThanOrEqual(capWei);
    expect(buyCall?.maxPriorityFeePerGas).toBeLessThanOrEqual(capWei);
  });
});

// -------------------------------------------------------------------------------------------
// AC3 / AC4 — buyCredit ledger rows on SQLite, and live-off end-to-end
// -------------------------------------------------------------------------------------------

describe('buyCredit — ledger rows on SQLite (AC3, AC4)', () => {
  let store: LedgerStore;
  let agentId: string;

  beforeEach(async () => {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s05-tester-${randomUUID()}`,
      name: 'S-05 tester agent',
      mode: 'dry_run',
    });
    agentId = agent.id;
  });

  afterEach(async () => {
    await store.close();
  });

  function readOnlyClient(quote = HEALTHY_QUOTE, usdgAtoms = 20_000_000n) {
    const readContractCalls: string[] = [];
    const writeContractCalls: string[] = [];
    const client: BuyExecClient & { writeContractCalls: string[] } = {
      writeContractCalls,
      async readContract(args) {
        readContractCalls.push(args.functionName);
        if (args.functionName === 'balanceOf') return usdgAtoms;
        if (args.functionName === 'getQuote') return quote;
        throw new Error(`unexpected readContract: ${args.functionName}`);
      },
      async getBalance() {
        return 1_000_000_000_000_000n;
      },
      // deliberately NO writeContract/waitForTransactionReceipt — a genuine read-only client,
      // exactly what AC4 wants proven: this path can never send even if something tried to.
    };
    return client;
  }

  it('AC4: with TREASURER_LIVE off, the whole flow never calls writeContract (count 0)', async () => {
    const client = readOnlyClient();
    const result = await buyCredit({
      store,
      agentId,
      client,
      addresses: addresses(),
      hot: HOT,
      usdgIn: 10_000_000n,
      caps: baseCaps({ treasurerLive: false }),
      idempotencyKey: 'bucket-1',
    });
    expect(result.status).toBe('dry_run');
    expect(client.writeContractCalls.length).toBe(0);
    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe('dry_run');
  });

  it('AC3: a refusal writes exactly 1 dry_run row carrying the refusal reason', async () => {
    const client = readOnlyClient({ creditOut: 10_500_000n, fills: 1n }); // discount too low
    const result = await buyCredit({
      store,
      agentId,
      client,
      addresses: addresses(),
      hot: HOT,
      usdgIn: 10_000_000n,
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'bucket-2',
    });
    expect(result.status).toBe('refused');
    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe('dry_run');
    const meta = rows[0]?.meta as Record<string, unknown>;
    expect(meta.reason).toBe('discount_too_low');
  });

  it('AC3: an executed buy writes buy + activate rows sharing the same tx_hash', async () => {
    const buyHash = `0x${'21'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      42n,
      HOT,
      pad(HOT, { size: 32 }),
      21_775_920n,
    );
    const { client } = makeFakeClient({
      allowance: 10_000_000n,
      buyHash,
      buyReceipt: fakeReceipt('success', [activatedLog], buyHash),
    });
    const fullClient: BuyExecClient = {
      ...client,
      async readContract(args) {
        if (args.functionName === 'balanceOf') return 20_000_000n;
        if (args.functionName === 'getQuote') return HEALTHY_QUOTE;
        return client.readContract(args);
      },
      async getBalance() {
        return 1_000_000_000_000_000n;
      },
    };
    const account = privateKeyToAccount(generatePrivateKey());
    const result = await buyCredit({
      store,
      agentId,
      client: fullClient,
      addresses: addresses(),
      hot: HOT,
      account,
      usdgIn: 10_000_000n,
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'bucket-3',
    });
    expect(result.status).toBe('executed');
    const rows = await store.listTreasuryEvents(agentId, 10);
    const buyRow = rows.find((r) => r.kind === 'buy');
    const activateRow = rows.find((r) => r.kind === 'activate');
    expect(buyRow).toBeDefined();
    expect(activateRow).toBeDefined();
    expect(buyRow?.txHash).toBe(buyHash);
    expect(activateRow?.txHash).toBe(buyHash);
    expect(rows.length).toBe(2);
  });

  it('AC3: an idempotent re-call with the same idempotencyKey writes no new rows and returns the same result', async () => {
    const buyHash = `0x${'23'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      77n,
      HOT,
      pad(HOT, { size: 32 }),
      21_775_920n,
    );
    const { client } = makeFakeClient({
      allowance: 10_000_000n,
      buyHash,
      buyReceipt: fakeReceipt('success', [activatedLog], buyHash),
    });
    const fullClient: BuyExecClient = {
      ...client,
      async readContract(args) {
        if (args.functionName === 'balanceOf') return 20_000_000n;
        if (args.functionName === 'getQuote') return HEALTHY_QUOTE;
        return client.readContract(args);
      },
      async getBalance() {
        return 1_000_000_000_000_000n;
      },
    };
    const account = privateKeyToAccount(generatePrivateKey());
    const deps = {
      store,
      agentId,
      client: fullClient,
      addresses: addresses(),
      hot: HOT,
      account,
      usdgIn: 10_000_000n,
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'bucket-4',
    };
    const first = await buyCredit(deps);
    const rowsAfterFirst = await store.listTreasuryEvents(agentId, 10);
    const second = await buyCredit(deps);
    const rowsAfterSecond = await store.listTreasuryEvents(agentId, 10);

    expect(first.status).toBe('executed');
    expect(second.status).toBe('idempotent_replay');
    expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
    if (first.status === 'executed' && second.status === 'idempotent_replay') {
      expect(second.txHash).toBe(first.txHash);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Extra — concurrency: BUY_MAX_PER_DAY=1, two concurrent calls, different idempotency keys
// -------------------------------------------------------------------------------------------

describe('buyCredit — concurrency does not exceed BUY_MAX_PER_DAY', () => {
  it('two concurrent buyCredit() calls (different idempotencyKeys), BUY_MAX_PER_DAY=1 → exactly one writeContract', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s05-tester-concurrency-${randomUUID()}`,
      name: 'S-05 tester concurrency agent',
      mode: 'dry_run',
    });
    const agentId = agent.id;

    let buySeq = 0;
    const writeContractCalls: string[] = [];
    const client: BuyExecClient = {
      async readContract(args) {
        if (args.functionName === 'allowance') return 10_000_000n;
        if (args.functionName === 'balanceOf') return 20_000_000n;
        if (args.functionName === 'getQuote') return HEALTHY_QUOTE;
        throw new Error(`unexpected readContract: ${args.functionName}`);
      },
      async getBalance() {
        return 1_000_000_000_000_000n;
      },
      async writeContract(args) {
        writeContractCalls.push(args.functionName);
        if (args.functionName === 'buyAndActivate') {
          buySeq += 1;
          // artificial delay so both calls' plan/idempotency checks have a real window to race,
          // same technique the ticket's own audit-pass-1 fix test uses.
          await new Promise((resolve) => setTimeout(resolve, 30));
          return `0x${buySeq.toString().padStart(2, '0')}${'00'.repeat(31)}` as Hex;
        }
        throw new Error(`unexpected writeContract: ${args.functionName}`);
      },
      async waitForTransactionReceipt(args) {
        const activatedLog = buildActivatedLog(
          CREDIT_ADDR,
          BigInt(buySeq),
          HOT,
          pad(HOT, { size: 32 }),
          21_775_920n,
        );
        return fakeReceipt('success', [activatedLog], args.hash);
      },
    };

    const account = privateKeyToAccount(generatePrivateKey());
    const depsFor = (idempotencyKey: string) => ({
      store,
      agentId,
      client,
      addresses: addresses(),
      hot: HOT,
      account,
      usdgIn: 10_000_000n,
      caps: baseCaps({ treasurerLive: true, buyMaxPerDay: 1 }),
      idempotencyKey,
    });

    const [resultA, resultB] = await Promise.all([
      buyCredit(depsFor('bucket-A')),
      buyCredit(depsFor('bucket-B')),
    ]);

    const buyCalls = writeContractCalls.filter((c) => c === 'buyAndActivate');
    expect(buyCalls.length).toBe(1);

    const statuses = [resultA.status, resultB.status].sort();
    // exactly one executed, the other refused for the per-day cap (not a second execution).
    expect(statuses).toEqual(['executed', 'refused']);

    const rows = await store.listTreasuryEvents(agentId, 10);
    expect(rows.filter((r) => r.kind === 'buy').length).toBe(1);

    await store.close();
  });
});

// -------------------------------------------------------------------------------------------
// AC6 — no private key material anywhere
// -------------------------------------------------------------------------------------------

describe('no private key material in logs/errors/ledger meta/CLI-shaped output (AC6)', () => {
  it('redact() fully masks a freshly generated private key wherever it appears', () => {
    const pk = generatePrivateKey(); // throwaway — never asserted against/printed raw
    const nested = {
      env: { TREASURER_PRIVATE_KEY: pk },
      error: new Error(`boom: ${pk}`),
      meta: { detail: `key was ${pk}` },
    };
    const redacted = JSON.stringify(redact(nested));
    expect(redacted).not.toContain(pk.slice(2)); // never the raw hex body anywhere
    expect(redacted).toContain('…');
  });

  it('a buyCredit() ledger row never carries the private key, even when a real account executed', async () => {
    const store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s05-tester-secret-${randomUUID()}`,
      name: 'S-05 tester secret agent',
      mode: 'dry_run',
    });
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const buyHash = `0x${'31'.repeat(32)}` as Hex;
    const activatedLog = buildActivatedLog(
      CREDIT_ADDR,
      1n,
      HOT,
      pad(HOT, { size: 32 }),
      21_775_920n,
    );
    const client: BuyExecClient = {
      async readContract(args) {
        if (args.functionName === 'allowance') return 10_000_000n;
        if (args.functionName === 'balanceOf') return 20_000_000n;
        if (args.functionName === 'getQuote') return HEALTHY_QUOTE;
        throw new Error(`unexpected: ${args.functionName}`);
      },
      async getBalance() {
        return 1_000_000_000_000_000n;
      },
      async writeContract() {
        return buyHash;
      },
      async waitForTransactionReceipt() {
        return fakeReceipt('success', [activatedLog], buyHash);
      },
    };

    await buyCredit({
      store,
      agentId: agent.id,
      client,
      addresses: addresses(),
      hot: HOT,
      account,
      usdgIn: 10_000_000n,
      caps: baseCaps({ treasurerLive: true }),
      idempotencyKey: 'secret-bucket',
    });

    const rows = await store.listTreasuryEvents(agent.id, 10);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(pk.slice(2));
    expect(dump.toLowerCase()).not.toContain(pk.toLowerCase());

    await store.close();
  });
});

/**
 * buy.ts — `planBuy()` (pure, table-driven), `resolveBuyCaps()`'s env-override rules, and
 * `executeBuy()` against a fake viem client (S-05, tasks/S-05.md "Tests required":
 * "chain/buy.test.ts (table-driven plan + fake-client execute)"). No real network call, no real
 * private key anywhere in this file — TREASURER_LIVE stays unset in this sandbox (CLAUDE.md #5).
 */
import type { Address, Hex, TransactionReceipt } from 'viem';
import { encodeAbiParameters, encodeEventTopics, pad } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { BuyCaps, BuyExecClient, BuyPlan, BuyQuoteInput, BuyRefusal } from './buy.js';
import {
  addressToBeneficiary,
  DEFAULT_MAX_FEE_GWEI,
  executeBuy,
  planBuy,
  resolveBuyCaps,
  resolveMaxFeeGweiCap,
} from './buy.js';
import { creditAbi } from './contracts.js';

const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const EXCHANGE: Address = '0x6951fFd32630b05e06F50062AEA801625A58eBC0';
const CREDIT: Address = '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C';
const HOT: Address = '0x1111111111111111111111111111111111111111';

const ADDRESSES = {
  credit: CREDIT,
  staking: '0xE0710011278BFb63E57C5f227E5980984B1EDDca' as Address,
  exchange: EXCHANGE,
  orbio: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3' as Address,
  usdg: USDG,
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address,
  payout: '0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5' as Address,
};

/** Live 2026-09-19 fixture (docs/api-notes.md "S-03 chain reads", read.test.ts's `LIVE_QUOTE`) —
 *  10 USDG in, 13,333,332 CREDIT out (a ~33% discount): re-used here rather than a fresh probe,
 *  per the ticket's "read-only live calls ... fine for fixtures". */
const LIVE_10_USDG_QUOTE: BuyQuoteInput = { creditOut: 13_333_332n, fills: 2n };

const PASSING_WALLET = { usdgAtoms: 1_000_000_000n, ethWei: 10n ** 18n };

function caps(overrides: Partial<BuyCaps> = {}): BuyCaps {
  return {
    treasurerLive: false,
    buyMaxUsdgPerTxAtoms: 10_000_000n, // 10 USDG
    buyMaxPerDay: 1,
    minDiscountRatio: 1.1,
    maxFills: 10n,
    minGasWei: 500_000_000_000_000n, // 0.0005 ETH
    ...overrides,
  };
}

const NOW = new Date('2026-09-19T12:00:00.000Z');

function expectRefusal(result: BuyPlan | BuyRefusal): BuyRefusal {
  if (result.kind !== 'refusal')
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result;
}
function expectPlan(result: BuyPlan | BuyRefusal): BuyPlan {
  if (result.kind !== 'plan') throw new Error(`expected a plan, got ${JSON.stringify(result)}`);
  return result;
}

describe('planBuy — table-driven (AC1: ≥12 rows)', () => {
  it('1. dry-run plan when live is off, everything else passing', () => {
    const plan = expectPlan(
      planBuy({
        usdgIn: 10_000_000n,
        quote: LIVE_10_USDG_QUOTE,
        caps: caps({ treasurerLive: false }),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(plan.dryRun).toBe(true);
  });

  it('2. live plan (dryRun: false) when live is on and everything else passes', () => {
    const plan = expectPlan(
      planBuy({
        usdgIn: 10_000_000n,
        quote: LIVE_10_USDG_QUOTE,
        caps: caps({ treasurerLive: true }),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(plan.dryRun).toBe(false);
  });

  it('3. usdgIn > BUY_MAX_USDG_PER_TX → per_tx_cap_exceeded', () => {
    const refusal = expectRefusal(
      planBuy({
        usdgIn: 10_000_001n,
        quote: { creditOut: 13_333_333n, fills: 2n },
        caps: caps(),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('per_tx_cap_exceeded');
  });

  it('4. usdgIn === BUY_MAX_USDG_PER_TX (boundary) is NOT refused', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: LIVE_10_USDG_QUOTE,
      caps: caps(),
      wallet: PASSING_WALLET,
      history: { buyTimestamps: [] },
      now: NOW,
    });
    expect(result.kind).toBe('plan');
  });

  it('5. buysToday >= BUY_MAX_PER_DAY (same UTC day) → per_day_cap_exceeded', () => {
    const refusal = expectRefusal(
      planBuy({
        usdgIn: 10_000_000n,
        quote: LIVE_10_USDG_QUOTE,
        caps: caps({ buyMaxPerDay: 1 }),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: ['2026-09-19T00:10:00.000Z'] }, // same UTC day as NOW, different hour
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('per_day_cap_exceeded');
  });

  it('6. UTC day boundary: a buy from the previous UTC day does NOT count toward today (audit focus: "day counter using local time")', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: LIVE_10_USDG_QUOTE,
      caps: caps({ buyMaxPerDay: 1 }),
      wallet: PASSING_WALLET,
      // One second before NOW's UTC calendar day starts.
      history: { buyTimestamps: ['2026-09-18T23:59:59.000Z'] },
      now: new Date('2026-09-19T00:00:01.000Z'),
    });
    expect(result.kind).toBe('plan');
  });

  it('7. quote discount below 1.10 → discount_too_low', () => {
    const refusal = expectRefusal(
      planBuy({
        usdgIn: 10_000_000n,
        quote: { creditOut: 10_900_000n, fills: 1n }, // ratio 1.09
        caps: caps(),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('discount_too_low');
  });

  it('8. quote discount exactly 1.10 (boundary) is NOT refused', () => {
    const result = planBuy({
      usdgIn: 10_000_000n,
      quote: { creditOut: 11_000_000n, fills: 1n }, // ratio exactly 1.10
      caps: caps(),
      wallet: PASSING_WALLET,
      history: { buyTimestamps: [] },
      now: NOW,
    });
    expect(result.kind).toBe('plan');
  });

  it('9. quote.fills > caps.maxFills → fills_exceeded', () => {
    const refusal = expectRefusal(
      planBuy({
        usdgIn: 10_000_000n,
        quote: { creditOut: 13_333_332n, fills: 11n },
        caps: caps({ maxFills: 10n }),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('fills_exceeded');
  });

  it('10. hot wallet USDG balance < usdgIn → insufficient_usdg_balance', () => {
    const refusal = expectRefusal(
      planBuy({
        usdgIn: 10_000_000n,
        quote: LIVE_10_USDG_QUOTE,
        caps: caps(),
        wallet: { usdgAtoms: 1n, ethWei: 10n ** 18n },
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('insufficient_usdg_balance');
  });

  it('11. hot wallet ETH balance < MIN_GAS_ETH → insufficient_gas_balance', () => {
    const refusal = expectRefusal(
      planBuy({
        usdgIn: 10_000_000n,
        quote: LIVE_10_USDG_QUOTE,
        caps: caps(),
        wallet: { usdgAtoms: 1_000_000_000n, ethWei: 1n },
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(refusal.reason).toBe('insufficient_gas_balance');
  });

  it('12. minCreditOut = floor(quote.creditOut × 0.98), exact integer (audit focus: "rounding up")', () => {
    const plan = expectPlan(
      planBuy({
        usdgIn: 10_000_000n,
        quote: LIVE_10_USDG_QUOTE, // creditOut = 13,333,332
        caps: caps({ treasurerLive: true }),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    // 13,333,332 × 9800 = 130,666,653,600; / 10000 = 13,066,665.36 → floors to 13,066,665.
    // Never 13,066,666 (that would be rounding up, the exact audit-focus bug).
    expect(plan.minCreditOut).toBe(13_066_665n);
  });

  it('13. a refusal check runs the same way regardless of caps.treasurerLive (dry-run models a real refusal)', () => {
    const liveOff = expectRefusal(
      planBuy({
        usdgIn: 10_000_001n,
        quote: { creditOut: 13_333_333n, fills: 2n },
        caps: caps({ treasurerLive: false }),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    const liveOn = expectRefusal(
      planBuy({
        usdgIn: 10_000_001n,
        quote: { creditOut: 13_333_333n, fills: 2n },
        caps: caps({ treasurerLive: true }),
        wallet: PASSING_WALLET,
        history: { buyTimestamps: [] },
        now: NOW,
      }),
    );
    expect(liveOff.reason).toBe('per_tx_cap_exceeded');
    expect(liveOn.reason).toBe('per_tx_cap_exceeded');
  });
});

describe('resolveBuyCaps — env override is downward-only (CLAUDE.md #5)', () => {
  it('defaults (no env set) match policy/defaults.ts', () => {
    const result = resolveBuyCaps({ env: { TREASURER_LIVE: false } });
    expect(result.treasurerLive).toBe(false);
    expect(result.buyMaxUsdgPerTxAtoms).toBe(10_000_000n); // BUY_MAX_USDG_PER_TX = '10'
    expect(result.buyMaxPerDay).toBe(1); // BUY_MAX_PER_DAY
    expect(result.minDiscountRatio).toBe(1.1);
    expect(result.maxFills).toBe(10n);
    expect(result.minGasWei.toString()).toBe('500000000000000'); // DEFAULT_MIN_GAS_ETH = 0.0005 ETH
  });

  it('env BUY_MAX_USDG_PER_TX lower than default is applied', () => {
    const warn = vi.fn();
    const result = resolveBuyCaps({
      env: { TREASURER_LIVE: false, BUY_MAX_USDG_PER_TX: '3' },
      warn,
    });
    expect(result.buyMaxUsdgPerTxAtoms).toBe(3_000_000n);
    expect(warn).not.toHaveBeenCalled();
  });

  it('env BUY_MAX_USDG_PER_TX higher than default is IGNORED and logs a warning', () => {
    const warn = vi.fn();
    const result = resolveBuyCaps({
      env: { TREASURER_LIVE: false, BUY_MAX_USDG_PER_TX: '1000' },
      warn,
    });
    expect(result.buyMaxUsdgPerTxAtoms).toBe(10_000_000n); // unchanged
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/RAISE/);
  });

  it('env BUY_MAX_PER_DAY lower than default is applied; higher is ignored + warns', () => {
    const lowered = resolveBuyCaps({ env: { TREASURER_LIVE: false, BUY_MAX_PER_DAY: '0' } });
    expect(lowered.buyMaxPerDay).toBe(0);

    const warn = vi.fn();
    const raised = resolveBuyCaps({
      env: { TREASURER_LIVE: false, BUY_MAX_PER_DAY: '5' },
      warn,
    });
    expect(raised.buyMaxPerDay).toBe(1); // unchanged
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an unparseable BUY_MAX_USDG_PER_TX is ignored (default kept) and warns, never throws', () => {
    const warn = vi.fn();
    const result = resolveBuyCaps({
      env: { TREASURER_LIVE: false, BUY_MAX_USDG_PER_TX: 'not-a-number' },
      warn,
    });
    expect(result.buyMaxUsdgPerTxAtoms).toBe(10_000_000n);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('env MIN_GAS_ETH higher than default RAISES the gas-safety floor (Minor/Question 2: floors may only go up)', () => {
    const warn = vi.fn();
    const result = resolveBuyCaps({ env: { TREASURER_LIVE: false, MIN_GAS_ETH: '0.01' }, warn });
    expect(result.minGasWei.toString()).toBe('10000000000000000');
    expect(warn).not.toHaveBeenCalled();
  });

  it('env MIN_GAS_ETH lower than default is IGNORED and logs a warning (Minor/Question 2)', () => {
    const warn = vi.fn();
    const result = resolveBuyCaps({ env: { TREASURER_LIVE: false, MIN_GAS_ETH: '0.0001' }, warn });
    expect(result.minGasWei.toString()).toBe('500000000000000'); // unchanged (DEFAULT_MIN_GAS_ETH)
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/LOWER/);
  });

  it('an unparseable MIN_GAS_ETH is ignored (default kept) and warns, never throws', () => {
    const warn = vi.fn();
    const result = resolveBuyCaps({
      env: { TREASURER_LIVE: false, MIN_GAS_ETH: 'not-a-number' },
      warn,
    });
    expect(result.minGasWei.toString()).toBe('500000000000000');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('TREASURER_LIVE=true is reflected on the resolved caps', () => {
    const result = resolveBuyCaps({ env: { TREASURER_LIVE: true } });
    expect(result.treasurerLive).toBe(true);
  });
});

describe('resolveMaxFeeGweiCap', () => {
  it('defaults to DEFAULT_MAX_FEE_GWEI when unset', () => {
    expect(resolveMaxFeeGweiCap({ MAX_FEE_GWEI: undefined })).toBe(DEFAULT_MAX_FEE_GWEI);
  });

  it('uses the env value when it is lower than the default (a fee cap may only be lowered)', () => {
    const warn = vi.fn();
    expect(resolveMaxFeeGweiCap({ MAX_FEE_GWEI: '2.5' }, warn)).toBe(2.5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a value that would RAISE the default fee cap is ignored and logs a warning (Minor/Question 2)', () => {
    const warn = vi.fn();
    expect(resolveMaxFeeGweiCap({ MAX_FEE_GWEI: '12.5' }, warn)).toBe(DEFAULT_MAX_FEE_GWEI);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/RAISE/);
  });

  it('falls back to the default and warns on an invalid value', () => {
    const warn = vi.fn();
    expect(resolveMaxFeeGweiCap({ MAX_FEE_GWEI: '-3' }, warn)).toBe(DEFAULT_MAX_FEE_GWEI);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('addressToBeneficiary', () => {
  it('left-pads the 20-byte address into a 32-byte value (PRD §3 shape)', () => {
    const beneficiary = addressToBeneficiary(HOT);
    expect(beneficiary).toBe(pad(HOT, { size: 32 }));
    expect(beneficiary.length).toBe(2 + 64); // '0x' + 64 hex chars
    expect(beneficiary.toLowerCase().endsWith(HOT.slice(2).toLowerCase())).toBe(true);
  });
});

// --- executeBuy — fake viem client (AC2) --------------------------------------------------------

function buildActivatedLog(params: { address: Address; activationId: bigint; amount: bigint }) {
  const topics = encodeEventTopics({
    abi: creditAbi,
    eventName: 'Activated',
    args: { activationId: params.activationId, from: HOT, beneficiary: addressToBeneficiary(HOT) },
  });
  const data = encodeAbiParameters([{ type: 'uint256', name: 'amount' }], [params.amount]);
  return { address: params.address, topics, data };
}

const APPROVE_HASH: Hex = `0x${'1'.repeat(64)}`;
const BUY_HASH: Hex = `0x${'2'.repeat(64)}`;

function fakeExecClient(opts: {
  allowance: bigint;
  buyReceiptStatus?: 'success' | 'reverted';
  approveReceiptStatus?: 'success' | 'reverted';
  activatedLogAddress?: Address; // defaults to ADDRESSES.credit; pass a wrong address to test the guard
  omitActivatedLog?: boolean;
}): {
  client: BuyExecClient;
  readContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
} {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'allowance') return opts.allowance;
    throw new Error(`fakeExecClient: unexpected readContract ${args.functionName}`);
  });

  const writeContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'approve') return APPROVE_HASH;
    if (args.functionName === 'buyAndActivate') return BUY_HASH;
    throw new Error(`fakeExecClient: unexpected writeContract ${args.functionName}`);
  });

  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (hash === APPROVE_HASH) {
      return {
        status: opts.approveReceiptStatus ?? 'success',
        logs: [],
      } as unknown as TransactionReceipt;
    }
    const logs = opts.omitActivatedLog
      ? []
      : [
          buildActivatedLog({
            address: opts.activatedLogAddress ?? ADDRESSES.credit,
            activationId: 7n,
            amount: 13_066_665n,
          }),
        ];
    return {
      status: opts.buyReceiptStatus ?? 'success',
      logs,
    } as unknown as TransactionReceipt;
  });

  const getBalance = vi.fn(async () => 10n ** 18n);

  return {
    client: { readContract, writeContract, waitForTransactionReceipt, getBalance },
    readContract,
    writeContract,
  };
}

const LIVE_PLAN: BuyPlan = {
  kind: 'plan',
  dryRun: false,
  usdgIn: 10_000_000n,
  minCreditOut: 13_066_665n,
  maxFills: 10n,
  quote: LIVE_10_USDG_QUOTE,
};

describe('executeBuy — fake viem client (AC2)', () => {
  it('skips approve when allowance already suffices, still sends buyAndActivate', async () => {
    const { client, writeContract } = fakeExecClient({ allowance: 10_000_000n });
    const result = await executeBuy(LIVE_PLAN, {
      client,
      account: { address: HOT } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
    });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0]?.[0]?.functionName).toBe('buyAndActivate');
    expect(result.txHash).toBe(BUY_HASH);
    expect(result.creditOut).toBe(13_066_665n);
    expect(result.activationId).toBe(7n);
  });

  it('sends approve first when allowance is short, for the exact usdgIn (never unlimited)', async () => {
    const { client, writeContract } = fakeExecClient({ allowance: 0n });
    await executeBuy(LIVE_PLAN, {
      client,
      account: { address: HOT } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
    });
    expect(writeContract).toHaveBeenCalledTimes(2);
    const approveCall = writeContract.mock.calls[0]?.[0];
    expect(approveCall.functionName).toBe('approve');
    expect(approveCall.args).toEqual([ADDRESSES.exchange, LIVE_PLAN.usdgIn]); // exact amount, audit focus
    const buyCall = writeContract.mock.calls[1]?.[0];
    expect(buyCall.functionName).toBe('buyAndActivate');
  });

  it('buyAndActivate args are exactly [usdgIn, minCreditOut, beneficiary bytes32, maxFills]', async () => {
    const { client, writeContract } = fakeExecClient({ allowance: 10_000_000n });
    await executeBuy(LIVE_PLAN, {
      client,
      account: { address: HOT } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
    });
    const call = writeContract.mock.calls[0]?.[0];
    expect(call.address).toBe(ADDRESSES.exchange);
    expect(call.args).toEqual([
      LIVE_PLAN.usdgIn,
      LIVE_PLAN.minCreditOut,
      addressToBeneficiary(HOT),
      LIVE_PLAN.maxFills,
    ]);
  });

  it('decodes the Activated event from a fixture receipt built from the real CREDIT ABI', async () => {
    const { client } = fakeExecClient({ allowance: 10_000_000n });
    const result = await executeBuy(LIVE_PLAN, {
      client,
      account: { address: HOT } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
    });
    expect(result.activationId).toBe(7n);
    expect(result.creditOut).toBe(13_066_665n);
  });

  it('MAX_FEE_GWEI is respected: maxFeePerGas passed to writeContract never exceeds the cap', async () => {
    const { client, writeContract } = fakeExecClient({ allowance: 10_000_000n });
    (
      client as unknown as {
        estimateFeesPerGas: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
      }
    ).estimateFeesPerGas = vi.fn(async () => ({
      maxFeePerGas: 50_000_000_000n,
      maxPriorityFeePerGas: 40_000_000_000n,
    })); // 50/40 gwei — way above the cap
    await executeBuy(LIVE_PLAN, {
      client,
      account: { address: HOT } as never,
      addresses: ADDRESSES,
      hot: HOT,
      maxFeeGweiCap: 5,
    });
    const call = writeContract.mock.calls[0]?.[0];
    const capWei = 5_000_000_000n; // 5 gwei
    expect(call.maxFeePerGas).toBeLessThanOrEqual(capWei);
    expect(call.maxPriorityFeePerGas).toBeLessThanOrEqual(call.maxFeePerGas);
  });

  it('throws — never "succeeds" — when the buyAndActivate receipt status is reverted (audit focus)', async () => {
    const { client } = fakeExecClient({ allowance: 10_000_000n, buyReceiptStatus: 'reverted' });
    await expect(
      executeBuy(LIVE_PLAN, {
        client,
        account: { address: HOT } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
      }),
    ).rejects.toThrow(/reverted/);
  });

  it('throws when the approve receipt status is reverted', async () => {
    const { client } = fakeExecClient({ allowance: 0n, approveReceiptStatus: 'reverted' });
    await expect(
      executeBuy(LIVE_PLAN, {
        client,
        account: { address: HOT } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
      }),
    ).rejects.toThrow(/approve reverted/);
  });

  it('throws when no Activated event is found in the receipt', async () => {
    const { client } = fakeExecClient({ allowance: 10_000_000n, omitActivatedLog: true });
    await expect(
      executeBuy(LIVE_PLAN, {
        client,
        account: { address: HOT } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
      }),
    ).rejects.toThrow(/no Activated event/);
  });

  it('ignores a log with the right topics but from the WRONG contract address (audit focus)', async () => {
    // Any address that isn't ADDRESSES.credit — reusing the staking address already in scope.
    const { client } = fakeExecClient({
      allowance: 10_000_000n,
      activatedLogAddress: ADDRESSES.staking,
    });
    await expect(
      executeBuy(LIVE_PLAN, {
        client,
        account: { address: HOT } as never,
        addresses: ADDRESSES,
        hot: HOT,
        maxFeeGweiCap: DEFAULT_MAX_FEE_GWEI,
      }),
    ).rejects.toThrow(/no Activated event/);
  });

  it("refuses to run at all against a dryRun plan (belt-and-braces, on top of buyCredit()'s own gate)", async () => {
    const { client, writeContract } = fakeExecClient({ allowance: 10_000_000n });
    await expect(
      executeBuy(
        { ...LIVE_PLAN, dryRun: true },
        {
          client,
          account: { address: HOT } as never,
          addresses: ADDRESSES,
          hot: HOT,
          maxFeeGweiCap: 5,
        },
      ),
    ).rejects.toThrow(/dryRun/);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

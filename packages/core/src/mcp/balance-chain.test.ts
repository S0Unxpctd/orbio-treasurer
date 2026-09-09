/**
 * Unit tests for the balance source chain (T-010 AC3, PRD FR-2.0).
 * Derived from the ticket's acceptance criteria, not from reading client.ts's internals.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AdapterShapeError,
  estimateBalanceMicroUsd,
  getBalanceViaChain,
  type McpBalanceReader,
} from './index.js';

describe('estimateBalanceMicroUsd', () => {
  it('computes last_known - metered_spend + expected_accrual exactly', () => {
    const result = estimateBalanceMicroUsd({
      lastKnownMicroUsd: '100000000', // $100
      meteredSpendMicroUsd: '2500000', // $2.50
      expectedAccrualMicroUsd: '750000', // $0.75
    });
    expect(result).toBe('98250000'); // $98.25
  });

  it('never touches floating point — exact for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    // 2^53 - 1 = 9007199254740991; push comfortably past it in microUSD terms.
    const result = estimateBalanceMicroUsd({
      lastKnownMicroUsd: '90071992547409910000',
      meteredSpendMicroUsd: '1',
      expectedAccrualMicroUsd: '2',
    });
    expect(result).toBe('90071992547409910001');
  });

  it('allows the estimate to go negative (a genuine deficit, not clamped to zero)', () => {
    const result = estimateBalanceMicroUsd({
      lastKnownMicroUsd: '1000000',
      meteredSpendMicroUsd: '5000000',
      expectedAccrualMicroUsd: '0',
    });
    expect(result).toBe('-4000000');
  });

  it('is a no-op when spend and accrual are both zero', () => {
    const result = estimateBalanceMicroUsd({
      lastKnownMicroUsd: '42',
      meteredSpendMicroUsd: '0',
      expectedAccrualMicroUsd: '0',
    });
    expect(result).toBe('42');
  });

  it('rejects a non-integer decimal string (money must never be a float)', () => {
    expect(() =>
      estimateBalanceMicroUsd({
        lastKnownMicroUsd: '100.5',
        meteredSpendMicroUsd: '0',
        expectedAccrualMicroUsd: '0',
      }),
    ).toThrow();
  });

  it('accumulates 1000 successive small ticks with zero drift (BigInt, not float)', () => {
    // Each tick: spend 333333 microUSD, accrue 111111 microUSD — a repeating-fraction-shaped
    // pair chosen specifically because it would NOT be exact under IEEE-754 float accumulation.
    let lastKnown = '100000000000'; // $100,000 starting balance, plenty of runway
    const perTickSpend = 333333n;
    const perTickAccrual = 111111n;
    const ticks = 1000;
    for (let i = 0; i < ticks; i++) {
      lastKnown = estimateBalanceMicroUsd({
        lastKnownMicroUsd: lastKnown,
        meteredSpendMicroUsd: perTickSpend.toString(),
        expectedAccrualMicroUsd: perTickAccrual.toString(),
      });
    }
    const expected = 100000000000n - BigInt(ticks) * (perTickSpend - perTickAccrual);
    expect(lastKnown).toBe(expected.toString());
  });
});

describe('getBalanceViaChain', () => {
  it('returns the mcp reading with source mcp and lowConfidence false when mcp succeeds', async () => {
    const mcp: McpBalanceReader = {
      getBalance: vi.fn().mockResolvedValue({ valueMicroUsd: '55000000' }),
    };
    const result = await getBalanceViaChain(mcp, {
      lastKnownMicroUsd: '0',
      meteredSpendMicroUsd: '0',
      expectedAccrualMicroUsd: '0',
    });
    expect(result).toEqual({ valueMicroUsd: '55000000', source: 'mcp', lowConfidence: false });
  });

  it('falls back to estimate with lowConfidence true when mcp is unavailable (no gateway step, P-2)', async () => {
    const mcp: McpBalanceReader = {
      getBalance: vi.fn().mockRejectedValue(new Error('mcp unreachable: connect ECONNREFUSED')),
    };
    const result = await getBalanceViaChain(mcp, {
      lastKnownMicroUsd: '10000000',
      meteredSpendMicroUsd: '1000000',
      expectedAccrualMicroUsd: '250000',
    });
    expect(result).toEqual({ valueMicroUsd: '9250000', source: 'estimate', lowConfidence: true });
  });

  it('rethrows AdapterShapeError instead of falling back — a malformed response fails loudly', async () => {
    const shapeError = new AdapterShapeError('orbio_get_balance', 'missing balance.microUsd', {
      redacted: true,
    });
    const mcp: McpBalanceReader = { getBalance: vi.fn().mockRejectedValue(shapeError) };
    await expect(
      getBalanceViaChain(mcp, {
        lastKnownMicroUsd: '0',
        meteredSpendMicroUsd: '0',
        expectedAccrualMicroUsd: '0',
      }),
    ).rejects.toBe(shapeError);
  });
});

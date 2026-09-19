/**
 * chain.ts — the Robinhood Chain definition and the ordered-RPC-fallback client (S-03, AC2:
 * "RPC fallback: unit test with a fake transport where the first RPC returns 429 and the
 * second answers"). Every test here uses viem's `custom()` transport wrapping a hand-written
 * EIP-1193-shaped fake provider — no network, no real RPC — via `createRobinhoodClient`'s
 * `transports` seam.
 */
import { custom } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  createRobinhoodClient,
  createRpcTracker,
  DEFAULT_RH_RPC_URLS,
  MULTICALL3_ADDRESS,
  parseRhRpcUrls,
  ROBINHOOD_CHAIN_ID,
  robinhoodChain,
} from './chain.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** A minimal EIP-1193 provider that always fails with an HTTP-429-shaped error. */
function failingProvider(calls: { count: number }) {
  return {
    async request(): Promise<never> {
      calls.count++;
      const err = new Error('rate limited') as Error & { status?: number };
      err.status = 429;
      throw err;
    },
  };
}

/** A minimal EIP-1193 provider that answers `eth_chainId`/`eth_getBalance`/`eth_call`. */
function answeringProvider(calls: { count: number }, opts: { balanceHex?: string } = {}) {
  return {
    async request({ method }: { method: string }): Promise<unknown> {
      calls.count++;
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getBalance') return opts.balanceHex ?? '0x2a';
      throw new Error(`answeringProvider: unexpected method ${method}`);
    },
  };
}

describe('robinhoodChain', () => {
  it('is chain id 4663 with 18-decimal ETH gas and the PRD §3 explorer', () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(ROBINHOOD_CHAIN_ID).toBe(4663);
    expect(robinhoodChain.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    expect(robinhoodChain.blockExplorers?.default.url).toBe('https://robin.etherscan.io');
  });

  it('declares the Multicall3 contract at the standard CREATE2 address', () => {
    expect(robinhoodChain.contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS);
  });
});

describe('parseRhRpcUrls', () => {
  it('defaults to publicnode -> ordofi when unset/empty', () => {
    expect(parseRhRpcUrls(undefined)).toEqual([...DEFAULT_RH_RPC_URLS]);
    expect(parseRhRpcUrls('')).toEqual([...DEFAULT_RH_RPC_URLS]);
    expect(parseRhRpcUrls('  ,  ,')).toEqual([...DEFAULT_RH_RPC_URLS]);
  });

  it('parses a comma-separated override, trimmed, order preserved', () => {
    expect(parseRhRpcUrls('https://a.example, https://b.example ,https://c.example')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });
});

describe('createRobinhoodClient — RPC fallback (AC2)', () => {
  it('falls back to the second transport when the first 429s, and returns its answer', async () => {
    const callsA = { count: 0 };
    const callsB = { count: 0 };
    const client = createRobinhoodClient([], {
      transports: [
        custom(failingProvider(callsA), { retryCount: 0 }),
        custom(answeringProvider(callsB, { balanceHex: '0x10' }), { retryCount: 0 }),
      ],
    });

    const balance = await client.getBalance({ address: ZERO_ADDRESS });

    expect(balance).toBe(16n);
    expect(callsA.count).toBeGreaterThanOrEqual(1);
    expect(callsB.count).toBeGreaterThanOrEqual(1);
  });

  it('throws if every transport in the fallback list fails', async () => {
    const client = createRobinhoodClient([], {
      transports: [
        custom(failingProvider({ count: 0 }), { retryCount: 0 }),
        custom(failingProvider({ count: 0 }), { retryCount: 0 }),
      ],
    });

    await expect(client.getBalance({ address: ZERO_ADDRESS })).rejects.toThrow();
  });

  it('a single working transport (no second RPC configured) answers directly', async () => {
    const calls = { count: 0 };
    const client = createRobinhoodClient([], {
      transports: [custom(answeringProvider(calls, { balanceHex: '0x7' }), { retryCount: 0 })],
    });
    expect(await client.getBalance({ address: ZERO_ADDRESS })).toBe(7n);
  });

  it('throws synchronously if given neither rpcUrls nor transports', () => {
    expect(() => createRobinhoodClient([])).toThrow(/no RPC URLs configured/);
  });
});

describe('createRpcTracker', () => {
  it('starts with lastHost null', () => {
    expect(createRpcTracker().lastHost).toBeNull();
  });
});

/**
 * contracts.ts — address loading from `Env` (S-03, tasks/S-03.md "In scope": "a contracts.ts
 * that reads ALL addresses from env ... never hard-coded in source"). Uses the exact PRD §3
 * addresses as fixtures.
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import {
  ChainEnvValidationError,
  creditAbi,
  erc20Abi,
  exchangeAbi,
  loadChainAddresses,
  stakingAbi,
} from './contracts.js';

// PRD §3, docs/PRD-1.0-sprint.md — the exact 7 addresses (some in the PRD's own printed casing,
// which is not itself EIP-55-checksummed for USDG — see docs/api-notes.md "S-03 chain reads"
// Discovered note; loadChainAddresses() re-checksums via getAddress() regardless of input casing).
const ALL_ADDRESSES = {
  CREDIT_ADDRESS: '0xe33322da1380e61e5ae5dfb21e7f62924c73004c',
  STAKING_ADDRESS: '0xe0710011278bfb63e57c5f227e5980984b1eddca',
  EXCHANGE_ADDRESS: '0x6951ffd32630b05e06f50062aea801625a58ebc0',
  ORBIO_ADDRESS: '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3',
  USDG_ADDRESS: '0x5fc5360d0400a0Fd4f2af552ADD042D716F1d168',
  NVDA_ADDRESS: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  PAYOUT_ADDRESS: '0x4cbbbf652b11ed1294df0ac49d8322394310cfc5',
};

describe('loadChainAddresses', () => {
  it('reads and checksums all 7 PRD §3 addresses from Env', () => {
    const env = loadEnv(ALL_ADDRESSES);
    const addresses = loadChainAddresses(env);
    expect(addresses.credit.toLowerCase()).toBe(ALL_ADDRESSES.CREDIT_ADDRESS.toLowerCase());
    expect(addresses.staking.toLowerCase()).toBe(ALL_ADDRESSES.STAKING_ADDRESS.toLowerCase());
    expect(addresses.exchange.toLowerCase()).toBe(ALL_ADDRESSES.EXCHANGE_ADDRESS.toLowerCase());
    expect(addresses.orbio.toLowerCase()).toBe(ALL_ADDRESSES.ORBIO_ADDRESS.toLowerCase());
    expect(addresses.usdg.toLowerCase()).toBe(ALL_ADDRESSES.USDG_ADDRESS.toLowerCase());
    expect(addresses.nvda.toLowerCase()).toBe(ALL_ADDRESSES.NVDA_ADDRESS.toLowerCase());
    expect(addresses.payout.toLowerCase()).toBe(ALL_ADDRESSES.PAYOUT_ADDRESS.toLowerCase());
  });

  it("re-checksums the PRD doc's USDG casing to the correct EIP-55 mixed case", () => {
    // Discovered (docs/api-notes.md "S-03 chain reads"): the PRD text's own printed casing for
    // USDG is not itself a valid EIP-55 checksum (one character's case is wrong) — viem's
    // getAddress() fixes it rather than erroring, since the string is a valid address either way.
    const env = loadEnv(ALL_ADDRESSES);
    const addresses = loadChainAddresses(env);
    expect(addresses.usdg).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  });

  it('reports every missing address by name only when none are set', () => {
    const env = loadEnv({});
    let error: unknown;
    try {
      loadChainAddresses(env);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ChainEnvValidationError);
    expect((error as ChainEnvValidationError).missing).toEqual([
      'CREDIT_ADDRESS',
      'STAKING_ADDRESS',
      'EXCHANGE_ADDRESS',
      'ORBIO_ADDRESS',
      'USDG_ADDRESS',
      'NVDA_ADDRESS',
      'PAYOUT_ADDRESS',
    ]);
  });

  it('reports only the invalid/missing ones when some are valid', () => {
    const env = loadEnv({
      ...ALL_ADDRESSES,
      CREDIT_ADDRESS: 'not-an-address',
    });
    let error: unknown;
    try {
      loadChainAddresses(env);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ChainEnvValidationError);
    expect((error as ChainEnvValidationError).missing).toEqual(['CREDIT_ADDRESS']);
  });

  it('rejects a too-short address (would silently truncate/misroute on-chain otherwise)', () => {
    const env = loadEnv({ ...ALL_ADDRESSES, PAYOUT_ADDRESS: '0x1234' });
    let error: unknown;
    try {
      loadChainAddresses(env);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ChainEnvValidationError);
    expect((error as ChainEnvValidationError).missing).toEqual(['PAYOUT_ADDRESS']);
  });
});

describe('ABIs (packages/core/abi/)', () => {
  it('erc20Abi has approve/allowance/balanceOf/transfer/decimals', () => {
    const names = erc20Abi.map((f) => ('name' in f ? f.name : undefined));
    expect(names).toEqual(
      expect.arrayContaining(['approve', 'allowance', 'balanceOf', 'transfer', 'decimals']),
    );
  });

  it('creditAbi additionally has activate(uint256) and activate(uint256,bytes32)', () => {
    const activateFns = creditAbi.filter((f) => 'name' in f && f.name === 'activate');
    expect(activateFns).toHaveLength(2);
  });

  it("exchangeAbi's getQuote returns the full {creditOut,usdgSpent,feeAtoms,fills,reason} tuple", () => {
    const getQuote = exchangeAbi.find((f) => 'name' in f && f.name === 'getQuote') as
      | { outputs: Array<{ components?: Array<{ name: string }> }> }
      | undefined;
    expect(getQuote).toBeDefined();
    const componentNames = getQuote?.outputs[0]?.components?.map((c) => c.name);
    expect(componentNames).toEqual(['creditOut', 'usdgSpent', 'feeAtoms', 'fills', 'reason']);
  });

  it('stakingAbi has the PRD §3 signatures: stake, settle, claim, settledOf, positionOf, rewardOf, rewardPeriod, totalStaked, MIN_POSITION, PERIOD, addresses', () => {
    const names = stakingAbi.map((f) => ('name' in f ? f.name : undefined));
    expect(names).toEqual(
      expect.arrayContaining([
        'stake',
        'settle',
        'claim',
        'settledOf',
        'positionOf',
        'rewardOf',
        'rewardPeriod',
        'totalStaked',
        'MIN_POSITION',
        'PERIOD',
        'addresses',
      ]),
    );
  });

  it('stakingAbi never declares unstakeAll (PRD §3: "plausible, unverified: never call it")', () => {
    const names = stakingAbi.map((f) => ('name' in f ? f.name : undefined));
    expect(names).not.toContain('unstakeAll');
  });
});

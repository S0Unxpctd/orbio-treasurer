/**
 * Contract addresses and ABIs for chain 4663 (S-03, docs/PRD-1.0-sprint.md §3). Addresses are
 * read from `Env` (never a literal in source — CLAUDE.md #5) and checksum-validated with
 * viem's `getAddress()`, which also catches a malformed value at load time rather than at the
 * first `eth_call`. ABIs live in `packages/core/abi/` (see that folder's README for provenance
 * and what's verified vs. hand-written/unverified).
 */
import { readFileSync } from 'node:fs';
import type { Abi, Address } from 'viem';
import { getAddress } from 'viem';
import type { Env } from '../env.js';

function loadAbi(name: string): Abi {
  const url = new URL(`../../abi/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Abi;
}

export const creditAbi: Abi = loadAbi('credit');
export const exchangeAbi: Abi = loadAbi('exchange');
export const erc20Abi: Abi = loadAbi('erc20');
export const stakingAbi: Abi = loadAbi('staking');

export interface ChainAddresses {
  readonly credit: Address;
  readonly staking: Address;
  readonly exchange: Address;
  readonly orbio: Address;
  readonly usdg: Address;
  readonly nvda: Address;
  readonly payout: Address;
}

const ADDRESS_ENV_KEYS = [
  'CREDIT_ADDRESS',
  'STAKING_ADDRESS',
  'EXCHANGE_ADDRESS',
  'ORBIO_ADDRESS',
  'USDG_ADDRESS',
  'NVDA_ADDRESS',
  'PAYOUT_ADDRESS',
] as const;

/** Thrown by `loadChainAddresses()`. Carries only variable *names* (CLAUDE.md #4 — an address is
 *  not a secret, but the pattern is kept consistent with `EnvValidationError`). */
export class ChainEnvValidationError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Missing or invalid chain address environment variable(s): ${missing.join(', ')}`);
    this.name = 'ChainEnvValidationError';
    this.missing = missing;
  }
}

/**
 * Reads and checksum-validates the 7 PRD §3 contract addresses from `env`. Every field is
 * required here — a caller that only needs a subset (none does, today) still gets a single,
 * complete error naming every missing/invalid one, rather than a confusing partial object.
 * `getAddress()` accepts an all-lowercase address unchanged and re-checksums a mixed-case one
 * that already matches; it throws only on a genuinely wrong checksum or a wrong-length string —
 * exactly the "invalid" case this function reports by name only.
 */
export function loadChainAddresses(env: Env): ChainAddresses {
  const missing: string[] = [];
  const resolved: Partial<Record<(typeof ADDRESS_ENV_KEYS)[number], Address>> = {};
  for (const key of ADDRESS_ENV_KEYS) {
    const raw = env[key];
    if (!raw) {
      missing.push(key);
      continue;
    }
    try {
      resolved[key] = getAddress(raw);
    } catch {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new ChainEnvValidationError(missing);
  }
  return {
    credit: resolved.CREDIT_ADDRESS as Address,
    staking: resolved.STAKING_ADDRESS as Address,
    exchange: resolved.EXCHANGE_ADDRESS as Address,
    orbio: resolved.ORBIO_ADDRESS as Address,
    usdg: resolved.USDG_ADDRESS as Address,
    nvda: resolved.NVDA_ADDRESS as Address,
    payout: resolved.PAYOUT_ADDRESS as Address,
  };
}

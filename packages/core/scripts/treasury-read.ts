#!/usr/bin/env tsx
/**
 * `pnpm treasury:read` — reads the live treasury snapshot and prints it, redacted, addresses
 * shortened (S-03, tasks/S-03.md AC7: "runs against the real chain and prints in < 10 s").
 * Read-only: never sends a transaction, never persists (that's `snapshotTreasury()`, exercised
 * by chain/snapshot.test.ts — this CLI is the human-facing read path, not the tick's).
 *
 * `hot` is the address `TREASURER_PRIVATE_KEY` derives to, or the zero address if unset (AC1:
 * "a zero-position read still returns a well-formed snapshot with zeros"). `staker` is
 * `STAKER_ADDRESS` if set, else the same zero-address fallback `readTreasury()` already applies.
 *
 * Run: pnpm treasury:read
 */
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createRobinhoodClient,
  createRpcTracker,
  loadChainAddresses,
  parseRhRpcUrls,
  readApiBalance,
  readTreasury,
} from '../src/chain/index.js';
import { loadEnv } from '../src/env.js';
import { redact } from '../src/redact.js';
import { getUpstreamKey } from '../src/router/upstream.js';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const addresses = loadChainAddresses(env);
  const rpcUrls = parseRhRpcUrls(env.RH_RPC_URLS);
  const tracker = createRpcTracker();
  const client = createRobinhoodClient(rpcUrls, { tracker });

  const hot: Address = env.TREASURER_PRIVATE_KEY
    ? privateKeyToAccount(env.TREASURER_PRIVATE_KEY as `0x${string}`).address
    : ZERO_ADDRESS;
  const staker = (env.STAKER_ADDRESS as Address | undefined) ?? ZERO_ADDRESS;

  const snapshot = await readTreasury(client, addresses, {
    hot,
    staker,
    rpcUrlHost: () => tracker.lastHost,
  });

  let apiBalance: unknown = null;
  if (env.ORBIO_GATEWAY_BASE_URL) {
    try {
      const key = await getUpstreamKey(env);
      apiBalance = await readApiBalance(env.ORBIO_GATEWAY_BASE_URL, key);
    } catch (err) {
      apiBalance = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const output = {
    asOf: snapshot.asOf,
    hot: shorten(hot),
    staker: shorten(staker),
    stakedOrbio: snapshot.stakedOrbio,
    settledCredit: snapshot.settledCredit,
    creditWalletHot: snapshot.creditWalletHot,
    creditWalletStaker: snapshot.creditWalletStaker,
    usdgBalanceHot: snapshot.usdgBalanceHot,
    ethBalanceHot: snapshot.ethBalanceHot,
    quote: snapshot.quote,
    totalStaked: snapshot.totalStaked,
    minPosition: snapshot.minPosition,
    period: snapshot.period,
    rpcUrlHost: snapshot.rpcUrlHost,
    usedMulticall: snapshot.usedMulticall,
    apiBalance,
  };

  console.log(JSON.stringify(redact(output), null, 2));
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify(redact({ error: err instanceof Error ? err.message : String(err) })),
  );
  process.exitCode = 1;
});

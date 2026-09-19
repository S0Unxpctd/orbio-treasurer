/**
 * Robinhood Chain (id 4663) definition and an ordered-RPC-fallback public client (S-03,
 * docs/PRD-1.0-sprint.md §3, tasks/S-03.md "In scope"). Read-only: this module never sends a
 * transaction (CLAUDE.md #5 — that's S-04/S-05/S-07, gated).
 *
 * Multicall3 (the standard CREATE2 deployment, same address on every chain that has it) IS
 * deployed on 4663 — confirmed live 2026-09-19, `eth_getCode` on `0xca11bde...ca11` returned
 * non-empty bytecode (see docs/api-notes.md "S-03 chain reads"). `read.ts` uses it when
 * available and falls back to sequential reads through the same fallback client otherwise
 * (ticket: "Uses multicall if available on 4663, else sequential with the fallback client").
 */
import type { Address, PublicClient, Transport } from 'viem';
import { createPublicClient, defineChain, fallback, http } from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;

/** Same CREATE2 address on every chain that has it deployed (confirmed live on 4663, see above). */
export const MULTICALL3_ADDRESS: Address = '0xca11bde05977b3631167028862be2a173976ca11';

/** Ticket default (`RH_RPC_URLS` unset): publicnode first (documented no-rate-limit), ordofi
 *  second. The official `rpc.mainnet.chain.robinhood.com` 429s after 2-3 calls (PRD §3) and is
 *  deliberately not in this list — an operator can still add it via `RH_RPC_URLS` if they want
 *  a third fallback, but nothing here depends on it. */
export const DEFAULT_RH_RPC_URLS = [
  'https://robinhood-rpc.publicnode.com',
  'https://rpc.ordofi.network',
] as const;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [...DEFAULT_RH_RPC_URLS] } },
  blockExplorers: {
    default: { name: 'Robin Explorer', url: 'https://robin.etherscan.io' },
  },
  contracts: {
    multicall3: { address: MULTICALL3_ADDRESS },
  },
});

/** Parses the comma-separated `RH_RPC_URLS` env value (already defaulted by `loadEnv()`) into an
 *  ordered, trimmed, non-empty list. Never returns an empty array — falls back to
 *  `DEFAULT_RH_RPC_URLS` if `raw` is empty or every entry trims away. */
export function parseRhRpcUrls(raw: string | undefined): string[] {
  const urls = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return urls.length > 0 ? urls : [...DEFAULT_RH_RPC_URLS];
}

/** One RPC actually answered a request; used only for the optional `rpcUrlHost` telemetry field
 *  on a `ChainSnapshot` (ledger `chain_snapshots.rpc_url_host`, S-02). Mutated in place by
 *  `trackedHttp()` transports below — a plain object rather than a return value because
 *  `createRobinhoodClient()`'s return type must stay a bare viem `PublicClient` (every call site
 *  passes it straight into viem's own APIs). */
export interface RpcTracker {
  /** Host of the RPC that most recently answered a request, across the whole client's
   *  lifetime — not just the current call. `null` until the first successful request. */
  lastHost: string | null;
}

export function createRpcTracker(): RpcTracker {
  return { lastHost: null };
}

/** Wraps `http(url)` so every request that transport actually serves (i.e. every request that
 *  reaches it without throwing) records `url`'s host on `tracker` before returning. A transport
 *  earlier in a `fallback()` chain that 429s or times out never calls this wrapped `request`
 *  for that attempt — viem's `fallback` transport moves to the next transport in the list
 *  instead — so `tracker.lastHost` always reflects whichever RPC actually served the last
 *  successful call, not merely the first one tried. */
function trackedHttp(url: string, tracker: RpcTracker): Transport {
  const inner = http(url);
  const host = safeHost(url);
  return ((config: Parameters<Transport>[0]) => {
    const built = inner(config);
    const trackedRequest = (async (...args: Parameters<typeof built.request>) => {
      const result = await built.request(...args);
      tracker.lastHost = host;
      return result;
    }) as typeof built.request;
    return { ...built, request: trackedRequest };
  }) as Transport;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Builds the ordered-fallback public client (ticket: "a public client with an ordered RPC
 * fallback list from env `RH_RPC_URLS`"). Real network calls always go through `http(url)`;
 * `transports`, when given, overrides that mapping entirely — the one seam AC2's fake-transport
 * test uses to simulate a 429-then-success sequence without touching the network. Every entry
 * in `rpcUrls` (or every transport in `transports`) is wrapped so a successful call updates
 * `tracker` (if given). `fallback()` works fine with a single-element list (it's just that one
 * transport, no actual fallback attempted) so there's no special-case for `rpcUrls.length === 1`.
 */
export function createRobinhoodClient(
  rpcUrls: readonly string[],
  options: { readonly transports?: readonly Transport[]; readonly tracker?: RpcTracker } = {},
): PublicClient {
  if (rpcUrls.length === 0 && !options.transports) {
    throw new Error('createRobinhoodClient: no RPC URLs configured');
  }
  const tracker = options.tracker ?? createRpcTracker();
  const list: Transport[] = options.transports
    ? [...options.transports]
    : rpcUrls.map((url) => trackedHttp(url, tracker));
  return createPublicClient({ chain: robinhoodChain, transport: fallback(list) });
}

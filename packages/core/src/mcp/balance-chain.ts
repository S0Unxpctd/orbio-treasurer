/**
 * getBalanceViaChain — the balance source chain (T-010, PRD FR-2.0, ARCHITECTURE.md §4a,
 * docs/api-notes.md P-1/P-2).
 *
 * P-2 (2026-09-08): the gateway has no key-info/credits endpoint -> the chain is `mcp` ->
 * `estimate`, with **no `gateway` step** ("'gateway' reserved, never produced" — ARCHITECTURE
 * §4a). `estimate` is always available (it is pure arithmetic over inputs the caller already
 * has) so this chain never itself fails; only a malformed MCP response (`AdapterShapeError`)
 * propagates, per CLAUDE.md rule 6 — unavailability degrades gracefully, a shape violation does
 * not.
 *
 * `estimate = last_known − metered_spend + expected_accrual`, in exact microUSD integers
 * (BigInt) — never a float, matching `ledger/decimal.ts`'s discipline for on-chain/money
 * amounts. `lowConfidence` is true whenever `source === 'estimate'`, per the ticket.
 */
import { normalizeTokenAmount } from '../ledger/decimal.js';
import type { BalanceSource } from '../ledger/types.js';
import { log } from '../log.js';
import { redact } from '../redact.js';
import { AdapterShapeError } from './schemas.js';

export interface BalanceSourceResult {
  readonly valueMicroUsd: string;
  /** `ledger/types.ts`'s `BalanceSource` — this chain only ever produces `'mcp'` or
   *  `'estimate'` ('gateway' is reserved, never produced, per P-2 / ARCHITECTURE §4a), but
   *  reuses the ledger's type so a `treasury_snapshots.balance_source` write is a direct
   *  assignment, no re-mapping at the boundary. */
  readonly source: BalanceSource;
  /** True whenever `source === 'estimate'` (the ticket's exact requirement) — never computed
   *  any other way, so a caller can rely on it as the single confidence signal. */
  readonly lowConfidence: boolean;
}

/** The one MCP call the balance chain needs — `OrbioMcpClient.getBalance()` satisfies this. */
export interface McpBalanceReader {
  getBalance(): Promise<{ valueMicroUsd: string }>;
}

export interface EstimateInput {
  /** The last MCP-sourced (or estimated) balance reading, microUSD. */
  readonly lastKnownMicroUsd: string;
  /** Metered spend since `lastKnownMicroUsd` was read, microUSD (FR-3.2's `usage_events.cost_usd`,
   *  converted to microUSD by the caller). */
  readonly meteredSpendMicroUsd: string;
  /** Expected accrual since `lastKnownMicroUsd` was read, microUSD (holder-yield accrual, per the
   *  agent's own measured rate or a network-wide estimate — computed by the caller). */
  readonly expectedAccrualMicroUsd: string;
}

function toBigInt(label: string, value: string): bigint {
  const normalized = normalizeTokenAmount(value);
  if (normalized === null) {
    throw new Error(`balance-chain: ${label} is required, got null/undefined`);
  }
  return BigInt(normalized);
}

/** Pure: `estimate = last_known − metered_spend + expected_accrual`, exact microUSD integers. */
export function estimateBalanceMicroUsd(input: EstimateInput): string {
  const lastKnown = toBigInt('lastKnownMicroUsd', input.lastKnownMicroUsd);
  const spend = toBigInt('meteredSpendMicroUsd', input.meteredSpendMicroUsd);
  const accrual = toBigInt('expectedAccrualMicroUsd', input.expectedAccrualMicroUsd);
  return (lastKnown - spend + accrual).toString();
}

/**
 * Tries `mcp.getBalance()`; on any failure OTHER than `AdapterShapeError`, falls back to
 * `estimateBalanceMicroUsd(estimateInput)` with `source: 'estimate'` and `lowConfidence: true`.
 * `AdapterShapeError` is rethrown, never swallowed — a malformed MCP response must fail the
 * tick loudly (CLAUDE.md rule 6), not silently degrade.
 */
export async function getBalanceViaChain(
  mcp: McpBalanceReader,
  estimateInput: EstimateInput,
): Promise<BalanceSourceResult> {
  try {
    const { valueMicroUsd } = await mcp.getBalance();
    return { valueMicroUsd, source: 'mcp', lowConfidence: false };
  } catch (err) {
    if (err instanceof AdapterShapeError) throw err;
    log('warn', 'balance-source-fallback', {
      reason: 'mcp_unavailable',
      error: redact(err instanceof Error ? err.message : String(err)),
    });
    return {
      valueMicroUsd: estimateBalanceMicroUsd(estimateInput),
      source: 'estimate',
      lowConfidence: true,
    };
  }
}

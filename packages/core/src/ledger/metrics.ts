/**
 * computeSnapshotMetrics — the pure math behind a `treasury_snapshots` row (T-011, PRD FR-1.3,
 * FR-3.3, §9, §10).
 *
 * Pure: no I/O, no `new Date()`, no ledger access. Every value it needs — including the age of
 * the burn-rate data — is a plain-object input, so it is trivially table-tested and re-derivable
 * from a stored snapshot's inputs (the same discipline FR-4.6 requires of policy decisions).
 *
 * Money in and out is a decimal string (see `decimal.ts`) — never a float — matching how these
 * same values are stored (`numeric(18,6)` / TEXT).
 */
import { divideDecimal, formatDecimal, maxDecimal, parseDecimal, subDecimal } from './decimal.js';

/** PRD FR-1.3 gives the formula but not a number; see tasks/T-011.md Discovered for the flag to So. */
export const DEFAULT_EPSILON_USD_PER_DAY = '0.01';

/** FR-3.3: burn_rate_usd_per_day is annotated low_confidence until this many hours of data exist. */
export const LOW_CONFIDENCE_THRESHOLD_HOURS = 6;

export interface SnapshotMetricsInput {
  /** credits_available_usd — the numerator of runway_days. */
  readonly creditsAvailableUsd: string;
  /** accrued_last_24h_usd — the numerator of coverage_ratio (FR-1.3). */
  readonly accruedLast24hUsd: string;
  /** spent_last_24h_usd — the denominator of coverage_ratio (FR-1.3). */
  readonly spentLast24hUsd: string;
  /** burn_rate_usd_per_day (FR-3.3), already computed by the caller from usage_events. */
  readonly burnRateUsdPerDay: string;
  /** accrual_rate_usd_per_day, already computed by the caller from successive balance reads. */
  readonly accrualRateUsdPerDay: string;
  /**
   * Hours of usage-event history burnRateUsdPerDay is based on (FR-3.3: "until 6 hours of data
   * exist"). An input, not read from a clock here — time is an input to pure functions.
   */
  readonly historyHours: number;
  /** ε floor for runway's denominator (FR-1.3). Defaults to DEFAULT_EPSILON_USD_PER_DAY. */
  readonly epsilonUsdPerDay?: string;
}

export interface SnapshotMetrics {
  /** accrued_last_24h_usd / spent_last_24h_usd, or null when nothing was spent (undefined ratio). */
  readonly coverageRatio: string | null;
  /** null means infinite runway (accrual >= burn), per FR-1.3 — never a stored "Infinity" string. */
  readonly runwayDays: string | null;
  /** true until historyHours reaches LOW_CONFIDENCE_THRESHOLD_HOURS (FR-3.3). */
  readonly burnLowConfidence: boolean;
}

export function computeSnapshotMetrics(input: SnapshotMetricsInput): SnapshotMetrics {
  const credits = parseDecimal(input.creditsAvailableUsd);
  const accrued = parseDecimal(input.accruedLast24hUsd);
  const spent = parseDecimal(input.spentLast24hUsd);
  const burn = parseDecimal(input.burnRateUsdPerDay);
  const accrual = parseDecimal(input.accrualRateUsdPerDay);
  const epsilon = parseDecimal(input.epsilonUsdPerDay ?? DEFAULT_EPSILON_USD_PER_DAY);

  const coverageRatio = spent === 0n ? null : formatDecimal(divideDecimal(accrued, spent));

  // FR-1.3: "if accrual >= burn, runway is displayed as ∞" — checked before the ε floor, since
  // the floor exists only to bound a small *positive* net burn, not to paper over this case.
  const netBurn = subDecimal(burn, accrual);
  const runwayDays =
    netBurn <= 0n ? null : formatDecimal(divideDecimal(credits, maxDecimal(netBurn, epsilon)));

  const burnLowConfidence = input.historyHours < LOW_CONFIDENCE_THRESHOLD_HOURS;

  return { coverageRatio, runwayDays, burnLowConfidence };
}

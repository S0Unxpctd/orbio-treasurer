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

import type { ScaledDecimal } from './decimal.js';
import {
  addDecimal,
  divideDecimal,
  formatDecimal,
  maxDecimal,
  parseDecimal,
  subDecimal,
} from './decimal.js';
import type { IsoTimestamp, LedgerStore } from './types.js';
import { assertUtcIso } from './util.js';

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

// ---------------------------------------------------------------------------------------------
// S-02 (PRD 1.0 §4 T-2, §6): savings() and burnDaily(), reading straight off usage_events.
//
// These are "pure over store reads" (tasks/S-02.md): given the same store state and the same
// `now`, they always return the same answer — no `new Date()`, no hidden clock, `now` is always
// an explicit UTC ISO-8601 input, same discipline as computeSnapshotMetrics above. They are not
// pure in the strict no-I/O sense (they call `store.listUsageEvents`), which is why they're
// `async` and this one function, not the whole module, is the exception to CLAUDE.md's "pure
// TypeScript, no I/O" rule — that rule scopes to `packages/core/src/policy/**` only.
// ---------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = parseDecimal('7');

export type MetricsWindow = '24h' | '7d' | 'all';
export type MeteredTier = 'S' | 'M' | 'L';

export interface TierSavings {
  readonly calls: number;
  readonly costUsd: string;
}

export interface SavingsResult {
  readonly calls: number;
  readonly costUsd: string;
  readonly baselineUsd: string;
  /** baselineUsd - costUsd. Can be negative if a call cost more than its baseline. */
  readonly savedUsd: string;
  /** savedUsd / baselineUsd, 4 decimal places, round-half-away-from-zero; "0.0000" when baselineUsd is 0. */
  readonly savedPct: string;
  readonly byTier: Record<MeteredTier, TierSavings>;
}

const PCT_DP = 4;
const PCT_SCALE = 10n ** BigInt(PCT_DP);

/** Formats numerator/denominator (both 6dp-scaled) to a 4dp percentage string; "0.0000" if denominator is 0. */
function formatRatio4dp(numerator: ScaledDecimal, denominator: ScaledDecimal): string {
  if (denominator === 0n) return '0.0000';
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const scaledNumerator = n * PCT_SCALE;
  const quotient = scaledNumerator / d;
  const remainder = scaledNumerator % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  const intPart = rounded / PCT_SCALE;
  const fracPart = (rounded % PCT_SCALE).toString().padStart(PCT_DP, '0');
  return `${negative && rounded !== 0n ? '-' : ''}${intPart.toString()}.${fracPart}`;
}

function isMeteredTier(value: string | null): value is MeteredTier {
  return value === 'S' || value === 'M' || value === 'L';
}

function windowSinceAt(window: MetricsWindow, now: IsoTimestamp): IsoTimestamp | undefined {
  if (window === 'all') return undefined;
  const windowMs = window === '24h' ? DAY_MS : 7 * DAY_MS;
  return new Date(new Date(now).getTime() - windowMs).toISOString();
}

/**
 * How much `agentId` spent vs. what it would have spent on the baseline model, over `window`,
 * as of `now`. Sums `usage_events.cost_usd`/`baseline_cost_usd` (missing values treated as 0)
 * across every fetched event; `byTier` additionally buckets by `tier_served` (S/M/L only — an
 * event with no/unknown tier still counts in the totals, just not in any `byTier` bucket).
 */
export async function savings(
  store: Pick<LedgerStore, 'listUsageEvents'>,
  agentId: string,
  window: MetricsWindow,
  now: IsoTimestamp,
): Promise<SavingsResult> {
  assertUtcIso(now, 'now');
  const sinceAt = windowSinceAt(window, now);
  const events = await store.listUsageEvents(agentId, sinceAt ? { sinceAt } : undefined);

  let calls = 0;
  let cost: ScaledDecimal = 0n;
  let baseline: ScaledDecimal = 0n;
  const byTier: Record<MeteredTier, { calls: number; cost: ScaledDecimal }> = {
    S: { calls: 0, cost: 0n },
    M: { calls: 0, cost: 0n },
    L: { calls: 0, cost: 0n },
  };

  for (const event of events) {
    calls += 1;
    const eventCost = parseDecimal(event.costUsd ?? '0');
    const eventBaseline = parseDecimal(event.baselineCostUsd ?? '0');
    cost = addDecimal(cost, eventCost);
    baseline = addDecimal(baseline, eventBaseline);
    if (isMeteredTier(event.tierServed)) {
      byTier[event.tierServed].calls += 1;
      byTier[event.tierServed].cost = addDecimal(byTier[event.tierServed].cost, eventCost);
    }
  }

  const saved = subDecimal(baseline, cost);

  return {
    calls,
    costUsd: formatDecimal(cost),
    baselineUsd: formatDecimal(baseline),
    savedUsd: formatDecimal(saved),
    savedPct: formatRatio4dp(saved, baseline),
    byTier: {
      S: { calls: byTier.S.calls, costUsd: formatDecimal(byTier.S.cost) },
      M: { calls: byTier.M.calls, costUsd: formatDecimal(byTier.M.cost) },
      L: { calls: byTier.L.calls, costUsd: formatDecimal(byTier.L.cost) },
    },
  };
}

/**
 * `max(last 24h cost, 7-day daily average, ε)` (PRD 1.0 §4 T-6's own definition, reused here so
 * T-6's policy engine and the public page compute the identical number). The 7-day average
 * always divides by 7 (not by however many days actually have history) — a sparse week reads as
 * a low average, not an inflated one from a short lookback window.
 */
export async function burnDaily(
  store: Pick<LedgerStore, 'listUsageEvents'>,
  agentId: string,
  now: IsoTimestamp,
  epsilonUsdPerDay: string = DEFAULT_EPSILON_USD_PER_DAY,
): Promise<string> {
  assertUtcIso(now, 'now');
  const nowMs = new Date(now).getTime();
  const since24hMs = nowMs - DAY_MS;
  const since7dAt = new Date(nowMs - 7 * DAY_MS).toISOString();

  const events = await store.listUsageEvents(agentId, { sinceAt: since7dAt });

  let last24h: ScaledDecimal = 0n;
  let total7d: ScaledDecimal = 0n;
  for (const event of events) {
    const eventCost = parseDecimal(event.costUsd ?? '0');
    total7d = addDecimal(total7d, eventCost);
    if (new Date(event.at).getTime() >= since24hMs) {
      last24h = addDecimal(last24h, eventCost);
    }
  }

  const avg7d = divideDecimal(total7d, SEVEN_DAYS);
  const epsilon = parseDecimal(epsilonUsdPerDay);
  return formatDecimal(maxDecimal(maxDecimal(last24h, avg7d), epsilon));
}

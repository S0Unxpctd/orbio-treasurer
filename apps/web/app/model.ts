/**
 * `renderModel()` — the pure, unit-tested data→view function behind `/` and `/api/stats`
 * (S-08, docs/PRD-1.0-sprint.md §4 T-8, tasks/S-08.md). Every I/O (LedgerStore reads, `savings()`,
 * `burnDaily()`) happens in `page.tsx` / `route.ts`; this file only turns already-fetched rows
 * into display-ready strings. No `new Date()` with no argument (time — `now` — is always an
 * explicit input, same discipline as `computeSnapshotMetrics`/`savings()` in
 * `packages/core/src/ledger/metrics.ts`), and no float math on money — every money/token figure
 * here is exact `BigInt` arithmetic over the decimal strings the ledger already hands back
 * (CLAUDE.md: "Money is decimal strings: format only, never float-math it").
 *
 * Savings figures (`savings.h24`/`savings.all`) are passed straight through from S-02's
 * `savings()` with zero reformatting — this is what AC2 ("savings numbers equal S-02's
 * savings() output") means literally: the SavingsResult the caller fetched IS the view's
 * savings numbers, byte for byte. Treasury/on-chain figures, which have no such single source
 * of truth to stay byte-identical to, get an explicit display transform (2dp + thousands
 * separators) per the ticket's "In scope" bullet.
 */
import {
  type AgentRow,
  type ChainSnapshotRow,
  divideDecimal,
  formatDecimal,
  parseDecimal,
  type SavingsResult,
  subDecimal,
  type TreasuryEventRow,
  type TreasuryEventToken,
} from '@orbio-treasurer/core';

/** Verbatim footer sentence, PRD §1 / tasks/S-08.md "In scope". Exported so route/page/smoke
 *  tests can all assert against the one string, never a re-typed copy. */
export const FOOTER_SENTENCE =
  'v1: the buy-and-stake leg is funded by seed capital and capped; caller billing is not live. ' +
  'Every on-chain action above links to its transaction.';

// --- header block (S-10, docs/PRD-1.0-sprint.md §1, tasks/S-10.md "In scope") ------------------
// Static text, not derived from any I/O — kept as named constants (same convention as
// `FOOTER_SENTENCE` above) so `page.tsx`, `model.test.ts` and anything else that needs the exact
// wording share one source, never a re-typed copy.

export const PRODUCT_NAME = 'Orbio Treasurer';

/** Verbatim PRD §1 pitch line. */
export const PITCH_LINE =
  "One base_url change. Your agents' crons cost less, because we route smarter and source " +
  'inference below list on Orbio, and you can verify it on-chain.';

/** One-liner "how to use" with the `base_url` + `model: "auto"` snippet (ticket wording: "a
 *  one-line 'how to use'"). `<this-host>` is a placeholder — the page doesn't know its own
 *  public URL at render time; the README/kit show the same pattern with a real host. */
export const HOW_TO_USE_LINE =
  'Point any OpenAI-compatible client at base_url: "https://<this-host>/v1", model: "auto".';

/** Verbatim, per tasks/S-10.md "In scope". */
export const ROBINHOOD_LINE =
  'Robinhood gave agents a trading account. Orbio Treasurer gives them a treasury that pays ' +
  'for their inference, on Robinhood Chain, with public proof.';

/** Verbatim, per tasks/S-10.md "In scope". */
export const STATUS_HINT = 'Status: v1 — read the footer.';

export const NO_DATA_NOTE = 'No data yet — this agent has not run a tick.';
export const NO_PROOF_NOTE = 'No on-chain action yet.';
export const NO_AGENTS_NOTE = 'No agents yet. Build one: npx create-orbio-agent my-agent';

const EXPLORER_TX_BASE = 'https://robin.etherscan.io/tx/';

/** Zero-filled stand-in for `savings()`'s return shape, used when there is no reference agent
 *  (AC1) so the page/API never call the ledger with a missing agentId. */
export const ZERO_SAVINGS: SavingsResult = {
  calls: 0,
  costUsd: '0.000000',
  baselineUsd: '0.000000',
  savedUsd: '0.000000',
  savedPct: '0.0000',
  byTier: {
    S: { calls: 0, costUsd: '0.000000' },
    M: { calls: 0, costUsd: '0.000000' },
    L: { calls: 0, costUsd: '0.000000' },
  },
};

// --- pure decimal-string formatting helpers (BigInt only, never Number/parseFloat) -----------

function addThousandsSeparators(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Re-rounds a `numeric(18,6)`-shaped decimal string (as `parseDecimal`/`formatDecimal` from
 * `@orbio-treasurer/core` produce/consume) to `dp` (<=6) decimal places, round-half-away-from-zero,
 * with thousands separators on the integer part. Exact BigInt arithmetic throughout.
 */
function formatMoneyDp(value: string, dp: number): string {
  const scaled = parseDecimal(value); // BigInt, scaled by 1e6
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const divisor = 10n ** BigInt(6 - dp);
  const scale = 10n ** BigInt(dp);
  const quotient = abs / divisor;
  const remainder = abs % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const intPart = rounded / scale;
  const fracPart = (rounded % scale).toString().padStart(dp, '0');
  return `${negative && rounded !== 0n ? '-' : ''}${addThousandsSeparators(intPart.toString())}.${fracPart}`;
}

/** `formatMoneyDp` with a leading `$`. */
function formatUsd(value: string, dp = 2): string {
  return `$${formatMoneyDp(value, dp)}`;
}

/**
 * Formats a raw on-chain integer token amount (`numeric(30,0)`, e.g. `chain_snapshots.staked_orbio`
 * — an exact integer with `tokenDecimals` implicit decimal places, never itself a decimal string)
 * down to `dp` human decimal places with thousands separators. Exact BigInt arithmetic; the
 * ticket's "staked ORBIO (18 dp, shown with 2 decimals and thousands separators)" line, generalised
 * to every raw token amount the treasury block shows (CREDIT 6dp, USDG 6dp, ETH 18dp).
 */
function formatTokenAmount(raw: string, tokenDecimals: number, dp = 2): string {
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const big = BigInt(digits);
  const divisor = 10n ** BigInt(tokenDecimals);
  const scale = 10n ** BigInt(dp);
  const scaledNumerator = big * scale;
  const quotient = scaledNumerator / divisor;
  const remainder = scaledNumerator % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const intPart = rounded / scale;
  const fracPart = (rounded % scale).toString().padStart(dp, '0');
  return `${negative && rounded !== 0n ? '-' : ''}${addThousandsSeparators(intPart.toString())}.${fracPart}`;
}

/** A ratio decimal string (e.g. `savings().savedPct`, `0` to `1`-ish) as a `dp`-place percentage
 *  label, e.g. `"0.4231"` -> `"42.31%"`. Shifting the decimal point by two is exact BigInt
 *  multiplication (`* 100n`), not float math. */
function formatPercentLabel(ratio: string, dp = 2): string {
  const asMoney = formatDecimal(parseDecimal(ratio) * 100n);
  return `${formatMoneyDp(asMoney, dp)}%`;
}

/** `0x1234…abcd` — AC7: "addresses shown shortened; full address only inside the explorer link." */
function shortenHex(hex: string): string {
  if (hex.length <= 12) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function minutesBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.floor(ms / 60000);
}

/** e.g. "2 min ago", "1 h ago", "3 d ago", "just now". Whole-unit, never `new Date()` with no
 *  argument — both timestamps are explicit inputs. */
function ageLabel(asOf: string, now: string): string {
  const minutes = minutesBetween(asOf, now);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

const TOKEN_DECIMALS: Record<TreasuryEventToken, number> = {
  ORBIO: 18,
  CREDIT: 6,
  USDG: 6,
  ETH: 18,
};

// --- view types ----------------------------------------------------------------------------

export interface AgentSummary {
  readonly slug: string;
  readonly name: string;
  readonly repoUrl: string | null;
  readonly lastSeenAt: string | null;
}

export interface TierLine {
  readonly tier: 'S' | 'M' | 'L';
  readonly calls: number;
  readonly costUsd: string;
  readonly costUsdDisplay: string;
}

export interface SavingsView {
  readonly calls: number;
  readonly costUsd: string;
  readonly baselineUsd: string;
  readonly savedUsd: string;
  readonly savedPct: string;
  readonly costUsdDisplay: string;
  readonly baselineUsdDisplay: string;
  readonly savedUsdDisplay: string;
  readonly savedPctDisplay: string;
}

export interface QuoteView {
  readonly usdgIn: string;
  readonly creditOut: string;
  readonly discountPct: string;
}

export interface TreasuryView {
  readonly stakedOrbioDisplay: string;
  readonly creditClaimableDisplay: string;
  readonly creditWalletDisplay: string;
  readonly apiAvailableDisplay: string;
  readonly apiUsedDisplay: string;
  readonly quote: QuoteView | null;
  readonly ethGasDisplay: string;
  readonly usdgDisplay: string;
  readonly mode: string | null;
  readonly runwayDays: string | null;
  readonly runwayDisplay: string;
  readonly asOf: string;
  readonly ageDisplay: string;
}

export interface ProofRow {
  readonly id: string;
  readonly kind: string;
  readonly amountDisplay: string | null;
  readonly usdValueDisplay: string | null;
  readonly at: string;
  readonly txHash: string | null;
  readonly txShort: string | null;
  readonly explorerUrl: string | null;
  readonly dryRun: boolean;
  readonly reason: string | null;
}

export interface HeaderView {
  readonly productName: string;
  readonly pitchLine: string;
  readonly howToUse: string;
  readonly robinhoodLine: string;
  readonly statusHint: string;
}

export interface RenderModel {
  readonly header: HeaderView;
  readonly hasAgent: boolean;
  readonly agent: AgentSummary | null;
  readonly savings: {
    readonly h24: SavingsView;
    readonly all: SavingsView;
    readonly byTier: readonly TierLine[];
  };
  readonly treasury: TreasuryView | null;
  readonly events: readonly ProofRow[];
  readonly agents: readonly AgentSummary[];
  readonly generatedAt: string;
  readonly footer: string;
  readonly noDataNote: string | null;
  readonly noProofNote: string | null;
  readonly noAgentsNote: string | null;
}

export interface RenderModelInput {
  readonly now: string;
  readonly agent: AgentRow | null;
  readonly savings24h: SavingsResult;
  readonly savingsAll: SavingsResult;
  /** `burnDaily()`'s output; `null` when there's no chain snapshot to compute runway against. */
  readonly burnDailyUsd: string;
  readonly chainSnapshot: ChainSnapshotRow | null;
  /** Already limited to the last 20 by the caller (`listTreasuryEvents(agentId, 20)`). */
  readonly treasuryEvents: readonly TreasuryEventRow[];
  readonly publicAgents: readonly AgentRow[];
}

function toAgentSummary(row: AgentRow): AgentSummary {
  return { slug: row.slug, name: row.name, repoUrl: row.repoUrl, lastSeenAt: row.lastSeenAt };
}

function buildSavingsView(result: SavingsResult): SavingsView {
  return {
    calls: result.calls,
    costUsd: result.costUsd,
    baselineUsd: result.baselineUsd,
    savedUsd: result.savedUsd,
    savedPct: result.savedPct,
    costUsdDisplay: formatUsd(result.costUsd),
    baselineUsdDisplay: formatUsd(result.baselineUsd),
    savedUsdDisplay: formatUsd(result.savedUsd),
    savedPctDisplay: formatPercentLabel(result.savedPct),
  };
}

function buildTierLines(result: SavingsResult): TierLine[] {
  return (['S', 'M', 'L'] as const).map((tier) => ({
    tier,
    calls: result.byTier[tier].calls,
    costUsd: result.byTier[tier].costUsd,
    costUsdDisplay: formatUsd(result.byTier[tier].costUsd),
  }));
}

/** 10 USDG -> quote's implied CREDIT out and discount %, or `null` ("quote unavailable"). */
function buildQuote(quoteCreditPerUsdg: string | null): QuoteView | null {
  if (quoteCreditPerUsdg === null) return null;
  const usdgIn = '10.000000';
  const creditOutScaled = parseDecimal(quoteCreditPerUsdg) * 10n; // rate * 10 USDG, still 1e6-scaled
  const creditOut = formatDecimal(creditOutScaled);
  // discount % = (creditOut - usdgIn) / creditOut * 100 — both operands already 1e6-scaled.
  const usdgInScaled = parseDecimal(usdgIn);
  const diff = subDecimal(creditOutScaled, usdgInScaled);
  const discountRatio =
    creditOutScaled === 0n ? '0' : formatDecimal(divideDecimal(diff, creditOutScaled));
  return {
    usdgIn: formatMoneyDp(usdgIn, 2),
    creditOut: formatMoneyDp(creditOut, 2),
    discountPct: formatPercentLabel(discountRatio, 1),
  };
}

function buildTreasury(
  snapshot: ChainSnapshotRow | null,
  burnDailyUsd: string,
  now: string,
): TreasuryView | null {
  if (!snapshot) return null;

  const available = snapshot.creditApiAvailable ?? '0';
  const burn = parseDecimal(burnDailyUsd); // burnDaily() already floors at epsilon — always > 0
  const runwayDays =
    burn <= 0n ? null : formatDecimal(divideDecimal(parseDecimal(available), burn));

  return {
    stakedOrbioDisplay: formatTokenAmount(snapshot.stakedOrbio ?? '0', TOKEN_DECIMALS.ORBIO),
    creditClaimableDisplay: formatTokenAmount(snapshot.settledCredit ?? '0', TOKEN_DECIMALS.CREDIT),
    creditWalletDisplay: formatTokenAmount(snapshot.creditWallet ?? '0', TOKEN_DECIMALS.CREDIT),
    apiAvailableDisplay: formatUsd(snapshot.creditApiAvailable ?? '0'),
    apiUsedDisplay: formatUsd(snapshot.creditApiUsed ?? '0'),
    quote: buildQuote(snapshot.quoteCreditPerUsdg),
    ethGasDisplay: formatTokenAmount(snapshot.ethBalance ?? '0', TOKEN_DECIMALS.ETH, 6),
    usdgDisplay: formatTokenAmount(snapshot.usdgBalance ?? '0', TOKEN_DECIMALS.USDG),
    mode: snapshot.mode,
    runwayDays,
    runwayDisplay: runwayDays === null ? '∞' : `${formatMoneyDp(runwayDays, 1)} d`,
    asOf: snapshot.asOf,
    ageDisplay: ageLabel(snapshot.asOf, now),
  };
}

function readReason(meta: unknown): string | null {
  if (meta && typeof meta === 'object' && 'reason' in meta) {
    const reason = (meta as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : null;
  }
  return null;
}

function buildProofRow(event: TreasuryEventRow): ProofRow {
  const dryRun = event.kind === 'dry_run';
  const amountDisplay =
    event.amount !== null && event.token !== null
      ? `${formatTokenAmount(event.amount, TOKEN_DECIMALS[event.token])} ${event.token}`
      : null;
  return {
    id: event.id,
    kind: event.kind,
    amountDisplay,
    usdValueDisplay: event.usdValue !== null ? formatUsd(event.usdValue) : null,
    at: event.at,
    txHash: event.txHash,
    txShort: event.txHash ? shortenHex(event.txHash) : null,
    explorerUrl: event.txHash ? `${EXPLORER_TX_BASE}${event.txHash}` : null,
    dryRun,
    reason: dryRun ? readReason(event.meta) : null,
  };
}

/** Pure: same `input` always produces the same `RenderModel` (AC1/AC2/AC5's unit-tested view
 *  model). All I/O — the ledger reads and `savings()`/`burnDaily()` calls that produce `input` —
 *  happens in the caller. */
export function renderModel(input: RenderModelInput): RenderModel {
  const hasAgent = input.agent !== null;
  return {
    header: {
      productName: PRODUCT_NAME,
      pitchLine: PITCH_LINE,
      howToUse: HOW_TO_USE_LINE,
      robinhoodLine: ROBINHOOD_LINE,
      statusHint: STATUS_HINT,
    },
    hasAgent,
    agent: input.agent ? toAgentSummary(input.agent) : null,
    savings: {
      h24: buildSavingsView(input.savings24h),
      all: buildSavingsView(input.savingsAll),
      byTier: buildTierLines(input.savingsAll),
    },
    treasury: buildTreasury(input.chainSnapshot, input.burnDailyUsd, input.now),
    events: input.treasuryEvents.map(buildProofRow),
    agents: input.publicAgents.map(toAgentSummary),
    generatedAt: input.now,
    footer: FOOTER_SENTENCE,
    noDataNote: hasAgent ? null : NO_DATA_NOTE,
    noProofNote: input.treasuryEvents.length === 0 ? NO_PROOF_NOTE : null,
    noAgentsNote: input.publicAgents.length === 0 ? NO_AGENTS_NOTE : null,
  };
}

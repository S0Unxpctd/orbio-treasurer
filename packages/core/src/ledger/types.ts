/**
 * LedgerStore — the interface behind which SqliteLedgerStore (kit default) and
 * PostgresLedgerStore (hosted reference + landing) sit (T-011, ADR-002, ARCHITECTURE.md §4).
 *
 * Row shapes here are hand-kept in sync with `ledger/schema.ts` (PRD §9) the same way
 * `gen-sql.ts` keeps the two SQL dialects in sync with it — `schema.ts` is still the single
 * source of truth for column names, types and constraints; this file is its TypeScript mirror
 * for the repository layer.
 *
 * FR-1.1: the ledger is append-only except two guarded mutations — `agents`' display fields and
 * `orders`' fill fields. That is reflected directly in the method list below: every table gets
 * an `insertX`, and only `agents` and `orders` also get an `updateX` (typed to exactly the
 * mutable columns FR-1.1 names — a call site cannot even attempt to change an immutable column,
 * let alone need the SQL trigger to stop it). `key_meta` revocation is modelled as a new
 * `insertKeyMeta` row carrying `revokedAt`, never an update, per FR-1.1 and schema.ts.
 *
 * Money and on-chain token-amount fields are decimal strings end to end (never `number`) — see
 * `decimal.ts`. Timestamps are UTC ISO-8601 strings (`.../as_of`, `.../at`, `.../placedAt`, ...);
 * both store implementations reject a non-UTC timestamp at the boundary (see `assertUtcIso` in
 * each store) rather than silently reinterpreting it.
 */

export type Id = string;
/** UTC ISO-8601, e.g. "2026-09-09T12:00:00.000Z". */
export type IsoTimestamp = string;
/** Decimal string, numeric(18,6) — money, rates, ratios, percentages, day counts. */
export type Money = string;
/** Decimal string, numeric(30,0) — large on-chain integer token amounts. */
export type TokenAmount = string;

export type AgentMode = 'dry_run' | 'live';
export type BalanceSource = 'mcp' | 'gateway' | 'estimate';
export type BookSnapshotSource = 'api' | 'page';
export type OrderSide = 'buy' | 'stake';

// --- agents ---------------------------------------------------------------------------------

export interface NewAgent {
  readonly slug: string;
  readonly name: string;
  readonly walletAddress?: string | null;
  /** Defaults to 'robinhood', matching schema.ts's column default. */
  readonly chain?: string;
  readonly repoUrl?: string | null;
  readonly xHandle?: string | null;
  readonly template?: string | null;
  readonly policy?: unknown;
  readonly mode: AgentMode;
  readonly agentTokenHash?: string | null;
  /** Defaults to true, matching schema.ts's column default. */
  readonly public?: boolean;
  readonly lastSeenAt?: IsoTimestamp | null;
}

export interface AgentRow {
  readonly id: Id;
  readonly slug: string;
  readonly name: string;
  readonly walletAddress: string | null;
  readonly chain: string;
  readonly repoUrl: string | null;
  readonly xHandle: string | null;
  readonly template: string | null;
  readonly policy: unknown;
  readonly mode: AgentMode;
  readonly agentTokenHash: string | null;
  readonly public: boolean;
  readonly lastSeenAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
}

/** FR-1.1's exact update allow-list for `agents`. */
export interface AgentMutablePatch {
  readonly name?: string;
  readonly repoUrl?: string | null;
  readonly xHandle?: string | null;
  readonly template?: string | null;
  readonly lastSeenAt?: IsoTimestamp | null;
}

// --- key_meta ---------------------------------------------------------------------------------

export interface NewKeyMeta {
  readonly agentId: Id;
  readonly keyPrefix: string;
  readonly keyLast4: string;
  /** Set only on the row that records a revocation — never applied via update (FR-1.1). */
  readonly revokedAt?: IsoTimestamp | null;
  readonly reason?: string | null;
}

export interface KeyMetaRow {
  readonly id: Id;
  readonly agentId: Id;
  readonly keyPrefix: string;
  readonly keyLast4: string;
  readonly revokedAt: IsoTimestamp | null;
  readonly reason: string | null;
  readonly createdAt: IsoTimestamp;
}

// --- treasury_snapshots -----------------------------------------------------------------------

export interface NewTreasurySnapshot {
  readonly agentId: Id;
  readonly asOf: IsoTimestamp;
  readonly creditsAvailable?: Money | null;
  readonly creditsAccruedDelta?: Money | null;
  readonly keySpentTotal?: Money | null;
  readonly keyRemaining?: Money | null;
  readonly orbioBalanceTokens?: TokenAmount | null;
  readonly orbioPriceUsd?: Money | null;
  readonly accrualRatePerDay?: Money | null;
  readonly burnRatePerDay?: Money | null;
  /** Defaults to false, matching schema.ts's column default. */
  readonly burnLowConfidence?: boolean;
  /** null = infinite runway (accrual >= burn), per FR-1.3. */
  readonly runwayDays?: Money | null;
  readonly coverageRatio?: Money | null;
  readonly state: string;
  readonly reconciliationDelta?: Money | null;
  readonly balanceSource: BalanceSource;
  readonly stableBalanceUsd?: Money | null;
  readonly yieldPerTokenPerDay?: Money | null;
  /** Defaults to false, matching schema.ts's column default. */
  readonly yieldLowConfidence?: boolean;
}

export interface TreasurySnapshotRow {
  readonly id: Id;
  readonly agentId: Id;
  readonly asOf: IsoTimestamp;
  readonly creditsAvailable: Money | null;
  readonly creditsAccruedDelta: Money | null;
  readonly keySpentTotal: Money | null;
  readonly keyRemaining: Money | null;
  readonly orbioBalanceTokens: TokenAmount | null;
  readonly orbioPriceUsd: Money | null;
  readonly accrualRatePerDay: Money | null;
  readonly burnRatePerDay: Money | null;
  readonly burnLowConfidence: boolean;
  readonly runwayDays: Money | null;
  readonly coverageRatio: Money | null;
  readonly state: string;
  readonly reconciliationDelta: Money | null;
  readonly balanceSource: BalanceSource;
  readonly stableBalanceUsd: Money | null;
  readonly yieldPerTokenPerDay: Money | null;
  readonly yieldLowConfidence: boolean;
  readonly createdAt: IsoTimestamp;
}

// --- usage_events -----------------------------------------------------------------------------

export interface NewUsageEvent {
  readonly agentId: Id;
  readonly at: IsoTimestamp;
  readonly model: string;
  readonly tierRequested?: string | null;
  readonly tierServed?: string | null;
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly costUsd?: Money | null;
  readonly latencyMs?: number | null;
  readonly status: string;
  readonly error?: string | null;
}

export interface UsageEventRow {
  readonly id: Id;
  readonly agentId: Id;
  readonly at: IsoTimestamp;
  readonly model: string;
  readonly tierRequested: string | null;
  readonly tierServed: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: Money | null;
  readonly latencyMs: number | null;
  readonly status: string;
  readonly error: string | null;
  readonly createdAt: IsoTimestamp;
}

// --- decisions --------------------------------------------------------------------------------

export interface NewDecision {
  readonly agentId: Id;
  readonly at: IsoTimestamp;
  readonly type: string;
  readonly ruleId?: string | null;
  readonly stateBefore?: string | null;
  readonly stateAfter?: string | null;
  readonly inputs?: unknown;
  readonly action?: unknown;
  /** Defaults to false, matching schema.ts's column default. */
  readonly executed?: boolean;
  readonly result?: unknown;
  readonly human?: string | null;
  /** Defaults to true, matching schema.ts's column default. */
  readonly public?: boolean;
}

export interface DecisionRow {
  readonly id: Id;
  readonly agentId: Id;
  readonly at: IsoTimestamp;
  readonly type: string;
  readonly ruleId: string | null;
  readonly stateBefore: string | null;
  readonly stateAfter: string | null;
  readonly inputs: unknown;
  readonly action: unknown;
  readonly executed: boolean;
  readonly result: unknown;
  readonly human: string | null;
  readonly public: boolean;
  readonly createdAt: IsoTimestamp;
}

// --- book_snapshots ---------------------------------------------------------------------------

export interface NewBookSnapshot {
  readonly at: IsoTimestamp;
  readonly source: BookSnapshotSource;
  readonly view?: unknown;
  readonly totalAvailableUsd?: Money | null;
  readonly bestDiscountPct?: Money | null;
}

export interface BookSnapshotRow {
  readonly id: Id;
  readonly at: IsoTimestamp;
  readonly source: BookSnapshotSource;
  readonly view: unknown;
  readonly totalAvailableUsd: Money | null;
  readonly bestDiscountPct: Money | null;
  readonly createdAt: IsoTimestamp;
}

// --- orders -------------------------------------------------------------------------------------

export interface NewOrder {
  readonly agentId: Id;
  readonly decisionId: Id;
  readonly side: OrderSide;
  readonly model?: string | null;
  readonly usd: Money;
  readonly discountPct?: Money | null;
  readonly externalId?: string | null;
  readonly status: string;
  readonly filledUsd?: Money | null;
  readonly feeUsd?: Money | null;
  readonly orbioOut?: TokenAmount | null;
  readonly priceImpactPct?: Money | null;
  readonly placedAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp | null;
}

export interface OrderRow {
  readonly id: Id;
  readonly agentId: Id;
  readonly decisionId: Id;
  readonly side: OrderSide;
  readonly model: string | null;
  readonly usd: Money;
  readonly discountPct: Money | null;
  readonly externalId: string | null;
  readonly status: string;
  readonly filledUsd: Money | null;
  readonly feeUsd: Money | null;
  readonly orbioOut: TokenAmount | null;
  readonly priceImpactPct: Money | null;
  readonly placedAt: IsoTimestamp;
  readonly resolvedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
}

/** FR-1.1's exact update allow-list for `orders`. */
export interface OrderFillPatch {
  readonly status?: string;
  readonly filledUsd?: Money | null;
  readonly feeUsd?: Money | null;
  readonly resolvedAt?: IsoTimestamp | null;
  readonly externalId?: string | null;
}

// --- the interface ------------------------------------------------------------------------------

export class NotFoundError extends Error {
  constructor(table: string, id: Id) {
    super(`${table} row not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export interface LedgerStore {
  readonly dialect: 'sqlite' | 'postgres';

  insertAgent(row: NewAgent): Promise<AgentRow>;
  getAgent(id: Id): Promise<AgentRow | null>;
  getAgentBySlug(slug: string): Promise<AgentRow | null>;
  /** Throws NotFoundError if `id` doesn't exist. Rejects an empty patch. */
  updateAgent(id: Id, patch: AgentMutablePatch): Promise<AgentRow>;

  insertKeyMeta(row: NewKeyMeta): Promise<KeyMetaRow>;

  insertTreasurySnapshot(row: NewTreasurySnapshot): Promise<TreasurySnapshotRow>;
  latestTreasurySnapshot(agentId: Id): Promise<TreasurySnapshotRow | null>;

  insertUsageEvent(row: NewUsageEvent): Promise<UsageEventRow>;

  insertDecision(row: NewDecision): Promise<DecisionRow>;

  insertBookSnapshot(row: NewBookSnapshot): Promise<BookSnapshotRow>;

  insertOrder(row: NewOrder): Promise<OrderRow>;
  getOrder(id: Id): Promise<OrderRow | null>;
  /** Throws NotFoundError if `id` doesn't exist. Rejects an empty patch. */
  updateOrderFill(id: Id, patch: OrderFillPatch): Promise<OrderRow>;

  /** Releases the underlying connection/handle. Safe to call more than once. */
  close(): Promise<void>;
}

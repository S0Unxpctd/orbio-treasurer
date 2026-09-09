/**
 * PostgresLedgerStore — the hosted-reference/landing LedgerStore implementation (T-011,
 * ADR-002, ADR-005).
 *
 * Unlike SqliteLedgerStore, this store does NOT apply the schema itself — the Postgres schema
 * lives in `supabase/migrations/` and is applied by `pnpm db:migrate` (Supabase's own tooling
 * / `pnpm --filter @orbio-treasurer/core gen:sql` regenerates it from schema.ts). This store
 * only ever assumes that schema already exists, same as any other application connecting to an
 * already-migrated database.
 *
 * `openPostgresLedger` takes a bare Postgres connection string (whatever `DATABASE_URL` or a
 * Supabase pooled connection string resolves to) — turning `SUPABASE_URL` +
 * `SUPABASE_SERVICE_ROLE_KEY` into one is env-wiring, out of scope here (see tasks/T-011.md
 * Discovered).
 *
 * Timestamps: postgres.js's own type parsing for `timestamptz`/`timestamp` can hand back either
 * a JS `Date` or (depending on version/config) an already-ISO string — this store does not lean
 * on either behaviour. Every row mapper below normalizes explicitly with `toIso`/`toIsoOrNull`
 * so the LedgerStore contract (`IsoTimestamp = string`, UTC, ending in "Z") holds regardless.
 * Money/token-amount (`numeric`) columns are returned by postgres.js as decimal strings by
 * default (ADR-005) — never coerced through a JS `number`, so no float ever touches them.
 *
 * jsonb columns (`agents.policy`, `decisions.inputs`/`action`/`result`, `book_snapshots.view`):
 * postgres.js does not parse these into JS values by default — it hands back the raw JSON text
 * (confirmed against a real Postgres cluster, audit pass 1 / T-011.md). `fromJsonb` below parses
 * explicitly (tolerating an already-parsed value too, in case that ever changes upstream) so
 * this store's `unknown` return shape actually matches SqliteLedgerStore's, not a JSON string.
 */
import postgres from 'postgres';
import { normalizeMoney, normalizeTokenAmount } from '../decimal.js';
import type {
  AgentMutablePatch,
  AgentRow,
  BookSnapshotRow,
  DecisionRow,
  Id,
  KeyMetaRow,
  LedgerStore,
  NewAgent,
  NewBookSnapshot,
  NewDecision,
  NewKeyMeta,
  NewOrder,
  NewTreasurySnapshot,
  NewUsageEvent,
  OrderFillPatch,
  OrderRow,
  TreasurySnapshotRow,
  UsageEventRow,
} from '../types.js';
import { NotFoundError } from '../types.js';
import { assertUtcIso, newId } from '../util.js';

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}
function toJsonbLiteral(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
/** Parses a jsonb column's value back into the JS value it was stored from. See file header. */
function fromJsonb(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

// --- row mappers: raw postgres.js rows -> LedgerStore rows ---

function mapAgentRow(r: Row): AgentRow {
  return {
    id: r.id as Id,
    slug: r.slug as string,
    name: r.name as string,
    walletAddress: (r.wallet_address as string | null) ?? null,
    chain: r.chain as string,
    repoUrl: (r.repo_url as string | null) ?? null,
    xHandle: (r.x_handle as string | null) ?? null,
    template: (r.template as string | null) ?? null,
    policy: fromJsonb(r.policy),
    mode: r.mode as AgentRow['mode'],
    agentTokenHash: (r.agent_token_hash as string | null) ?? null,
    public: r.public as boolean,
    lastSeenAt: toIsoOrNull(r.last_seen_at),
    createdAt: toIso(r.created_at),
  };
}

function mapKeyMetaRow(r: Row): KeyMetaRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    keyPrefix: r.key_prefix as string,
    keyLast4: r.key_last4 as string,
    revokedAt: toIsoOrNull(r.revoked_at),
    reason: (r.reason as string | null) ?? null,
    createdAt: toIso(r.created_at),
  };
}

function mapTreasurySnapshotRow(r: Row): TreasurySnapshotRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    asOf: toIso(r.as_of),
    creditsAvailable: (r.credits_available as string | null) ?? null,
    creditsAccruedDelta: (r.credits_accrued_delta as string | null) ?? null,
    keySpentTotal: (r.key_spent_total as string | null) ?? null,
    keyRemaining: (r.key_remaining as string | null) ?? null,
    orbioBalanceTokens: (r.orbio_balance_tokens as string | null) ?? null,
    orbioPriceUsd: (r.orbio_price_usd as string | null) ?? null,
    accrualRatePerDay: (r.accrual_rate_per_day as string | null) ?? null,
    burnRatePerDay: (r.burn_rate_per_day as string | null) ?? null,
    burnLowConfidence: r.burn_low_confidence as boolean,
    runwayDays: (r.runway_days as string | null) ?? null,
    coverageRatio: (r.coverage_ratio as string | null) ?? null,
    state: r.state as string,
    reconciliationDelta: (r.reconciliation_delta as string | null) ?? null,
    balanceSource: r.balance_source as TreasurySnapshotRow['balanceSource'],
    stableBalanceUsd: (r.stable_balance_usd as string | null) ?? null,
    yieldPerTokenPerDay: (r.yield_per_token_per_day as string | null) ?? null,
    yieldLowConfidence: r.yield_low_confidence as boolean,
    createdAt: toIso(r.created_at),
  };
}

function mapUsageEventRow(r: Row): UsageEventRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    at: toIso(r.at),
    model: r.model as string,
    tierRequested: (r.tier_requested as string | null) ?? null,
    tierServed: (r.tier_served as string | null) ?? null,
    promptTokens: (r.prompt_tokens as number | null) ?? null,
    completionTokens: (r.completion_tokens as number | null) ?? null,
    costUsd: (r.cost_usd as string | null) ?? null,
    latencyMs: (r.latency_ms as number | null) ?? null,
    status: r.status as string,
    error: (r.error as string | null) ?? null,
    createdAt: toIso(r.created_at),
  };
}

function mapDecisionRow(r: Row): DecisionRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    at: toIso(r.at),
    type: r.type as string,
    ruleId: (r.rule_id as string | null) ?? null,
    stateBefore: (r.state_before as string | null) ?? null,
    stateAfter: (r.state_after as string | null) ?? null,
    inputs: fromJsonb(r.inputs),
    action: fromJsonb(r.action),
    executed: r.executed as boolean,
    result: fromJsonb(r.result),
    human: (r.human as string | null) ?? null,
    public: r.public as boolean,
    createdAt: toIso(r.created_at),
  };
}

function mapBookSnapshotRow(r: Row): BookSnapshotRow {
  return {
    id: r.id as Id,
    at: toIso(r.at),
    source: r.source as BookSnapshotRow['source'],
    view: fromJsonb(r.view),
    totalAvailableUsd: (r.total_available_usd as string | null) ?? null,
    bestDiscountPct: (r.best_discount_pct as string | null) ?? null,
    createdAt: toIso(r.created_at),
  };
}

function mapOrderRow(r: Row): OrderRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    decisionId: r.decision_id as Id,
    side: r.side as OrderRow['side'],
    model: (r.model as string | null) ?? null,
    usd: r.usd as string,
    discountPct: (r.discount_pct as string | null) ?? null,
    externalId: (r.external_id as string | null) ?? null,
    status: r.status as string,
    filledUsd: (r.filled_usd as string | null) ?? null,
    feeUsd: (r.fee_usd as string | null) ?? null,
    orbioOut: (r.orbio_out as string | null) ?? null,
    priceImpactPct: (r.price_impact_pct as string | null) ?? null,
    placedAt: toIso(r.placed_at),
    resolvedAt: toIsoOrNull(r.resolved_at),
    createdAt: toIso(r.created_at),
  };
}

export class PostgresLedgerStore implements LedgerStore {
  readonly dialect = 'postgres' as const;

  constructor(private readonly sql: Sql) {}

  /** Builds `update <table> set col = $2, ... where id = $1 returning *` for a sparse patch. */
  private async updateRow(table: string, id: Id, columns: Row): Promise<Row | undefined> {
    const keys = Object.keys(columns);
    if (keys.length === 0) {
      throw new Error(`update ${table}: patch must set at least one field`);
    }
    const setClauses = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = keys.map((key) => columns[key]);
    const rows = await this.sql.unsafe(
      `update ${table} set ${setClauses} where id = $1 returning *`,
      [id, ...values] as Parameters<Sql['unsafe']>[1],
    );
    return rows[0] as Row | undefined;
  }

  // --- agents ---

  async insertAgent(row: NewAgent): Promise<AgentRow> {
    if (row.lastSeenAt !== undefined && row.lastSeenAt !== null) {
      assertUtcIso(row.lastSeenAt, 'lastSeenAt');
    }
    const id = newId();
    const rows = await this.sql`
      insert into agents
        (id, slug, name, wallet_address, chain, repo_url, x_handle, template, policy, mode,
         agent_token_hash, public, last_seen_at)
      values
        (${id}, ${row.slug}, ${row.name}, ${row.walletAddress ?? null}, ${row.chain ?? 'robinhood'},
         ${row.repoUrl ?? null}, ${row.xHandle ?? null}, ${row.template ?? null},
         ${toJsonbLiteral(row.policy)}::jsonb, ${row.mode}, ${row.agentTokenHash ?? null},
         ${row.public ?? true}, ${row.lastSeenAt ?? null})
      returning *
    `;
    return mapAgentRow(rows[0] as Row);
  }

  async getAgent(id: Id): Promise<AgentRow | null> {
    const rows = await this.sql`select * from agents where id = ${id}`;
    return rows[0] ? mapAgentRow(rows[0] as Row) : null;
  }

  async getAgentBySlug(slug: string): Promise<AgentRow | null> {
    const rows = await this.sql`select * from agents where slug = ${slug}`;
    return rows[0] ? mapAgentRow(rows[0] as Row) : null;
  }

  async updateAgent(id: Id, patch: AgentMutablePatch): Promise<AgentRow> {
    const columns: Row = {};
    if (patch.name !== undefined) columns.name = patch.name;
    if (patch.repoUrl !== undefined) columns.repo_url = patch.repoUrl;
    if (patch.xHandle !== undefined) columns.x_handle = patch.xHandle;
    if (patch.template !== undefined) columns.template = patch.template;
    if (patch.lastSeenAt !== undefined) {
      if (patch.lastSeenAt !== null) assertUtcIso(patch.lastSeenAt, 'lastSeenAt');
      columns.last_seen_at = patch.lastSeenAt;
    }
    const dbRow = await this.updateRow('agents', id, columns);
    if (!dbRow) throw new NotFoundError('agents', id);
    return mapAgentRow(dbRow);
  }

  // --- key_meta ---

  async insertKeyMeta(row: NewKeyMeta): Promise<KeyMetaRow> {
    if (row.revokedAt !== undefined && row.revokedAt !== null) {
      assertUtcIso(row.revokedAt, 'revokedAt');
    }
    const id = newId();
    const rows = await this.sql`
      insert into key_meta (id, agent_id, key_prefix, key_last4, revoked_at, reason)
      values (${id}, ${row.agentId}, ${row.keyPrefix}, ${row.keyLast4}, ${row.revokedAt ?? null},
              ${row.reason ?? null})
      returning *
    `;
    return mapKeyMetaRow(rows[0] as Row);
  }

  // --- treasury_snapshots ---

  async insertTreasurySnapshot(row: NewTreasurySnapshot): Promise<TreasurySnapshotRow> {
    assertUtcIso(row.asOf, 'asOf');
    const id = newId();
    const rows = await this.sql`
      insert into treasury_snapshots
        (id, agent_id, as_of, credits_available, credits_accrued_delta, key_spent_total,
         key_remaining, orbio_balance_tokens, orbio_price_usd, accrual_rate_per_day,
         burn_rate_per_day, burn_low_confidence, runway_days, coverage_ratio, state,
         reconciliation_delta, balance_source, stable_balance_usd, yield_per_token_per_day,
         yield_low_confidence)
      values
        (${id}, ${row.agentId}, ${row.asOf}, ${normalizeMoney(row.creditsAvailable)},
         ${normalizeMoney(row.creditsAccruedDelta)}, ${normalizeMoney(row.keySpentTotal)},
         ${normalizeMoney(row.keyRemaining)}, ${normalizeTokenAmount(row.orbioBalanceTokens)},
         ${normalizeMoney(row.orbioPriceUsd)}, ${normalizeMoney(row.accrualRatePerDay)},
         ${normalizeMoney(row.burnRatePerDay)}, ${row.burnLowConfidence ?? false},
         ${normalizeMoney(row.runwayDays)}, ${normalizeMoney(row.coverageRatio)}, ${row.state},
         ${normalizeMoney(row.reconciliationDelta)}, ${row.balanceSource},
         ${normalizeMoney(row.stableBalanceUsd)}, ${normalizeMoney(row.yieldPerTokenPerDay)},
         ${row.yieldLowConfidence ?? false})
      returning *
    `;
    return mapTreasurySnapshotRow(rows[0] as Row);
  }

  async latestTreasurySnapshot(agentId: Id): Promise<TreasurySnapshotRow | null> {
    const rows = await this.sql`
      select * from treasury_snapshots where agent_id = ${agentId} order by as_of desc limit 1
    `;
    return rows[0] ? mapTreasurySnapshotRow(rows[0] as Row) : null;
  }

  // --- usage_events ---

  async insertUsageEvent(row: NewUsageEvent): Promise<UsageEventRow> {
    assertUtcIso(row.at, 'at');
    const id = newId();
    const rows = await this.sql`
      insert into usage_events
        (id, agent_id, at, model, tier_requested, tier_served, prompt_tokens, completion_tokens,
         cost_usd, latency_ms, status, error)
      values
        (${id}, ${row.agentId}, ${row.at}, ${row.model}, ${row.tierRequested ?? null},
         ${row.tierServed ?? null}, ${row.promptTokens ?? null}, ${row.completionTokens ?? null},
         ${normalizeMoney(row.costUsd)}, ${row.latencyMs ?? null}, ${row.status},
         ${row.error ?? null})
      returning *
    `;
    return mapUsageEventRow(rows[0] as Row);
  }

  // --- decisions ---

  async insertDecision(row: NewDecision): Promise<DecisionRow> {
    assertUtcIso(row.at, 'at');
    const id = newId();
    const rows = await this.sql`
      insert into decisions
        (id, agent_id, at, type, rule_id, state_before, state_after, inputs, action, executed,
         result, human, public)
      values
        (${id}, ${row.agentId}, ${row.at}, ${row.type}, ${row.ruleId ?? null},
         ${row.stateBefore ?? null}, ${row.stateAfter ?? null}, ${toJsonbLiteral(row.inputs)}::jsonb,
         ${toJsonbLiteral(row.action)}::jsonb, ${row.executed ?? false},
         ${toJsonbLiteral(row.result)}::jsonb, ${row.human ?? null}, ${row.public ?? true})
      returning *
    `;
    return mapDecisionRow(rows[0] as Row);
  }

  // --- book_snapshots ---

  async insertBookSnapshot(row: NewBookSnapshot): Promise<BookSnapshotRow> {
    assertUtcIso(row.at, 'at');
    const id = newId();
    const rows = await this.sql`
      insert into book_snapshots (id, at, source, view, total_available_usd, best_discount_pct)
      values (${id}, ${row.at}, ${row.source}, ${toJsonbLiteral(row.view)}::jsonb,
              ${normalizeMoney(row.totalAvailableUsd)}, ${normalizeMoney(row.bestDiscountPct)})
      returning *
    `;
    return mapBookSnapshotRow(rows[0] as Row);
  }

  // --- orders ---

  async insertOrder(row: NewOrder): Promise<OrderRow> {
    assertUtcIso(row.placedAt, 'placedAt');
    if (row.resolvedAt !== undefined && row.resolvedAt !== null) {
      assertUtcIso(row.resolvedAt, 'resolvedAt');
    }
    const id = newId();
    const rows = await this.sql`
      insert into orders
        (id, agent_id, decision_id, side, model, usd, discount_pct, external_id, status,
         filled_usd, fee_usd, orbio_out, price_impact_pct, placed_at, resolved_at)
      values
        (${id}, ${row.agentId}, ${row.decisionId}, ${row.side}, ${row.model ?? null},
         ${normalizeMoney(row.usd)}, ${normalizeMoney(row.discountPct)}, ${row.externalId ?? null},
         ${row.status}, ${normalizeMoney(row.filledUsd)}, ${normalizeMoney(row.feeUsd)},
         ${normalizeTokenAmount(row.orbioOut)}, ${normalizeMoney(row.priceImpactPct)},
         ${row.placedAt}, ${row.resolvedAt ?? null})
      returning *
    `;
    return mapOrderRow(rows[0] as Row);
  }

  async getOrder(id: Id): Promise<OrderRow | null> {
    const rows = await this.sql`select * from orders where id = ${id}`;
    return rows[0] ? mapOrderRow(rows[0] as Row) : null;
  }

  async updateOrderFill(id: Id, patch: OrderFillPatch): Promise<OrderRow> {
    const columns: Row = {};
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.filledUsd !== undefined) columns.filled_usd = normalizeMoney(patch.filledUsd);
    if (patch.feeUsd !== undefined) columns.fee_usd = normalizeMoney(patch.feeUsd);
    if (patch.resolvedAt !== undefined) {
      if (patch.resolvedAt !== null) assertUtcIso(patch.resolvedAt, 'resolvedAt');
      columns.resolved_at = patch.resolvedAt;
    }
    if (patch.externalId !== undefined) columns.external_id = patch.externalId;
    const dbRow = await this.updateRow('orders', id, columns);
    if (!dbRow) throw new NotFoundError('orders', id);
    return mapOrderRow(dbRow);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

/**
 * Opens a Postgres ledger store against an already-migrated database (see file header). Does
 * not itself apply supabase/migrations/*.sql — that's `pnpm db:migrate`'s job. `postgres(...)`
 * is a synchronous factory — it doesn't connect until the first query — so this performs no
 * network I/O itself and needs no env var read; nothing under `packages/core`/`create-orbio-agent`
 * calls it unless `LEDGER=postgres` (CLAUDE.md #5c).
 */
export function openPostgresLedger(connectionString: string): LedgerStore {
  return new PostgresLedgerStore(postgres(connectionString));
}

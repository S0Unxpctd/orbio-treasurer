/**
 * SqliteLedgerStore — the kit-default LedgerStore implementation (T-011, ADR-002, ADR-005).
 *
 * Zero provisioning (FR-7.1): `openSqliteLedger(path)` creates the parent directory and the
 * database file if they don't exist, turns on `PRAGMA foreign_keys` (per-connection — the
 * comment at the top of sqlite/schema.sql calls this out as the repository's job), and applies
 * schema.sql (every statement is `IF NOT EXISTS`, so this is safe to do on every open, including
 * against an existing file with data in it).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { normalizeMoney, normalizeTokenAmount } from '../decimal.js';
import type {
  AgentMutablePatch,
  AgentRow,
  BookSnapshotRow,
  CallerKeyRow,
  ChainSnapshotRow,
  DecisionRow,
  Id,
  IsoTimestamp,
  KeyMetaRow,
  LedgerStore,
  NewAgent,
  NewBookSnapshot,
  NewCallerKey,
  NewChainSnapshot,
  NewDecision,
  NewKeyMeta,
  NewOrder,
  NewTreasuryEvent,
  NewTreasurySnapshot,
  NewUsageEvent,
  OrderFillPatch,
  OrderRow,
  TreasuryEventRow,
  TreasurySnapshotRow,
  UsageEventRow,
} from '../types.js';
import { CallerKeyAlreadyRevokedError, NotFoundError } from '../types.js';
import { assertTxHash, assertUtcIso, newId } from '../util.js';

// Discovered (tasks/S-08.md AC6): plain `readFileSync(new URL('./schema.sql', import.meta.url))`
// works under Node/tsx/Vitest but breaks when this module is bundled into Next.js's webpack
// server build (apps/web is the first ticket to load SqliteLedgerStore from inside the Next
// app) two ways in a row: (1) the URL instance webpack's `import.meta.url` produces fails
// Node's internal `instanceof URL` check inside both `fs` and `node:url`'s `fileURLToPath`, and
// (2) webpack specifically pattern-matches the literal `new URL('...', import.meta.url)` call
// shape as a static-asset import and rewrites it to an emitted `/_next/static/...` URL instead
// of a real file path. Routing `import.meta.url` through a variable first defeats webpack's
// syntactic pattern match (so this stays a plain runtime URL resolution, not an asset import),
// and reading `.pathname` off the result avoids the `instanceof URL` check entirely — plain
// string in, plain string out (POSIX paths only, matching ARCHITECTURE.md's Linux/macOS target).
const here = import.meta.url;
const SCHEMA_SQL = readFileSync(decodeURIComponent(new URL('./schema.sql', here).pathname), 'utf8');

function toBoolInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
function fromBoolInt(value: number): boolean {
  return value === 1;
}
function toJsonText(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
function fromJsonText(value: unknown): unknown {
  return value === null || value === undefined ? null : JSON.parse(value as string);
}

// --- row mappers: raw better-sqlite3 rows (snake_case, 0/1 booleans, JSON-as-text) -> LedgerStore rows ---

function mapAgentRow(r: Record<string, unknown>): AgentRow {
  return {
    id: r.id as Id,
    slug: r.slug as string,
    name: r.name as string,
    walletAddress: (r.wallet_address as string | null) ?? null,
    chain: r.chain as string,
    repoUrl: (r.repo_url as string | null) ?? null,
    xHandle: (r.x_handle as string | null) ?? null,
    template: (r.template as string | null) ?? null,
    policy: fromJsonText(r.policy),
    mode: r.mode as AgentRow['mode'],
    agentTokenHash: (r.agent_token_hash as string | null) ?? null,
    public: fromBoolInt(r.public as number),
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapKeyMetaRow(r: Record<string, unknown>): KeyMetaRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    keyPrefix: r.key_prefix as string,
    keyLast4: r.key_last4 as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapTreasurySnapshotRow(r: Record<string, unknown>): TreasurySnapshotRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    asOf: r.as_of as string,
    creditsAvailable: (r.credits_available as string | null) ?? null,
    creditsAccruedDelta: (r.credits_accrued_delta as string | null) ?? null,
    keySpentTotal: (r.key_spent_total as string | null) ?? null,
    keyRemaining: (r.key_remaining as string | null) ?? null,
    orbioBalanceTokens: (r.orbio_balance_tokens as string | null) ?? null,
    orbioPriceUsd: (r.orbio_price_usd as string | null) ?? null,
    accrualRatePerDay: (r.accrual_rate_per_day as string | null) ?? null,
    burnRatePerDay: (r.burn_rate_per_day as string | null) ?? null,
    burnLowConfidence: fromBoolInt(r.burn_low_confidence as number),
    runwayDays: (r.runway_days as string | null) ?? null,
    coverageRatio: (r.coverage_ratio as string | null) ?? null,
    state: r.state as string,
    reconciliationDelta: (r.reconciliation_delta as string | null) ?? null,
    balanceSource: r.balance_source as TreasurySnapshotRow['balanceSource'],
    stableBalanceUsd: (r.stable_balance_usd as string | null) ?? null,
    yieldPerTokenPerDay: (r.yield_per_token_per_day as string | null) ?? null,
    yieldLowConfidence: fromBoolInt(r.yield_low_confidence as number),
    createdAt: r.created_at as string,
  };
}

function mapUsageEventRow(r: Record<string, unknown>): UsageEventRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    at: r.at as string,
    model: r.model as string,
    tierRequested: (r.tier_requested as string | null) ?? null,
    tierServed: (r.tier_served as string | null) ?? null,
    promptTokens: (r.prompt_tokens as number | null) ?? null,
    completionTokens: (r.completion_tokens as number | null) ?? null,
    costUsd: (r.cost_usd as string | null) ?? null,
    latencyMs: (r.latency_ms as number | null) ?? null,
    status: r.status as string,
    error: (r.error as string | null) ?? null,
    requestedModel: (r.requested_model as string | null) ?? null,
    routeReason: (r.route_reason as string | null) ?? null,
    baselineCostUsd: (r.baseline_cost_usd as string | null) ?? null,
    callerKeyId: (r.caller_key_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapCallerKeyRow(r: Record<string, unknown>): CallerKeyRow {
  return {
    id: r.id as Id,
    agentId: (r.agent_id as string | null) ?? null,
    keyHash: r.key_hash as string,
    keyPrefix: r.key_prefix as string,
    label: (r.label as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapTreasuryEventRow(r: Record<string, unknown>): TreasuryEventRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    at: r.at as string,
    kind: r.kind as TreasuryEventRow['kind'],
    amount: (r.amount as string | null) ?? null,
    token: (r.token as TreasuryEventRow['token']) ?? null,
    usdValue: (r.usd_value as string | null) ?? null,
    txHash: (r.tx_hash as string | null) ?? null,
    meta: fromJsonText(r.meta),
    createdAt: r.created_at as string,
  };
}

function mapChainSnapshotRow(r: Record<string, unknown>): ChainSnapshotRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    asOf: r.as_of as string,
    stakedOrbio: (r.staked_orbio as string | null) ?? null,
    settledCredit: (r.settled_credit as string | null) ?? null,
    creditWallet: (r.credit_wallet as string | null) ?? null,
    creditApiAvailable: (r.credit_api_available as string | null) ?? null,
    creditApiUsed: (r.credit_api_used as string | null) ?? null,
    quoteCreditPerUsdg: (r.quote_credit_per_usdg as string | null) ?? null,
    ethBalance: (r.eth_balance as string | null) ?? null,
    usdgBalance: (r.usdg_balance as string | null) ?? null,
    mode: (r.mode as string | null) ?? null,
    rpcUrlHost: (r.rpc_url_host as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapDecisionRow(r: Record<string, unknown>): DecisionRow {
  return {
    id: r.id as Id,
    agentId: r.agent_id as Id,
    at: r.at as string,
    type: r.type as string,
    ruleId: (r.rule_id as string | null) ?? null,
    stateBefore: (r.state_before as string | null) ?? null,
    stateAfter: (r.state_after as string | null) ?? null,
    inputs: fromJsonText(r.inputs),
    action: fromJsonText(r.action),
    executed: fromBoolInt(r.executed as number),
    result: fromJsonText(r.result),
    human: (r.human as string | null) ?? null,
    public: fromBoolInt(r.public as number),
    createdAt: r.created_at as string,
  };
}

function mapBookSnapshotRow(r: Record<string, unknown>): BookSnapshotRow {
  return {
    id: r.id as Id,
    at: r.at as string,
    source: r.source as BookSnapshotRow['source'],
    view: fromJsonText(r.view),
    totalAvailableUsd: (r.total_available_usd as string | null) ?? null,
    bestDiscountPct: (r.best_discount_pct as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapOrderRow(r: Record<string, unknown>): OrderRow {
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
    placedAt: r.placed_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export class SqliteLedgerStore implements LedgerStore {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: Database.Database) {}

  // --- agents ---

  async insertAgent(row: NewAgent): Promise<AgentRow> {
    if (row.lastSeenAt !== undefined && row.lastSeenAt !== null) {
      assertUtcIso(row.lastSeenAt, 'lastSeenAt');
    }
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into agents
           (id, slug, name, wallet_address, chain, repo_url, x_handle, template, policy, mode, agent_token_hash, public, last_seen_at)
         values
           (@id, @slug, @name, @walletAddress, @chain, @repoUrl, @xHandle, @template, @policy, @mode, @agentTokenHash, @public, @lastSeenAt)
         returning *`,
      )
      .get({
        id,
        slug: row.slug,
        name: row.name,
        walletAddress: row.walletAddress ?? null,
        chain: row.chain ?? 'robinhood',
        repoUrl: row.repoUrl ?? null,
        xHandle: row.xHandle ?? null,
        template: row.template ?? null,
        policy: toJsonText(row.policy),
        mode: row.mode,
        agentTokenHash: row.agentTokenHash ?? null,
        public: toBoolInt(row.public ?? true),
        lastSeenAt: row.lastSeenAt ?? null,
      }) as Record<string, unknown>;
    return mapAgentRow(dbRow);
  }

  async getAgent(id: Id): Promise<AgentRow | null> {
    const dbRow = this.db.prepare('select * from agents where id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return dbRow ? mapAgentRow(dbRow) : null;
  }

  async getAgentBySlug(slug: string): Promise<AgentRow | null> {
    const dbRow = this.db.prepare('select * from agents where slug = ?').get(slug) as
      | Record<string, unknown>
      | undefined;
    return dbRow ? mapAgentRow(dbRow) : null;
  }

  async updateAgent(id: Id, patch: AgentMutablePatch): Promise<AgentRow> {
    const set: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.name !== undefined) {
      set.push('name = @name');
      params.name = patch.name;
    }
    if (patch.repoUrl !== undefined) {
      set.push('repo_url = @repoUrl');
      params.repoUrl = patch.repoUrl;
    }
    if (patch.xHandle !== undefined) {
      set.push('x_handle = @xHandle');
      params.xHandle = patch.xHandle;
    }
    if (patch.template !== undefined) {
      set.push('template = @template');
      params.template = patch.template;
    }
    if (patch.lastSeenAt !== undefined) {
      if (patch.lastSeenAt !== null) assertUtcIso(patch.lastSeenAt, 'lastSeenAt');
      set.push('last_seen_at = @lastSeenAt');
      params.lastSeenAt = patch.lastSeenAt;
    }
    if (set.length === 0) {
      throw new Error('updateAgent: patch must set at least one field');
    }
    const dbRow = this.db
      .prepare(`update agents set ${set.join(', ')} where id = @id returning *`)
      .get(params) as Record<string, unknown> | undefined;
    if (!dbRow) throw new NotFoundError('agents', id);
    return mapAgentRow(dbRow);
  }

  async listPublicAgents(): Promise<AgentRow[]> {
    const dbRows = this.db
      .prepare('select * from agents where public = 1 order by created_at desc')
      .all() as Record<string, unknown>[];
    return dbRows.map(mapAgentRow);
  }

  // --- key_meta ---

  async insertKeyMeta(row: NewKeyMeta): Promise<KeyMetaRow> {
    if (row.revokedAt !== undefined && row.revokedAt !== null) {
      assertUtcIso(row.revokedAt, 'revokedAt');
    }
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into key_meta (id, agent_id, key_prefix, key_last4, revoked_at, reason)
         values (@id, @agentId, @keyPrefix, @keyLast4, @revokedAt, @reason)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId,
        keyPrefix: row.keyPrefix,
        keyLast4: row.keyLast4,
        revokedAt: row.revokedAt ?? null,
        reason: row.reason ?? null,
      }) as Record<string, unknown>;
    return mapKeyMetaRow(dbRow);
  }

  // --- treasury_snapshots ---

  async insertTreasurySnapshot(row: NewTreasurySnapshot): Promise<TreasurySnapshotRow> {
    assertUtcIso(row.asOf, 'asOf');
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into treasury_snapshots
           (id, agent_id, as_of, credits_available, credits_accrued_delta, key_spent_total,
            key_remaining, orbio_balance_tokens, orbio_price_usd, accrual_rate_per_day,
            burn_rate_per_day, burn_low_confidence, runway_days, coverage_ratio, state,
            reconciliation_delta, balance_source, stable_balance_usd, yield_per_token_per_day,
            yield_low_confidence)
         values
           (@id, @agentId, @asOf, @creditsAvailable, @creditsAccruedDelta, @keySpentTotal,
            @keyRemaining, @orbioBalanceTokens, @orbioPriceUsd, @accrualRatePerDay,
            @burnRatePerDay, @burnLowConfidence, @runwayDays, @coverageRatio, @state,
            @reconciliationDelta, @balanceSource, @stableBalanceUsd, @yieldPerTokenPerDay,
            @yieldLowConfidence)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId,
        asOf: row.asOf,
        creditsAvailable: normalizeMoney(row.creditsAvailable),
        creditsAccruedDelta: normalizeMoney(row.creditsAccruedDelta),
        keySpentTotal: normalizeMoney(row.keySpentTotal),
        keyRemaining: normalizeMoney(row.keyRemaining),
        orbioBalanceTokens: normalizeTokenAmount(row.orbioBalanceTokens),
        orbioPriceUsd: normalizeMoney(row.orbioPriceUsd),
        accrualRatePerDay: normalizeMoney(row.accrualRatePerDay),
        burnRatePerDay: normalizeMoney(row.burnRatePerDay),
        burnLowConfidence: toBoolInt(row.burnLowConfidence ?? false),
        runwayDays: normalizeMoney(row.runwayDays),
        coverageRatio: normalizeMoney(row.coverageRatio),
        state: row.state,
        reconciliationDelta: normalizeMoney(row.reconciliationDelta),
        balanceSource: row.balanceSource,
        stableBalanceUsd: normalizeMoney(row.stableBalanceUsd),
        yieldPerTokenPerDay: normalizeMoney(row.yieldPerTokenPerDay),
        yieldLowConfidence: toBoolInt(row.yieldLowConfidence ?? false),
      }) as Record<string, unknown>;
    return mapTreasurySnapshotRow(dbRow);
  }

  async latestTreasurySnapshot(agentId: Id): Promise<TreasurySnapshotRow | null> {
    const dbRow = this.db
      .prepare('select * from treasury_snapshots where agent_id = ? order by as_of desc limit 1')
      .get(agentId) as Record<string, unknown> | undefined;
    return dbRow ? mapTreasurySnapshotRow(dbRow) : null;
  }

  // --- usage_events ---

  async insertUsageEvent(row: NewUsageEvent): Promise<UsageEventRow> {
    assertUtcIso(row.at, 'at');
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into usage_events
           (id, agent_id, at, model, tier_requested, tier_served, prompt_tokens,
            completion_tokens, cost_usd, latency_ms, status, error, requested_model,
            route_reason, baseline_cost_usd, caller_key_id)
         values
           (@id, @agentId, @at, @model, @tierRequested, @tierServed, @promptTokens,
            @completionTokens, @costUsd, @latencyMs, @status, @error, @requestedModel,
            @routeReason, @baselineCostUsd, @callerKeyId)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId,
        at: row.at,
        model: row.model,
        tierRequested: row.tierRequested ?? null,
        tierServed: row.tierServed ?? null,
        promptTokens: row.promptTokens ?? null,
        completionTokens: row.completionTokens ?? null,
        costUsd: normalizeMoney(row.costUsd),
        latencyMs: row.latencyMs ?? null,
        status: row.status,
        error: row.error ?? null,
        requestedModel: row.requestedModel ?? null,
        routeReason: row.routeReason ?? null,
        baselineCostUsd: normalizeMoney(row.baselineCostUsd),
        callerKeyId: row.callerKeyId ?? null,
      }) as Record<string, unknown>;
    return mapUsageEventRow(dbRow);
  }

  async listUsageEvents(
    agentId: Id,
    opts: { sinceAt?: IsoTimestamp } = {},
  ): Promise<UsageEventRow[]> {
    if (opts.sinceAt !== undefined) assertUtcIso(opts.sinceAt, 'sinceAt');
    const dbRows = (
      opts.sinceAt !== undefined
        ? this.db
            .prepare('select * from usage_events where agent_id = ? and at >= ? order by at desc')
            .all(agentId, opts.sinceAt)
        : this.db
            .prepare('select * from usage_events where agent_id = ? order by at desc')
            .all(agentId)
    ) as Record<string, unknown>[];
    return dbRows.map(mapUsageEventRow);
  }

  // --- decisions ---

  async insertDecision(row: NewDecision): Promise<DecisionRow> {
    assertUtcIso(row.at, 'at');
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into decisions
           (id, agent_id, at, type, rule_id, state_before, state_after, inputs, action,
            executed, result, human, public)
         values
           (@id, @agentId, @at, @type, @ruleId, @stateBefore, @stateAfter, @inputs, @action,
            @executed, @result, @human, @public)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId,
        at: row.at,
        type: row.type,
        ruleId: row.ruleId ?? null,
        stateBefore: row.stateBefore ?? null,
        stateAfter: row.stateAfter ?? null,
        inputs: toJsonText(row.inputs),
        action: toJsonText(row.action),
        executed: toBoolInt(row.executed ?? false),
        result: toJsonText(row.result),
        human: row.human ?? null,
        public: toBoolInt(row.public ?? true),
      }) as Record<string, unknown>;
    return mapDecisionRow(dbRow);
  }

  // --- book_snapshots ---

  async insertBookSnapshot(row: NewBookSnapshot): Promise<BookSnapshotRow> {
    assertUtcIso(row.at, 'at');
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into book_snapshots (id, at, source, view, total_available_usd, best_discount_pct)
         values (@id, @at, @source, @view, @totalAvailableUsd, @bestDiscountPct)
         returning *`,
      )
      .get({
        id,
        at: row.at,
        source: row.source,
        view: toJsonText(row.view),
        totalAvailableUsd: normalizeMoney(row.totalAvailableUsd),
        bestDiscountPct: normalizeMoney(row.bestDiscountPct),
      }) as Record<string, unknown>;
    return mapBookSnapshotRow(dbRow);
  }

  // --- orders ---

  async insertOrder(row: NewOrder): Promise<OrderRow> {
    assertUtcIso(row.placedAt, 'placedAt');
    if (row.resolvedAt !== undefined && row.resolvedAt !== null) {
      assertUtcIso(row.resolvedAt, 'resolvedAt');
    }
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into orders
           (id, agent_id, decision_id, side, model, usd, discount_pct, external_id, status,
            filled_usd, fee_usd, orbio_out, price_impact_pct, placed_at, resolved_at)
         values
           (@id, @agentId, @decisionId, @side, @model, @usd, @discountPct, @externalId, @status,
            @filledUsd, @feeUsd, @orbioOut, @priceImpactPct, @placedAt, @resolvedAt)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId,
        decisionId: row.decisionId,
        side: row.side,
        model: row.model ?? null,
        usd: normalizeMoney(row.usd),
        discountPct: normalizeMoney(row.discountPct),
        externalId: row.externalId ?? null,
        status: row.status,
        filledUsd: normalizeMoney(row.filledUsd),
        feeUsd: normalizeMoney(row.feeUsd),
        orbioOut: normalizeTokenAmount(row.orbioOut),
        priceImpactPct: normalizeMoney(row.priceImpactPct),
        placedAt: row.placedAt,
        resolvedAt: row.resolvedAt ?? null,
      }) as Record<string, unknown>;
    return mapOrderRow(dbRow);
  }

  async getOrder(id: Id): Promise<OrderRow | null> {
    const dbRow = this.db.prepare('select * from orders where id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return dbRow ? mapOrderRow(dbRow) : null;
  }

  async updateOrderFill(id: Id, patch: OrderFillPatch): Promise<OrderRow> {
    const set: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.status !== undefined) {
      set.push('status = @status');
      params.status = patch.status;
    }
    if (patch.filledUsd !== undefined) {
      set.push('filled_usd = @filledUsd');
      params.filledUsd = normalizeMoney(patch.filledUsd);
    }
    if (patch.feeUsd !== undefined) {
      set.push('fee_usd = @feeUsd');
      params.feeUsd = normalizeMoney(patch.feeUsd);
    }
    if (patch.resolvedAt !== undefined) {
      if (patch.resolvedAt !== null) assertUtcIso(patch.resolvedAt, 'resolvedAt');
      set.push('resolved_at = @resolvedAt');
      params.resolvedAt = patch.resolvedAt;
    }
    if (patch.externalId !== undefined) {
      set.push('external_id = @externalId');
      params.externalId = patch.externalId;
    }
    if (set.length === 0) {
      throw new Error('updateOrderFill: patch must set at least one field');
    }
    const dbRow = this.db
      .prepare(`update orders set ${set.join(', ')} where id = @id returning *`)
      .get(params) as Record<string, unknown> | undefined;
    if (!dbRow) throw new NotFoundError('orders', id);
    return mapOrderRow(dbRow);
  }

  // --- caller_keys (S-02) ---

  async insertCallerKey(row: NewCallerKey): Promise<CallerKeyRow> {
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into caller_keys (id, agent_id, key_hash, key_prefix, label)
         values (@id, @agentId, @keyHash, @keyPrefix, @label)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId ?? null,
        keyHash: row.keyHash,
        keyPrefix: row.keyPrefix,
        label: row.label ?? null,
      }) as Record<string, unknown>;
    return mapCallerKeyRow(dbRow);
  }

  async getCallerKeyByHash(keyHash: string): Promise<CallerKeyRow | null> {
    const dbRow = this.db.prepare('select * from caller_keys where key_hash = ?').get(keyHash) as
      | Record<string, unknown>
      | undefined;
    return dbRow ? mapCallerKeyRow(dbRow) : null;
  }

  async revokeCallerKey(id: Id, at: IsoTimestamp): Promise<CallerKeyRow> {
    assertUtcIso(at, 'at');
    const existing = this.db.prepare('select * from caller_keys where id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) throw new NotFoundError('caller_keys', id);
    if (existing.revoked_at !== null) throw new CallerKeyAlreadyRevokedError(id);
    const dbRow = this.db
      .prepare(
        'update caller_keys set revoked_at = @at where id = @id and revoked_at is null returning *',
      )
      .get({ id, at }) as Record<string, unknown> | undefined;
    // Guarded by the existence + null checks above; a concurrent revoke between them would only
    // ever be able to make this a no-op (revoked_at is null -> value, never value -> value), so
    // this can only be undefined if the row vanished, which the ledger never allows.
    if (!dbRow) throw new CallerKeyAlreadyRevokedError(id);
    return mapCallerKeyRow(dbRow);
  }

  // --- treasury_events (S-02) ---

  async insertTreasuryEvent(row: NewTreasuryEvent): Promise<TreasuryEventRow> {
    assertUtcIso(row.at, 'at');
    if (row.txHash !== undefined && row.txHash !== null) assertTxHash(row.txHash);
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into treasury_events (id, agent_id, at, kind, amount, token, usd_value, tx_hash, meta)
         values (@id, @agentId, @at, @kind, @amount, @token, @usdValue, @txHash, @meta)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId,
        at: row.at,
        kind: row.kind,
        amount: normalizeTokenAmount(row.amount),
        token: row.token ?? null,
        usdValue: normalizeMoney(row.usdValue),
        txHash: row.txHash ?? null,
        meta: toJsonText(row.meta),
      }) as Record<string, unknown>;
    return mapTreasuryEventRow(dbRow);
  }

  async listTreasuryEvents(agentId: Id, limit: number): Promise<TreasuryEventRow[]> {
    const dbRows = this.db
      .prepare('select * from treasury_events where agent_id = ? order by at desc limit ?')
      .all(agentId, limit) as Record<string, unknown>[];
    return dbRows.map(mapTreasuryEventRow);
  }

  // --- chain_snapshots (S-02) ---

  async insertChainSnapshot(row: NewChainSnapshot): Promise<ChainSnapshotRow> {
    assertUtcIso(row.asOf, 'asOf');
    const id = newId();
    const dbRow = this.db
      .prepare(
        `insert into chain_snapshots
           (id, agent_id, as_of, staked_orbio, settled_credit, credit_wallet,
            credit_api_available, credit_api_used, quote_credit_per_usdg, eth_balance,
            usdg_balance, mode, rpc_url_host)
         values
           (@id, @agentId, @asOf, @stakedOrbio, @settledCredit, @creditWallet,
            @creditApiAvailable, @creditApiUsed, @quoteCreditPerUsdg, @ethBalance,
            @usdgBalance, @mode, @rpcUrlHost)
         returning *`,
      )
      .get({
        id,
        agentId: row.agentId,
        asOf: row.asOf,
        stakedOrbio: normalizeTokenAmount(row.stakedOrbio),
        settledCredit: normalizeTokenAmount(row.settledCredit),
        creditWallet: normalizeTokenAmount(row.creditWallet),
        creditApiAvailable: normalizeMoney(row.creditApiAvailable),
        creditApiUsed: normalizeMoney(row.creditApiUsed),
        quoteCreditPerUsdg: normalizeMoney(row.quoteCreditPerUsdg),
        ethBalance: normalizeTokenAmount(row.ethBalance),
        usdgBalance: normalizeTokenAmount(row.usdgBalance),
        mode: row.mode ?? null,
        rpcUrlHost: row.rpcUrlHost ?? null,
      }) as Record<string, unknown>;
    return mapChainSnapshotRow(dbRow);
  }

  async latestChainSnapshot(agentId: Id): Promise<ChainSnapshotRow | null> {
    const dbRow = this.db
      .prepare('select * from chain_snapshots where agent_id = ? order by as_of desc limit 1')
      .get(agentId) as Record<string, unknown> | undefined;
    return dbRow ? mapChainSnapshotRow(dbRow) : null;
  }

  async close(): Promise<void> {
    if (this.db.open) this.db.close();
  }
}

/**
 * Opens (creating if necessary) a SQLite ledger at `path` and returns a ready-to-use
 * LedgerStore. `path` may be `:memory:` for tests. No SUPABASE_* variable, no network — FR-7.1 /
 * CLAUDE.md #5c.
 */
export function openSqliteLedger(path: string): LedgerStore {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return new SqliteLedgerStore(db);
}

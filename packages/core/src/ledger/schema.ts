/**
 * Ledger schema — the single source of truth (T-002, ADR-002, PRD §9).
 *
 * `packages/core/scripts/gen-sql.ts` reads this file and generates:
 *   - supabase/migrations/001_schema.sql   (Postgres DDL)
 *   - supabase/migrations/002_rls.sql      (Postgres RLS)
 *   - supabase/migrations/003_append_only.sql (Postgres triggers)
 *   - supabase/migrations/004_cron.sql     (Postgres pg_cron job — static, not schema-derived)
 *   - packages/core/src/ledger/sqlite/schema.sql (SQLite DDL + triggers)
 *
 * Never hand-edit the generated SQL files; edit this file and re-run
 * `pnpm --filter @orbio-treasurer/core gen:sql`.
 *
 * Dialect mapping (ADR-002 — never floats in storage):
 *   - money / percentages / rates / ratios  -> Postgres numeric(18,6)   | SQLite TEXT (decimal string)
 *   - on-chain token amounts                -> Postgres numeric(30,0)   | SQLite TEXT (decimal string)
 *   - timestamps                            -> Postgres timestamptz    | SQLite TEXT (ISO 8601 UTC)
 *   - jsonb                                 -> Postgres jsonb          | SQLite TEXT (JSON string)
 *   - booleans                              -> Postgres boolean        | SQLite INTEGER (0/1, CHECKed)
 *
 * Every table implicitly gets, per PRD §9's header note:
 *   id uuid primary key default gen_random_uuid()   (Postgres)
 *   id TEXT primary key                             (SQLite — the repository supplies the uuid; SQLite has
 *                                                     no built-in uuid generator, see ADR-005)
 *   created_at timestamptz not null default now()   (Postgres)
 *   created_at TEXT not null default (UTC ISO 8601 now)  (SQLite)
 * These two columns are NOT listed in each table's `columns` array below.
 */

export type ColumnType =
  | 'uuid' // opaque id / foreign key, stored as text in both dialects
  | 'text'
  | 'int'
  | 'boolean'
  | 'timestamp' // UTC instant
  | 'jsonb'
  | 'money' // exact decimal: USD amounts, prices, rates, ratios, percentages, day counts
  | 'token_amount'; // exact decimal: large on-chain integer token balances

export type ColumnDefault =
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'text'; readonly value: string };

export interface ColumnDef {
  readonly name: string;
  readonly type: ColumnType;
  /** Defaults to nullable; set true for columns that must always be supplied. */
  readonly notNull?: boolean;
  readonly unique?: boolean;
  readonly default?: ColumnDefault;
  /**
   * Raw SQL boolean expression, identical in both dialects (e.g. "side in ('buy','stake')").
   * Only simple, dialect-portable expressions (IN-lists) are used in this schema.
   */
  readonly check?: string;
  /** Foreign key to `<table>.id`. No ON DELETE clause: the ledger never deletes rows. */
  readonly references?: { readonly table: string };
}

export interface IndexDef {
  /** Column names, optionally suffixed " desc" for a descending key, e.g. "as_of desc". */
  readonly columns: readonly string[];
}

/**
 * How writes to this table are constrained after insert.
 *   - 'append-only': UPDATE and DELETE are always rejected (treasury_snapshots, usage_events,
 *     decisions, book_snapshots, and — as of PRD 0.3.1 / FR-1.1 — key_meta: key revocation is
 *     modelled as inserting a new key_meta row carrying `revoked_at`, never updating one in
 *     place; see tasks/T-002.md Discovered / audit pass 1 F2).
 *   - 'mutable-guard': DELETE is always rejected; UPDATE is rejected unless every changed
 *     column is in `mutableColumns` (agents, orders).
 *   - 'none': no ledger trigger is generated for this table. Unused today — every table is
 *     either append-only or mutable-guarded — kept for a future table that genuinely has no
 *     write constraint.
 */
export type WritePolicy =
  | { readonly kind: 'append-only' }
  | { readonly kind: 'mutable-guard'; readonly mutableColumns: readonly string[] }
  | { readonly kind: 'none' };

/**
 * Anonymous (public, unauthenticated) read access, Postgres RLS only.
 *   - 'own-public-column': anon may select rows where this table's own `public` column is true.
 *   - 'via-agent-public': anon may select rows whose `agent_id` points at an agents row with
 *     public = true.
 *   - 'all': every row is anon-readable (book_snapshots — see Discovered in tasks/T-002.md:
 *     the ticket says to gate book_snapshots by "agents with public = true", but book_snapshots
 *     has no agent_id column per PRD §9 — it is global book state, not per-agent. Treated as
 *     globally public, same as the book itself.)
 *   - 'none': anon has no read access at all (key_meta — key material metadata is never public).
 */
export type RlsPolicy =
  | { readonly kind: 'own-public-column' }
  | { readonly kind: 'via-agent-public' }
  | { readonly kind: 'all' }
  | { readonly kind: 'none' };

export interface TableDef {
  readonly name: string;
  readonly comment: string;
  readonly columns: readonly ColumnDef[];
  readonly indexes?: readonly IndexDef[];
  readonly writePolicy: WritePolicy;
  readonly rls: RlsPolicy;
}

const money = (name: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'money',
  ...opts,
});
const tokenAmount = (name: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'token_amount',
  ...opts,
});
const text = (name: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'text',
  ...opts,
});
const int = (name: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'int',
  ...opts,
});
const boolean = (name: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'boolean',
  ...opts,
});
const timestamp = (name: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'timestamp',
  ...opts,
});
const jsonb = (name: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'jsonb',
  ...opts,
});
const fk = (name: string, table: string, opts: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'uuid',
  notNull: true,
  references: { table },
  ...opts,
});

export const LEDGER_SCHEMA: readonly TableDef[] = [
  {
    name: 'agents',
    comment: 'One row per registered agent (reference or kit-built). PRD §9.',
    columns: [
      text('slug', { notNull: true, unique: true }),
      text('name', { notNull: true }),
      text('wallet_address'),
      text('chain', { notNull: true, default: { kind: 'text', value: 'robinhood' } }),
      text('repo_url'),
      text('x_handle'),
      text('template'),
      jsonb('policy'),
      text('mode', { notNull: true, check: "mode in ('dry_run','live')" }),
      text('agent_token_hash'), // never the token itself — see CLAUDE.md #4
      boolean('public', { notNull: true, default: { kind: 'bool', value: true } }),
      timestamp('last_seen_at'),
    ],
    // FR-1.1 says only "agents.display_* fields" (a wording not matched by any §9 column name)
    // and orders.status are ever updated. Resolved per T-002's concrete builder guidance as the
    // profile-ish fields plus last_seen_at; flagged for So in tasks/T-002.md Discovered.
    writePolicy: {
      kind: 'mutable-guard',
      mutableColumns: ['name', 'repo_url', 'x_handle', 'template', 'last_seen_at'],
    },
    rls: { kind: 'own-public-column' },
  },
  {
    name: 'key_meta',
    comment:
      'Metadata about Orbio keys the agent has held — never the key itself. Append-only: ' +
      'revocation is a new row with revoked_at, never an update (PRD 0.3.1, FR-1.1). PRD §9.',
    columns: [
      fk('agent_id', 'agents'),
      text('key_prefix', { notNull: true }),
      text('key_last4', { notNull: true }),
      timestamp('revoked_at'),
      text('reason'),
    ],
    writePolicy: { kind: 'append-only' },
    rls: { kind: 'none' },
  },
  {
    name: 'caller_keys',
    comment:
      'S-02 (PRD 1.0 §4 T-2). Who called the gateway — never the key itself, only its hash and ' +
      'a display prefix. The ONE guarded update is revocation: revoked_at may move null -> a ' +
      'value exactly once (enforced at the store boundary, mirrored by the mutable-guard ' +
      'trigger allow-list below); no other column, and no second revocation, is ever permitted.',
    columns: [
      fk('agent_id', 'agents', { notNull: false }),
      text('key_hash', { notNull: true, unique: true }),
      text('key_prefix', { notNull: true }),
      text('label'),
      timestamp('revoked_at'),
    ],
    writePolicy: { kind: 'mutable-guard', mutableColumns: ['revoked_at'] },
    rls: { kind: 'none' },
  },
  {
    name: 'treasury_snapshots',
    comment: "Append-only. PRD §9 + the balance/yield columns added after §9's prose.",
    columns: [
      fk('agent_id', 'agents'),
      timestamp('as_of', { notNull: true }),
      money('credits_available'),
      money('credits_accrued_delta'),
      money('key_spent_total'),
      money('key_remaining'),
      tokenAmount('orbio_balance_tokens'),
      money('orbio_price_usd'),
      money('accrual_rate_per_day'),
      money('burn_rate_per_day'),
      boolean('burn_low_confidence', { notNull: true, default: { kind: 'bool', value: false } }),
      money('runway_days'), // null = infinite runway (accrual >= burn), per FR-1.3
      money('coverage_ratio'),
      text('state', { notNull: true }),
      money('reconciliation_delta'),
      text('balance_source', {
        notNull: true,
        check: "balance_source in ('mcp','gateway','estimate')",
      }),
      money('stable_balance_usd'),
      money('yield_per_token_per_day'),
      boolean('yield_low_confidence', { notNull: true, default: { kind: 'bool', value: false } }),
    ],
    indexes: [{ columns: ['agent_id', 'as_of desc'] }],
    writePolicy: { kind: 'append-only' },
    rls: { kind: 'via-agent-public' },
  },
  {
    name: 'usage_events',
    comment:
      'Append-only. One row per metered inference call. PRD §9; S-02 adds the router-meter columns.',
    columns: [
      fk('agent_id', 'agents'),
      timestamp('at', { notNull: true }),
      text('model', { notNull: true }),
      text('tier_requested'),
      text('tier_served'),
      int('prompt_tokens'),
      int('completion_tokens'),
      money('cost_usd'),
      int('latency_ms'),
      text('status', { notNull: true }),
      text('error'),
      // S-02 (PRD 1.0 §4 T-2, §6): what the gateway actually asked for/why, and the caller key
      // that made the call, so savings() and burnDaily() can be computed straight off this table.
      text('requested_model'),
      text('route_reason'),
      money('baseline_cost_usd'),
      fk('caller_key_id', 'caller_keys', { notNull: false }),
    ],
    indexes: [{ columns: ['agent_id', 'at desc'] }],
    writePolicy: { kind: 'append-only' },
    rls: { kind: 'via-agent-public' },
  },
  {
    name: 'decisions',
    comment: 'Append-only. Policy engine output; also the public feed. PRD §9 + §10.',
    columns: [
      fk('agent_id', 'agents'),
      timestamp('at', { notNull: true }),
      text('type', { notNull: true }),
      text('rule_id'),
      text('state_before'),
      text('state_after'),
      jsonb('inputs'),
      jsonb('action'),
      boolean('executed', { notNull: true, default: { kind: 'bool', value: false } }),
      jsonb('result'),
      text('human'),
      boolean('public', { notNull: true, default: { kind: 'bool', value: true } }),
    ],
    indexes: [{ columns: ['agent_id', 'at desc'] }, { columns: ['at desc'] }],
    writePolicy: { kind: 'append-only' },
    rls: { kind: 'own-public-column' },
  },
  {
    name: 'book_snapshots',
    comment: 'Append-only. Global book state, not per-agent. PRD §9.',
    columns: [
      timestamp('at', { notNull: true }),
      text('source', { notNull: true, check: "source in ('api','page')" }),
      jsonb('view'),
      money('total_available_usd'),
      money('best_discount_pct'),
    ],
    indexes: [{ columns: ['at desc'] }],
    writePolicy: { kind: 'append-only' },
    rls: { kind: 'all' },
  },
  {
    name: 'orders',
    comment:
      'Mutable only via the executor, and only the fill fields: status, filled_usd, fee_usd, ' +
      'resolved_at, external_id (PRD 0.3.1: fills arrive after placement; everything else ' +
      'immutable). PRD §9.',
    columns: [
      fk('agent_id', 'agents'),
      fk('decision_id', 'decisions'),
      text('side', { notNull: true, check: "side in ('buy','stake')" }),
      text('model'),
      money('usd', { notNull: true }),
      money('discount_pct'),
      text('external_id'), // order id or tx hash
      text('status', { notNull: true }),
      money('filled_usd'),
      money('fee_usd'),
      tokenAmount('orbio_out'),
      money('price_impact_pct'),
      timestamp('placed_at', { notNull: true }),
      timestamp('resolved_at'),
    ],
    indexes: [{ columns: ['agent_id', 'placed_at desc'] }],
    writePolicy: {
      kind: 'mutable-guard',
      mutableColumns: ['status', 'filled_usd', 'fee_usd', 'resolved_at', 'external_id'],
    },
    rls: { kind: 'via-agent-public' },
  },
  {
    name: 'treasury_events',
    comment:
      'Append-only. S-02 (PRD 1.0 §4 T-2, §6): what the treasury did on-chain (or dry-ran), ' +
      'with tx hashes when there is one. tx_hash is validated (^0x[0-9a-f]{64}$) at the store ' +
      'boundary, not by a DB CHECK — see util.ts assertTxHash / CLAUDE.md #6.',
    columns: [
      fk('agent_id', 'agents'),
      timestamp('at', { notNull: true }),
      text('kind', {
        notNull: true,
        // 'tick' added by S-06 (migration 006, both dialects) — tick/tick.ts's own idempotency
        // marker row, one per 15-min UTC bucket per agent.
        check:
          "kind in ('settle','claim','activate','buy','stake','mode_change','alert','dry_run','tick')",
      }),
      tokenAmount('amount'),
      text('token', { check: "token in ('CREDIT','ORBIO','USDG','ETH')" }),
      money('usd_value'),
      text('tx_hash'),
      jsonb('meta'),
    ],
    indexes: [{ columns: ['agent_id', 'at desc'] }],
    writePolicy: { kind: 'append-only' },
    rls: { kind: 'via-agent-public' },
  },
  {
    name: 'chain_snapshots',
    comment:
      'Append-only. S-02 (PRD 1.0 §4 T-2, §6): what the treasury saw on-chain/off-chain at a point in time.',
    columns: [
      fk('agent_id', 'agents'),
      timestamp('as_of', { notNull: true }),
      tokenAmount('staked_orbio'),
      tokenAmount('settled_credit'),
      tokenAmount('credit_wallet'),
      money('credit_api_available'),
      money('credit_api_used'),
      money('quote_credit_per_usdg'),
      tokenAmount('eth_balance'),
      tokenAmount('usdg_balance'),
      text('mode'),
      text('rpc_url_host'),
    ],
    indexes: [{ columns: ['agent_id', 'as_of desc'] }],
    writePolicy: { kind: 'append-only' },
    rls: { kind: 'via-agent-public' },
  },
];

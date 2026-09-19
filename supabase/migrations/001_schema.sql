-- GENERATED FILE — do not hand-edit.
-- Source: packages/core/src/ledger/schema.ts
-- Regenerate: pnpm --filter @orbio-treasurer/core gen:sql
-- Table definitions (Postgres / Supabase).

-- gen_random_uuid() lives in pgcrypto; Supabase ships it enabled, but this is idempotent.
create extension if not exists pgcrypto;

-- One row per registered agent (reference or kit-built). PRD §9.
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  wallet_address text,
  chain text not null default 'robinhood',
  repo_url text,
  x_handle text,
  template text,
  policy jsonb,
  mode text not null check (mode in ('dry_run','live')),
  agent_token_hash text,
  public boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- Metadata about Orbio keys the agent has held — never the key itself. Append-only: revocation is a new row with revoked_at, never an update (PRD 0.3.1, FR-1.1). PRD §9.
create table if not exists key_meta (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  key_prefix text not null,
  key_last4 text not null,
  revoked_at timestamptz,
  reason text,
  created_at timestamptz not null default now()
);

-- S-02 (PRD 1.0 §4 T-2). Who called the gateway — never the key itself, only its hash and a display prefix. The ONE guarded update is revocation: revoked_at may move null -> a value exactly once (enforced at the store boundary, mirrored by the mutable-guard trigger allow-list below); no other column, and no second revocation, is ever permitted.
create table if not exists caller_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id),
  key_hash text not null unique,
  key_prefix text not null,
  label text,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Append-only. PRD §9 + the balance/yield columns added after §9's prose.
create table if not exists treasury_snapshots (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  as_of timestamptz not null,
  credits_available numeric(18,6),
  credits_accrued_delta numeric(18,6),
  key_spent_total numeric(18,6),
  key_remaining numeric(18,6),
  orbio_balance_tokens numeric(30,0),
  orbio_price_usd numeric(18,6),
  accrual_rate_per_day numeric(18,6),
  burn_rate_per_day numeric(18,6),
  burn_low_confidence boolean not null default false,
  runway_days numeric(18,6),
  coverage_ratio numeric(18,6),
  state text not null,
  reconciliation_delta numeric(18,6),
  balance_source text not null check (balance_source in ('mcp','gateway','estimate')),
  stable_balance_usd numeric(18,6),
  yield_per_token_per_day numeric(18,6),
  yield_low_confidence boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_treasury_snapshots_agent_id_as_of_desc on treasury_snapshots (agent_id, as_of desc);

-- Append-only. One row per metered inference call. PRD §9; S-02 adds the router-meter columns.
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  at timestamptz not null,
  model text not null,
  tier_requested text,
  tier_served text,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd numeric(18,6),
  latency_ms integer,
  status text not null,
  error text,
  requested_model text,
  route_reason text,
  baseline_cost_usd numeric(18,6),
  caller_key_id uuid references caller_keys(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_usage_events_agent_id_at_desc on usage_events (agent_id, at desc);

-- Append-only. Policy engine output; also the public feed. PRD §9 + §10.
create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  at timestamptz not null,
  type text not null,
  rule_id text,
  state_before text,
  state_after text,
  inputs jsonb,
  action jsonb,
  executed boolean not null default false,
  result jsonb,
  human text,
  public boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_decisions_agent_id_at_desc on decisions (agent_id, at desc);
create index if not exists idx_decisions_at_desc on decisions (at desc);

-- Append-only. Global book state, not per-agent. PRD §9.
create table if not exists book_snapshots (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null,
  source text not null check (source in ('api','page')),
  view jsonb,
  total_available_usd numeric(18,6),
  best_discount_pct numeric(18,6),
  created_at timestamptz not null default now()
);
create index if not exists idx_book_snapshots_at_desc on book_snapshots (at desc);

-- Mutable only via the executor, and only the fill fields: status, filled_usd, fee_usd, resolved_at, external_id (PRD 0.3.1: fills arrive after placement; everything else immutable). PRD §9.
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  decision_id uuid not null references decisions(id),
  side text not null check (side in ('buy','stake')),
  model text,
  usd numeric(18,6) not null,
  discount_pct numeric(18,6),
  external_id text,
  status text not null,
  filled_usd numeric(18,6),
  fee_usd numeric(18,6),
  orbio_out numeric(30,0),
  price_impact_pct numeric(18,6),
  placed_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_orders_agent_id_placed_at_desc on orders (agent_id, placed_at desc);

-- Append-only. S-02 (PRD 1.0 §4 T-2, §6): what the treasury did on-chain (or dry-ran), with tx hashes when there is one. tx_hash is validated (^0x[0-9a-f]{64}$) at the store boundary, not by a DB CHECK — see util.ts assertTxHash / CLAUDE.md #6.
create table if not exists treasury_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  at timestamptz not null,
  kind text not null check (kind in ('settle','claim','activate','buy','stake','mode_change','alert','dry_run','tick')),
  amount numeric(30,0),
  token text check (token in ('CREDIT','ORBIO','USDG','ETH')),
  usd_value numeric(18,6),
  tx_hash text,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_treasury_events_agent_id_at_desc on treasury_events (agent_id, at desc);

-- Append-only. S-02 (PRD 1.0 §4 T-2, §6): what the treasury saw on-chain/off-chain at a point in time.
create table if not exists chain_snapshots (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  as_of timestamptz not null,
  staked_orbio numeric(30,0),
  settled_credit numeric(30,0),
  credit_wallet numeric(30,0),
  credit_api_available numeric(18,6),
  credit_api_used numeric(18,6),
  quote_credit_per_usdg numeric(18,6),
  eth_balance numeric(30,0),
  usdg_balance numeric(30,0),
  mode text,
  rpc_url_host text,
  created_at timestamptz not null default now()
);
create index if not exists idx_chain_snapshots_agent_id_as_of_desc on chain_snapshots (agent_id, as_of desc);

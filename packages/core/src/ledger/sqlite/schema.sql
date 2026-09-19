-- GENERATED FILE — do not hand-edit.
-- Source: packages/core/src/ledger/schema.ts
-- Regenerate: pnpm --filter @orbio-treasurer/core gen:sql
-- Single-file ledger schema for kit agents (ADR-002). Money and token amounts are TEXT
-- decimal strings, never REAL — see schema.ts. Foreign keys are declared but SQLite only
-- enforces them when the connection runs `PRAGMA foreign_keys = ON;` (per-connection,
-- not persisted in this file — the repository layer, T-011, must set it on open).
-- One row per registered agent (reference or kit-built). PRD §9.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  wallet_address TEXT,
  chain TEXT NOT NULL DEFAULT 'robinhood',
  repo_url TEXT,
  x_handle TEXT,
  template TEXT,
  policy TEXT,
  mode TEXT NOT NULL CHECK (mode in ('dry_run','live')),
  agent_token_hash TEXT,
  public INTEGER NOT NULL DEFAULT 1 CHECK (public in (0,1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Metadata about Orbio keys the agent has held — never the key itself. Append-only: revocation is a new row with revoked_at, never an update (PRD 0.3.1, FR-1.1). PRD §9.
CREATE TABLE IF NOT EXISTS key_meta (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  key_prefix TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  revoked_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- S-02 (PRD 1.0 §4 T-2). Who called the gateway — never the key itself, only its hash and a display prefix. The ONE guarded update is revocation: revoked_at may move null -> a value exactly once (enforced at the store boundary, mirrored by the mutable-guard trigger allow-list below); no other column, and no second revocation, is ever permitted.
CREATE TABLE IF NOT EXISTS caller_keys (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Append-only. PRD §9 + the balance/yield columns added after §9's prose.
CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  as_of TEXT NOT NULL,
  credits_available TEXT,
  credits_accrued_delta TEXT,
  key_spent_total TEXT,
  key_remaining TEXT,
  orbio_balance_tokens TEXT,
  orbio_price_usd TEXT,
  accrual_rate_per_day TEXT,
  burn_rate_per_day TEXT,
  burn_low_confidence INTEGER NOT NULL DEFAULT 0 CHECK (burn_low_confidence in (0,1)),
  runway_days TEXT,
  coverage_ratio TEXT,
  state TEXT NOT NULL,
  reconciliation_delta TEXT,
  balance_source TEXT NOT NULL CHECK (balance_source in ('mcp','gateway','estimate')),
  stable_balance_usd TEXT,
  yield_per_token_per_day TEXT,
  yield_low_confidence INTEGER NOT NULL DEFAULT 0 CHECK (yield_low_confidence in (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_treasury_snapshots_agent_id_as_of_desc ON treasury_snapshots (agent_id, as_of DESC);
-- Append-only. One row per metered inference call. PRD §9; S-02 adds the router-meter columns.
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  at TEXT NOT NULL,
  model TEXT NOT NULL,
  tier_requested TEXT,
  tier_served TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd TEXT,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  requested_model TEXT,
  route_reason TEXT,
  baseline_cost_usd TEXT,
  caller_key_id TEXT REFERENCES caller_keys(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_events_agent_id_at_desc ON usage_events (agent_id, at DESC);
-- Append-only. Policy engine output; also the public feed. PRD §9 + §10.
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  rule_id TEXT,
  state_before TEXT,
  state_after TEXT,
  inputs TEXT,
  action TEXT,
  executed INTEGER NOT NULL DEFAULT 0 CHECK (executed in (0,1)),
  result TEXT,
  human TEXT,
  public INTEGER NOT NULL DEFAULT 1 CHECK (public in (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_agent_id_at_desc ON decisions (agent_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_at_desc ON decisions (at DESC);
-- Append-only. Global book state, not per-agent. PRD §9.
CREATE TABLE IF NOT EXISTS book_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source in ('api','page')),
  view TEXT,
  total_available_usd TEXT,
  best_discount_pct TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_book_snapshots_at_desc ON book_snapshots (at DESC);
-- Mutable only via the executor, and only the fill fields: status, filled_usd, fee_usd, resolved_at, external_id (PRD 0.3.1: fills arrive after placement; everything else immutable). PRD §9.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  side TEXT NOT NULL CHECK (side in ('buy','stake')),
  model TEXT,
  usd TEXT NOT NULL,
  discount_pct TEXT,
  external_id TEXT,
  status TEXT NOT NULL,
  filled_usd TEXT,
  fee_usd TEXT,
  orbio_out TEXT,
  price_impact_pct TEXT,
  placed_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_agent_id_placed_at_desc ON orders (agent_id, placed_at DESC);
-- Append-only. S-02 (PRD 1.0 §4 T-2, §6): what the treasury did on-chain (or dry-ran), with tx hashes when there is one. tx_hash is validated (^0x[0-9a-f]{64}$) at the store boundary, not by a DB CHECK — see util.ts assertTxHash / CLAUDE.md #6.
CREATE TABLE IF NOT EXISTS treasury_events (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind in ('settle','claim','activate','buy','stake','mode_change','alert','dry_run','tick')),
  amount TEXT,
  token TEXT CHECK (token in ('CREDIT','ORBIO','USDG','ETH')),
  usd_value TEXT,
  tx_hash TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_treasury_events_agent_id_at_desc ON treasury_events (agent_id, at DESC);
-- Append-only. S-02 (PRD 1.0 §4 T-2, §6): what the treasury saw on-chain/off-chain at a point in time.
CREATE TABLE IF NOT EXISTS chain_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  as_of TEXT NOT NULL,
  staked_orbio TEXT,
  settled_credit TEXT,
  credit_wallet TEXT,
  credit_api_available TEXT,
  credit_api_used TEXT,
  quote_credit_per_usdg TEXT,
  eth_balance TEXT,
  usdg_balance TEXT,
  mode TEXT,
  rpc_url_host TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chain_snapshots_agent_id_as_of_desc ON chain_snapshots (agent_id, as_of DESC);

-- Append-only / mutable-column-guard triggers.

CREATE TRIGGER IF NOT EXISTS trg_agents_no_delete
BEFORE DELETE ON agents
BEGIN
  SELECT RAISE(ABORT, 'agents rows cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_agents_guard_update
BEFORE UPDATE ON agents
WHEN (
    NEW.id IS NOT OLD.id
    OR NEW.slug IS NOT OLD.slug
    OR NEW.wallet_address IS NOT OLD.wallet_address
    OR NEW.chain IS NOT OLD.chain
    OR NEW.policy IS NOT OLD.policy
    OR NEW.mode IS NOT OLD.mode
    OR NEW.agent_token_hash IS NOT OLD.agent_token_hash
    OR NEW.public IS NOT OLD.public
    OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'agents: only name, repo_url, x_handle, template, last_seen_at may be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_key_meta_no_update
BEFORE UPDATE ON key_meta
BEGIN
  SELECT RAISE(ABORT, 'key_meta is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_key_meta_no_delete
BEFORE DELETE ON key_meta
BEGIN
  SELECT RAISE(ABORT, 'key_meta is append-only: DELETE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_caller_keys_no_delete
BEFORE DELETE ON caller_keys
BEGIN
  SELECT RAISE(ABORT, 'caller_keys rows cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_caller_keys_guard_update
BEFORE UPDATE ON caller_keys
WHEN (
    NEW.id IS NOT OLD.id
    OR NEW.agent_id IS NOT OLD.agent_id
    OR NEW.key_hash IS NOT OLD.key_hash
    OR NEW.key_prefix IS NOT OLD.key_prefix
    OR NEW.label IS NOT OLD.label
    OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'caller_keys: only revoked_at may be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_treasury_snapshots_no_update
BEFORE UPDATE ON treasury_snapshots
BEGIN
  SELECT RAISE(ABORT, 'treasury_snapshots is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_treasury_snapshots_no_delete
BEFORE DELETE ON treasury_snapshots
BEGIN
  SELECT RAISE(ABORT, 'treasury_snapshots is append-only: DELETE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_usage_events_no_update
BEFORE UPDATE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_usage_events_no_delete
BEFORE DELETE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only: DELETE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_decisions_no_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_decisions_no_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions is append-only: DELETE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_snapshots_no_update
BEFORE UPDATE ON book_snapshots
BEGIN
  SELECT RAISE(ABORT, 'book_snapshots is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_snapshots_no_delete
BEFORE DELETE ON book_snapshots
BEGIN
  SELECT RAISE(ABORT, 'book_snapshots is append-only: DELETE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_no_delete
BEFORE DELETE ON orders
BEGIN
  SELECT RAISE(ABORT, 'orders rows cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_guard_update
BEFORE UPDATE ON orders
WHEN (
    NEW.id IS NOT OLD.id
    OR NEW.agent_id IS NOT OLD.agent_id
    OR NEW.decision_id IS NOT OLD.decision_id
    OR NEW.side IS NOT OLD.side
    OR NEW.model IS NOT OLD.model
    OR NEW.usd IS NOT OLD.usd
    OR NEW.discount_pct IS NOT OLD.discount_pct
    OR NEW.orbio_out IS NOT OLD.orbio_out
    OR NEW.price_impact_pct IS NOT OLD.price_impact_pct
    OR NEW.placed_at IS NOT OLD.placed_at
    OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'orders: only status, filled_usd, fee_usd, resolved_at, external_id may be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_treasury_events_no_update
BEFORE UPDATE ON treasury_events
BEGIN
  SELECT RAISE(ABORT, 'treasury_events is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_treasury_events_no_delete
BEFORE DELETE ON treasury_events
BEGIN
  SELECT RAISE(ABORT, 'treasury_events is append-only: DELETE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_chain_snapshots_no_update
BEFORE UPDATE ON chain_snapshots
BEGIN
  SELECT RAISE(ABORT, 'chain_snapshots is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_chain_snapshots_no_delete
BEFORE DELETE ON chain_snapshots
BEGIN
  SELECT RAISE(ABORT, 'chain_snapshots is append-only: DELETE is not permitted');
END;

-- GENERATED FILE — do not hand-edit.
-- Source: packages/core/src/ledger/schema.ts
-- Regenerate: pnpm --filter @orbio-treasurer/core gen:sql
-- Triggers enforcing append-only / mutable-column-guard write policies.
create or replace function ledger_reject_write() returns trigger as $$
begin
  raise exception '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
end;
$$ language plpgsql;

create or replace function agents_guard_write() returns trigger as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'agents rows cannot be deleted';
  end if;
  if TG_OP = 'UPDATE' then
    if NEW.id IS DISTINCT FROM OLD.id
       OR NEW.slug IS DISTINCT FROM OLD.slug
       OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
       OR NEW.chain IS DISTINCT FROM OLD.chain
       OR NEW.policy IS DISTINCT FROM OLD.policy
       OR NEW.mode IS DISTINCT FROM OLD.mode
       OR NEW.agent_token_hash IS DISTINCT FROM OLD.agent_token_hash
       OR NEW.public IS DISTINCT FROM OLD.public
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    then
      raise exception 'agents: only name, repo_url, x_handle, template, last_seen_at may be updated';
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_agents_guard
before update or delete on agents
for each row execute function agents_guard_write();

create trigger trg_key_meta_append_only
before update or delete on key_meta
for each row execute function ledger_reject_write();

create or replace function caller_keys_guard_write() returns trigger as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'caller_keys rows cannot be deleted';
  end if;
  if TG_OP = 'UPDATE' then
    if NEW.id IS DISTINCT FROM OLD.id
       OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
       OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
       OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
       OR NEW.label IS DISTINCT FROM OLD.label
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    then
      raise exception 'caller_keys: only revoked_at may be updated';
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_caller_keys_guard
before update or delete on caller_keys
for each row execute function caller_keys_guard_write();

create trigger trg_treasury_snapshots_append_only
before update or delete on treasury_snapshots
for each row execute function ledger_reject_write();

create trigger trg_usage_events_append_only
before update or delete on usage_events
for each row execute function ledger_reject_write();

create trigger trg_decisions_append_only
before update or delete on decisions
for each row execute function ledger_reject_write();

create trigger trg_book_snapshots_append_only
before update or delete on book_snapshots
for each row execute function ledger_reject_write();

create or replace function orders_guard_write() returns trigger as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'orders rows cannot be deleted';
  end if;
  if TG_OP = 'UPDATE' then
    if NEW.id IS DISTINCT FROM OLD.id
       OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
       OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
       OR NEW.side IS DISTINCT FROM OLD.side
       OR NEW.model IS DISTINCT FROM OLD.model
       OR NEW.usd IS DISTINCT FROM OLD.usd
       OR NEW.discount_pct IS DISTINCT FROM OLD.discount_pct
       OR NEW.orbio_out IS DISTINCT FROM OLD.orbio_out
       OR NEW.price_impact_pct IS DISTINCT FROM OLD.price_impact_pct
       OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    then
      raise exception 'orders: only status, filled_usd, fee_usd, resolved_at, external_id may be updated';
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_orders_guard
before update or delete on orders
for each row execute function orders_guard_write();

create trigger trg_treasury_events_append_only
before update or delete on treasury_events
for each row execute function ledger_reject_write();

create trigger trg_chain_snapshots_append_only
before update or delete on chain_snapshots
for each row execute function ledger_reject_write();

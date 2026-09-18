-- GENERATED FILE — do not hand-edit.
-- Source: packages/core/src/ledger/schema.ts
-- Regenerate: pnpm --filter @orbio-treasurer/core gen:sql
-- Row Level Security: anon may SELECT public rows only. service_role bypasses RLS
-- (Supabase grants service_role the BYPASSRLS attribute by default — no policy needed for it).

alter table agents enable row level security;
create policy agents_anon_select on agents for select to anon using (public = true);
grant select on agents to anon;

alter table key_meta enable row level security;
-- key_meta: no anon policy — anon has no read access (RLS default-denies).

alter table caller_keys enable row level security;
-- caller_keys: no anon policy — anon has no read access (RLS default-denies).

alter table treasury_snapshots enable row level security;
create policy treasury_snapshots_anon_select on treasury_snapshots for select to anon using (
  exists (select 1 from agents a where a.id = treasury_snapshots.agent_id and a.public = true)
);
grant select on treasury_snapshots to anon;

alter table usage_events enable row level security;
create policy usage_events_anon_select on usage_events for select to anon using (
  exists (select 1 from agents a where a.id = usage_events.agent_id and a.public = true)
);
grant select on usage_events to anon;

alter table decisions enable row level security;
create policy decisions_anon_select on decisions for select to anon using (public = true);
grant select on decisions to anon;

alter table book_snapshots enable row level security;
-- book_snapshots has no agent_id (global, not per-agent) — see schema.ts RlsPolicy doc.
create policy book_snapshots_anon_select on book_snapshots for select to anon using (true);
grant select on book_snapshots to anon;

alter table orders enable row level security;
create policy orders_anon_select on orders for select to anon using (
  exists (select 1 from agents a where a.id = orders.agent_id and a.public = true)
);
grant select on orders to anon;

alter table treasury_events enable row level security;
create policy treasury_events_anon_select on treasury_events for select to anon using (
  exists (select 1 from agents a where a.id = treasury_events.agent_id and a.public = true)
);
grant select on treasury_events to anon;

alter table chain_snapshots enable row level security;
create policy chain_snapshots_anon_select on chain_snapshots for select to anon using (
  exists (select 1 from agents a where a.id = chain_snapshots.agent_id and a.public = true)
);
grant select on chain_snapshots to anon;

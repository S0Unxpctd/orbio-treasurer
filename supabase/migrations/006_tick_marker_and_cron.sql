-- S-06 (Sprint 1.0, docs/PRD-1.0-sprint.md §4 T-6, §6) — hand-written delta migration, same
-- reason as 005: gen-sql.ts always renders the FULL target schema for 001-004, which is right
-- for a fresh project but a no-op against the already-migrated real Supabase project (001-004
-- applied 2026-09-09, 005 applied since for S-02's tables). Two deltas that project still needs:
--
--  1. `treasury_events.kind`'s CHECK constraint doesn't have 'tick' yet — add it (Postgres has no
--     `ADD CONSTRAINT ... IF NOT EXISTS`, so this drops-then-adds by the constraint's own default
--     name, `<table>_<column>_check`, confirmed against a fresh 001-003 apply locally).
--  2. The `treasurer-tick` cron job (004_cron.sql) still calls `net.http_post` with header
--     `x-cron-secret` against `current_setting('app.cron_secret')` — this ticket's route is
--     `POST /api/tick` with header `x-tick-secret` = env `TICK_SECRET` (tasks/S-06.md "In
--     scope"), a distinct name from the older T-002-era `CRON_SECRET`/`x-cron-secret` pair (never
--     reused — a stale `app.cron_secret` Postgres setting must not silently satisfy the new
--     header). `cron.schedule()` with an *existing* job name updates that job in place (pg_cron's
--     own documented upsert-by-name behaviour) — no `cron.unschedule()` needed first.
--
-- Every statement here is safely re-runnable (AC7: "applies twice without error"): the CHECK
-- constraint drop is `if exists`, the add is preceded by that drop, and `cron.schedule()` is
-- itself idempotent by job name.

-- --- 1. treasury_events.kind: add 'tick' -------------------------------------------------------
alter table treasury_events drop constraint if exists treasury_events_kind_check;
alter table treasury_events add constraint treasury_events_kind_check
  check (kind in ('settle','claim','activate','buy','stake','mode_change','alert','dry_run','tick'));

-- --- 2. re-point the cron job at /api/tick with x-tick-secret ----------------------------------
-- pg_cron/pg_net are not installed in this sandbox (same scope note as 004_cron.sql/T-002) — this
-- statement is checked for syntax/content only here (packages/core/src/ledger/migration-006.test.ts),
-- proven for real only on the hosted Supabase project (docs/runbook.md's two `alter database ...`
-- statements set `app.tick_url`/`app.tick_secret` once).
select cron.schedule(
  'treasurer-tick',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.tick_url'),
    headers := jsonb_build_object(
      'x-tick-secret', current_setting('app.tick_secret'),
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

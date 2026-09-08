-- GENERATED FILE — do not hand-edit.
-- Source: packages/core/src/ledger/schema.ts
-- Regenerate: pnpm --filter @orbio-treasurer/core gen:sql
-- Hosted-reference tick schedule (FR-10.1, ARCHITECTURE §7, probe P-8).
-- app.tick_url and app.cron_secret are Postgres settings, set by docs/runbook.md via
-- 'alter database ... set app.tick_url = ...' (or per-session in the Supabase dashboard).
-- They are NEVER hard-coded in this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'treasurer-tick',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.tick_url'),
    headers := jsonb_build_object(
      'x-cron-secret', current_setting('app.cron_secret'),
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

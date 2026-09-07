# Runbook

## Deploy

1. `pnpm db:migrate` (Supabase CLI logged into the `orbio-treasurer` project).
2. Push to `main` → Vercel builds `apps/web`. Preview deploys on PRs.
3. Confirm the cron job targets the production URL: `select * from cron.job;` → command contains `NEXT_PUBLIC_SITE_URL/api/cron/tick`.
4. `curl -X POST -H "x-cron-secret: …" $SITE/api/cron/tick` once by hand; check `/status`.

## Secrets

Set by So only, in Vercel (Production + Preview) and Supabase Vault. Names in `ARCHITECTURE.md §6`. Rotation: change the value, redeploy, confirm `/status` shows a fresh tick. Orbio key rotation is automatic (`KEY_ROTATE`); the MCP OAuth token is manual.

## Going live (money moves) — checklist

Execute in order; paste each result in the L2 ticket (T-033).

- [ ] ≥ 24h of dry-run history for the agent: `select count(*) from treasury_snapshots where agent_id=… and as_of > now()-interval '24h'` ≥ 90
- [ ] `LiveBookClient` fixtures recorded and `T-013` round-trip evidence present
- [ ] Caps confirmed by So in the ticket: `max_buy_usd_per_day`, `max_spend_usd_per_day`, `min_list_discount`, `reserve_days`
- [ ] Dedicated wallet balance confirmed on Blockscout; nothing else in it
- [ ] `TREASURER_LIVE=true` and `BOOK_CLIENT=live` set in Production only
- [ ] Redeploy; watch `/status` and the decision feed for one hour; first `BUY_CREDIT`/`LIST_SURPLUS` verified on the book

## Rollback

Set `TREASURER_LIVE=false` → redeploy. Open orders: cancel via `pnpm tick --cancel-open` (dry-run prints what it would cancel; add `--yes`). The ledger is append-only; nothing to restore.

## Incident notes

_(dated)_

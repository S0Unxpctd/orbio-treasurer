# Runbook

## Deploy

1. Enable `pg_cron` and `pg_net` on the Supabase project, then `pnpm db:migrate`.
2. Push to `main` → Vercel builds `apps/web`. Preview deploys on PRs. Tick route: `runtime = 'nodejs'`, `maxDuration = 60`.
3. Confirm the cron job targets production: `select * from cron.job;` → command contains `NEXT_PUBLIC_SITE_URL/api/cron/tick`.
4. `curl -X POST -H "x-cron-secret: …" $SITE/api/cron/tick` once by hand; check `/status`.

## Secrets

Set by So only, in Vercel (Production + Preview) and Supabase Vault. Names in `ARCHITECTURE.md §6`. The agent wallet private key (`AGENT_WALLET_PK`, L2a only) and the Orbio key live in env only. Rotation: change the value, redeploy, confirm `/status` shows a fresh tick. Orbio key rotation is automatic (`KEY_ROTATE`); the MCP OAuth token is manual (see probe P-1 for its lifetime).

## Going live (money moves) — checklist

Applies to `STAKE_CLIENT=uniswap` (L2a, ticket T-021) and `BOOK_CLIENT=orbio` (L2b, ticket T-033). Execute in order; paste each result in the ticket.

- [ ] Gate probe passed and recorded in `docs/api-notes.md` (P-7 for stake; Orbio's endpoint documented for buy)
- [ ] ≥ 24h of dry-run history with `would_have` decisions for that action: `select count(*) from decisions where agent_id=… and type in ('STAKE_UP','BUY_CREDIT') and executed=false and at > now()-interval '24h'` > 0, and ≥ 90 snapshots in 24h
- [ ] Round-trip script evidence present (`roundtrip-stake.ts` $5 / `roundtrip-buy.ts` $1), run only after So's `ok live` in the ticket
- [ ] Caps confirmed by So in the ticket: `max_stake_usd_per_day`, `max_buy_usd_per_day`, `max_spend_usd_per_day`, `max_slippage_pct`, `stable_reserve_usd`
- [ ] Dedicated wallet balances confirmed on Blockscout (stablecoin reserve + $ORBIO position); nothing else in it
- [ ] `TREASURER_LIVE=true` plus the relevant client flag set in Production only
- [ ] Redeploy; watch `/status` and the decision feed for one hour; first executed order verified on Blockscout (stake) or on the key's quota (buy)

## Rollback

Set `TREASURER_LIVE=false` → redeploy. The ledger is append-only; nothing to restore. Open buy orders (L2b) are resolved by Orbio; note their ids in the incident entry.

## Incident notes

_(dated)_

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

## Gateway (S-01) — quick curl

`GATEWAY_KEYS` (comma-separated `otk_<32 hex>`), `ORBIO_GATEWAY_BASE_URL` and `ORBIO_KEY` must be
set. List the catalog (no auth) and route one call through `model: "auto"`:

```
curl "$SITE/v1/models" | jq '.data[].id'

curl -s "$SITE/v1/chat/completions" \
  -H "Authorization: Bearer otk_00000000000000000000000000000000" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"one sentence: is the treasury healthy?"}]}' \
  -D - -o /tmp/resp.json
# response headers include x-treasurer-model / -tier / -reason / -cost-usd / -baseline-usd
```

## Chain 4663 read (S-03) — addresses, RPCs, quick CLI

Every address below is PRD §3, live-verified 2026-09-19 (docs/api-notes.md "S-03 chain reads").
They live in env (`.env.example`), never as literals in source (CLAUDE.md #5) — `chain/contracts.ts`'s
`loadChainAddresses()` reads and checksum-validates all 7 at once.

| Var | Address | What |
|---|---|---|
| `CREDIT_ADDRESS` | `0xe33322da1380e61e5ae5dfb21e7f62924c73004c` | CREDIT (ERC-20, 6 dec, 1 CREDIT = $1 inference) |
| `STAKING_ADDRESS` | `0xe0710011278bfb63e57c5f227e5980984b1eddca` | Staking (ABI hand-written, unpublished — `packages/core/abi/staking.json`) |
| `EXCHANGE_ADDRESS` | `0x6951ffd32630b05e06f50062aea801625a58ebc0` | Exchange (getQuote/buy/buyAndActivate) |
| `PAYOUT_ADDRESS` | `0x4cbbbf652b11ed1294df0ac49d8322394310cfc5` | Payout |
| `ORBIO_ADDRESS` | `0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3` | $ORBIO (18 dec) |
| `USDG_ADDRESS` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | USDG (6 dec, EIP-3009). **Discovered**: the PRD doc's own printed casing for this address is not a valid EIP-55 checksum (one char wrong) — the value here is the correct checksum; `getAddress()` accepts either input casing and always resolves to this one. |
| `NVDA_ADDRESS` | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | Tokenized NVIDIA stock (Uniswap v4 pool pair for ORBIO, T-7) |

RPC fallback (`RH_RPC_URLS`, comma-separated, ordered): `https://robinhood-rpc.publicnode.com`
first, `https://rpc.ordofi.network` second — both confirmed live 2026-09-19, no rate limit hit.
The official `https://rpc.mainnet.chain.robinhood.com` is deliberately not in the default list
(PRD §3: 429s after 2-3 calls). Multicall3 (standard CREATE2 address
`0xca11bde05977b3631167028862be2a173976ca11`) IS deployed on 4663 — `readTreasury()` batches
all 9 non-ETH reads through it and only falls back to sequential reads if the multicall call
itself fails.

```
pnpm treasury:read
```

Prints the current snapshot (staked ORBIO, settled/claimable CREDIT, CREDIT/USDG/ETH wallet
balances, the live 10-USDG book quote, staking totals, and — if `ORBIO_GATEWAY_BASE_URL` and
either `TREASURER_PRIVATE_KEY` or `ORBIO_KEY` are set — the gateway's `/key` balance) as one
redacted JSON object, addresses shortened. Read-only; never sends a transaction.

`TREASURER_PRIVATE_KEY` (and `STAKER_PRIVATE_KEY`, once So confirms the staking wallet is
dedicated — PRD §9 Q1) are the only S-03 secrets; both are 0x + 64-hex, validated by `env.ts` at
boot (name-only errors, CLAUDE.md #4), never logged (`redact()` masks both the raw hex shape and
the `sk-orb-...` key `deriveOrbioKey()` derives from it).

## Tick loop (S-06) — deploy, keys, local dry-run

Migration `006_tick_marker_and_cron.sql` adds `'tick'` to `treasury_events.kind`'s CHECK and
re-points the existing `treasurer-tick` cron job (004) at `POST /api/tick` with header
`x-tick-secret` (replacing the older `/api/cron/tick` + `x-cron-secret` pair above, which this
ticket's route does not implement — `app/api/tick/route.ts` is the only tick endpoint now).
`pg_cron`/`pg_net` are not installed in this sandbox, so the cron statement is checked for syntax
only here (`packages/core/src/ledger/migration-006.test.ts`); it only takes effect once applied
against the hosted Supabase project.

1. `pnpm db:migrate` (applies 006; safe to re-run — every statement in it is idempotent, AC7).
2. Set `TICK_SECRET` in Vercel (Production + Preview) to a fresh random value — this is the
   value `x-tick-secret` must equal; unset or mismatched → every `POST /api/tick` 401s.
3. On the Supabase project, once, as the project owner (not from this sandbox — `pg_cron`/`pg_net`
   aren't installed here):
   ```sql
   alter database postgres set app.tick_url = 'https://<production-domain>/api/tick';
   alter database postgres set app.tick_secret = '<same value as Vercel TICK_SECRET>';
   ```
   Confirm with `select * from cron.job where jobname = 'treasurer-tick';` — the command should
   reference `app.tick_url`/`app.tick_secret` (migration 006's body), running every 15 min.
4. Smoke-test by hand once: `curl -X POST -H "x-tick-secret: $TICK_SECRET" $SITE/api/tick` → 200
   + a JSON summary (bucket, mode, previousMode, modeChanged, action counts — no secrets, AC8).
5. `REFERENCE_AGENT_SLUG` (default `treasurer`) is both the agent `runTick()` ticks and the agent
   whose `chain_snapshots.mode` the gateway's router reads (`app/v1/_gateway.ts`, 60 s cache) — only
   set it if you renamed that agent. `TREASURER_MODE`, if set, always overrides the ledger-derived
   mode (tests/manual override only — leave it unset in normal operation).

Local dry-run, no route/cron needed: `pnpm tick` runs one tick against `LEDGER_SQLITE_PATH`'s
agent (`REFERENCE_AGENT_SLUG`), prints the redacted summary, never sends a transaction
(`TREASURER_LIVE` must already be `false`/unset — the CLI itself has no `--live` flag and cannot
flip it).

Caller keys backed by the ledger (S-02's `caller_keys` table, checked before the `GATEWAY_KEYS`
env fallback): `pnpm keys:create --label <x> [--agent <slug>]` inserts a new `otk_<32 hex>` key
and prints the raw value exactly once — copy it immediately, it is not stored anywhere in
readable form afterward (only its hash and `key_prefix`/`key_last4`).

## Rollback

Set `TREASURER_LIVE=false` → redeploy. The ledger is append-only; nothing to restore. Open buy orders (L2b) are resolved by Orbio; note their ids in the incident entry.

## Incident notes

_(dated)_

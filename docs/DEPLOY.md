# DEPLOY.md — repo on GitHub to live page + first live tick

For So. Follow in order. Every step that touches money is marked **[live]** — do not run it
without the `ok live` line already written in the relevant ticket (`PROCESS.md` §5, `CLAUDE.md`
rule 5).

## 1. GitHub

The sandbox pushes to `S0Unxpctd/orbio-treasurer` when it has push access; when it doesn't, it
leaves commits as bundles under `.sync/` and says so in `STATUS.md`. If there are bundles
waiting: `git fetch .sync/<bundle-name> main:main-from-sandbox && git merge main-from-sandbox`,
then push yourself. Confirm: `git log --oneline -5` on `main` shows the latest ticket commits.

## 2. Supabase

1. If the project shows **INACTIVE** in the dashboard, restore it first (Supabase pauses free
   projects after inactivity) and wait for it to go **ACTIVE**.
2. Apply migrations `005` and `006` (everything up to `004` was already applied on 2026-09-09).
   Two ways — either works, the Management API path is what was used in the sandbox on Sept 9
   because the sandbox has HTTPS egress only, no direct Postgres port:
   - **From your own machine** (has a real Postgres connection): `pnpm db:migrate` (runs
     `supabase db push`).
   - **Management API** (same method as Sept 9, works from anywhere with HTTPS): for each new
     file in `supabase/migrations/` (`005_*.sql`, `006_*.sql`, in order),
     ```
     curl -X POST "https://api.supabase.com/v1/projects/<project-ref>/database/query" \
       -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>" \
       -H "content-type: application/json" \
       --data-binary @- <<'EOF'
     {"query": "<paste the migration file's SQL here, as one JSON string>"}
     EOF
     ```
     `<SUPABASE_ACCESS_TOKEN>` is a personal access token from the Supabase account dashboard
     (Account → Access Tokens), not `SUPABASE_SERVICE_ROLE_KEY`. Confirm each call returns `201`.
3. Verify: in the SQL editor,
   ```sql
   select * from cron.job where jobname = 'treasurer-tick';
   ```
   should show one row, schedule `*/15 * * * *`. It errors on every run until step 4 below sets
   `app.tick_url`/`app.tick_secret` — harmless (visible in `cron.job_run_details`), or pause it
   first with `update cron.job set active = false where jobname = 'treasurer-tick';`.

## 3. Vercel — project settings

- Framework Preset: **Next.js**.
- Root Directory: **`apps/web`**.
- Install Command: leave the default — Vercel detects the pnpm workspace (`pnpm-workspace.yaml`
  at the true repo root) and installs from there automatically even with Root Directory set to a
  subfolder.
- Build Command (override the default): **`cd ../.. && pnpm --filter @orbio-treasurer/web... build`**
- Output Directory: leave the default (`.next`, relative to Root Directory).

### Why this exact command (verified locally, 2026-09-19)

Next 16 defaults to Turbopack, but `apps/web/next.config.ts` has a webpack-only `config.resolve`
fix (S-08 Discovered — TS's `.js`-specifier convention needs `extensionAlias`, which Turbopack
doesn't read the same way). Plain `next build` fails immediately:
```
⨯ ERROR: This build is using Turbopack, with a `webpack` config and no `turbopack` config.
```
`apps/web/package.json`'s `build` script is `next build --webpack`, confirmed clean:
```
▲ Next.js 16.3.4 (webpack)
✓ Compiled successfully in 10.3s
  Route (app)
  ┌ ƒ /
  ├ ○ /_not-found
  ├ ƒ /api/agents
  ├ ƒ /api/health
  ├ ƒ /api/stats
  ├ ƒ /api/tick
  ├ ƒ /v1/chat/completions
  └ ƒ /v1/models
```
But `apps/web` also needs `@orbio-treasurer/core`'s `dist/` built first (it imports the package
by name, not by source path) — a bare `next build` inside `apps/web` alone does not build its
workspace dependency. `pnpm --filter @orbio-treasurer/web... build` (the `...` suffix means "this
package and everything it depends on") builds `@orbio-treasurer/core` first, then `apps/web`, in
one command, confirmed from a clean `dist/`/`.next`:
```
packages/core build$ tsc -p tsconfig.json && ...
packages/core build: Done
apps/web build$ next build --webpack
apps/web build: ✓ Compiled successfully in 10.2s
apps/web build: Done
```
Run from `apps/web` itself (as Vercel does with Root Directory set that way), it's
`cd ../.. && pnpm --filter @orbio-treasurer/web... build` — confirmed to produce `apps/web/.next`
in place, exit 0.

## 4. Cron wiring

Once the Vercel deployment has a URL:
```sql
alter database postgres set app.tick_url = 'https://<vercel-host>/api/tick';
alter database postgres set app.tick_secret = '<same value as Vercel TICK_SECRET, below>';
```
Re-run the `cron.job` check from step 2.3 — the command now resolves both settings and the next
scheduled run (every 15 min) should succeed with no `current_setting` error in
`cron.job_run_details`.

## 5. Environment variables (Vercel — Production + Preview)

Every variable this table doesn't list is not needed for this deployment — see "Not set for
this deploy" below for why, one line per variable, so nothing here silently disappears.

| Variable | Required? | Example / value | Where it comes from |
|---|---|---|---|
| `LEDGER` | required | `postgres` | fixed — the hosted app never uses SQLite |
| `DATABASE_URL` | required | `postgres://...supabase.co:5432/postgres` | Supabase → Project Settings → Database → Connection string |
| `SUPABASE_URL` | required | `https://<ref>.supabase.co` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | required | a long JWT-shaped secret | Supabase → Project Settings → API (service_role, secret) |
| `ORBIO_GATEWAY_BASE_URL` | required | `https://api.orbio.so/api/v1` | fixed, PRD §3 |
| `TREASURER_PRIVATE_KEY` | required | `0x` + 64 hex | the hot wallet's key — So generates and holds this |
| `STAKER_ADDRESS` | required | `0x` + 40 hex | the staking wallet's address (may equal the hot wallet's) |
| `STAKER_PRIVATE_KEY` | optional | `0x` + 64 hex | only if the staking wallet is dedicated (PRD §9 Q1) — enables automated settle/claim/activate (S-04); unset means manual fallback |
| `RH_RPC_URLS` | required | `https://robinhood-rpc.publicnode.com,https://rpc.ordofi.network` | fixed, live-verified `docs/api-notes.md` "S-03 chain reads" |
| `CREDIT_ADDRESS` | required | `0xe33322da1380e61e5ae5dfb21e7f62924c73004c` | PRD §3 |
| `STAKING_ADDRESS` | required | `0xE0710011278BFb63E57C5f227E5980984B1EDDca` | PRD §3 |
| `EXCHANGE_ADDRESS` | required | `0x6951ffd32630b05e06f50062aea801625a58ebc0` | PRD §3 |
| `ORBIO_ADDRESS` | required | `0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3` | PRD §3 |
| `USDG_ADDRESS` | required | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | PRD §3 (corrected checksum casing — see `docs/api-notes.md` "S-03 chain reads" Discovered) |
| `NVDA_ADDRESS` | required | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | PRD §3 |
| `PAYOUT_ADDRESS` | required | `0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5` | PRD §3 |
| `TICK_SECRET` | required | a fresh random string | generate yourself (`openssl rand -hex 32`); also goes into the `alter database` statement in step 4 |
| `REFERENCE_AGENT_SLUG` | optional (default `treasurer`) | `treasurer` | only set if you renamed the reference agent |
| `GATEWAY_KEYS` | optional fallback | `otk_...,otk_...` | comma list of caller keys, checked only when a key isn't found in the DB-backed `caller_keys` table (`pnpm keys:create`) |
| `ORBIO_KEY` | optional | an Orbio-issued API key | alternative to deriving a key from `TREASURER_PRIVATE_KEY`; the derived key wins if both are set |
| `TREASURER_LIVE` | required | `false` | **leave `false`** until So writes `ok live <ticket>` — see step 7 |
| `BUY_MAX_USDG_PER_TX` | optional (default in `policy/defaults.ts`) | `10` | may only lower the code default, per ticket |
| `BUY_MAX_PER_DAY` | optional | `1` | may only lower the code default |
| `ACTIVATE_MAX_PER_DAY` | optional | `50` | may only lower the code default |
| `MAX_FEE_GWEI` | optional | — | may only lower the code default (gas ceiling) |
| `MIN_GAS_ETH` | optional | — | may only raise the code default (gas floor) |
| `STAKER_MIN_GAS_ETH` | optional | — | same, for the staker wallet's own sends |
| `STAKING_SETTLE_PERIODS` | optional | — | manual override; leave unset (period discovery works, `docs/api-notes.md` "S-04 period discovery") |
| `STAKING_LAST_PERIOD_HINT` | optional | — | speed hint only |
| `ROUTER_ALLOW` | optional | — | restrict the router's model catalog; leave unset for "every catalog id allowed" |
| `TREASURER_MODE` | optional | — | forces `normal`/`eco`/`critical`; leave unset in normal operation |
| `RH_CHAIN_ID` | optional (default `4663`) | `4663` | never needs setting for this chain |
| `LEDGER_SQLITE_PATH` | not used | — | SQLite-only var; the hosted app runs `LEDGER=postgres` |

### Not set for this deploy

These `env.ts` variables exist for other configurations and don't apply here:

- `ORBIO_MCP_URL`, `ORBIO_MCP_TOKEN`, `ORBIO_MCP_REFRESH_TOKEN`, `ORBIO_MCP_TOKEN_EXPIRES_AT`,
  `ORBIO_MCP_CLIENT_ID` — the MCP client (`packages/core/src/mcp/`) is frozen and obsolete for
  Sprint 1.0 (`CLAUDE.md` banner); nothing reads these at runtime.
- `RH_RPC_URL` (singular), `UNISWAP_ROUTER`, `UNISWAP_QUOTER`, `ORBIO_TOKEN`, `STABLE_TOKEN`,
  `AGENT_WALLET_PK` — the legacy `STAKE_CLIENT=uniswap` gate from the pre-sprint PRD. This
  deployment leaves `STAKE_CLIENT` at its default (`none`); the sprint's stake-up leg (S-07) is
  blocked on Yash for a confirmed swap entrypoint (P-7b, `docs/api-notes.md`) and ships as a
  manual-fallback alert in the meantime, not this env-gated path.
- `ORBIO_BOOK_READ_URL`, `ORBIO_BUY_URL`, `ORBIO_BUY_TOKEN` — the legacy `BOOK_CLIENT=orbio` gate.
  This sprint's book quote comes from `Exchange.getQuote()` via a live chain read, not this path.
- `LANDING_URL`, `LANDING_AGENT_TOKEN` — the old MCP-era landing push. Superseded by this app's
  own `/api/agents`.
- `CRON_SECRET` — superseded by `TICK_SECRET` (S-06 repoints the cron job at `/api/tick` with
  `x-tick-secret`, replacing the older `/api/cron/tick` + `x-cron-secret` pair this var gated).
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` — `apps/book-daily` (obsolete,
  superseded by `examples/daily-digest`, which posts through an optional plain webhook, no X SDK
  or keys needed).
- `NEXT_PUBLIC_SITE_URL` — declared in `env.ts`, not read anywhere in this sprint's code (the
  tick route and the page don't need to know their own public URL at runtime).

## 6. Smoke test

```
SMOKE_BASE_URL=https://<vercel-host> pnpm smoke
```
Checks `/` (200, footer sentence present verbatim), `/api/stats` (200, required JSON fields),
`/api/agents` (200 GET, 401 on an unauthenticated POST). Then, once, by hand:
```
curl -X POST -H "x-tick-secret: $TICK_SECRET" https://<vercel-host>/api/tick
```
Expect `200` and a JSON summary (`bucket`, `mode`, `previousMode`, `modeChanged`, action counts —
never a secret). This runs the tick in dry-run (since `TREASURER_LIVE=false`); it writes a
`chain_snapshots` row and, if any policy condition would fire, a `dry_run` `treasury_events` row
with a reason — visible on the page's Proof block, greyed out.

## 7. First live tick — **[live]**

Only after **So has written `ok live S-06`** (or the relevant ticket) in that ticket file.

1. Confirm on `robin.etherscan.io` (search the hot wallet address):
   - ETH balance ≥ `0.005`.
   - USDG balance ≥ `10`.
   - If `STAKER_PRIVATE_KEY` is set, the staker wallet holds a staking position
     (`Staking.positionOf(staker) > 0`) — `pnpm treasury:read` prints this.
2. Set `TREASURER_LIVE=true` in Vercel (Production only), redeploy.
3. Run one tick by hand from your own shell (not the sandbox — it never sees `TREASURER_LIVE=true`
   or a real private key):
   ```
   pnpm tick
   ```
   Expect: if there's claimable CREDIT, a `claim` then `activate` `treasury_events` row, each
   with a real `tx_hash`; if runway is short, a `buy` row with a `tx_hash`; if the stake-up
   threshold is hit and P-7b is still blocked, a `stakeup` `alert` row with a deep link (no tx —
   manual fallback, expected). Every row should show up on the page's Proof block within the
   60-second cache window, linked to `robin.etherscan.io/tx/<hash>`.
4. To flip live off again: set `TREASURER_LIVE=false` in Vercel, redeploy. The ledger is
   append-only; nothing to roll back. Note any open item in the ticket's *Discovered* section.

## 8. Seed the reference agent (once, before the first tick)

```
pnpm seed:agent
```
Idempotent — creates the `REFERENCE_AGENT_SLUG` agent row if it doesn't exist yet, no-ops if it
does. Doing this before the first tick/cron fire avoids the race S-06's tester noted: two
concurrent first-ever ticks both trying to create the same agent row. `pnpm seed:agent --with-key
--label demo` also prints one caller key, shown once — save it immediately.

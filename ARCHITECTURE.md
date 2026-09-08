# Architecture

Companion to `PRD.md`. This file locks the technical decisions so the coding agent never re-opens them mid-week. Changes go through an ADR in `adr/`.

## 1. Stack (locked)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, strict mode | One language for lib, CLI, site, bot |
| Package manager / monorepo | pnpm workspaces + Turborepo | Fast, simple, standard |
| Web + API | Next.js 16 (App Router, Route Handlers) on Vercel — current major at scaffold time (T-001) | Public URL in minutes; edge caching for read endpoints |
| Ledger (kit agents) | **SQLite** via `better-sqlite3`, one file, created on first run | Zero provisioning; a builder must never need a database account to run the kit (ADR-002) |
| Ledger (hosted reference + landing) | Supabase Postgres, RLS on, service role for writes | Managed, free tier enough, Vault for secrets, pg_cron |
| Scheduling (hosted) | **Supabase Cron (pg_cron + pg_net)** → `POST /api/cron/tick` every 15 min with `x-cron-secret` | Vercel Hobby cron is once per day; Supabase runs every minute if needed |
| Scheduling (kit) | In-process `setInterval` tick every 15 min, plus `pnpm tick` for one-shot | No infra assumption about the builder's host |
| Chain access (L2a) | `viem` against a Robinhood Chain RPC; Uniswap router/quoter addresses from env | Standard EVM tooling; addresses verified by probe P-7, never hard-coded |
| LLM SDK | Vercel AI SDK (`ai` + `@openrouter/ai-sdk-provider` pointed at the Orbio gateway base URL) | Named in the brief; middleware hook for metering |
| MCP client | `@modelcontextprotocol/sdk` (Streamable HTTP transport) | Official; Orbio MCP is HTTP |
| Validation | Zod at every boundary (env, API in/out, adapter outputs) | Adapter outputs from a 1-week-old API must be validated |
| Tests | Vitest (unit, integration with fixtures), Playwright (smoke on deployed URLs) | Fast; table-driven tests for the policy engine |
| Lint/format | Biome | One tool |
| CLI | `create-orbio-agent` built with `citty` + `giget`-style template copy | Tiny, no framework |
| X posting | X API v2 `POST /2/tweets` with OAuth 1.0a user context (free tier write) | Verify current free-tier limits on day 4 |
| Charts | None this week (cut in PRD 0.2) | Tables and the widget carry the numbers |

Nothing else gets added without an ADR. If a library is missing, prefer writing 30 lines over adding a dependency.

## 2. Repository layout

```
orbio-treasurer/
├── PRD.md  ARCHITECTURE.md  PROCESS.md  CLAUDE.md  STATUS.md
├── adr/                         # architecture decision records (ADR-000-template.md)
├── docs/
│   ├── api-notes.md             # everything learned about Orbio's real API shapes, with raw samples
│   └── runbook.md               # how to deploy, rotate secrets, go live, roll back
├── tasks/                       # ticket backlog (see PROCESS.md)
├── packages/
│   ├── core/                    # @orbio-treasurer/core
│   │   └── src/
│   │       ├── ledger/          # LedgerStore interface; sqlite/ and postgres/ implementations; shared schema + tests
│   │       ├── mcp/             # OrbioMcpClient + balance fallback (gateway key-info | estimate)
│   │       ├── book/            # BookClient interface, ReadOnlyBookClient, OrbioAgenticBuyClient (L2b), mock/, fixtures/
│   │       ├── stake/           # StakeClient interface, UniswapStakeClient (L2a), fixtures/
│   │       ├── metering/        # AI SDK middleware → usage_events ; pricing table fallback
│   │       ├── policy/          # evaluate(), defaults, rules (pure), humanize()
│   │       ├── executors/       # apply Decision[] : route, buy, stake, signal, rotate, alert
│   │       ├── tick.ts          # one tick = snapshot → evaluate → execute → log
│   │       ├── treasurer.ts     # public API: createTreasurer(config) → { model(), tick(), status() }
│   │       └── redact.ts        # mandatory secret redaction for loggers
│   └── create-orbio-agent/      # CLI + templates/{minimal,x-bot}
├── apps/
│   ├── web/                     # Next.js: landing, agent detail pages, widget, badge, public API, registry, cron route
│   └── book-daily/              # the demo X bot, generated FROM the kit (template x-bot), then committed
├── scripts/
│   ├── probes/                  # P-1 … P-8, one file each, 30-minute yes/no checks; output pasted to docs/api-notes.md
│   └── roundtrip-*.ts           # $1 buy (L2b) / $5 swap (L2a) live proofs; refuse to run without TREASURER_LIVE=true
└── supabase/
    ├── migrations/              # SQL, numbered
    └── seed.sql
```

The reference Treasurer (So's own agent) is `apps/book-daily`: the bot *is* the reference agent. One wallet, one key, one process.

## 3. Runtime topology

```
                 every 15 min
Supabase Cron ─────────────────▶ apps/web  POST /api/cron/tick  (secret, nodejs, maxDuration 60)
                                    │  for each agent hosted here (book-daily):
                                    ▼
                          core.tick(agentCtx)
              ┌─────────────┼──────────────┬───────────────┐
              ▼             ▼              ▼               ▼
        OrbioMcpClient  BookClient    LedgerStore        Executors
        get_balance     getBook()     snapshots          route / buy / stake
        key_status      StakeClient   usage_events       signal / rotate / alert
                                      decisions
                                      book_snapshots

External agents (built with the kit) run their own tick on their own schedule
and PUSH public metrics:   POST /api/registry/:slug/push  (agent token)

Readers:  GET /api/agents/:slug/status · /embed/:slug · /badge/:slug.svg · site pages
```

Kit agents (`LEDGER=sqlite`) run the same `core.tick()` in-process on a 15-minute interval and push only public metrics to the landing.

Key design points:

- **The tick is idempotent.** It is keyed by `(agent_id, floor(now, 15min))`; a duplicate call is a no-op. Cron retries are safe.
- **Policy is pure.** `evaluate()` takes plain objects and returns `Decision[]`. Executors are the only place with side effects. This is what makes the audit and test steps cheap.
- **Adapters validate.** Every external payload (MCP, book, X, pricing) is parsed with Zod; unknown shapes are logged (redacted) to `docs/api-notes.md` candidates and fail the tick loudly rather than writing garbage.
- **Two deploy targets, one codebase.** `apps/web` hosts the reference agent's tick for simplicity. Kit-generated agents are self-hosted (Vercel or anywhere Node runs) and only push metrics.

## 4. The three seams

Everything uncertain sits behind an interface; the policy engine imports none of the implementations.

```ts
export interface LedgerStore { /* insert-only repos + orders.status; same for sqlite and postgres */ }

export interface BookClient {
  readonly capabilities: { read: 'api' | 'json' | 'none'; buy: boolean; list: boolean };
  getBook(): Promise<BookView | null>;
  buy(req: BuyRequest): Promise<OrderResult>;     // throws NotSupported if !buy
  list(req: ListRequest): Promise<OrderResult>;   // throws NotSupported if !list — reserved for v2 (cross-venue selling); no implementation this week
}

export interface StakeClient {
  readonly capabilities: { swap: boolean };
  balances(): Promise<{ stableUsd: number; orbio: bigint }>;
  quote(stableUsd: number): Promise<{ orbioOut: bigint; priceImpactPct: number; route: string }>;
  swap(stableUsd: number, minOrbioOut: bigint): Promise<TxResult>;   // throws NotSupported if !swap
}
```

- `LEDGER=sqlite|postgres`. Kit default `sqlite`. The hosted reference and the landing use `postgres`.
- `BOOK_CLIENT=readonly|orbio`. `readonly` reads via `ORBIO_BOOK_READ_URL` (official) or the observed JSON endpoint (fixtures dated), or returns `null` when neither exists (probe P-3). `orbio` = `OrbioAgenticBuyClient`, enabled only after Orbio ships, the `$1 round-trip` passes, and So writes `ok live`.
- `STAKE_CLIENT=none|uniswap`. `uniswap` enabled only after probe P-7 passes, 24h of dry-run with `would_have` stake decisions, the `$5 round-trip` passes, and So writes `ok live`.

Executors translate unavailable capabilities into `SIGNAL_FUND` decisions (deep link + copy-ready sentence) so the human can act in one click when the machine can't.

## 4a. Balance without the MCP (FR-2.0)

The MCP is designed for interactive clients; headless token lifetime is unknown until probe P-1. So the runtime never *depends* on it after boot:

```
boot:  mcp.create_key (once) → key in env/Vault
tick:  balance = try mcp.get_balance
               ?? try gateway.keyInfo(key)        # probe P-2, OpenRouter-compatible endpoint if present
               ?? estimate(last_known − metered_spend + expected_accrual)
       snapshot.balance_source = 'mcp' | 'gateway' | 'estimate'
```

Inference always goes through the key via the AI SDK; the MCP is a reporting and rotation channel, not a dependency for serving.

## 5. Metering and routing in the agent process

```ts
const t = createTreasurer(config);           // reads env, opens ledger, loads policy state
const model = t.model('frontier');           // resolves to a concrete model by current state
const res = await generateText({ model, prompt });   // AI SDK; middleware records usage_event
```

`t.model(tier)` wraps the provider with `wrapLanguageModel({ middleware: meteringMiddleware })`. State is read from the latest snapshot (cached 60s) so routing reacts within one tick of a state change. If `max_spend_usd_per_day` is exhausted, `t.model()` throws `BudgetExceeded`.

## 6. Environment variables

```
# core (every agent)
LEDGER=sqlite|postgres                           # kit default sqlite
LEDGER_SQLITE_PATH=./treasurer.db
ORBIO_MCP_URL=https://www.orbio.so/api/mcp
ORBIO_MCP_TOKEN                                  # OAuth token; env/Vault only; never in DB
ORBIO_GATEWAY_BASE_URL                           # OpenAI-compatible base for the Orbio key
ORBIO_KEY                                        # created once via MCP, then persisted here by the human (or Vault)
BOOK_CLIENT=readonly|orbio
ORBIO_BOOK_READ_URL, ORBIO_BUY_URL, ORBIO_BUY_TOKEN   # when known
STAKE_CLIENT=none|uniswap
RH_RPC_URL, RH_CHAIN_ID=4663, UNISWAP_ROUTER, UNISWAP_QUOTER, ORBIO_TOKEN, STABLE_TOKEN, AGENT_WALLET_PK   # L2a only; PK env only
TREASURER_LIVE=false                             # FR-4.5
LANDING_URL, LANDING_AGENT_TOKEN                 # registry push (kit)
# hosted only
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
NEXT_PUBLIC_SITE_URL
# book-daily
X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
```

All read through `env.ts` with Zod; the app refuses to boot on a missing required var and prints which one (name only).

## 7. Deployment

- `apps/web` → Vercel project `orbio-treasurer` (production = `main`). Preview deploys per PR. **Route handlers that run the tick declare `export const runtime = 'nodejs'` and `export const maxDuration = 60`** (the MCP SDK needs Node, and the default 10s timeout kills a tick). If probe P-5 fails, the reference tick moves to a small always-on worker (Railway/Fly) with the same code and one env change.
- Supabase: enable `pg_cron` and `pg_net` extensions before migration 004 (probe P-8 checks the round trip).
- Supabase project `orbio-treasurer`; migrations applied with `supabase db push` from CI or locally. Cron created by migration `00X_cron.sql` (`select cron.schedule('tick', '*/15 * * * *', $$ select net.http_post(...) $$)`).
- `packages/create-orbio-agent` → published to npm as `create-orbio-agent` on day 5 (So's npm account). Until then, tested via `pnpm --filter create-orbio-agent build && node dist/index.js`.
- Going live (L2 or live mode): follow `docs/runbook.md` → checklist requires 24h dry-run, caps confirmed, dedicated wallet balance confirmed.

## 8. Observability

Minimal, deliberate: structured JSON logs through one `log()` that redacts; `/status` page (FR-10.2); `ALERT_*` decisions double as alerts and are visible on the site. No third-party APM this week.

## 9. Conventions

- Files: `kebab-case.ts`; types: `PascalCase`; rule ids: `R-<AREA>-<n>`; decision types: `UPPER_SNAKE`.
- Money in USD as `number` in memory (6-dp rounding at boundaries), `numeric(18,6)` in DB. Token balances as `bigint` strings.
- Time: UTC in DB and API; Paris only for the X post schedule.
- Errors: typed (`NotSupported`, `BudgetExceeded`, `AdapterShapeError`); never swallow; a failed tick logs a decision `TICK_FAILED` with a redacted reason.
- Commits: `type(scope): summary` + ticket id, e.g. `feat(policy): R-BUY-1 deficit buy sizing [T-012]`.

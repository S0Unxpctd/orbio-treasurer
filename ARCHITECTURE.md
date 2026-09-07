# Architecture

Companion to `PRD.md`. This file locks the technical decisions so the coding agent never re-opens them mid-week. Changes go through an ADR in `adr/`.

## 1. Stack (locked)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, strict mode | One language for lib, CLI, site, bot |
| Package manager / monorepo | pnpm workspaces + Turborepo | Fast, simple, standard |
| Web + API | Next.js 15 (App Router, Route Handlers) on Vercel | Public URL in minutes; edge caching for read endpoints |
| Database | Supabase Postgres, RLS on, service role for writes | Managed, free tier enough, Vault for secrets, pg_cron |
| Scheduling | **Supabase Cron (pg_cron + pg_net)** → `POST /api/cron/tick` every 15 min with `x-cron-secret` | Vercel Hobby cron is once per day; Supabase runs every minute if needed |
| LLM SDK | Vercel AI SDK (`ai` + `@openrouter/ai-sdk-provider` pointed at the Orbio gateway base URL) | Named in the brief; middleware hook for metering |
| MCP client | `@modelcontextprotocol/sdk` (Streamable HTTP transport) | Official; Orbio MCP is HTTP |
| Validation | Zod at every boundary (env, API in/out, adapter outputs) | Adapter outputs from a 1-week-old API must be validated |
| Tests | Vitest (unit, integration with fixtures), Playwright (smoke on deployed URLs) | Fast; table-driven tests for the policy engine |
| Lint/format | Biome | One tool |
| CLI | `create-orbio-agent` built with `citty` + `giget`-style template copy | Tiny, no framework |
| X posting | X API v2 `POST /2/tweets` with OAuth 1.0a user context (free tier write) | Verify current free-tier limits on day 4 |
| Charts | Lightweight SVG via `recharts` on the agent page | Only where a number needs a trend |

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
│   │       ├── ledger/          # repositories over Supabase (append-only writers)
│   │       ├── mcp/             # OrbioMcpClient
│   │       ├── book/            # BookClient interface, SignalsBookClient, LiveBookClient, fixtures/
│   │       ├── metering/        # AI SDK middleware → usage_events ; pricing table fallback
│   │       ├── policy/          # evaluate(), defaults, rules (pure), humanize()
│   │       ├── executors/       # apply Decision[] : route, list, buy, rotate, alert
│   │       ├── tick.ts          # one tick = snapshot → evaluate → execute → log
│   │       ├── treasurer.ts     # public API: createTreasurer(config) → { model(), tick(), status() }
│   │       └── redact.ts        # mandatory secret redaction for loggers
│   └── create-orbio-agent/      # CLI + templates/{minimal,x-bot}
├── apps/
│   ├── web/                     # Next.js: aggregator, agent pages, widget, badge, public API, cron route
│   └── book-daily/              # the demo X bot, generated FROM the kit (template x-bot), then committed
└── supabase/
    ├── migrations/              # SQL, numbered
    └── seed.sql
```

The reference Treasurer (So's own agent) is `apps/book-daily`: the bot *is* the reference agent. One wallet, one key, one process.

## 3. Runtime topology

```
                 every 15 min
Supabase Cron ─────────────────▶ apps/web  POST /api/cron/tick  (secret)
                                    │  for each agent hosted here (book-daily):
                                    ▼
                          core.tick(agentCtx)
              ┌─────────────┼──────────────┬───────────────┐
              ▼             ▼              ▼               ▼
        OrbioMcpClient  BookClient    Ledger (Supabase)  Executors
        get_balance     getBook()     snapshots          route / list / buy
        key_status      (api|page)    usage_events       rotate / alert
                                      decisions
                                      book_snapshots

External agents (built with the kit) run their own tick on their own schedule
and PUSH public metrics:   POST /api/registry/:slug/push  (agent token)

Readers:  GET /api/agents/:slug/status · /embed/:slug · /badge/:slug.svg · site pages
```

Key design points:

- **The tick is idempotent.** It is keyed by `(agent_id, floor(now, 15min))`; a duplicate call is a no-op. Cron retries are safe.
- **Policy is pure.** `evaluate()` takes plain objects and returns `Decision[]`. Executors are the only place with side effects. This is what makes the audit and test steps cheap.
- **Adapters validate.** Every external payload (MCP, book, X, pricing) is parsed with Zod; unknown shapes are logged (redacted) to `docs/api-notes.md` candidates and fail the tick loudly rather than writing garbage.
- **Two deploy targets, one codebase.** `apps/web` hosts the reference agent's tick for simplicity. Kit-generated agents are self-hosted (Vercel or anywhere Node runs) and only push metrics.

## 4. The BookClient seam (the one uncertainty)

```ts
export interface BookClient {
  readonly capabilities: { read: 'api' | 'page'; write: boolean };
  getBook(): Promise<BookView>;
  getFills(since: Date): Promise<Fill[]>;
  buy(req: BuyRequest): Promise<OrderResult>;     // throws NotSupported if !write
  list(req: ListRequest): Promise<OrderResult>;   // throws NotSupported if !write
  cancel(externalId: string): Promise<void>;      // throws NotSupported if !write
}
```

- `BOOK_CLIENT=signals` → `SignalsBookClient` (read via API if `ORBIO_BOOK_READ_URL` is set, else via the public page parser with recorded fixtures). Executors turn `BUY_CREDIT` / `LIST_SURPLUS` into `SIGNAL_BUY` / `SIGNAL_LIST` decisions containing a deep link and a copy-ready sentence.
- `BOOK_CLIENT=live` → `LiveBookClient`. Only enabled after the day-1 `$1 round-trip` script (`scripts/roundtrip.ts`) succeeds and its output is recorded in `docs/api-notes.md`.

The policy engine never imports either implementation.

## 5. Metering and routing in the agent process

```ts
const t = createTreasurer(config);           // reads env, opens ledger, loads policy state
const model = t.model('frontier');           // resolves to a concrete model by current state
const res = await generateText({ model, prompt });   // AI SDK; middleware records usage_event
```

`t.model(tier)` wraps the provider with `wrapLanguageModel({ middleware: meteringMiddleware })`. State is read from the latest snapshot (cached 60s) so routing reacts within one tick of a state change. If `max_spend_usd_per_day` is exhausted, `t.model()` throws `BudgetExceeded`.

## 6. Environment variables

```
# core
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY          # server only
ORBIO_MCP_URL=https://www.orbio.so/api/mcp
ORBIO_MCP_TOKEN                                  # OAuth token, Vault or env; never in DB
ORBIO_GATEWAY_BASE_URL                           # OpenAI-compatible base for the Orbio key
BOOK_CLIENT=signals|live
ORBIO_BOOK_READ_URL, ORBIO_BOOK_WRITE_URL, ORBIO_BOOK_TOKEN   # when known
TREASURER_LIVE=false                             # FR-4.5
CRON_SECRET
# web
NEXT_PUBLIC_SITE_URL
# book-daily
X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
```

All read through `env.ts` with Zod; the app refuses to boot on a missing required var and prints which one (name only).

## 7. Deployment

- `apps/web` → Vercel project `orbio-treasurer` (production = `main`). Preview deploys per PR.
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

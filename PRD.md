# Orbio Treasurer — Product Requirements Document

| Field | Value |
|---|---|
| Version | 0.1 (hackathon scope) |
| Date | 2026-09-07 |
| Owner | So (product) · Claude (build) |
| Status | Draft, awaiting two answers from Orbio (see §14) |
| Event | Orbio Build Week — 7 days of build, projects public by day 7 |

This document is the single source of truth for what gets built. `ARCHITECTURE.md` says how, `PROCESS.md` says in what order and with which quality gates, `tasks/` breaks it into tickets. When a ticket and this PRD disagree, the PRD wins and the ticket gets fixed.

---

## 1. One-liner

**Orbio Treasurer gives any AI agent a treasury that funds its own inference from a $ORBIO position, and proves it in public.**

The agent holds $ORBIO, collects the inference credits its holdings earn every hour through the Orbio MCP, measures what it burns, and runs a deterministic policy: route to cheaper models when runway gets tight, buy the cheapest credit on the Orbio book when in deficit, list surplus credit when it has more than it needs. Every agent exposes a live "proof of self-funding" widget, and a public site aggregates every agent deployed with the kit.

## 2. Context: what Orbio is (facts as of 2026-09-07)

- Orbio is a credit market for AI inference. **50% of every trading fee $ORBIO collects is converted into OpenRouter credits and distributed to holders**, split by time-weighted balance, each hour.
- Holders spend those credits through an Orbio API key (one key, all of OpenRouter: every model, image/video, web search, PDFs/audio, TTS, sandboxed shell, structured outputs) or **sell unused credit on an order book**; buyers get the same models 10–80% under list price. Holder surplus sells are **paid in USDG within minutes**. Third-party OpenRouter-key sellers are paid via Whop on a 7-day settlement.
- The token lives on **Robinhood Chain** (explorer: Blockscout). Launched 2026-08-31, ~$15M market cap, 950M supply, top 10 wallets ≈ 36% of supply. ~$46k credits distributed all-time; ~$12k of credit listed on the book. **The book is thin: liquidity on both sides is the ecosystem's bottleneck.**
- The **Orbio MCP** (`https://www.orbio.so/api/mcp`, HTTP transport, OAuth) exposes four tools: `orbio_get_balance`, `orbio_create_key`, `orbio_get_key_status`, `orbio_revoke_key`. Tagline: *"let your agent keep itself funded."* There is **no MCP tool to buy or list on the book** as of today (see §14).
- The founder's stated thesis (X, 2026-09-07): distribution before decentralization; the target buyer is the retail dev who "switches to a cheaper key only if switching costs almost nothing"; the product should get "into as many hands as it can reach."
- Hackathon: hold 1,000+ $ORBIO to enter, $100 of inference per builder, +20% boost on holder credits during the week, 8M $ORBIO prize pool (10 winners), no published judging criteria ("Seven days. Ten winners. No rules."), projects must be public by day 7. Other entrants are building: a smart-money indexer for trading agents, a token-launch audit agent for Robinhood Chain, a trenches trading desktop.

## 3. Problem

An autonomous agent has a cost line, inference, that grows faster than the value it produces, and nobody manages it. There is no budget, no runway forecast, no arbitrage across models or venues, and nothing happens when the balance runs out except the agent stopping. Orbio makes this problem solvable for the first time: an agent can *own an income-producing asset* ($ORBIO) that pays its inference, and a *market* where the gap between income and spend can be closed in either direction. But today a holder has to do all of that by hand: check the dashboard, create a key, watch usage, decide to sell or buy, click.

The people this hits are exactly the population Orbio is built for: solo devs and vibecoders running agents on retail-priced inference with no procurement function.

## 4. Goals and non-goals

### Goals (hackathon)

1. **Make the flywheel legible.** Stake → credits/hour → tokens burned → % of cost covered, live, on a public widget, with verifiable on-chain and book references.
2. **Thicken the book from both sides.** Treasurers buy when in deficit and list when in surplus, under caps a human sets. Every Treasurer is a small, honest market participant.
3. **Make it a kit, not a demo.** `npx create-orbio-agent` scaffolds a self-funded agent in one command. At least one agent not built by So runs on it by day 7.
4. **Prove it works *because of* Orbio,** not because of access to OpenRouter: zero top-ups, unattended continuity, credit-driven throughput.

### Non-goals (explicitly out of scope for the week)

- Any LLM in the decision loop. Policy is deterministic rules. The LLM is used only to write the demo bot's daily post and, optionally, to render a decision as a sentence.
- A generic multi-provider FinOps product (OpenRouter direct, Anthropic, OpenAI keys). Orbio is the only venue this week. The adapter design leaves the door open; nothing is built behind it.
- A local HTTP proxy that intercepts arbitrary OpenAI-compatible traffic. Metering is SDK-side (§8.3).
- Custody of anyone else's funds or keys. Each agent runs its own wallet, its own MCP auth, its own Orbio key. The aggregator stores public metrics only.
- Automatic USDG → $ORBIO rebuy. Designed as a policy action, shipped as **manual/off** unless a Robinhood Chain DEX route is trivially available on day 6 (cut list item #1).
- Voice, telephony, Telegram bot UIs. The demo agent is an X bot.
- Mobile apps, auth for spectators, multi-tenant dashboards with login. The aggregator is public and read-only.

## 5. Users

| Persona | What they want | How Treasurer serves them |
|---|---|---|
| **Agent builder (vibecoder)** — has an agent idea, an Orbio key from the hackathon, doesn't want to babysit a balance | Ship an agent that stays alive without top-ups; know when it's going to run dry | The kit, the policy engine, the widget on their own page |
| **$ORBIO holder** — earns credits hourly, uses some, leaves the rest idle | Turn idle credit into USDG without watching the book | Surplus listing under a reserve and a minimum discount |
| **Orbio team / judges** — need to see that builders extend the product | Proof that the MCP tagline is true and that the book gets volume | The aggregator: agents count, credits earned, book volume generated, decision feed |
| **Spectator on X** — crypto-native, skeptical | Verifiable numbers, not a pitch | Daily post from a bot that funds itself from the market it reports on; explorer and book links on every figure |

## 6. Product overview

Five deliverables, one repository (see `ARCHITECTURE.md` for layout):

1. **`@orbio-treasurer/core`** — the library. Ledger, metering, policy engine, MCP client, book adapter. Runs inside the agent's process or as a worker.
2. **Treasurer worker + public API** — the hourly tick (snapshot, evaluate policy, act, log), and read-only endpoints per agent.
3. **Widget** — embeddable status card (iframe + SVG badge + JSON), the "proof of self-funding."
4. **`create-orbio-agent`** — CLI that scaffolds an agent with the Treasurer wired in and registers it with the aggregator.
5. **Aggregator site** — public registry of all Treasurer-powered agents, network totals, live decision feed, one page per agent.

Plus the **demo agent**: *Orbio Book Daily*, an X bot posting the daily state of the book and holder distributions, funded entirely by its own treasury.

## 7. Scope by layer

Everything is built in three layers so that each is a defensible product on its own. Which layer ships as default depends on Orbio's answer about a book API (§14). The `BookClient` adapter (§8.5) is the seam.

| Layer | Depends on | What it delivers | Status |
|---|---|---|---|
| **L0 — Self-funding core** | Orbio MCP only (exists today) | Key lifecycle, accrual tracking, metering, burn rate, runway, credit-aware routing, decision log, widget | **Committed** |
| **L1 — Market intelligence** | Read access to the book (public page today; API preferred) | Book snapshots, price index per model, buy/list *signals* with deep links, daily X post | **Committed** (read via API if given, else via public page) |
| **L2 — Autonomous execution** | Write access to the book (buy, list, cancel) | Treasurer executes buys on deficit and listings on surplus, under caps | **Conditional** on §14 Q1. If no API: ship signals only, say so on the site |

## 8. Functional requirements

Requirement IDs (`FR-x.y`) are referenced by tickets in `tasks/`. Each has acceptance criteria (AC). "Must" = in scope this week; "Should" = build if the day's ticket finishes early; "Could" = cut list.

### 8.1 Treasury ledger

- **FR-1.1 (Must)** The ledger is append-only. Tables: `agents`, `treasury_snapshots`, `usage_events`, `decisions`, `book_snapshots`, `orders`, `key_meta`. Schema in §9. No row is ever updated except `agents.display_*` fields and `orders.status`.
  AC: attempting to update a `decisions` or `treasury_snapshots` row fails at the DB level (RLS/trigger).
- **FR-1.2 (Must)** Every hour (and on demand), a snapshot records: `credits_available_usd`, `credits_accrued_since_last_usd`, `key_spent_usd`, `key_remaining_usd`, `orbio_balance_tokens`, `orbio_price_usd` (best effort), `burn_rate_usd_per_day` (§8.3), `runway_days`, `coverage_ratio`.
  AC: 24 consecutive hourly snapshots exist for the reference agent with no gaps > 90 min.
- **FR-1.3 (Must)** `coverage_ratio = accrued_last_24h_usd / spent_last_24h_usd`, and `runway_days = credits_available_usd / max(burn_rate_usd_per_day - accrual_rate_usd_per_day, ε)`; if accrual ≥ burn, runway is displayed as `∞`.
  AC: table-driven unit tests cover zero burn, zero accrual, accrual > burn, and the ε floor.

### 8.2 Orbio MCP integration

- **FR-2.1 (Must)** An `OrbioMcpClient` wraps the four tools over HTTP transport with OAuth; tokens are stored encrypted (Supabase Vault or env), never logged, never returned by any API.
  AC: grep of logs and API responses in tests finds no secret material; a redaction test asserts key strings are masked to `sk-or-…last4`.
- **FR-2.2 (Must)** Key lifecycle: on first run, `orbio_create_key`; on each tick, `orbio_get_key_status`; if the key is missing/invalid/flagged, `orbio_revoke_key` then `orbio_create_key` (rotation), logged as a decision of type `KEY_ROTATE`.
  AC: simulated invalid key triggers rotation exactly once; balance is unchanged.
- **FR-2.3 (Must)** Accrual is derived from successive `orbio_get_balance` readings corrected for spend and orders in the interval. Any residual is logged as `reconciliation_delta`.
  AC: reconciliation delta on the reference agent is < 2% of accrual over 24h, or an alert decision is logged.

### 8.3 Metering and credit-aware routing

- **FR-3.1 (Must)** The core exports `treasurer.model(tier)` returning a Vercel AI SDK model bound to the agent's Orbio key, where `tier ∈ {frontier, standard, economy}` maps to a configurable model list per tier. The Treasurer picks the model within the tier based on the current policy state (§8.4).
  AC: with state `TIGHT`, `model('frontier')` returns the first *standard* model; with `DEFICIT`, it returns *economy*; with `COMFORTABLE`, the frontier model. Tested.
- **FR-3.2 (Must)** A middleware records every completed call as a `usage_event`: model, prompt/completion tokens, cost in USD (from OpenRouter pricing as returned by the gateway; fallback to a local price table), latency, tier requested vs. served.
  AC: 100% of calls made through `treasurer.model()` produce exactly one `usage_event`; calls that throw record `status = error` with no cost.
- **FR-3.3 (Must)** `burn_rate_usd_per_day` = spend over the trailing 24h, or over the whole history if < 24h old, annotated `low_confidence = true` until 6 hours of data exist.
- **FR-3.4 (Should)** A per-agent daily hard cap on spend (`policy.max_spend_usd_per_day`). When hit, `treasurer.model()` throws `BudgetExceeded` with a structured reason; the agent decides what to do.

### 8.4 Policy engine

- **FR-4.1 (Must)** The engine is a pure function `evaluate(snapshot, policy, bookView) → Decision[]`. No I/O, no LLM. Executors apply decisions and log results.
  AC: 100% branch coverage on `evaluate` via table-driven tests; the function is importable and runs in < 5 ms.
- **FR-4.2 (Must)** States by runway: `COMFORTABLE` (runway ≥ `comfortable_days`, default 7), `TIGHT` (≥ `tight_days`, default 3, and < comfortable), `DEFICIT` (< tight). `∞` runway is `COMFORTABLE`.
- **FR-4.3 (Must)** Actions per state:
  - `COMFORTABLE`: routing = frontier. If `credits_available > reserve + surplus_threshold`, emit `LIST_SURPLUS` for `credits_available − reserve`, at `max(best_ask_discount − 2%, min_list_discount)`, where `reserve = burn_rate × reserve_days` (default 5).
  - `TIGHT`: routing = standard. No trades. Emit `ALERT_TIGHT` once per state entry.
  - `DEFICIT`: routing = economy. Emit `BUY_CREDIT` for `min(need, max_buy_usd_per_day − bought_today)`, where `need = (tight_days × burn_rate) − credits_available`, targeting the deepest discount on the book with sufficient size. If cap exhausted or book empty, emit `ALERT_DEFICIT_UNFUNDED`.
- **FR-4.4 (Must)** Defaults (`policy.defaults.ts`): `comfortable_days 7`, `tight_days 3`, `reserve_days 5`, `min_list_discount 30%`, `max_buy_usd_per_day 10`, `max_spend_usd_per_day 15`, `mode dry_run`, `rebuy_orbio off`. All overridable per agent in `treasurer.config.ts`.
- **FR-4.5 (Must)** Two modes. `dry_run`: decisions are logged with `executed = false` and a `would_have` payload. `live`: executors run. **Live mode requires an explicit `TREASURER_LIVE=true` env var and at least 24h of dry-run history**, else the worker refuses to start live and logs why.
- **FR-4.6 (Must)** Every decision row stores: type, state before/after, the rule id that fired, the numeric inputs, the action payload, execution result, and a one-line human string rendered from a template (not an LLM).
  AC: a decision can be fully re-derived from its stored inputs by re-running `evaluate`.
- **FR-4.7 (Should)** Hysteresis: a state change requires two consecutive ticks in the new state, except into `DEFICIT`, which is immediate.

### 8.5 Book adapter

- **FR-5.1 (Must)** Interface `BookClient` with `getBook(): BookView`, `getFills(since)`, and, behind a `capabilities` flag, `buy(model?, usd, maxPrice)`, `list(usd, discount)`, `cancel(orderId)`. Two implementations:
  - `SignalsBookClient` — reads only (public page or read API). Write methods throw `NotSupported`; executors convert `BUY_CREDIT`/`LIST_SURPLUS` into `SIGNAL_*` decisions with a **deep link** to the exact action on orbio.so and a `copy-ready` summary.
  - `LiveBookClient` — full read/write against the Orbio book API, once its shape is known (`docs/api-notes.md`).
  AC: the policy engine and executors have zero knowledge of which implementation is active; swapping is one env var (`BOOK_CLIENT=signals|live`).
- **FR-5.2 (Must)** `BookView` normalizes: per model (or per key listing if the book is not per-model): best discount, depth at each discount step (2% increments, 10–80%), total available USD, timestamp, source (`api|page`). A `book_snapshot` is stored on every tick.
- **FR-5.3 (Must, L2 only)** Order lifecycle: `pending → filled|partial|cancelled|failed`, with the returned order id, fill price, fees. A `LIST_SURPLUS` order that is unfilled after `list_ttl_hours` (default 24) is cancelled and re-priced 2% deeper, once, then left.
- **FR-5.4 (Must, L2 only)** Day-1 proof: before any other L2 work, a scripted **$1 buy and $1 list round-trip** runs against the live API and its results are pasted into `docs/api-notes.md`. No L2 ticket starts before this passes.

### 8.6 Widget and public API

- **FR-6.1 (Must)** `GET /api/agents/:slug/status` returns JSON: identity (name, wallet short, explorer link), stake, accrual/hour, burn/day, coverage ratio, runway, state, last 5 decisions (human strings), book position (open orders count and USD), uptime, `as_of`. Cache 60s. No auth.
- **FR-6.2 (Must)** `GET /embed/:slug` renders the status card as a standalone page suitable for an iframe (light/dark aware, ≤ 400×220 default). `GET /badge/:slug.svg` renders a shields-style badge: `self-funded · 91% covered · runway 12d`.
- **FR-6.3 (Must)** Every figure that has a source links to it: wallet → Blockscout, balance → Orbio dashboard, orders → book, decision → decision detail page.
- **FR-6.4 (Should)** `GET /api/agents/:slug/decisions?since=` and `/snapshots?since=` for anyone who wants to chart it.

### 8.7 Starter kit: `create-orbio-agent`

- **FR-7.1 (Must)** `npx create-orbio-agent my-agent` produces a runnable TypeScript project: `treasurer.config.ts` (policy, tiers, wallet, aggregator opt-in), `agent.ts` (a minimal loop using `treasurer.model()`), `README`, `.env.example`, and a `vercel.json`/worker entry so the tick runs on a schedule.
  AC: fresh machine, `npx create-orbio-agent demo && cd demo && cp .env.example .env && pnpm dev` → the agent makes one call and the local status endpoint reports it, in under 5 minutes, without editing code.
- **FR-7.2 (Must)** First boot registers the agent with the aggregator (`POST /api/registry`) using a generated agent token; the aggregator only ever receives public metrics (`FR-8.2`). Opt-out flag in config.
- **FR-7.3 (Must)** The kit ships in `dry_run` with a banner explaining the 24h rule (`FR-4.5`).
- **FR-7.4 (Should)** Template variants: `--template x-bot` (the demo agent), `--template minimal`.

### 8.8 Aggregator site

- **FR-8.1 (Must)** Home: network totals (agents live, $ORBIO staked by agents, credits earned by agents all-time and last 24h, inference spent, average coverage, book volume generated by Treasurers), a list of agents with their badges, and a live decision feed (public strings only).
- **FR-8.2 (Must)** Agents push metrics; the aggregator never holds keys, tokens, or wallets' private material. Push payload = the same shape as `FR-6.1` plus new decisions since last push, signed with the agent token. Replay-protected by `as_of`.
- **FR-8.3 (Must)** Agent page: the widget large, 7-day charts (accrual vs. spend, runway, coverage), decision log with rule ids, open orders, links (repo, X, explorer).
- **FR-8.4 (Must)** A "How it works" section that explains the flywheel in one diagram and links to the kit, the MCP, and Orbio's docs. This section doubles as the hackathon submission page.
- **FR-8.5 (Should)** Public "Inference Index" page: best discount per model over time, depth, and holder distributions per day (from `book_snapshots` and the leaderboard), with a JSON endpoint.

### 8.9 Demo agent: Orbio Book Daily (X bot)

- **FR-9.1 (Must)** Once a day at a fixed hour (Paris time), reads the latest `book_snapshot` and the leaderboard total, and posts a ≤ 280-char status: best discount per top-3 models, total credit available, credits distributed to holders in 24h, plus one line: *"This post cost $0.0X. Paid by my treasury: N $ORBIO → $Y/h."* Post copy is written by an LLM through `treasurer.model('economy')`; the numbers are injected from the ledger, never generated.
  AC: a numbers-in-text validator asserts every figure in the post equals the ledger value it came from; a mismatch blocks the post and logs `POST_BLOCKED`.
- **FR-9.2 (Must)** The bot is built *from the kit* (`--template x-bot`), not hand-wired, so it is also the kit's integration test.
- **FR-9.3 (Should)** Posts a second time only on notable events: state change to `DEFICIT`, a fill, a new agent joining the aggregator.

### 8.10 Operations

- **FR-10.1 (Must)** The tick runs every 15 minutes (snapshot every tick; hourly aggregates computed from ticks). Scheduling is done by **Supabase Cron (pg_cron + pg_net)** calling `POST /api/cron/tick` with a shared secret, because Vercel Hobby limits cron to once per day. See `ARCHITECTURE.md`.
- **FR-10.2 (Must)** A `STATUS.md` in the repo and a `/status` route show: last tick time, ticks in last 24h, last error. A missed tick > 45 min creates an `ALERT_TICK_MISSED` decision.
- **FR-10.3 (Must)** All write endpoints require a secret; all read endpoints are rate-limited (60 req/min/IP) and cached.

## 9. Data model

Postgres (Supabase). All money columns are `numeric(18,6)` USD unless suffixed. All tables have `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`.

```
agents
  slug text unique, name text, wallet_address text, chain text default 'robinhood',
  repo_url text, x_handle text, template text, policy jsonb, mode text ('dry_run'|'live'),
  agent_token_hash text, public boolean default true, last_seen_at timestamptz

key_meta                        -- never the key itself
  agent_id fk, key_prefix text, key_last4 text, created_at, revoked_at, reason text

treasury_snapshots              -- append-only
  agent_id fk, as_of timestamptz, credits_available, credits_accrued_delta, key_spent_total,
  key_remaining, orbio_balance_tokens numeric(30,0), orbio_price_usd, accrual_rate_per_day,
  burn_rate_per_day, burn_low_confidence boolean, runway_days numeric null (null = ∞),
  coverage_ratio, state text, reconciliation_delta

usage_events                    -- append-only
  agent_id fk, at timestamptz, model text, tier_requested text, tier_served text,
  prompt_tokens int, completion_tokens int, cost_usd, latency_ms int, status text, error text

decisions                       -- append-only
  agent_id fk, at timestamptz, type text, rule_id text, state_before text, state_after text,
  inputs jsonb, action jsonb, executed boolean, result jsonb, human text, public boolean default true

book_snapshots                  -- append-only
  at timestamptz, source text ('api'|'page'), view jsonb, total_available_usd, best_discount_pct

orders                          -- status is the only mutable column
  agent_id fk, decision_id fk, side text ('buy'|'list'), model text null, usd, discount_pct,
  external_id text, status text, filled_usd, fee_usd, placed_at, resolved_at
```

Indexes on `(agent_id, as_of desc)`, `(agent_id, at desc)`, `(at desc)` for the feed. Row Level Security: anon role can `select` where `public = true`; only the service role writes. A trigger rejects `update`/`delete` on the four append-only tables.

## 10. Policy specification (normative)

```
inputs:  credits_available, accrual_rate_per_day, burn_rate_per_day, bought_today,
         open_list_usd, book.best_bid_discount, book.best_ask_discount, book.depth
derived: net_burn = max(burn - accrual, 0)
         runway   = net_burn == 0 ? ∞ : credits_available / net_burn
         reserve  = burn * reserve_days
state:   runway ≥ comfortable_days → COMFORTABLE
         runway ≥ tight_days       → TIGHT
         else                      → DEFICIT

COMFORTABLE:
  ROUTE(frontier)
  surplus = credits_available - reserve - open_list_usd
  if surplus ≥ surplus_min_usd (default 5):
     LIST_SURPLUS(usd = surplus, discount = clamp(best_ask_discount - 2, min_list_discount, 80))
TIGHT:
  ROUTE(standard); ALERT_TIGHT (once per entry)
DEFICIT:
  ROUTE(economy)
  need   = tight_days * burn - credits_available
  budget = max_buy_usd_per_day - bought_today
  if need > 0 and budget > 0 and book.depth_at_best ≥ 1:
     BUY_CREDIT(usd = min(need, budget), max_discount_accept = best_ask_discount)
  else ALERT_DEFICIT_UNFUNDED(reason)

always: if key invalid → KEY_ROTATE ; if tick gap > 45min → ALERT_TICK_MISSED
```

Rule ids are stable strings (`R-LIST-1`, `R-BUY-1`, `R-ROUTE-TIGHT`, …) and appear in the decision log and in tests.

## 11. Security and safety

- Secrets (MCP OAuth token, Orbio key, X tokens, cron secret, agent tokens) live in Vercel env / Supabase Vault. They are never written to the DB in clear, never logged, never returned. A redaction helper is mandatory in all loggers.
- Live mode is opt-in, gated by env + 24h dry-run history (`FR-4.5`). Buy cap defaults to $10/day. There is no path by which the Treasurer can spend more than `max_buy_usd_per_day` + `max_spend_usd_per_day` in a day.
- The aggregator is a metrics sink, not a controller: it cannot send instructions to agents.
- The X bot has a numbers validator (`FR-9.1`); it never posts a figure it did not read from the ledger.
- The reference Treasurer runs on a **dedicated wallet** holding only what the demo needs.

## 12. Success metrics (judging day)

| Metric | Target |
|---|---|
| Reference Treasurer continuous uptime | ≥ 96 hours by day 7, with ≤ 2 missed ticks |
| Decisions logged (all types) | ≥ 200, including ≥ 1 executed `BUY_CREDIT` or `LIST_SURPLUS` if L2 |
| Agents registered on the aggregator | ≥ 2, of which ≥ 1 not built by So |
| Daily X posts by the demo bot | ≥ 5 consecutive |
| Hackathon inference budget spent | < $30 of $100 (policy is rule-based; LLM only writes posts) |
| Kit time-to-first-call | < 5 min on a fresh machine (`FR-7.1`) |
| Everything on the site verifiable | 100% of figures link to explorer/book/ledger |

## 13. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| No book write API this week | Medium | L2 is conditional; L0+L1 ship regardless; the site states it plainly; ask early (§14) |
| Book read only via HTML page, brittle | Medium | `SignalsBookClient` isolates parsing; fixtures recorded on day 1; fall back to last good snapshot with `stale = true` |
| Hourly accrual too small to be legible on the widget | Medium | Size the reference stake from leaderboard yield; display per-day and cumulative alongside per-hour |
| Vercel Hobby cron once/day | Certain | Supabase Cron every 15 min (`FR-10.1`) |
| Burning the $100 in agentic loops | Medium | No LLM in policy; hard cap `max_spend_usd_per_day`; dry-run first |
| Solo builder, 7 days | Certain | Cut list is explicit (§15); L0 live by day 3 no matter what |
| Token volatility / fee volume drops mid-week | Medium | This is what the Treasurer is for; the widget shows the deficit response honestly |
| Overlap with other entrants | Low | Treasurer sits *under* other agents; offer the kit to them (collab > compete) |

## 14. Open questions (asked in the builders Telegram on 2026-09-07)

1. **Is there, or will there be this week, an API to buy or list credit on the book programmatically?** Determines whether L2 ships as `LiveBookClient` or `SignalsBookClient`. Also needed: auth model, rate limits, whether the book is per-model or per-listing, fee on fills.
2. **Are the $100 of hackathon inference on a separate key/balance from holder credits?** Determines whether the reference Treasurer's `credits_available` needs to exclude the grant, and how the demo's "coverage" is computed honestly (grant excluded from accrual).

Until answered, `BOOK_CLIENT=signals` is the default and the demo's coverage excludes any balance flagged as grant.

## 15. Timeline and cut list

Day-by-day plan lives in `tasks/README.md`. Milestones:

- **Day 1** — ledger, MCP client, book read, snapshots flowing; `$1 round-trip` if API exists.
- **Day 2** — policy engine tested; dry-run running.
- **Day 3** — reference Treasurer **live and public** (widget, status endpoint); announce.
- **Day 4** — X bot posting; index endpoints.
- **Day 5** — `create-orbio-agent` works on a fresh machine.
- **Day 6** — aggregator live; second agent (ideally external); L2 live if unlocked.
- **Day 7** — buffer, README, submission page, thread, short video.

Cut list, in order, if behind: (1) USDG→$ORBIO rebuy, (2) Inference Index page, (3) aggregator charts (keep the numbers), (4) kit template variants, (5) second demo agent by So (but not the external one — chase it). Never cut: live reference Treasurer, decision log, widget, one demo agent.

## 16. Demo script (day 7, ≤ 3 minutes)

1. Open the reference agent's page: stake, credits/hour, burn/day, coverage %, runway. Click the wallet → Blockscout. Click the balance → Orbio dashboard.
2. Scroll the decision log: show a `ROUTE` change and, if L2, a `BUY_CREDIT` with its fill on the book.
3. Open the X bot's latest post; show the "this post cost $0.0X, paid by my treasury" line and that every number matches the ledger.
4. `npx create-orbio-agent demo` on camera → agent appears on the aggregator within a minute.
5. Aggregator home: agents live, $ORBIO staked by agents, book volume generated. Close on the flywheel diagram.

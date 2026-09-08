# Orbio Treasurer — Product Requirements Document

| Field | Value |
|---|---|
| Version | 0.2 (hackathon scope, re-cut after Orbio's answer) |
| Date | 2026-09-08 |
| Owner | So (product) · Claude (build) |
| Status | Approved for build. One answer pending from Orbio (§14 Q3) |
| Event | Orbio Build Week — 7 days of build, projects public by day 7 |

**What changed in 0.2:** Orbio confirmed that buying credit off the book goes through a Whop checkout page (fiat or crypto) and is not agentic; they are building agentic buying themselves this week and encouraged "boilerplate + a project on top + landing + Loom." Consequences: we do **not** build buy/list execution; `BookClient.buy()` becomes an adapter for Orbio's upcoming endpoint; the agentic deficit response becomes **stake-up** (swap USDG → $ORBIO on a DEX, conditional on pool verification); the kit no longer requires Supabase (ledger abstraction, ADR-002); scope trimmed to one polished product (~20 tickets); a **fragility map with day-1 probes** is added (§13a).

This document is the single source of truth for what gets built. `ARCHITECTURE.md` says how, `PROCESS.md` says in what order and with which quality gates, `tasks/` breaks it into tickets. When a ticket and this PRD disagree, the PRD wins and the ticket gets fixed.

---

## 1. One-liner

**Orbio Treasurer gives any AI agent a treasury that funds its own inference from a $ORBIO position, and proves it in public.**

The agent holds $ORBIO, collects the inference credits its holdings earn every hour through the Orbio MCP, measures what it burns, and runs a deterministic policy: route to cheaper models when runway gets tight; when in deficit, grow its position (swap stablecoin → $ORBIO on a DEX, fully agentic, conditional) or buy credit through Orbio's agentic-buy endpoint the day it ships; alert and signal when it can do neither. Every agent exposes a live "proof of self-funding" widget that states its real coverage ratio, and a landing page lists every agent deployed with the kit.

The honest pitch: **the Treasurer manages the gap between what a position earns and what an agent burns, and shows it in public.** Not "free inference forever."

## 2. Context: what Orbio is (facts as of 2026-09-07)

- Orbio is a credit market for AI inference. **50% of every trading fee $ORBIO collects is converted into OpenRouter credits and distributed to holders**, split by time-weighted balance, each hour.
- Holders spend those credits through an Orbio API key (one key, all of OpenRouter: every model, image/video, web search, PDFs/audio, TTS, sandboxed shell, structured outputs) or **sell unused credit on an order book**; buyers get the same models 10–80% under list price. Holder surplus sells are **paid in USDG within minutes**. Third-party OpenRouter-key sellers are paid via Whop on a 7-day settlement.
- The token lives on **Robinhood Chain** (explorer: Blockscout). Launched 2026-08-31, ~$15M market cap, 950M supply, top 10 wallets ≈ 36% of supply. ~$46k credits distributed all-time; ~$12k of credit listed on the book. **The book is thin: liquidity on both sides is the ecosystem's bottleneck.**
- The **Orbio MCP** (`https://www.orbio.so/api/mcp`, HTTP transport, OAuth) exposes four tools: `orbio_get_balance`, `orbio_create_key`, `orbio_get_key_status`, `orbio_revoke_key`. Tagline: *"let your agent keep itself funded."* There is **no MCP tool to buy or list on the book**. Orbio (Yash, 2026-09-08): buying goes through a Whop checkout page, "you can buy with crypto on whop checkout page but thats not agentic… and thats the bottleneck… im trying to solve this, so agents can buy credits on their own, will have something this week."
- **Holder yield, order of magnitude (launch week):** ~$46k distributed over ~8 days across 950M tokens ≈ $0.00005 per token per week. 100k tokens (~$1,650) ≈ $5/week; 1M tokens ≈ $50/week. A daily X post on an economy model costs < $0.01/day. **Light agents are fully self-funded by a small position; heavy agents are not, and the product must say so.**
- The founder's stated thesis (X, 2026-09-07): distribution before decentralization; the target buyer is the retail dev who "switches to a cheaper key only if switching costs almost nothing"; the product should get "into as many hands as it can reach."
- Hackathon: hold 1,000+ $ORBIO to enter, $100 of inference per builder, +20% boost on holder credits during the week, 8M $ORBIO prize pool (10 winners), no published judging criteria ("Seven days. Ten winners. No rules."), projects must be public by day 7. Other entrants are building: a smart-money indexer for trading agents, a token-launch audit agent for Robinhood Chain, a trenches trading desktop.

## 3. Problem

An autonomous agent has a cost line, inference, that grows faster than the value it produces, and nobody manages it. There is no budget, no runway forecast, no arbitrage across models or venues, and nothing happens when the balance runs out except the agent stopping. Orbio makes this problem solvable for the first time: an agent can *own an income-producing asset* ($ORBIO) that pays its inference, and a *market* where the gap between income and spend can be closed in either direction. But today a holder has to do all of that by hand: check the dashboard, create a key, watch usage, decide to sell or buy, click.

The people this hits are exactly the population Orbio is built for: solo devs and vibecoders running agents on retail-priced inference with no procurement function.

## 4. Goals and non-goals

### Goals (hackathon)

1. **Make the flywheel legible.** Stake → credits/hour → tokens burned → % of cost covered, live, on a public widget, with verifiable on-chain and book references.
2. **Close the loop without a human, with what exists today.** Income is passive (hourly credits), spend control is agentic (routing, caps), reinvestment is agentic (DEX swap). The one non-agentic leg, buying credit, is Orbio's bottleneck; our adapter is ready for the endpoint they ship.
3. **Make it a kit, not a demo.** `npx create-orbio-agent` scaffolds a self-funded agent in one command with no external database. At least one agent not built by So runs on it by day 7.
4. **Prove it works *because of* Orbio,** not because of access to OpenRouter: zero top-ups, unattended continuity, credit-driven throughput. And be the first integrator of Orbio's agentic buying when it lands.

### Non-goals (explicitly out of scope for the week)

- **Buying or listing credit on the book.** Not agentic today (Whop checkout); Orbio is building it. We ship an adapter with a documented interface and integrate theirs when it exists.
- An inference price index, per-agent charts, and kit template variants beyond `minimal` and `x-bot`. Cut in 0.2 to keep one polished product.
- Any LLM in the decision loop. Policy is deterministic rules. The LLM is used only to write the demo bot's daily post and, optionally, to render a decision as a sentence.
- A generic multi-provider FinOps product (OpenRouter direct, Anthropic, OpenAI keys). Orbio is the only venue this week. The adapter design leaves the door open; nothing is built behind it.
- A local HTTP proxy that intercepts arbitrary OpenAI-compatible traffic. Metering is SDK-side (§8.3).
- Custody of anyone else's funds or keys. Each agent runs its own wallet, its own MCP auth, its own Orbio key. The landing stores public metrics only.
- Buying $ORBIO with anything other than stablecoin already in the agent's wallet. The Treasurer never bridges, never touches the owner's other assets.
- Voice, telephony, Telegram bot UIs. The demo agent is an X bot.
- Mobile apps, auth for spectators, multi-tenant dashboards with login. The landing is public and read-only.

## 5. Users

| Persona | What they want | How Treasurer serves them |
|---|---|---|
| **Agent builder (vibecoder)** — has an agent idea, an Orbio key from the hackathon, doesn't want to babysit a balance | Ship an agent that stays alive without top-ups; know when it's going to run dry | The kit, the policy engine, the widget on their own page |
| **$ORBIO holder** — earns credits hourly, wants them to do something | Put credits to work in an agent that manages itself | The kit; the policy that keeps the agent inside its means |
| **Orbio team / judges** — need to see that builders extend the product | Proof that the MCP tagline is true; an answer to "how do you remove the human"; a first integrator for agentic buying | The landing: agents count, credits earned, decision feed, stake-up flow; the buy adapter waiting for their endpoint |
| **Spectator on X** — crypto-native, skeptical | Verifiable numbers, not a pitch | Daily post from a bot that funds itself from the market it reports on; explorer and book links on every figure |

## 6. Product overview

One product, four visible parts, one repository (see `ARCHITECTURE.md` for layout):

1. **`@orbio-treasurer/core`** — the library. Ledger (pluggable: SQLite/file for kit agents, Postgres for the hosted reference), metering, policy engine, MCP client, book adapter, stake adapter. Runs inside the agent's process.
2. **Widget + public API** — embeddable status card (iframe + SVG badge + JSON), the "proof of self-funding," served by the landing for every registered agent.
3. **`create-orbio-agent`** — CLI that scaffolds an agent with the Treasurer wired in, no external database, and registers it with the landing.
4. **Landing** — one page: what it is, the flywheel diagram, the reference agent's widget large, the list of registered agents with badges, the live decision feed, the kit command, links. This page is the hackathon submission.

Plus the **demo agent**: *Orbio Book Daily*, an X bot posting the daily state of Orbio and its own treasury, built from the kit and funded entirely by its position.

## 7. Scope by layer

Everything is built in layers so that each is a defensible product on its own. The `BookClient` (§8.5) and `StakeClient` (§8.11) adapters are the seams.

| Layer | Depends on | What it delivers | Status |
|---|---|---|---|
| **L0 — Self-funding core** | Orbio MCP only (exists today) | Key lifecycle, accrual tracking, metering, burn rate, runway, credit-aware routing, decision log, widget, kit, landing | **Committed** |
| **L1 — Market awareness** | Read access to the book (official read endpoint preferred; observed JSON endpoint as fallback) | Book snapshots, best discount per model, buy *signals* with deep links, daily X post | **Committed if a read source exists by day 2**; otherwise the X post reports treasury + holder distributions only |
| **L2a — Stake-up** | A verified ORBIO/stablecoin pool on a Robinhood Chain DEX with usable liquidity; stablecoin in the agent's wallet | Deficit → swap stablecoin → $ORBIO under a daily cap, raising hourly accrual. Fully agentic today. | **Conditional** on probe P-7 (§13a). Designed regardless; shipped only if the probe passes |
| **L2b — Agentic buy** | Orbio's agentic-buy endpoint (Yash: "this week") | `BookClient.buy()` implementation; deficit → buy credit when cheaper than stake-up | **Conditional** on Orbio shipping. Adapter interface and tests ready from day 2; integrate the day it lands |

## 8. Functional requirements

Requirement IDs (`FR-x.y`) are referenced by tickets in `tasks/`. Each has acceptance criteria (AC). "Must" = in scope this week; "Should" = build if the day's ticket finishes early; "Could" = cut list.

### 8.1 Treasury ledger

- **FR-1.0 (Must)** The ledger is behind a `LedgerStore` interface with two implementations: `SqliteLedger` (default for kit agents; single file, zero setup, `better-sqlite3`) and `PostgresLedger` (Supabase; used by the hosted reference agent and the landing). Same schema, same append-only guarantees, same tests run against both.
  AC: the whole `core` test suite passes against both stores; a kit agent runs with no `SUPABASE_*` env var.
- **FR-1.1 (Must)** The ledger is append-only. Tables: `agents`, `treasury_snapshots`, `usage_events`, `decisions`, `book_snapshots`, `orders`, `key_meta`. Schema in §9. No row is ever updated except `agents.display_*` fields and `orders.status`.
  AC: attempting to update a `decisions` or `treasury_snapshots` row fails at the store level (trigger in Postgres; guarded repository + trigger in SQLite).
- **FR-1.2 (Must)** Every hour (and on demand), a snapshot records: `credits_available_usd`, `credits_accrued_since_last_usd`, `key_spent_usd`, `key_remaining_usd`, `orbio_balance_tokens`, `orbio_price_usd` (best effort), `burn_rate_usd_per_day` (§8.3), `runway_days`, `coverage_ratio`.
  AC: 24 consecutive hourly snapshots exist for the reference agent with no gaps > 90 min.
- **FR-1.3 (Must)** `coverage_ratio = accrued_last_24h_usd / spent_last_24h_usd`, and `runway_days = credits_available_usd / max(burn_rate_usd_per_day - accrual_rate_usd_per_day, ε)`; if accrual ≥ burn, runway is displayed as `∞`.
  AC: table-driven unit tests cover zero burn, zero accrual, accrual > burn, and the ε floor.

### 8.2 Orbio MCP integration

- **FR-2.1 (Must)** An `OrbioMcpClient` wraps the four tools over HTTP transport with OAuth; tokens are stored encrypted (Supabase Vault or env), never logged, never returned by any API.
  AC: grep of logs and API responses in tests finds no secret material; a redaction test asserts key strings are masked to `sk-or-…last4`.
- **FR-2.0 (Must)** **MCP-independent operation.** Once a key exists, the agent must keep running if the MCP is unreachable or its OAuth token has expired: inference goes through the key, not the MCP; remaining quota is read from the gateway's key-info endpoint if it exists (probe P-1), else estimated from metering. MCP unavailability is logged as `MCP_UNAVAILABLE` once per state entry and the widget shows `balance: estimated`.
  AC: with the MCP mocked as failing, 24 simulated ticks run, route, and log without error; the snapshot carries `balance_source = 'gateway'|'estimate'`.
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
  - `COMFORTABLE`: routing = frontier. No funding action. (Surplus listing is out of scope in 0.2, see §4.)
  - `TIGHT`: routing = standard. No funding action. Emit `ALERT_TIGHT` once per state entry.
  - `DEFICIT`: routing = economy. Compute `need = (tight_days × burn_rate) − credits_available`. Choose the funding action by cost, among the ones whose adapter is available:
    - `BUY_CREDIT` (L2b) if `book.buy` is available: cost per $1 of credit = `1 − best_discount`.
    - `STAKE_UP` (L2a) if `stake.swap` is available and `stable_balance ≥ min_swap_usd`: cost per $1/day of *added accrual* = `orbio_price / yield_per_token_per_day`; the engine converts it to an equivalent "days to cover need" and prefers it over buying only if `payback_days ≤ stake_payback_max_days` (default 30).
    - Otherwise `SIGNAL_FUND` with a deep link and a copy-ready sentence, and `ALERT_DEFICIT_UNFUNDED` once per state entry.
    Amounts are capped by `max_buy_usd_per_day − bought_today` and `max_stake_usd_per_day − staked_today` respectively.
- **FR-4.4 (Must)** Defaults (`policy.defaults.ts`): `comfortable_days 7`, `tight_days 3`, `max_buy_usd_per_day 10`, `max_stake_usd_per_day 10`, `min_swap_usd 5`, `stake_payback_max_days 30`, `max_slippage_pct 1.5`, `max_spend_usd_per_day 15`, `mode dry_run`. All overridable per agent in `treasurer.config.ts`.
- **FR-4.5 (Must)** Two modes. `dry_run`: decisions are logged with `executed = false` and a `would_have` payload. `live`: executors run. **Live mode requires an explicit `TREASURER_LIVE=true` env var and at least 24h of dry-run history**, else the worker refuses to start live and logs why.
- **FR-4.6 (Must)** Every decision row stores: type, state before/after, the rule id that fired, the numeric inputs, the action payload, execution result, and a one-line human string rendered from a template (not an LLM).
  AC: a decision can be fully re-derived from its stored inputs by re-running `evaluate`.
- **FR-4.7 (Should)** Hysteresis: a state change requires two consecutive ticks in the new state, except into `DEFICIT`, which is immediate.

### 8.5 Book adapter

- **FR-5.1 (Must)** Interface `BookClient` with `getBook(): BookView`, and, behind a `capabilities.write` flag, `buy(req): OrderResult`. Two implementations:
  - `ReadOnlyBookClient` — reads via the official read endpoint if Orbio provides one, else via the observed JSON endpoint behind the public page (fixtures recorded and dated; parser isolated). `buy()` throws `NotSupported`; executors convert `BUY_CREDIT` into `SIGNAL_FUND` with a **deep link** to the Whop checkout for the exact listing and a copy-ready summary.
  - `OrbioAgenticBuyClient` (L2b) — implements `buy()` against Orbio's agentic-buy endpoint the day it ships. Until then: interface, Zod schemas drafted from what Yash describes, and contract tests against a local mock so integration is a one-day ticket.
  AC: the policy engine and executors have zero knowledge of which implementation is active; swapping is one env var (`BOOK_CLIENT=readonly|orbio`).
- **FR-5.2 (Should)** `BookView` normalizes: per model (or per listing): best discount, depth at 2% steps, total available USD, timestamp, source. A `book_snapshot` is stored on every tick when a source exists. If no read source exists by day 2 (probe P-3), L1 degrades to "no book data" and the X post drops the book lines.
- **FR-5.3 (Must, L2b only)** Order lifecycle: `pending → filled|partial|failed`, with the returned order id, fill price, fees, and the credit actually landing on the key confirmed by the next `orbio_get_key_status`.
- **FR-5.4 (Must, L2b only)** Before enabling `orbio` in production, a scripted **$1 buy round-trip** runs against the live endpoint and its results are pasted into `docs/api-notes.md`, with So's `ok live` in the ticket first.

### 8.6 Widget and public API

- **FR-6.1 (Must)** `GET /api/agents/:slug/status` returns JSON: identity (name, wallet short, explorer link), stake, accrual/hour, burn/day, coverage ratio, runway, state, last 5 decisions (human strings), book position (open orders count and USD), uptime, `as_of`. Cache 60s. No auth.
- **FR-6.2 (Must)** `GET /embed/:slug` renders the status card as a standalone page suitable for an iframe (light/dark aware, ≤ 400×220 default). `GET /badge/:slug.svg` renders a shields-style badge: `self-funded · 91% covered · runway 12d`.
- **FR-6.3 (Must)** Every figure that has a source links to it: wallet → Blockscout, balance → Orbio dashboard, orders → book, decision → decision detail page.
- **FR-6.4 (Should)** `GET /api/agents/:slug/decisions?since=` and `/snapshots?since=` for anyone who wants to chart it.

### 8.7 Starter kit: `create-orbio-agent`

- **FR-7.1 (Must)** `npx create-orbio-agent my-agent` produces a runnable TypeScript project: `treasurer.config.ts` (policy, tiers, wallet, landing opt-in), `agent.ts` (a minimal loop using `treasurer.model()`), `README`, `.env.example`, a SQLite ledger file created on first run, and an in-process 15-minute tick. **No database to provision, no account to create beyond the Orbio MCP auth the builder already has.**
  AC: fresh machine, `npx create-orbio-agent demo && cd demo && cp .env.example .env && pnpm dev` → the agent makes one call and the local status endpoint reports it, in under 5 minutes, without editing code and without any `SUPABASE_*` variable.
- **FR-7.2 (Must)** First boot registers the agent with the landing (`POST /api/registry`) using a generated agent token; the landing only ever receives public metrics (`FR-8.2`). Opt-out flag in config.
- **FR-7.3 (Must)** The kit ships in `dry_run` with a banner explaining the 24h rule (`FR-4.5`).
- **FR-7.4 (Must)** Exactly two templates: `minimal` (default) and `x-bot` (the demo agent). No others this week.

### 8.8 Landing (the submission page)

- **FR-8.1 (Must)** One page, in this order: one-line pitch and the honest sub-line (§1); the flywheel diagram (inline SVG, light/dark); the reference agent's widget, large and live; network totals (agents live, $ORBIO held by agents, credits earned by agents all-time and last 24h, inference spent, average coverage ratio); the list of registered agents with badges; the live decision feed (public strings, rule ids); the kit command with a 5-line quickstart; links (repo, MCP, Orbio, X bot, explorer). No login, no charts.
- **FR-8.2 (Must)** Agents push metrics; the landing never holds keys, tokens, or wallets' private material. Push payload = the same shape as `FR-6.1` plus new decisions since last push, signed with the agent token. Replay-protected by `as_of`.
- **FR-8.3 (Must)** Agent detail page (`/a/:slug`): the widget, the decision log with rule ids and inputs, orders (buy/stake) with external links, links (repo, X, explorer). Plain tables, no charts.
- **FR-8.4 (Must)** Every claim on the page is backed by a ledger value or an external link. Stake-up is described per FR-11.4. If L2b is not live, the page says "agentic buying: waiting on Orbio's endpoint, adapter ready" in plain words.

### 8.9 Demo agent: Orbio Book Daily (X bot)

- **FR-9.1 (Must)** Once a day at a fixed hour (Paris time), reads its own latest snapshot, the leaderboard total and, if available, the latest `book_snapshot`, and posts a ≤ 280-char status: credits distributed to holders in 24h, its own treasury line (*"This post cost $0.00X. My position: N $ORBIO → $Y/day. Coverage: Z%."*), and, when book data exists, the best discount on the top models. Post copy is written by an LLM through `treasurer.model('economy')`; the numbers are injected from the ledger, never generated.
  AC: a numbers-in-text validator asserts every figure in the post equals the ledger value it came from; a mismatch blocks the post and logs `POST_BLOCKED`.
- **FR-9.2 (Must)** The bot is built *from the kit* (`--template x-bot`), not hand-wired, so it is also the kit's integration test.
- **FR-9.3 (Should)** Posts a second time only on notable events: state change to `DEFICIT`, an executed `STAKE_UP` or `BUY_CREDIT`, a new agent joining the landing.

### 8.11 Stake adapter (L2a, conditional on probe P-7)

- **FR-11.1 (Must if P-7 passes)** Interface `StakeClient` with `quote(stableUsd): {orbioOut, priceImpactPct, route}`, `swap(stableUsd, minOrbioOut): TxResult`, `balances(): {stable, orbio}`. Implementation `UniswapStakeClient` over `viem` against the verified Robinhood Chain pool; RPC and router addresses in env; the agent's private key in env only (never in the ledger, never logged), dedicated wallet.
  AC: fixtures for quote/swap; a `$5` live swap round-trip recorded in `docs/api-notes.md` with So's `ok live` first; the ledger `orders` row carries `side='stake'`, tx hash, `orbio_out`, `price_impact_pct`.
- **FR-11.2 (Must if P-7 passes)** Guards: `priceImpactPct ≤ max_slippage_pct`, `stableUsd ≤ max_stake_usd_per_day − staked_today`, `stable_balance − stableUsd ≥ stable_reserve_usd` (default 5), one swap per tick max, never swap in `dry_run`.
- **FR-11.3 (Must)** Yield estimate used by the policy: `yield_per_token_per_day` = the agent's own measured accrual per held token over the trailing 24h (falls back to a network-wide estimate from the leaderboard total ÷ supply, flagged `low_confidence`). The widget shows both the estimate and the honest payback in days.
- **FR-11.4 (Must)** The landing and widget label stake-up as what it is: a purchase of a volatile asset whose yield depends on trading volume. No APY figures; payback in days with a confidence flag.

### 8.10 Operations

- **FR-10.1 (Must)** The tick runs every 15 minutes (snapshot every tick; hourly aggregates computed from ticks). For the hosted reference agent, scheduling is done by **Supabase Cron (pg_cron + pg_net)** calling `POST /api/cron/tick` with a shared secret, because Vercel Hobby limits cron to once per day. Kit agents run the tick in-process (`setInterval` in a long-running Node process, or any scheduler the builder has). See `ARCHITECTURE.md`.
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
  agent_id fk, decision_id fk, side text ('buy'|'stake'), model text null, usd, discount_pct null,
  external_id text (order id or tx hash), status text, filled_usd, fee_usd, orbio_out numeric(30,0) null,
  price_impact_pct null, placed_at, resolved_at
```

`treasury_snapshots` additionally carries `balance_source text ('mcp'|'gateway'|'estimate')`, `stable_balance_usd`, and `yield_per_token_per_day` with `yield_low_confidence boolean`.

Indexes on `(agent_id, as_of desc)`, `(agent_id, at desc)`, `(at desc)` for the feed. Postgres: Row Level Security, anon role can `select` where `public = true`; only the service role writes. Both stores: a trigger rejects `update`/`delete` on the four append-only tables.

## 10. Policy specification (normative)

```
inputs:  credits_available, accrual_rate_per_day, burn_rate_per_day,
         bought_today, staked_today, stable_balance, orbio_price, yield_per_token_per_day,
         book.best_discount, book.depth_at_best, caps.book_write, caps.stake
derived: net_burn = max(burn - accrual, 0)
         runway   = net_burn == 0 ? ∞ : credits_available / net_burn
state:   runway ≥ comfortable_days → COMFORTABLE
         runway ≥ tight_days       → TIGHT
         else                      → DEFICIT

COMFORTABLE:  ROUTE(frontier)
TIGHT:        ROUTE(standard); ALERT_TIGHT (once per entry)
DEFICIT:
  ROUTE(economy)
  need = tight_days * burn - credits_available          # USD of credit the agent is short
  options = []
  if caps.book_write and book.depth_at_best ≥ 1:
     budget = max_buy_usd_per_day - bought_today
     if budget ≥ 1: options += BUY_CREDIT(usd = min(need, budget), cost_per_usd = 1 - best_discount)
  if caps.stake and stable_balance - stable_reserve ≥ min_swap_usd:
     budget = min(max_stake_usd_per_day - staked_today, stable_balance - stable_reserve)
     tokens = budget / orbio_price
     added_accrual_per_day = tokens * yield_per_token_per_day
     payback_days = budget / max(added_accrual_per_day, ε)
     if budget ≥ min_swap_usd and payback_days ≤ stake_payback_max_days:
        options += STAKE_UP(usd = budget, payback_days)
  if options empty: SIGNAL_FUND(deep_link, sentence); ALERT_DEFICIT_UNFUNDED (once per entry)
  else: pick BUY_CREDIT if present and need can be covered today, else STAKE_UP
        (rationale: credit closes the gap now; stake closes it over payback_days)

always: if key invalid → KEY_ROTATE ; if tick gap > 45min → ALERT_TICK_MISSED ;
        if mcp unreachable → MCP_UNAVAILABLE (once per entry), balance_source = gateway|estimate
```

Rule ids are stable strings (`R-BUY-1`, `R-STAKE-1`, `R-SIGNAL-1`, `R-ROUTE-TIGHT`, …) and appear in the decision log and in tests. `yield_per_token_per_day` comes from FR-11.3.

## 11. Security and safety

- Secrets (MCP OAuth token, Orbio key, X tokens, cron secret, agent tokens) live in Vercel env / Supabase Vault. They are never written to the DB in clear, never logged, never returned. A redaction helper is mandatory in all loggers.
- Live mode is opt-in, gated by env + 24h dry-run history (`FR-4.5`). Buy and stake caps default to $10/day each. There is no path by which the Treasurer can move more than `max_buy_usd_per_day` + `max_stake_usd_per_day` + `max_spend_usd_per_day` in a day.
- The agent's wallet private key (L2a) lives in env only, on a dedicated wallet funded with the stablecoin reserve and nothing else. The Treasurer never bridges and never touches other assets.
- The landing is a metrics sink, not a controller: it cannot send instructions to agents.
- The X bot has a numbers validator (`FR-9.1`); it never posts a figure it did not read from the ledger.
- The reference Treasurer runs on a **dedicated wallet** holding only what the demo needs.

## 12. Success metrics (judging day)

| Metric | Target |
|---|---|
| Reference Treasurer continuous uptime | ≥ 96 hours by day 7, with ≤ 2 missed ticks |
| Decisions logged (all types) | ≥ 200, including ≥ 1 executed `STAKE_UP` if L2a, ≥ 1 executed `BUY_CREDIT` if L2b |
| Coverage ratio of the reference agent | ≥ 100% (a light agent on a small position must be fully covered, or the pitch is wrong) |
| Agents registered on the landing | ≥ 2, of which ≥ 1 not built by So |
| Daily X posts by the demo bot | ≥ 5 consecutive |
| Hackathon inference budget spent | < $30 of $100 (policy is rule-based; LLM only writes posts) |
| Kit time-to-first-call | < 5 min on a fresh machine (`FR-7.1`) |
| Everything on the site verifiable | 100% of figures link to explorer/book/ledger |

## 13. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| MCP OAuth not usable headless / token expires | **High** | FR-2.0: the key spends, not the MCP; probe P-1 on day 1; gateway key-info or estimate fallback |
| Kit onboarding friction kills adoption by other builders | High (fixed) | ADR-002: SQLite ledger, zero provisioning; FR-7.1 5-minute AC |
| No book read source | Medium | L1 degrades gracefully; X post drops book lines; ask Yash for a read endpoint (§14 Q3) |
| Stake-up pool missing or illiquid | Medium | Probe P-7; L2a designed but not shipped; `SIGNAL_FUND` fallback |
| Hourly accrual too small to be legible on the widget | Medium | Light demo agent; display per-day and cumulative; honest coverage % |
| Serverless tick timeouts / cold starts | Medium | `maxDuration = 60`, Node runtime, idempotent bucket key |
| X developer app approval delay | Medium | Create the app on day 1 (probe P-6) |
| Burning the $100 in agentic loops | Medium | No LLM in policy; hard cap `max_spend_usd_per_day`; dry-run first |
| Solo builder, 7 days | Certain | ~20 tickets; cut list §15; day-3 target, day-4 hard limit for go-live |
| Token volatility / fee volume drops mid-week | Medium | This is what the Treasurer is for; the widget shows the deficit response honestly |
| Orbio ships agentic buying mid-week | Medium (good) | Adapter interface + mock contract tests ready by day 2; integration is one ticket |
| Overlap with other entrants | Low | Treasurer sits *under* other agents; offer the kit to them |

## 13a. Fragility map and day-1 probes

Every external dependency gets a **30-minute probe ticket on day 1**, before any code that depends on it. A probe answers one yes/no question, records the raw (redacted) evidence in `docs/api-notes.md`, and sets the default for the layer it gates. Nothing below is assumed until probed.

| # | Probe | Question | If yes | If no |
|---|---|---|---|---|
| **P-1** | MCP headless auth | Can a server process call `orbio_get_balance` for > 6h with the token obtained once? Is there a refresh token? | MCP is the balance source | `balance_source = gateway` (P-2) or `estimate`; MCP used only at boot for `create_key` |
| **P-2** | Gateway key info | Does the Orbio gateway expose an OpenRouter-compatible key-info/credits endpoint for the agent's key? | Remaining quota without MCP | Quota estimated from metering; widget says `estimated` |
| **P-3** | Book read | Is there an official read endpoint, or a stable JSON endpoint behind orbio.so the page fetches? | L1 committed | L1 = "no book data"; X post without book lines |
| **P-4** | Per-call cost | Does the gateway return `usage.cost` (or equivalent) per completion? | Metering exact | Local price table, flagged `estimated` |
| **P-5** | Serverless tick | Does one full tick (MCP + book + DB) complete in < 20s from a Vercel Node function with `maxDuration = 60`? | Hosted tick on Vercel | Move the reference tick to a tiny always-on worker (Railway/Fly) — one env change |
| **P-6** | X API | Is the developer app approved and can it post once from a script? | Bot ships day 4 | Bot posts via a fallback (Typefully/Buffer API) or the daily post is a landing feed entry |
| **P-7** | Stake pool | Does an ORBIO/stablecoin pool exist on a Robinhood Chain DEX with ≥ $50k liquidity and < 1.5% impact on a $10 swap? RPC and router addresses known? | L2a ships (after 24h dry-run + So's ok) | L2a designed, not shipped; deficit → `SIGNAL_FUND` |
| **P-8** | pg_cron → Vercel | Does `net.http_post` from Supabase reach the preview route with the secret every 15 min? | Cron as designed | GitHub Actions schedule (5-min granularity) as interim |

**Solid by construction** (no probe needed): policy engine (pure), ledger schema, redaction, public read API, widget, kit scaffolding.

## 14. Open questions

1. ~~Book buy/list API?~~ **Answered 2026-09-08 (Yash):** no; buying goes through Whop checkout (fiat or crypto), not agentic; Orbio is building agentic buying "this week." → L2b conditional adapter.
2. **Are the $100 of hackathon inference on a separate key/balance from holder credits?** Still open. Until answered, the demo's coverage excludes any balance flagged as grant.
3. **Is there a read endpoint for the book (or may we use the page's JSON endpoint)?** Asked 2026-09-08. Gates L1 (probe P-3).
4. **Is listing holder surplus agentic today?** Asked 2026-09-08. Out of scope either way this week; informs the roadmap section on the landing.

## 15. Timeline and cut list

Day-by-day plan lives in `tasks/README.md`. Milestones:

- **Day 1** — **all eight probes first**, then ledger (both stores), MCP client with fallback, snapshots flowing.
- **Day 2** — policy engine tested; executors; metering; dry-run running; buy-adapter contract tests against a mock.
- **Day 3 (target; day 4 hard limit)** — reference Treasurer **live and public** (widget, status endpoint, landing v1); announce.
- **Day 4** — X bot posting (built from the kit template); landing shows the feed.
- **Day 5** — `create-orbio-agent` works on a fresh machine with no database; registry push.
- **Day 6** — second agent (ideally external); L2a live if P-7 passed and 24h dry-run done; L2b integration if Orbio shipped.
- **Day 7** — buffer, README, landing final copy, thread, ≤ 3-min video.

Why day 3: judging happens days 10–13 and the strongest evidence of "unattended" is history (≥ 96h of ticks), live money needs 24h of dry-run first, and something will break — a day-3 breakage is repaired on day 4 without touching the plan. Day 4 loses nothing irrecoverable; day 5 turns a running system into a demo.

Cut list, in order, if behind: (1) L2a stake-up, (2) L2b integration, (3) agent detail page (keep the widget + feed), (4) second demo agent by So (but not the external one — chase it), (5) FR-9.3 event posts. Never cut: live reference Treasurer, decision log, widget, kit with SQLite, one demo agent, landing.

## 16. Demo script (day 7, ≤ 3 minutes)

1. Open the landing: the reference agent's widget — position, credits/day, burn/day, coverage %, runway. Click the wallet → Blockscout. Click the balance → Orbio dashboard.
2. Scroll the decision log: a `ROUTE` change; if L2a, a `STAKE_UP` with its tx on Blockscout and the accrual rising after; if L2b, a `BUY_CREDIT` with the credit landing on the key.
3. Open the X bot's latest post; show the treasury line and that every number matches the ledger.
4. `npx create-orbio-agent demo` on camera, no database, → agent appears on the landing within a minute.
5. Close on the flywheel diagram and the one-liner: the Treasurer manages the gap and shows it in public. Say plainly what is waiting on Orbio's agentic-buy endpoint.

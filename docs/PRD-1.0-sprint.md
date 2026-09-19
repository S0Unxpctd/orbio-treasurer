# Orbio Treasurer — PRD 1.0 (sprint edition)

Date: 2026-09-19 00:45 Paris · Deadline: 2026-09-20 (Orbio Build Week) · Owner: So · Orchestrator: Claude
Supersedes PRD 0.3.x. Everything from 0.3.x not listed here is out of scope. This document wins over tickets.

## 1. One paragraph

Orbio Treasurer is a gateway other agents call to make their recurring LLM tasks cheaper. The caller changes one line (`base_url`) and sends `model: "auto"`. The Treasurer routes each call to the cheapest model that fits, pays for inference with Orbio CREDIT it sources below list price (claimed from a staked $ORBIO position, or bought at a discount on the on-chain book), meters every call, and shows the savings and the treasury on a public page with on-chain proof. The loop: volume → margin → buy $ORBIO → stake → more CREDIT → cheaper inference → more volume. In v1 nobody pays us yet: the "buy and stake" leg is a capped policy rule funded by So's seed capital. It proves the mechanism, not the economics, and the page says so.

Pitch line: "One base_url change. Your agents' crons cost less, because we route smarter and source inference below list on Orbio, and you can verify it on-chain."

## 2. Users

- Caller: any agent runtime that speaks the OpenAI chat completions API (Hermes, LangChain, OpenClaw, plain `fetch`). Gets an API key from us. Sets `model: "auto"` (or `auto:S|M|L` as a floor) and optionally `x-baseline-model` for the savings comparison.
- Operator (So): stakes ORBIO, funds the hot wallet, flips `TREASURER_LIVE`, reads the page.
- Judge / Orbio (Yash): reads the page, the tx links, the README, watches the Loom.

## 3. Fixed facts (do not re-research)

- Orbio gateway `https://api.orbio.so/api/v1` (also `https://www.orbio.so/api/v1`), OpenAI-compatible. `GET /models` has per-token pricing. Each completion returns `usage.cost` (USD) and header `X-Orbio-Balance` (balance BEFORE the request). `GET /key` → `{balance:{currency,available,used}, rate_limit:{requests_per_minute:120, concurrent:32}}`.
- API key without OAuth: `sig = wallet.signMessage("Orbio API key · chain 4663 · epoch 0")` → key `sk-orb-0-<base64(sig)>`. The activated balance is bound to the wallet address (beneficiary). Rotation = higher epoch.
- Chain: Robinhood Chain id 4663. RPC `https://robinhood-rpc.publicnode.com` (no rate limit, no `eth_getLogs` archive) ; `https://rpc.ordofi.network` ok ; official `https://rpc.mainnet.chain.robinhood.com` 429 after 2–3 calls. Explorer `https://robin.etherscan.io`. Gas in ETH.
- Contracts (4663): CREDIT `0xe33322da1380e61e5ae5dfb21e7f62924c73004c` (ERC-20, 6 dec, 1 CREDIT = $1 inference) · Staking `0xe0710011278bfb63e57c5f227e5980984b1eddca` · Exchange `0x6951ffd32630b05e06f50062aea801625a58ebc0` · Payout `0x4cbbbf652b11ed1294df0ac49d8322394310cfc5` · ORBIO `0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3` (18 dec) · USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec, EIP-3009) · NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`. Staking/Exchange/CREDIT are UUPS proxies.
- Published ABIs: `https://www.orbio.so/protocol/abi/{credit,exchange,erc20}.json`. Staking ABI not published; reconstructed and verified by eth_call on 2026-09-16: `stake(uint256)` (approve first), `settle(uint256[] periodIds) → uint256`, `claim() → uint256`, `settledOf(address)`, `positionOf(address)`, `rewardOf(address,uint256)`, `rewardPeriod(uint256) → 5×uint256`, `totalStaked()`, `MIN_POSITION() = 1000e18`, `PERIOD() = 3600`, `addresses()` (7 addresses). `unstakeAll` plausible, unverified: never call it.
- Exchange: `getQuote(usdgIn, maxFills) → (creditOut, fills)` (free read), `feeBps() = 0`, `MAX_FILLS() = 64`, `buy(usdgIn, minCreditOut, recipient, maxFills)`, `buyAndActivate(usdgIn, minCreditOut, bytes32 beneficiary, maxFills)`. On 2026-09-16: 10 USDG → 22.22 CREDIT (55% discount), 12.8k CREDIT listed. Quotes do not reserve liquidity; unused USDG is returned; revert if `minCreditOut` not met.
- CREDIT: `activate(amount)` / `activate(amount, bytes32 beneficiary)` burns and credits the API balance. Event `Activated(uint256 id, address, bytes32, uint256)`. Irreversible.
- Staking: min 1,000 ORBIO, hourly periods, reward weight = amount × time, no fixed yield. Collect = `settle` then `claim` (CREDIT minted to the staker wallet, ORBIO stays staked). Exit is all-or-nothing: out of scope.
- ORBIO trades in a Uniswap v4 pool paired with NVDA; USDG → NVDA → ORBIO is the route. No official Uniswap deployment on 4663 is documented; the canonical PoolManager address has no code there. Router address unknown → T-7 starts with a probe.
- Holder yield at launch: ~$0.00005 per token per week. Staking covers light loads only; the book discount is the main lever.
- Competitors: BagBot (key lifecycle + alerts), generic routers (OpenRouter auto, Not Diamond). Our difference: Orbio-sourced credit below list, on-chain proof, a loop that stakes.

## 4. Scope v1.0 — tickets

Two tickets in flight max, different packages. Process per ticket: Code → Test (Sonnet, fresh context each) → So's sign-off. Audit added on T-4, T-5, T-6, T-7 (they move money). Builder/tester prompts: PROCESS.md.

| # | Ticket | Package | Depends on |
|---|---|---|---|
| T-1 | Gateway + router | `apps/gateway` | — |
| T-2 | Ledger + meter | `packages/ledger` | — |
| T-3 | Treasury read | `packages/chain` | T-2 |
| T-4 | Settle → claim → activate | `packages/chain` | T-3 |
| T-5 | buyAndActivate | `packages/chain` | T-3 |
| T-6 | Tick + policy | `apps/gateway`, `packages/policy` | T-2, T-3 |
| T-7 | Stake-up (buy ORBIO + stake) | `packages/chain` | T-3, probe P-7b |
| T-8 | Public page | `apps/gateway` | T-2, T-3 |
| T-9 | Kit + demo agent | `packages/create-orbio-agent`, `examples/daily-digest` | T-1, T-8 |
| T-10 | Landing copy, README, Loom, submission | repo root | all |

### T-1 Gateway + router
- `POST /v1/chat/completions`, `GET /v1/models`. Auth: `Authorization: Bearer otk_…` (our keys, hashed in DB). Unknown key → 401.
- `model` handling: exact Orbio model id → pass through. `auto` → router picks. `auto:S`, `auto:M`, `auto:L` → floor tier. Header `x-baseline-model` (optional) → used for savings; default baseline = tier L default model.
- Router = pure function `route(request, models, floor) → {model, tier, reason}`. Tiers built from `/models` pricing at boot (cached 10 min): S ≤ $0.40 / M input, M ≤ $3 / M, L above. Rules, in order: `tools` present or `response_format` json → ≥ M; total prompt chars > 24k → ≥ M; system prompt contains "reason", "analy", "code", "plan" → ≥ M; otherwise S. Floor from `auto:X` and from policy mode (`eco` caps at M) apply after.
- Forward to Orbio with the Treasurer key derived from `TREASURER_PRIVATE_KEY` (signed message above). Streaming passthrough (SSE). Non-stream: read `usage.cost`; stream: read the final usage chunk.
- On upstream 402/insufficient balance → 503 `{error:"treasury_empty"}` and a ledger event `alert`.
- Every call → `ledger.recordCall(...)` (T-2 interface) fire-and-forget with retry once.
- AC: 12 unit tests on `route()`; one integration test against the real gateway with `model:"auto"` returning a completion and a `cost_usd > 0` row.

### T-2 Ledger + meter
- Supabase Postgres, migrations in `supabase/migrations/`. Tables:
  - `keys(id, key_hash, label, agent_id, created_at, revoked_at)`
  - `agents(id, name, url, kit_version, created_at)` (kit registrations)
  - `calls(id, ts, key_id, requested_model, routed_model, tier, reason, prompt_tokens, completion_tokens, cost_usd numeric(12,6), baseline_cost_usd numeric(12,6), latency_ms, status)`
  - `treasury_events(id, ts, kind, amount numeric(30,0), token, tx_hash, meta jsonb)` — kind ∈ settle, claim, activate, buy, stake, mode_change, alert. Append-only (no UPDATE/DELETE grants).
  - `treasury_snapshots(ts, staked_orbio, settled_credit, credit_wallet, credit_api_available, credit_api_used, quote_credit_per_usdg, eth_balance, usdg_balance, mode)`
- `baseline_cost_usd` = tokens × price of baseline model from `/models`. `saved_usd = baseline − cost`.
- Views: `v_savings_24h`, `v_savings_total`, `v_burn_daily_7d`.
- tx_hash allow-list: exact `0x` + 64 hex. Secrets never logged (redact()).
- AC: tests on a local Postgres (initdb works in the sandbox) — 20+ tests incl. append-only enforcement.

### T-3 Treasury read
- `packages/chain` with viem, chain 4663 definition, RPC fallback list (publicnode → ordofi → official).
- `readTreasury(hot, staker) → snapshot`: `positionOf(staker)`, `settledOf(staker)`, `CREDIT.balanceOf(hot)`, `CREDIT.balanceOf(staker)`, `GET /key` balance, `getQuote(10 USDG, 10)`, ETH and USDG balances of hot.
- Writes a `treasury_snapshots` row. CLI `pnpm treasury:read` prints it.
- AC: unit tests with mocked RPC; one live read printed in the report (numbers, no secrets).

### T-4 Settle → claim → activate (gated)
- If `STAKER_PRIVATE_KEY` is set: `settle(periodIds)` for finalized periods since last settle, then `claim()`, then `CREDIT.activate(amount, bytes32(hot))` from the staker so the API balance lands on the hot wallet's key. If not set: read-only; the tick emits an `alert` "claimable X CREDIT — run manually" and So does it by hand, then transfers CREDIT to hot; the Treasurer then calls `activate(amount)` from hot.
- Gates: `TREASURER_LIVE=true` and `ACTIVATE_MAX_PER_DAY` (default 50 CREDIT). Dry-run mode logs the would-be tx.
- AC: every tx → `treasury_events` with hash; dry-run tests; one live run only on So's written ok in the ticket.

### T-5 buyAndActivate (gated)
- `buyCredit(usdgIn)`: `getQuote(usdgIn, 10)` → `minCreditOut = quote × 0.98` → `USDG.approve(exchange, usdgIn)` → `buyAndActivate(usdgIn, minCreditOut, bytes32(hot), 10)`.
- Gates: `TREASURER_LIVE`, `BUY_MAX_USDG_PER_TX=10`, `BUY_MAX_PER_DAY=1`. Reject if quote discount < 10% (`creditOut/usdgIn < 1.10`).
- AC: dry-run tests incl. cap enforcement; one live buy on So's ok, hash on the page.

### T-6 Tick + policy
- `GET/POST /api/tick` (secret header `TICK_SECRET`), called by Supabase `pg_cron` every 15 min via `pg_net` (`app.tick_url`, `app.tick_secret` settings). Also runnable by `pnpm tick`.
- Policy = pure function `decide(snapshot, stats, config) → actions[]`, deterministic, unit-tested:
  - `burn_daily` = max(last 24h cost, 7-day daily average, ε=0.01).
  - `runway_days = credit_api_available / burn_daily`.
  - mode: `normal` if runway ≥ 2d; `eco` (router floor cap M) if < 2d; `critical` (cap S) if < 0.5d. Mode change → event.
  - claimable > 0 → action `claim_activate`.
  - runway < 1d and deficit > 1 USDG → action `buy(min(BUY_MAX_USDG_PER_TX, deficit_usd))`.
  - `calls_since_last_stakeup ≥ STAKEUP_EVERY_CALLS (1000)` → action `stakeup(STAKEUP_USDG=1)`.
  - Any action blocked by a gate → `alert` event with reason.
- Tick executes actions through T-4/T-5/T-7 executors, writes a snapshot, returns JSON summary.
- AC: 15+ policy tests (table-driven); tick integration test in dry-run.

### T-7 Stake-up (gated, 50% confidence)
- Probe P-7b first (read-only, 1h max): find a working USDG → NVDA → ORBIO swap path on 4663: (a) `Staking.addresses()` and `Payout` bytecode for router/pool addresses; (b) Uniswap v4 PoolManager/UniversalRouter candidates on robin.etherscan.io; (c) ask Yash on Telegram (So). Output: contract addresses + a quoted price for 1 USDG, or NO.
- If YES: `buyOrbio(usdgIn)` → swap → if hot has no position and amount < MIN_POSITION: transfer ORBIO to staker and emit `alert` "stake manually"; else `ORBIO.approve(staking)` + `stake(amount)`. Gates: `TREASURER_LIVE`, `STAKEUP_MAX_USDG_PER_DAY=5`.
- If NO: policy still emits the `stakeup` action as an `alert` with a deep link (Uniswap or explorer) and the amount; the page shows "manual stake-up pending". Ship this fallback regardless.

### T-8 Public page
- `/` (single page, server-rendered, no auth): Savings block (calls routed, $ spent, $ baseline, $ saved, % saved, last 24h and total, per-tier split). Treasury block (staked ORBIO, CREDIT claimed, CREDIT activated, USDG spent on the book, ORBIO bought, current mode, runway days, last tick). Proof block: last 20 `treasury_events` with `robin.etherscan.io/tx/<hash>` links. Agents block: rows from `agents`. Footer: "v1: buy-and-stake leg funded by seed capital, capped; caller billing not live."
- `/api/stats` JSON for the kit and for the Loom.
- Plain HTML + minimal CSS, dark, readable on phone. No charts library.

### T-9 Kit + demo agent
- `npx create-orbio-agent my-agent` → copies a template: `agent.ts` (a cron task calling the gateway with `model:"auto"`), `.env.example` (`ORBIO_TREASURER_URL`, `ORBIO_TREASURER_KEY`), `README.md`, and a `register` step that POSTs `{name, url}` to `/api/agents` (auth by key) so the agent appears on the page.
- `examples/daily-digest`: fetches 3 RSS feeds, summarises with `auto`, writes to stdout / a webhook (`DIGEST_WEBHOOK_URL`, optional). X posting only if `X_*` keys are provided; not required.
- AC: `npx` run in a clean folder produces a working agent that appears on the page after one call.

### T-10 Landing copy, README, Loom, submission
- README: the paragraph in §1, a 5-line quickstart, the proof links, the honest limits, the roadmap (§8). Loom ≤ 3 min: page → one call through the gateway → ledger row → tick → tx on explorer → kit in 60 s. Submission per Orbio's form.

## 5. Architecture (short) — builds on the existing repo (49 commits, 2026-09-09)

Existing monorepo (pnpm, turbo, biome, vitest, Next 16, TS strict) — reuse, do not rescaffold:
- `apps/web` = the gateway (Next app router on Vercel): add `/v1/*`, `/api/tick`, `/api/agents`, `/api/stats`, `/`.
- `packages/core`: `ledger/` (LedgerStore SQLite + Postgres, 281 tests — extend the schema with `calls`, `treasury_events`, `treasury_snapshots`, `keys`, `agents`), `policy/` (evaluate(), states — rewrite rules per T-6, keep the pure-function shape and test style), `redact.ts` + `log.ts` (keep), `mcp/` (obsolete since 2026-09-16: keep the folder, exclude its 17 failing tests from CI, do not build on it), new `chain/` (viem, ABIs under `packages/core/abi/`), new `router/`.
- `packages/create-orbio-agent` (stub exists), `apps/book-daily` → becomes `examples/daily-digest` (rename), `supabase/migrations/001–004` (applied on the Sept 9 Supabase project; new migrations start at 005), `scripts/probes/`.
- Ticket mapping to the old board (tasks/README.md): T-1 ≈ T-017+T-019 (gateway), T-2 ≈ T-011 ext., T-3/T-4/T-5 ≈ T-012 (book) + T-021 (chain), T-6 ≈ T-014+T-016, T-7 ≈ T-021, T-8 ≈ T-019+T-030, T-9 ≈ T-025+T-026, T-10 ≈ T-062+T-070. Old tickets not mapped are dropped. New ticket files: `tasks/S-01.md` … `tasks/S-10.md` to avoid number clashes; the board gets a "Sprint 1.0" section on top.
- Package rule for parallelism: two tickets in flight only if they touch different top-level folders of `packages/core/src` or different apps.

## 6. Gates, secrets, money

- `TREASURER_LIVE` default `false`. Live only after So writes `ok live T-x` in the ticket. Caps: `BUY_MAX_USDG_PER_TX=10`, `BUY_MAX_PER_DAY=1`, `STAKEUP_MAX_USDG_PER_DAY=5`, `ACTIVATE_MAX_PER_DAY=50`. Caps change only with So's written ok.
- Secrets in `.env.local` (git-ignored) in the sandbox; production values set by So in Vercel and Supabase. Never printed, pasted, or committed. `redact()` on every logger.
- Hot wallet holds small amounts only (≈0.005 ETH, 10 USDG). Never `unstakeAll`. Never call an unverified selector.

## 7. Timeline (Paris)

- 19th 00:00–02:00: So provisions (repo, wallets, Supabase, Vercel, `.env.local`). PRD + briefs T-1/T-2.
- 19th 02:00–12:00: T-1 ∥ T-2 → T-3 ∥ T-4. Vercel deploy as soon as T-1 passes.
- 19th 12:00–20:00: T-5 ∥ T-6 → T-7 ∥ T-8.
- 19th 20:00–24:00: T-9. First live run with So's ok: claim, activate, buy, stake-up (or manual fallback), hashes on the page. Code freeze 22:00 (T-9/T-10 excepted).
- 20th: T-10, second live tick, submission. 4h buffer.

Cut order if slipping: T-7 → manual fallback only; T-9 CLI → template repo; T-4 → manual settle/claim; streaming removed.

## 8. Out of scope v1 (roadmap, shown on the page and README)

Caller billing (x402 USDG on 4663, USDG supports EIP-3009 — proven), prebuy ahead of predicted cron demand, selling surplus CREDIT on the book, multi-key view, exit/unstake, MCP tool interface, per-caller quality feedback loop.

## 9. Open questions

- Q1 (So): is the staking wallet dedicated (only ORBIO)? If yes, `STAKER_PRIVATE_KEY` can be provided and T-4 automates fully.
- Q2 (Yash): Uniswap v4 router / pool addresses on 4663 for USDG → NVDA → ORBIO. Blocks the automated half of T-7.
- Q3 (Yash): exact Orbio model ids for the S/M/L defaults, if `/models` is ambiguous.

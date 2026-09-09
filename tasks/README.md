# Backlog / board (v0.3 — deadline Sept 20)

Tickets follow `PROCESS.md`. Status lives inside each ticket; this table is updated by hand at the evening check-in.
`P-00x` are probes (PRD §13a): 30 minutes, yes/no, evidence into `docs/api-notes.md`, no audit step. Conditional tickets (L2a, L2b) stay `blocked` until their gate opens. `W2` = week-2 tickets (PRD 0.3).

| Ticket | Title | Day | Date | Layer | Est | Depends on | Status |
|---|---|---|---|---|---|---|---|
| **D0 — docs, accounts, X app, pool link (nothing depends on Orbio)** | | | Sept 8 | | | | |
| [T-001](T-001.md) | Monorepo scaffold, tooling, CI | 0 | Sept 8 | L0 | 2h | — | done |
| [T-002](T-002.md) | Ledger schema (both dialects), RLS, append-only triggers, cron SQL | 0 | Sept 8 | L0 | 3.5h | T-001 | done |
| [T-003](T-003.md) | redact() + structured logger | 0 | Sept 8 | L0 | 1.5h | T-001 | done |
| **D1 — PROBES FIRST (P-1…P-8), then data flowing** | | | Sept 9 | | | | |
| [P-001](P-001.md) | Probe P-1 · MCP headless auth | 1 | Sept 9 | L0 | 0.5h | T-001 | todo |
| [P-002](P-002.md) | Probe P-2 · Gateway key-info endpoint | 1 | Sept 9 | L0 | 0.5h | T-001 | todo |
| [P-003](P-003.md) | Probe P-3 · Book read source | 1 | Sept 9 | L1 | 0.5h | T-001 | todo |
| [P-004](P-004.md) | Probe P-4 · Per-call cost from gateway | 1 | Sept 9 | L0 | 0.5h | T-001 | todo |
| [P-005](P-005.md) | Probe P-5 · Serverless tick budget | 1 | Sept 9 | L0 | 0.5h | T-001 | todo |
| [P-006](P-006.md) | Probe P-6 · X developer app | 1 | Sept 9 | L1 | 0.5h | T-001 | todo |
| [P-007](P-007.md) | Probe P-7 · Stake pool on Robinhood Chain | 1 | Sept 9 | L2a | 0.5h | T-001 | todo |
| [P-008](P-008.md) | Probe P-8 · pg_cron → Vercel round trip | 1 | Sept 9 | L0 | 0.5h | T-002, P-005 | todo |
| [T-010](T-010.md) | OrbioMcpClient + balance fallback chain | 1 | Sept 9 | L0 | 3.5h | T-002, T-003, P-001, P-002 | todo |
| [T-011](T-011.md) | LedgerStore interface + SQLite and Postgres implementations | 1 | Sept 9 | L0 | 4.5h | T-002 | todo |
| [T-012](T-012.md) | BookClient interface + ReadOnlyBookClient (conditional on P-3) | 1 | Sept 9 | L1 | 2.5h | T-003, P-003 | todo |
| [T-014](T-014.md) | tick(): snapshot pipeline in dry_run + cron route | 1 | Sept 9 | L0 | 3h | T-010, T-011, T-012, P-005, P-008 | todo |
| **D2 — policy, executors, metering, L2b mock (dry-run running)** | | | Sept 10 | | | | |
| [T-015](T-015.md) | Policy engine: evaluate(), states, funding options, humanize() | 2 | Sept 10 | L0 | 4.5h | T-011 | todo |
| [T-016](T-016.md) | Executors: route, signal, rotate, alert + live gating | 2 | Sept 10 | L0 | 3h | T-015, T-014 | todo |
| [T-017](T-017.md) | Metering middleware + treasurer.model(tier) + BudgetExceeded | 2 | Sept 10 | L0 | 3h | T-011, T-015, P-004 | todo |
| [T-018](T-018.md) | L2b contract: OrbioAgenticBuyClient against a local mock | 2 | Sept 10 | L2b | 2.5h | T-016 | todo |
| **D3 — GO LIVE target (hard limit Sept 12): API, widget, landing v1, reference agent public** | | | Sept 11 | | | | |
| [T-019](T-019.md) | Public API + widget + badge | 3 | Sept 11 | L0 | 4h | T-016 | todo |
| [T-022](T-022.md) | GO LIVE checkpoint: reference Treasurer public (target day 3, limit day 4) | 3 | Sept 11 | L0 | 2h | T-014, T-019, T-030 | todo |
| [T-030](T-030.md) | Landing v1 + registry push | 3 | Sept 11 | L0 | 4h | T-019, T-011 | todo |
| **D4 — Orbio Book Daily posting** | | | Sept 12 | | | | |
| [T-023](T-023.md) | X client + numbers validator | 4 | Sept 12 | L1 | 2.5h | T-017, P-006 | todo |
| [T-024](T-024.md) | Orbio Book Daily: daily post job | 4 | Sept 12 | L1 | 3h | T-023, T-012 | todo |
| **D5 — create-orbio-agent on a fresh machine, no database** | | | Sept 13 | | | | |
| [T-025](T-025.md) | create-orbio-agent CLI + minimal template (SQLite, no DB account) | 5 | Sept 13 | L0 | 3.5h | T-017, T-014 | todo |
| [T-026](T-026.md) | Kit ↔ landing: first-boot registration + push, opt-out | 5 | Sept 13 | L0 | 2h | T-025, T-030 | todo |
| [T-027](T-027.md) | x-bot template + regenerate book-daily from the kit | 5 | Sept 13 | L1 | 2.5h | T-025, T-024 | todo |
| **D6 — second agent · L2a if P-7 passed · agent page · L2b the day Orbio ships** | | | Sept 14 | | | | |
| [T-021](T-021.md) | L2a: UniswapStakeClient + STAKE_UP executor (conditional on P-7) | 6 | Sept 14 | L2a | 4h | P-007, T-016 | todo |
| [T-031](T-031.md) | Agent detail page (/a/:slug) | 6 | Sept 14 | L0 | 2.5h | T-030 | todo |
| [T-032](T-032.md) | Second agent: onboard an external builder (fallback: So's second) | 6 | Sept 14 | L0 | 2h | T-026, T-027 | todo |
| [T-033](T-033.md) | L2b integration: Orbio's real agentic-buy endpoint (conditional on Orbio shipping) | 6 | Sept 14 | L2b | 3h | T-018, T-022 | todo |
| **D7 — week-1 buffer, README v1, first thread** | | | Sept 15 | | | | |
| [T-040](T-040.md) | Week-1 buffer, README v1, first thread | 7 | Sept 15 | L0 | 3h | T-030, T-022 | todo |
| **D8 — probe P-9, multi-key balances** | | | Sept 16 | | | | |
| [P-009](P-009.md) | Probe P-9 · OpenRouter credits/key endpoint | 8 | Sept 16 | W2 | 0.5h | T-022 | todo |
| [T-050](T-050.md) | Multi-key balances: keys[] config, KeyBalance sources, key_balances table | 8 | Sept 16 | W2 | 4h | P-009, T-017 | todo |
| **D9 — portfolio view + key-aware routing · onboarding campaign** | | | Sept 17 | | | | |
| [T-051](T-051.md) | Consolidated portfolio view (widget line + agent page table) + key-aware routing Orbio↔OpenRouter | 9 | Sept 17 | W2 | 4h | T-050, T-019, T-031 | todo |
| [T-052](T-052.md) | x402 buyer-side spike + RH-chain facilitator reference (conditional on Yash) | 9 | Sept 17 | L2b | 4h | T-018, T-021 | todo |
| [T-060](T-060.md) | Onboarding campaign for new participants (target 3–5 external agents) | 9 | Sept 17 | W2 | 3h (So-heavy) | T-026, T-027, T-022 | todo |
| **D10 — FEATURE FREEZE 18:00 · hardening** | | | Sept 18 | | | | |
| [T-061](T-061.md) | Feature freeze + hardening pass | 10 | Sept 18 | W2 | 3h | T-051, T-060 | todo |
| **D11 — video, thread, final copy, metrics** | | | Sept 19 | | | | |
| [T-062](T-062.md) | Video, thread, landing final copy, metrics | 11 | Sept 19 | W2 | 4h | T-061 | todo |
| **D12 — submission + buffer** | | | Sept 20 | | | | |
| [T-070](T-070.md) | Submission day + buffer | 12 | Sept 20 | W2 | 2h | T-062 | todo |

Estimates are **human-developer hours** used to size tickets (2–4h units). With the coding agent building, a ticket takes ~45–90 min wall-clock end to end (code → audit → test → sign-off).

- Week 1 committed (L0 + L1): **62h**
- Week 2 (multi-key, onboarding, freeze, video, submission): **20h** (of which ~5h is So's outreach time, not code)
- Probes: 4.5h
- Conditional (L2a stake-up, L2b agentic buy): 10h, only if their gates open

Cut list and freeze rule: `PRD.md §15`.

## Critical path

T-001 → T-002 → P-001/P-002/P-005/P-008 → T-010/T-011 → T-014 → T-015 → T-016 → T-019 → T-030 → **T-022 (go-live Sept 11 / limit Sept 12)** → T-024 → T-025 → T-026 → T-040 → P-009 → T-050 → T-051 → **T-061 (freeze Sept 18)** → T-062 → T-070

## Two-in-flight rule

At most two tickets in code at once, only if they touch different packages. Probes are the exception: run all of a day's probes in one morning, they are read-only.

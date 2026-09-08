# Backlog / board (v0.2)

Tickets follow `PROCESS.md`. Status lives inside each ticket; this table is updated by hand at the evening check-in.
`P-00x` are probes (PRD §13a): 30 minutes, yes/no, evidence into `docs/api-notes.md`, no audit step. Conditional tickets (L2a, L2b) are `blocked`, not deleted, until their gate opens.

| Ticket | Title | Day | Layer | Est | Depends on | Status |
|---|---|---|---|---|---|---|
| **Day 0 — tonight, nothing here depends on Orbio** | | | | | | |
| [T-001](T-001.md) | Monorepo scaffold, tooling, CI | 0 | L0 | 2h | — | todo |
| [T-002](T-002.md) | Ledger schema (both dialects), RLS, append-only triggers, cron SQL | 0 | L0 | 3.5h | T-001 | todo |
| [T-003](T-003.md) | redact() + structured logger | 0 | L0 | 1.5h | T-001 | todo |
| **Day 1 — PROBES FIRST (P-1…P-8, 30 min each), then data flowing** | | | | | | |
| [P-001](P-001.md) | Probe P-1 · MCP headless auth | 1 | L0 | 0.5h | T-001 | todo |
| [P-002](P-002.md) | Probe P-2 · Gateway key-info endpoint | 1 | L0 | 0.5h | T-001 | todo |
| [P-003](P-003.md) | Probe P-3 · Book read source | 1 | L1 | 0.5h | T-001 | todo |
| [P-004](P-004.md) | Probe P-4 · Per-call cost from gateway | 1 | L0 | 0.5h | T-001 | todo |
| [P-005](P-005.md) | Probe P-5 · Serverless tick budget | 1 | L0 | 0.5h | T-001 | todo |
| [P-006](P-006.md) | Probe P-6 · X developer app | 1 | L1 | 0.5h | T-001 | todo |
| [P-007](P-007.md) | Probe P-7 · Stake pool on Robinhood Chain | 1 | L2a | 0.5h | T-001 | todo |
| [P-008](P-008.md) | Probe P-8 · pg_cron → Vercel round trip | 1 | L0 | 0.5h | T-002, P-005 | todo |
| [T-010](T-010.md) | OrbioMcpClient + balance fallback chain | 1 | L0 | 3.5h | T-002, T-003, P-001, P-002 | todo |
| [T-011](T-011.md) | LedgerStore interface + SQLite and Postgres implementations | 1 | L0 | 4.5h | T-002 | todo |
| [T-012](T-012.md) | BookClient interface + ReadOnlyBookClient (conditional on P-3) | 1 | L1 | 2.5h | T-003, P-003 | todo |
| [T-014](T-014.md) | tick(): snapshot pipeline in dry_run + cron route | 1 | L0 | 3h | T-010, T-011, T-012, P-005, P-008 | todo |
| **Day 2 — policy, executors, metering, L2b mock contract (dry-run running)** | | | | | | |
| [T-015](T-015.md) | Policy engine: evaluate(), states, funding options, humanize() | 2 | L0 | 4.5h | T-011 | todo |
| [T-016](T-016.md) | Executors: route, signal, rotate, alert + live gating | 2 | L0 | 3h | T-015, T-014 | todo |
| [T-017](T-017.md) | Metering middleware + treasurer.model(tier) + BudgetExceeded | 2 | L0 | 3h | T-011, T-015, P-004 | todo |
| [T-018](T-018.md) | L2b contract: OrbioAgenticBuyClient against a local mock | 2 | L2b | 2.5h | T-016 | todo |
| **Day 3 — GO LIVE target (day 4 hard limit): API, widget, landing v1, reference agent public** | | | | | | |
| [T-019](T-019.md) | Public API + widget + badge | 3 | L0 | 4h | T-016 | todo |
| [T-030](T-030.md) | Landing v1 + registry push | 3 | L0 | 4h | T-019, T-011 | todo |
| [T-022](T-022.md) | GO LIVE checkpoint: reference Treasurer public (target day 3, limit day 4) | 3 | L0 | 2h | T-014, T-019, T-030 | todo |
| **Day 4 — Orbio Book Daily posting** | | | | | | |
| [T-023](T-023.md) | X client + numbers validator | 4 | L1 | 2.5h | T-017, P-006 | todo |
| [T-024](T-024.md) | Orbio Book Daily: daily post job | 4 | L1 | 3h | T-023, T-012 | todo |
| **Day 5 — create-orbio-agent works on a fresh machine with no database** | | | | | | |
| [T-025](T-025.md) | create-orbio-agent CLI + minimal template (SQLite, no DB account) | 5 | L0 | 3.5h | T-017, T-014 | todo |
| [T-026](T-026.md) | Kit ↔ landing: first-boot registration + push, opt-out | 5 | L0 | 2h | T-025, T-030 | todo |
| [T-027](T-027.md) | x-bot template + regenerate book-daily from the kit | 5 | L1 | 2.5h | T-025, T-024 | todo |
| **Day 6 — second agent · L2a stake-up if P-7 passed · L2b if Orbio shipped · agent page** | | | | | | |
| [T-021](T-021.md) | L2a: UniswapStakeClient + STAKE_UP executor (conditional on P-7) | 6 | L2a | 4h | P-007, T-016 | todo |
| [T-031](T-031.md) | Agent detail page (/a/:slug) | 6 | L0 | 2.5h | T-030 | todo |
| [T-032](T-032.md) | Second agent: onboard an external builder (fallback: So's second) | 6 | L0 | 2h | T-026, T-027 | todo |
| [T-033](T-033.md) | L2b integration: Orbio's real agentic-buy endpoint (conditional on Orbio shipping) | 6 | L2b | 3h | T-018, T-022 | todo |
| **Day 7 — buffer, README, submission, thread, video** | | | | | | |
| [T-040](T-040.md) | Buffer + polish + submission | 7 | L0 | 4h | T-030, T-022 | todo |

Estimates are **human-developer hours**, used to size tickets to 2–4h units. With the coding agent building, a ticket takes ~45–90 min wall-clock end to end (code → audit → test → sign-off); the dev-hour number is a size, not a schedule.

- Committed (L0 + L1): **63h** across 21 tickets
- Probes: 4h (8 × 30 min)
- Conditional (L2a stake-up, L2b agentic buy): 10h, only if their gates open

If behind on the evening of day 3, apply the cut list in `PRD.md §15`.

## Critical path

T-001 → T-002 → P-001/P-002/P-005/P-008 → T-010/T-011 → T-014 → T-015 → T-016 → T-019 → T-030 → **T-022 (go-live, day 3 target / day 4 limit)** → T-024 → T-025 → T-026 → T-040

## Two-in-flight rule

At most two tickets in code at once, only if they touch different packages. Probes are the exception: run all eight in one morning, they are read-only.

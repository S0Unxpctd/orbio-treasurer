# STATUS

Updated every evening by So after the merge. The judges may read this; keep it factual.

## Day 0 — 2026-09-07

- Docs written: PRD 0.1, ARCHITECTURE, PROCESS, CLAUDE.md, 26 tickets.
- Asked Orbio (builders Telegram): book write API? $100 grant on a separate balance?

## Day 0 (cont.) — 2026-09-08

- Orbio (Yash) answered: buying = Whop checkout, not agentic, they're building agentic buying this week; encouraged boilerplate + project + landing + Loom.
- PRD → 0.2: no buy/list execution; L2b adapter for Orbio's endpoint; L2a stake-up conditional on probe P-7; kit on SQLite (ADR-002); fragility map + 8 probes; scope re-cut to one product.
- Board regenerated: 24 committed tickets + 8 probes + 3 conditional. Committed ≈ 55h dev-equivalent of code + 6h buffer/outreach; conditional ≈ 10h.
- Still open with Orbio: grant on a separate balance? book read endpoint? surplus listing agentic?
- Defaults: `LEDGER=sqlite` (kit) / `postgres` (hosted), `BOOK_CLIENT=readonly`, `STAKE_CLIENT=none`, `TREASURER_LIVE=false`.
- Reference agent: not yet running. Budget spent: $0 / $100.
- **Deadline moved by Orbio to Sept 20.** PRD → 0.3: week 1 unchanged (go-live Sept 11), week 2 = L2b integration + onboarding campaign + multi-key balance view (§8.12), freeze Sept 18 18:00.

## Day 0 (evening) — 2026-09-08

- Shipped through Code → Audit → Test (builders/auditors/testers on Sonnet, orchestration on Fable): **T-001** scaffold (1 Blocker caught: probe runner), **T-002** ledger schema both dialects + RLS + append-only + cron SQL + env (2 Majors caught, fixed; 163 tests incl. real Postgres), **T-003** redact()/logger (5 Blockers + 3 Majors + 1 pass-2 Blocker caught, fixed; 152 tests).
- PRD 0.3.1: orders' mutable set = fill fields; key_meta append-only. Probe P-10 done: USDG on RH chain has EIP-3009 (x402 path B viable). Competitor noted: BagBot.
- Awaiting So: sign-off T-001/T-002/T-003; ADR-004 rule; GitHub push (CI link); Supabase/Vercel projects; X app; pool link; verify `cron.job` on real Supabase (AC4 of T-002).
- Tomorrow (Sept 9, D1): probes P-1…P-8 first (need So's MCP token + Orbio key in env), then T-010, T-011, T-012, T-014.

## Template for each day

```
## Day N — YYYY-MM-DD
- Shipped: T-xxx, T-yyy (one line each)
- Blocked: T-zzz — exact question
- Reference agent: uptime Xh, ticks last 24h N/96, state, last decision
- Book: open orders N ($X), fills today N
- Agents on aggregator: N (external: N)
- Budget spent: $X / $100
- Tomorrow: T-…
```

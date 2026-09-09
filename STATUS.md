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

## Day 1 (morning) — 2026-09-09

- So signed off T-001/T-002/T-003 and ratified ADR-004. Repo on GitHub (`S0Unxpctd/orbio-treasurer`); sandbox can fetch but not push yet (repo not in the session's sources) → bundles until fixed.
- Supabase project live: migrations 001–004 applied through the Management API (sandbox has HTTPS only); 7 tables, 6 policies, 7 triggers, pg_cron 1.6.4 + pg_net 0.20.4, `treasurer-tick` scheduled `*/15 * * * *` (errors harmlessly until `app.tick_url` is set once Vercel exists). T-002 AC4 closed.
- Next: P-1 (MCP OAuth, with So), T-011 LedgerStore on Sonnet, T-010, T-012, T-014.

## Day 1 (night) — 2026-09-09, 02:00–05:30 Paris

- Shipped through Code → Audit → Test on Sonnet: **T-011** LedgerStore (1 Blocker caught: Postgres store didn't parse jsonb; 281/281 on real Postgres), **T-015** policy engine (3 Majors caught: unfunded-alert edge, §10 option selection, scope), **T-010** MCP client (1 Major caught: concurrent refresh not single-flighted). Suite: 152 → 820 tests.
- Probes: **P-1 YES** (3600 s token, headless refresh works, refresh token rotates; balance chain mcp → estimate), **P-3 NO** (no book JSON endpoint → `BOOK read = none`). P-2/P-4 statuses carried to the board.
- Awaiting So: `ok` on T-011, T-015, T-010, P-001, P-003; ε = 0.01 $/day; prebuy reserve = 0; discount unit; coverage tool ADR-006 or drop AC1 of T-015; push (18+ commits in bundle).
- Blocked: T-012 (P-3 NO → NullBookClient path), T-014 (P-5/P-8 need Vercel, not before Sept 10).
- Reference agent: not yet running. Budget spent: $0 / $100.

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

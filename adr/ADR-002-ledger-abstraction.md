# ADR-002 · Ledger abstraction: SQLite for kit agents, Postgres for the hosted reference

2026-09-08 · accepted

## Context
ADR-001 put the ledger on Supabase Postgres. That is right for the hosted reference agent and the landing, but the kit's whole value is a five-minute path from `npx create-orbio-agent` to a running self-funded agent. Asking every builder to create a Supabase project, copy two secrets and run migrations kills that path, and it contradicts PRD FR-7.1. Orbio's own feedback ("boilerplate… would get traction") makes the kit the centre of the project, so onboarding friction is the top adoption risk.

## Decision
Introduce a `LedgerStore` interface in `packages/core/src/ledger/` with two implementations sharing one schema and one test suite: `SqliteLedger` (`better-sqlite3`, single file, created on first run, triggers for append-only) as the kit default, and `PostgresLedger` (Supabase) for the hosted reference agent and the landing. Selection by `LEDGER=sqlite|postgres`. Kit agents push public metrics to the landing over HTTP; the landing is the only place that needs Postgres.

## Consequences
The kit needs no database account. Core tests run twice (both stores) in CI. Money columns are `numeric(18,6)` in Postgres and `TEXT` decimal strings in SQLite, converted at the repository boundary, never floats in storage. Ticket T-011 grows by ~1.5h; T-025 loses the Supabase setup steps and its 5-minute acceptance criterion becomes achievable. Migrations exist in two dialects; the schema file in `ledger/schema.ts` is the source and both SQL files are generated from it.

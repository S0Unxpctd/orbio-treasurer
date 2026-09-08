# ADR-005 · Node drivers for the ledger stores

2026-09-08 · accepted

## Context
ARCHITECTURE.md §1 names the two ledger stores (SQLite via `better-sqlite3`, Supabase Postgres) but not a Postgres driver for `PostgresLedger`, and CLAUDE.md rule 7 requires an ADR for any dependency beyond §1. T-002 needs both drivers to generate/apply DDL and (for Postgres) to run the real integration tests against a local cluster.

## Decision
- `better-sqlite3` (+ `@types/better-sqlite3`) — already named in ARCH §1 and ADR-002; added to `@orbio-treasurer/core`'s dependencies here since T-002 is the first ticket that actually needs it. Synchronous API, single file, zero daemon — fits the kit's zero-provisioning goal (ADR-002) and needs no async ledger interface just to satisfy SQLite.
- `postgres` (the `porsager/postgres` package) — the Postgres driver for `PostgresLedger`. Chosen over `pg` for a smaller surface, native `numeric`/`bigint`-safe string handling out of the box (we need exact decimal strings anyway, see ADR-002), tagged-template queries that are easy to keep injection-safe, and first-class async/await with no separate pool-config ceremony for Supabase's pooled connection string.
- `better-sqlite3` is added to `pnpm-workspace.yaml`'s `onlyBuiltDependencies` (it has a native postinstall build step) so `pnpm install` stays non-interactive, matching the precedent already set for `esbuild`.

## Consequences
Both drivers are dependencies of `@orbio-treasurer/core` only — no other package needs a DB driver. `LedgerStore` implementations (T-011) wrap these directly; the interface itself stays driver-agnostic. Adding a third store (or swapping `postgres` for `pg`) would need its own ADR.

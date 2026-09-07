# ADR-001 · Stack lock and the BookClient seam

2026-09-07 · accepted

## Context
Seven days, one human directing, one coding agent building, a one-week-old external API whose write side may not exist. Re-deciding the stack mid-week or coupling the policy to a specific book API would burn the week.

## Decision
TypeScript monorepo (pnpm + Turborepo), Next.js 15 on Vercel, Supabase Postgres with pg_cron scheduling (Vercel Hobby cron is once/day), Vercel AI SDK for model calls with a metering middleware, official MCP SDK for Orbio. The policy engine is a pure function. All book access goes through a `BookClient` interface with `SignalsBookClient` (read, deep links) and `LiveBookClient` (read/write) implementations selected by one env var. Live money is gated by `TREASURER_LIVE=true` plus 24h of dry-run history.

## Consequences
No stack debates in tickets. L0 and L1 ship regardless of Orbio's answer; L2 is a swap of one env var once the day-1 round-trip passes. Adding any dependency outside `ARCHITECTURE.md §1` requires a new ADR.

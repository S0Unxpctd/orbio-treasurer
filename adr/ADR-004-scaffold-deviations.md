# ADR-004 · Scaffold-time deviations from ADR-001: Next.js 16, `tsx`

2026-09-08 · accepted · ratified by So 2026-09-09 (T-001 Sign-off)

## Context
ADR-001 named Next.js 15. At scaffold time (T-001) the current stable major is 16.3; same framework, same App Router and Route Handlers. The scaffold also added `tsx` (root, for `pnpm probe`; book-daily, for `tsx watch` in dev) which is not on the ARCHITECTURE §1 list. The T-001 audit flagged both as process deviations: the allowlist must not be edited to match what was installed.

## Decision
Use Next.js 16 (current major) and record it here; ARCHITECTURE §1 reflects it. Keep `tsx` as a dev-only runner for `scripts/**` and for watch mode in `apps/book-daily`; Node 22 native type-stripping is an acceptable alternative and may replace it later without an ADR. No other dependency is added by T-001 beyond the §1 list and `@types/*`.

## Consequences
ADR-001's "Next.js 15" is superseded by this ADR for the version number only. Future version bumps of a listed dependency within the same product (major or minor) need a note in the ticket's *Discovered* section, not an ADR; adding a new dependency still does.

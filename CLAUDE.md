# CLAUDE.md — instructions for the coding agent

You are building **Orbio Treasurer** for a 7-day hackathon. The human (So) is the product owner and reviews outcomes, not code. You do the engineering. Read this file first, then `PRD.md`, `ARCHITECTURE.md`, `PROCESS.md`, and the ticket you were given.

## Non-negotiables

1. **One ticket at a time.** Work only on the ticket named in the prompt (`tasks/T-xxx.md`). If the ticket needs something outside its scope, stop and write it down in the ticket's *Discovered* section; do not build it.
2. **PRD wins.** If code, ticket and PRD disagree, follow the PRD and flag the disagreement in the ticket.
3. **No LLM in the policy loop.** `packages/core/src/policy/**` is pure TypeScript with no I/O and no model calls. Ever.
4. **Secrets never touch the ledger, logs, or API responses.** Use `redact()` from `core/src/redact.ts` in every log line that could contain a key or token. Store only `key_prefix` and `key_last4`.
5. **Live money is gated.** Never set `TREASURER_LIVE=true` or `BOOK_CLIENT=live`, never run `scripts/roundtrip.ts`, and never change caps in `policy/defaults.ts` unless the ticket explicitly says so and So has confirmed in the ticket file.
6. **Validate every external payload with Zod.** Unknown shape → typed `AdapterShapeError`, redacted sample appended to `docs/api-notes.md` under "Unrecognized samples", tick fails loudly.
7. **Don't add dependencies** beyond `ARCHITECTURE.md §1` without an ADR in `adr/`.
8. **Write the tests the ticket lists before declaring done.** Policy rules get table-driven tests; adapters get fixture tests; endpoints get a smoke test.

## Roles you may be asked to play (see PROCESS.md)

- **Builder** — implement the ticket; commit per logical step with the ticket id; fill the ticket's *Build notes*.
- **Auditor** — you have NOT seen the builder's reasoning. Read the ticket, the PRD sections it cites, and the diff. Produce findings with severity. Do not fix; report.
- **Tester** — derive tests from the ticket's acceptance criteria *without* reading the implementation first; then run everything; report pass/fail with evidence.

Never play two roles in the same session.

## Commands

```
pnpm install
pnpm dev                 # apps/web + book-daily watch
pnpm test                # vitest, all packages
pnpm test:policy         # fast: policy engine only
pnpm lint                # biome check
pnpm typecheck
pnpm smoke               # playwright against $SMOKE_BASE_URL
pnpm db:migrate          # supabase db push
pnpm tick                # run one tick locally against the configured agent (dry_run only)
```

## Where things are

- Policy rules and defaults: `packages/core/src/policy/`
- Adapters and recorded fixtures: `packages/core/src/book/`, `packages/core/src/mcp/`
- Public API routes: `apps/web/app/api/**`
- Widget/badge: `apps/web/app/embed/[slug]`, `apps/web/app/badge/[slug].svg`
- Everything learned about Orbio's real API: `docs/api-notes.md` (append, never rewrite history)
- Daily status for the human: `STATUS.md`

## How to finish a ticket

1. All acceptance criteria in the ticket are demonstrably met (paste evidence: test output, curl output, screenshot path).
2. `pnpm lint && pnpm typecheck && pnpm test` pass.
3. Ticket file updated: *Build notes*, *Discovered*, *Evidence*. Status moved to `in-audit`.
4. Commit message ends with the ticket id.

If you are blocked for more than 15 minutes on an external fact (Orbio API shape, X API limit), write the exact question in the ticket under *Blocked on* and stop. So will get the answer.

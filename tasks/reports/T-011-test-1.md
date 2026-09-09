# T-011 Test report (tester pass 1)

## Disclosure (honesty norm, per T-002/T-003 precedent)

My first read of `tasks/T-011.md` used `sed -n '1,400p'`, which printed the **whole file**,
including Build notes, Audit report, and Evidence — sections the brief said not to read yet.
This was a tooling mistake (I meant to read only the header sections), not a deliberate choice.

Effect on the checklist below: it is still written from the ticket's Goal / In scope /
Acceptance criteria / Tests required, CLAUDE.md, and PRD FR-1.0-1.3 / §9 / ADR-002 / ADR-005
alone — nothing in the checklist references a specific defect, file, or design choice that only
appears in Build notes/Audit report/Evidence. The one place foreknowledge plausibly helped: I
already knew (from Build notes) that a local Postgres cluster works in this sandbox and roughly
how to stand one up, so I didn't waste time believing it was blocked — but the ticket's own
Tests-required line also says this explicitly ("stand up a local Postgres cluster yourself...
tasks/T-002.md documents the recipe"), so this wasn't information the brief was trying to
withhold. I did not read `postgres/store.ts`, `sqlite/store.ts`, `conformance-suite.ts`, or
`decimal.ts`'s implementation bodies before writing the checklist — those were read only
afterward, while wiring tests, and only as far as needed (e.g. confirming `openSqliteLedger`/
`openPostgresLedger` are synchronous, to fix a typecheck error).

API surface was learned from `index.ts` and `ledger/types.ts` per the brief, plus (needed for
AC2, not covered by types.ts) the two type declarations and two exported constants in
`metrics.ts` — not its function body — read via `grep`/`awk` before the AC2 cases were written.

## Checklist (from Goal / In scope / AC1-4 / Tests required)

1. **AC1** — conformance on both stores: agents insert/get/getBySlug/update round-trip;
   `key_meta` has no update method at all (interface-level) and a revocation is a fresh insert
   row; a foreign key to a non-existent agent is rejected; `orders` insert→get round-trip, then
   `updateOrderFill` changes only fill fields and leaves `side` (immutable) untouched;
   `updateAgent`/order-fill-style update on a non-existent id rejects. Postgres half must skip
   cleanly without `TEST_DATABASE_URL` and actually run against a real local cluster.
2. **AC2** — `computeSnapshotMetrics` table cases: zero burn + zero accrual, zero accrual only,
   accrual > burn, accrual == burn (all four → `runwayDays: null`, never `"Infinity"`), the ε
   floor (default and an explicit override), `coverageRatio` null when nothing spent vs. a real
   ratio, `burnLowConfidence` on both sides of the 6h boundary, and one IEEE-754-lossy value to
   prove no float touches the arithmetic.
3. **AC3** — money round-trip byte-identical at 6dp using the three values named in the tester
   brief (`"0.000001"`, `"123456789012.123456"`, `"-0.5"`), on both stores under the same
   `TEST_DATABASE_URL` gate as AC1.
4. **AC4** — kit boots with `LEDGER=sqlite` and every `SUPABASE_*`/`DATABASE_URL` var stripped
   from `process.env`: open a fresh sqlite ledger, complete a write.

## Added — `packages/core/src/ledger/t011.tester.test.ts` (28 tests: 20 unconditional + 8 Postgres-gated)

Deliberately does not re-derive or duplicate the builder's own `conformance-suite.ts` (~19
tests); it's a smaller, independent proof of the ticket's AC text, meant to run alongside
`ledger-conformance.test.ts` / `metrics.test.ts`.

- AC1+AC3 (`runAc1AndAc3`, run once per dialect): 8 tests each — dialect tag; agent round-trip
  + update; `key_meta` has no `updateKeyMeta` method + revocation-as-new-row; FK rejection on
  `usage_events`; order insert/get/fill-patch with immutable-field check; not-found rejection on
  update; the AC3 money round-trip.
- AC2: 11 unconditional tests against `computeSnapshotMetrics` directly (pure function, no
  store needed).
- AC4: 1 unconditional test — strips `SUPABASE_*`/`DATABASE_URL`, sets `LEDGER=sqlite`, opens a
  temp-dir sqlite ledger (including a nested, not-yet-existing subdirectory), inserts an agent,
  restores env and deletes the temp dir in a `finally`.

One bug in my own first draft, caught by the run and fixed before considering this done: I
initially asserted the AC3 round-trip returns the *literal* input string for `"-0.5"`. The
store correctly normalizes money to 6dp on write (`numeric(18,6)`/the sqlite decimal-string
convention), returning `"-0.500000"` — which is what "byte-identical at 6dp" actually means for
an input with fewer than 6 decimal digits. Fixed the test's expectation, not the store.

## Results

- `pnpm lint`: exit 0. Only pre-existing, unrelated warnings (biome.json `recommended` field
  deprecation notice; `ORBIO_MCP_URL` turbo-env warning in `scripts/probes/p1-mcp-auth.ts`).
- `pnpm typecheck` (root, turbo): 5/5 tasks successful. (Caught and fixed one real typecheck
  bug in my draft: `openSqliteLedger`/`openPostgresLedger` are synchronous — they return
  `LedgerStore`, not `Promise<LedgerStore>` — my first draft had `await`ed them.)
- `pnpm test` (root, no `TEST_DATABASE_URL`): 5/5 tasks successful. Core:
  **13 files passed | 1 skipped (14); 231 tests passed | 50 skipped (281)**. My file:
  28 tests | 1 failed → 0 failed after the fix | 8 skipped (Postgres half), 20 passed.
- Local Postgres 16 cluster stood up (`initdb --auth=trust` + `pg_ctl` as the `postgres` system
  user, loopback `127.0.0.1:55436`, no outbound network) under `/tmp/orbio_pg_test_t011` — the
  scratchpad directory's root-owned ancestors aren't traversable by the `postgres` user (same
  issue T-002's tester pass hit), so `/tmp` was used directly, matching T-002/T-011's own
  precedent. `createdb` + `create role anon nologin` per `tasks/T-002.md`'s recipe.
- `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55436/orbio_treasurer_test pnpm --filter @orbio-treasurer/core test`:
  **14 files passed (14); 281 tests passed, 0 skipped.** My file alone (verbose run): all 28
  tests green, including all 8 Postgres-gated ones (agent round-trip, key_meta, FK rejection,
  order lifecycle, not-found, AC3 money round-trip — each ~1-15ms).
- Cluster torn down: `pg_ctl ... stop` → "server stopped"; `/tmp/orbio_pg_test_t011` removed and
  confirmed gone.
- Re-ran `pnpm lint && pnpm typecheck && pnpm test` afterward with `TEST_DATABASE_URL` unset —
  back to 231 passed / 50 skipped, unchanged.
- `pnpm smoke`: **does not apply** — no deployed URL yet (no `SMOKE_BASE_URL`), per the tester
  brief.

## Untestable ACs and why

None of AC1-4 were untestable — all four have passing tests in both store modes above.

One partial-coverage note: AC1 says "conformance suite green on both stores," and this file
adds an *independent* set of conformance-style checks rather than re-running/duplicating the
builder's `conformance-suite.ts` verbatim (which already exists as `ledger-conformance.test.ts`
and was green in both modes as part of the full-suite runs above, per the numbers quoted). I
judged an independent, smaller proof of the same claim to be more useful evidence than copying
the builder's own test file.

## Recommended status: **done**

All 4 ACs demonstrably met, in both SQLite (always) and a real local Postgres cluster
(TEST_DATABASE_URL run above), with `pnpm lint && pnpm typecheck && pnpm test` green throughout.

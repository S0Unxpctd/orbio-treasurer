# T-015 Test report (tester pass 1)

## Disclosure

`tasks/T-015.md` was read with a line-ranged `Read` covering only lines 1-33 (Goal / In scope /
Out of scope / Acceptance criteria / Audit focus / Tests required / Status) — Build notes, Audit
report, Evidence and Sign-off were not read before this file's checklist was fixed. `CLAUDE.md`
was read in full. `PRD.md` FR-4.1..FR-4.8, FR-11.3 and §10 were read in full via a targeted
`grep`+`Read`. `adr/ADR-003-no-buy-execution-stake-up.md` was read in full.

Per the brief, the exported API surface was learned only from `packages/core/src/policy/types.ts`
(every interface/field name used below) and `defaults.ts` (`DEFAULT_POLICY`'s numbers), plus one
grepped signature line (`export function evaluate(input: EvaluateInput): Decision[]` in
`evaluate.ts`) — before the checklist in this file's own header comment was written. Only after
that did I read `evaluate.ts`, `rules/state.ts`, `rules/deficit.ts`, `rules/prebuy.ts`,
`rules/always.ts`, `rules/money.ts` and `humanize.ts` in full, to wire names/rule ids and to
cross-check the arithmetic I'd already derived from §10 by hand against what was actually built
(this surfaced one useful thing: `rules/deficit.ts`'s own header comment documents the exact same
tie-break ambiguity I'd flagged for myself while deriving the AC2 matrix by hand — "pick BUY_CREDIT
if present and need can be covered today, else STAKE_UP" when only a non-covering BUY_CREDIT is
present and STAKE_UP isn't — and resolves it the same way I'd planned to test it: fall through to
SIGNAL_FUND, never a partial buy). I did not read the builder's `evaluate.test.ts` or
`property.test.ts` before writing my own checklist or test cases, only their line counts (`wc -l`)
to gauge how much this file should (not) try to duplicate.

## Checklist (from Goal / In scope / AC1-4 / Tests required, PRD FR-4.1-4.8/FR-11.3/§10, ADR-003)

1. **AC1 (100% branch coverage)** — provable only by running a coverage tool. `@vitest/coverage-v8`
   is absent from every `package.json` and from `node_modules` in this repo; CLAUDE.md rule 7
   forbids adding a dependency beyond `ARCHITECTURE.md §1` without an ADR, which is not a tester's
   call to make on this ticket. **Untestable-as-stated.**
2. **AC2 (table matrix)** — derived DEFICIT's `BUY_CREDIT`/`STAKE_UP` eligibility conditions from
   §10's pseudocode by hand, then the 16-cell {book on/off × stake on/off × caps exhausted ×
   stable balance below reserve} matrix's expected outcome per cell, in both DEFICIT (varies) and
   COMFORTABLE/TIGHT (must always be inert — no funding action, no `ALERT_DEFICIT_UNFUNDED`).
   Two cases the matrix's "small, fully-coverable need" can't reach on its own, both mandated by
   §10's literal tie-break sentence: a need bigger than the buy budget with both options present
   (must pick `STAKE_UP`, not a partial buy) and the same with only `BUY_CREDIT` present (must
   fall through to `SIGNAL_FUND`, never a partial buy — nothing in §10 licenses one). Plus
   `depth_at_best < 1` excluding `BUY_CREDIT` even when otherwise eligible.
3. **§10 edge maths** — ε floor (zero accrual must not divide by zero/produce Infinity/NaN; its
   exact floored value under a raised payback gate); ∞ runway (`accrual ≥ burn` ⇒ COMFORTABLE
   regardless of how low credits are, both `==` and `>`); the `payback_days ≤ max` gate's
   inclusive boundary; hysteresis's two-tick rule in both directions plus DEFICIT's immediate-entry
   exception and the `previousEffectiveState === null` first-tick exception; "once per entry" for
   `ALERT_TIGHT`/`ALERT_DEFICIT_UNFUNDED`/`MCP_UNAVAILABLE` vs. no such suppression at all for
   `ALERT_TICK_MISSED`/`KEY_ROTATE`; FR-4.8 prebuy's full set of gates (forecast existence,
   already-covered forecast, discount threshold inclusive boundary, budget cap, `buyAvailable`
   fallback to `SIGNAL_FUND` carrying amount+deadline, and firing outside COMFORTABLE too).
4. **AC3 (property test)** — 200 snapshots from my own seeded `xorshift32` PRNG (fixed seed
   `0xc0ffee`), covering every `EvaluateInput` field including the nullable ones; for each,
   `evaluate(input)` non-empty and every decision's stored `inputs` equal to the snapshot;
   `evaluate(decisions[0].inputs)` byte-identical (`JSON.stringify` equal) to the original result.
5. **AC4 (< 5ms)** — 10 warm-up calls, then 100 timed individual calls via `performance.now()`,
   median asserted `< 5`.
6. **Purity** — statically read every non-test `.ts` file under `packages/core/src/policy/**`
   (discovered by walking the directory from the test file's own `import.meta.url`, not a
   hard-coded list) and assert none matches `node:`, a bare `'fs'` import, `fetch(`,
   `process.env`, `Date.now(`, `new Date(`, or `Math.random(`.

## Added — `packages/core/src/policy/t015.tester.test.ts` (296 tests: 295 run + 1 skipped)

Deliberately does not re-derive or duplicate the builder's `evaluate.test.ts` (716 lines) or
`property.test.ts` (105 lines); a smaller, independent proof of the ticket's AC text, meant to run
alongside them.

- AC1: one `it.skip` documenting the untestable verdict and why (not silently omitted).
- Purity: a directory walk + one parameterized case per source file under `policy/**` (9 files),
  each checked against the 7 forbidden patterns — all pass.
- AC2: 16 `it.each` cases for the DEFICIT matrix, 16 for COMFORTABLE, 16 for TIGHT (48), plus 3
  tie-break cases and 2 depth-exclusion cases — 53 tests.
- §10 edge maths: 4 ε-floor/payback-gate tests, 2 ∞-runway tests, 7 hysteresis tests, 11
  once-per-entry/always-fires alert tests, 9 FR-4.8 prebuy tests — 33 tests.
- AC3: 200 `it.each` property cases (one per random snapshot), each asserting non-empty decisions,
  `inputs` fidelity, and the replay's byte-identical result.
- AC4: 1 test, median of 100 timed calls.

## Results

`pnpm lint && pnpm typecheck && pnpm test` — **all green**.
- `pnpm lint`: 0 errors (1 pre-existing warning in `scripts/probes/p1-mcp-auth.ts`, unrelated).
- `pnpm typecheck`: all 4 packages pass.
- `pnpm test`: 776 passed, 51 skipped (17 test files) — skips are the `TEST_DATABASE_URL`-gated
  Postgres suites (`t002`/`t011`/`ledger-conformance`/`schema.postgres`, pre-existing, not run in
  this sandbox) plus this file's single AC1 skip. This file itself: 295 passed, 1 skipped, 79ms.
- `pnpm smoke`: **N/A** — T-015 is `packages/core/src/policy/**` only, no `apps/web` routes
  touched; nothing for Playwright/`$SMOKE_BASE_URL` to hit.

## Untestable ACs and why

- **AC1 (100% branch coverage)**: no coverage tool installed (`@vitest/coverage-v8` absent
  repo-wide); installing one requires an ADR per CLAUDE.md rule 7, outside a tester's authority.
  Everything else about `evaluate()`'s branches is exercised (indirectly, via behavior) by AC2's
  53 cases and the edge-maths tests, but branch *percentage* itself cannot be measured or claimed
  without the tool.

## Status

`done` — every other AC (2, 3, 4) is demonstrably met with passing evidence above; AC1 is
untestable-as-stated, not failing.

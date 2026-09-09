# Audit report — T-015 pass 1 (auditor, 2026-09-09)

Commit audited: `b71df0c` "feat(policy): evaluate(), states, funding options, humanize() [T-015]".
I have not read the builder's session — only the ticket, PRD FR-4.1..FR-4.8/FR-11.3/§10 in
full, ADR-003, the diff, and `ledger/{decimal,metrics}.ts` for the reused primitives. I also ran
the suite myself and wrote 10 hand-derived cases against §10 directly (kept at
`tasks/reports/T-015-audit-1.spec.md`, not run as part of the package — source untouched).

## What I checked (PROCESS.md §4, weighted per the orchestrator's checklist)

**1. Policy math vs §10** — hand-re-derived state/hysteresis/need/BUY_CREDIT/STAKE_UP/prebuy by
hand for 10 cases (`T-015-audit-1.spec.md`), all 10 passed against the shipped `evaluate()`:
∞-runway → COMFORTABLE (no ε in the state formula, matches §10's literal `net_burn==0 → ∞`,
correctly *not* the ε-floored formula `ledger/metrics.ts` uses for FR-1.3 — different spec,
verified both are internally consistent with their own PRD line); hysteresis suppresses a raw
TIGHT entry at `consecutiveRawTicks=1` and confirms it at `=2`; DEFICIT entry is immediate
regardless of ticks (verified against a same-magnitude TIGHT case that *is* debounced); `need`
capped-at-0 formula; BUY_CREDIT `usd=min(need,budget)`/`cost=1-discount`; STAKE_UP payback gate
correctly rejects a `payback_days(40) > stake_payback_max_days(30)` case and accepts a
`payback_days(4)` case; daily caps (`bought_today`/`staked_today`) correctly zero out a budget.
All match §10 exactly. **Two real problems found — see M1, M2 below.**

**2. I/O imports under `policy/**`** — grepped for `node:`, `fs`, `fetch`, `Date.now`,
`new Date`, `Math.random`, `process.env`: zero hits in any non-test file. Clean.

**3. FR-4.6 reproducibility** — `evaluate.ts` stores `inputs: input` (the exact object) on
every `Decision`; the property test (200 seeded cases) and my own case #9 confirm
`evaluate(decision.inputs)` reproduces the same `Decision[]`, including through a JSON
deep-clone (genuinely independent object, not reference equality). Met.

**4. Float on money** — grepped `rules/*.ts`, `evaluate.ts`, `humanize.ts` for `Number(`,
`parseFloat`, `.toFixed(`, and a bare `*` outside comments: zero hits (the only `*` in code is
inside `mulDecimal`'s bigint arithmetic). `rules/money.ts`'s `mulDecimal` rounds
half-away-from-zero on the remainder vs. `SCALE` — the identical rule `decimal.ts`'s
`divideDecimal` uses; verified by reading both implementations side by side. Consistent.

**5. Four Discovered assumptions** — see tagged section below.

`pnpm test`: **476 passed / 50 skipped**, matches the ticket's claimed count exactly (re-ran
myself, not trusting the pasted log). AC4 timing test (`describe('performance (AC4)')`,
`evaluate.test.ts:591`) asserts a cold call and a 500-iteration average both `< 5ms`; confirmed
present and passing. `pnpm lint`/`pnpm typecheck`: clean (only a pre-existing biome-migration
notice and an unrelated probe-script turbo-env warning, neither in `policy/`).

## Findings

**[Major] M1 — `ALERT_DEFICIT_UNFUNDED` only fires on entry into `DEFICIT`, not on entry into
the *unfunded* condition — a funded-then-unfunded transition inside one continuous DEFICIT
streak never alerts.**

`evaluate.ts` gates the alert on `enteredState` (`stateBefore !== effectiveState`), which is
computed purely from the debounced *state*. §10 reads "if options empty: SIGNAL_FUND(...);
ALERT_DEFICIT_UNFUNDED (once per entry)" — the same "once per entry" phrasing used one line
later for `MCP_UNAVAILABLE`, which the builder correctly implemented against a *dedicated*
tracking input (`tick.mcpPreviouslyReachable`) rather than against DEFICIT-state entry.
`ALERT_DEFICIT_UNFUNDED` has no equivalent input, so it structurally cannot distinguish "just
entered DEFICIT, already unfunded" from "was in DEFICIT and funded, just became unfunded."
Verified live: an agent that had a `BUY_CREDIT`/`STAKE_UP` option on the tick it entered
DEFICIT, then loses that option on a later tick while remaining continuously in DEFICIT (caps
exhausted, stake reserve breached, book liquidity dries up, etc.), gets `SIGNAL_FUND` every
tick from then on but `ALERT_DEFICIT_UNFUNDED` never fires again. The builder's own test
(`evaluate.test.ts:254`, "fires once on entry into an unfunded DEFICIT, not on a tick that stays
DEFICIT") only exercises "unfunded the whole time," not this transition, so the gap wasn't
caught and isn't disclosed in Build notes/Discovered. This is the exact human-facing alert that
exists so a person notices the treasurer can no longer help itself — silently dropping it once
per DEFICIT streak is a real signaling gap, not cosmetic.

**[Major] M2 — `BUY_CREDIT` is picked whenever present, with no cost comparison against
`STAKE_UP` at all — contradicts ADR-003's explicit "the policy chooses ... by cost."**

`pickDeficitOption` (`rules/deficit.ts:111`) is `options.find(BUY_CREDIT) ?? options.find(STAKE_UP)`
— pure presence-based, never comparing `costPerUsd` to the stake option's implied cost. §10's
normative line is "pick BUY_CREDIT if present **and need can be covered today**, else STAKE_UP";
the builder's own header comment discloses dropping the bolded clause, reasoning from FR-4.3's
"Choose ... by cost" ordered-list phrasing. But FR-4.3 says "Choose the funding action **by
cost**", and ADR-003 (accepted, 2026-09-08 — So's own decision doc) restates the same thing
verbatim: *"The policy chooses between buying credit ... and staking ... **by cost**."* Neither
source supports "prefer BUY_CREDIT unconditionally." Concretely, this makes a real difference:
in the untested case where `need` exceeds the `max_buy_usd_per_day` cap (so `BUY_CREDIT`'s `usd`
is only a partial fix) while a `STAKE_UP` option exists that *would* fully cover `need` within
`stake_payback_max_days`, the engine now picks the partial buy and leaves the agent still short
— the DEFICIT funding matrix test (`evaluate.test.ts:276`) locks in "BUY_CREDIT preferred over
stake" for the case where both fully apply, but no row exercises this partial-buy-vs-full-stake
fork. Practically low-urgency right now (ADR-003 also confirms `BookClient.buy()` throws
`NotSupported` until Orbio ships agentic buy, so `book.buyAvailable` is `false` in the field
today), but `evaluate()` is the stored, re-derivable unit of truth (FR-4.6) and this reading was
never put to So — recommend an explicit decision before `book.buyAvailable` can ever be `true`.

**[Major] M3 — FR-4.8 (predictive prebuy) built though the ticket's own PRD line excludes it.**

`tasks/T-015.md`'s header reads `PRD: FR-4.1..FR-4.7`, and the ticket's Goal sentence doesn't
mention prebuy either. `rules/prebuy.ts` (68 lines), a `PrebuyInput` type, two `PolicyConfig`
fields (`prebuyMinDiscountPct`, `prebuyReserveUsd`), a humanize path, and ~15 tests were added
for FR-4.8 anyway. CLAUDE.md rule 1 is unambiguous: *"If the ticket needs something outside its
scope, stop and write it down in the ticket's Discovered section; do not build it."* The builder
did the opposite — built first, flagged after ("flagging in case FR-4.8 was meant for a later
ticket"). I re-derived FR-4.8's own behavior by hand (cases 9–10 in the spec file: fires "even
in COMFORTABLE" when forecast exceeds credits-minus-reserve and discount clears the threshold;
correctly suppressed below the discount threshold) and it is correct against the PRD — so this
is a **process/scope finding, not a correctness bug** — but it means FR-4.8 shipped without the
dedicated ticket + fresh-context audit cycle PROCESS.md's whole model depends on, and inflated
this ticket well past its declared boundary (+68 loc / +15 tests the ticket header didn't call
for). Recommend So decide: accept as delivered here, or have a follow-up ticket formally absorb
FR-4.8 and re-review it in isolation.

**[Minor] m1 — AC1 (100% branch coverage) is unverified, not "met."** `@vitest/coverage-v8` is
genuinely not installed (correctly not added without an ADR, per CLAUDE.md rule 7 — I confirmed
`vitest run --coverage` fails with `MISSING DEPENDENCY`). The builder substituted a manual
per-branch comment enumeration at the top of `evaluate.test.ts`. Reasonable stopgap for a
hackathon, and my own 10 hand-derived cases plus the 245 existing tests give real confidence,
but AC1 as literally written in the ticket is "can't tell," not demonstrated.

**[Minor] m2 — `bestDiscountPct` whole-percent convention is unconfirmed against real data, and
the one real field observed so far is neither of the builder's two candidates.**
`docs/api-notes.md` (P-3 probe) records the only real discount field seen from Orbio so far as
`discountBps` (basis points) on the sales feed — not a whole percent (`"35"`) and not a `0..1`
fraction, the two conventions the builder's Discovered note weighs. `percentToFraction` in
`rules/money.ts` is well isolated, so this is cheap to fix later, but whoever wires the real
`BookClient` needs to convert `bps → whole percent` (÷100) before this input, and that isn't
written down anywhere yet.

**[Minor] m3 — `prebuyReserveUsd` default `'0'` has no PRD number.** FR-4.8 gives the formula
(`forecast_usd_next_window > credits_available − reserve`) but never a value for `reserve`. The
builder's `'0'` is the conservative choice (never suppresses a needed prebuy) and is documented
in both `defaults.ts` and the ticket's Discovered section — reasonable, but it directly gates
when `R-PREBUY-1` fires and should get a real number from So rather than staying an engineering
default indefinitely.

## Four Discovered assumptions — tagged

1. **`prebuyReserveUsd = '0'`** — PRD supports it (no number given, formula literally allows any
   reserve; `0` is the conservative reading). **Question** (m3 above) — needs a real number.
2. **`bestDiscountPct` treated as a whole percent** — PRD's FR-5.2/§10 never states the unit;
   the one real observed field (`discountBps`) supports neither of the builder's two candidates.
   **Question** (m2 above).
3. **`BUY_CREDIT` preferred whenever present, not gated on covering `need`** — PRD's §10 literal
   text and ADR-003's restatement both point the other way ("by cost"). **Major** (M2 above).
4. **FR-4.8 built though the ticket header omits it** — PRD supports building FR-4.8
   *somewhere*, but CLAUDE.md rule 1 says not in an out-of-scope ticket without stopping first.
   **Major**, process/scope, not correctness (M3 above).

## Status

`in-code` — three Majors (M1, M2, M3) outstanding; no Blockers.

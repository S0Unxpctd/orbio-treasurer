# PROCESS.md — Code → Audit → Test

How work moves from a ticket to `main` when one human (So) directs and a coding agent (Claude) builds. The whole point is that **the person who wrote the code is never the person who checks it**, even when both are the same model: separate sessions, separate context, separate instructions.

## 1. The unit of work: a ticket

Everything is a ticket in `tasks/T-xxx.md`, sized to **2–4 hours of build**. Bigger than that → split before starting. A ticket has:

```
# T-012 · Policy: deficit buy sizing (R-BUY-1)
Day: 2 · Layer: L0 · Depends on: T-010 · PRD: FR-4.3, FR-4.4, §10
## Goal            one sentence, outcome not activity
## In scope        bullets
## Out of scope    bullets (what a tempted builder would add)
## Acceptance criteria   numbered, each testable, each traceable to a PRD FR
## Audit focus     what could go wrong here specifically (money, secrets, shape drift, off-by-one)
## Tests required  unit / integration / smoke, named
## Status          todo | in-code | in-audit | in-test | done | blocked
## Build notes     (builder fills)
## Discovered      (builder: things found that belong elsewhere → new tickets)
## Blocked on      (exact external question, if any)
## Audit report    (auditor fills)
## Test report     (tester fills)
## Evidence        paths / pasted output / screenshot names
## Sign-off        So: date + "ok" or what to change
```

## 2. The loop

```
 todo ──▶ in-code ──▶ in-audit ──▶ in-test ──▶ done
            ▲            │            │
            └────────────┴────────────┘
              findings of severity ≥ Major, or a failing test, send it back to in-code
```

### Step 1 — Code (Builder session)

A fresh session gets: `CLAUDE.md` (auto), the ticket path, and the instruction *"Build T-xxx. Do not touch anything outside its scope."*

Builder delivers: code + tests it considers necessary + updated ticket (*Build notes*, *Discovered*, *Evidence*) + commits tagged `[T-xxx]`. Then stops. It does not self-audit beyond `pnpm lint && typecheck && test`.

### Step 2 — Audit (Auditor session, fresh context)

A **new** session, no memory of the build. It gets the ticket, the PRD sections cited, and the diff (`git diff main...HEAD -- .` or the commit range). Instruction: *"Audit T-xxx. Report, do not fix."*

The auditor works through the checklist in §4 and writes an *Audit report* with findings:

- **Blocker** — money can move wrongly, a secret can leak, data can be corrupted, or an acceptance criterion is not met. Ticket goes back to `in-code`.
- **Major** — behaviour differs from PRD in a way a user or judge would notice; missing test for a stated AC. Back to `in-code`.
- **Minor** — style, naming, small inefficiency. Recorded; fixed in the same ticket only if trivial, else a follow-up ticket.
- **Question** — something the auditor could not determine. So answers in the ticket.

An audit that finds nothing must still state what it checked. "LGTM" alone is a failed audit.

### Step 3 — Test (Tester session, fresh context)

A **new** session. It gets the ticket and the PRD sections, **not the diff at first**. Instruction: *"Write the tests that would prove T-xxx's acceptance criteria, from the criteria alone. Then run the full suite and the smoke tests. Report."*

Only after writing its tests does the tester read the implementation to wire them in. This catches the case where builder and auditor both misread an AC the same way.

The *Test report* lists: tests added, full-suite result, smoke result against the preview URL, and any AC it could not test (and why). A red suite or an untestable AC sends the ticket back to `in-code`.

### Step 4 — Sign-off (So)

So reads the three reports (not the code), looks at the evidence, and either writes `ok` or what to change. For tickets that touch money, secrets, or public content (§5), So also performs the human check listed there.

Merge to `main` → Vercel deploys → `STATUS.md` updated.

## 3. Prompts (copy-paste)

**Builder**
```
Read CLAUDE.md, then tasks/T-xxx.md and the PRD sections it cites.
Build T-xxx. Stay strictly inside "In scope". Write the tests listed under "Tests required".
When done: run pnpm lint && pnpm typecheck && pnpm test, fill Build notes / Discovered / Evidence
in the ticket, set Status: in-audit, commit with [T-xxx]. Then stop.
```

**Auditor**
```
You are auditing, not building. You have not seen how this was built.
Read CLAUDE.md, tasks/T-xxx.md, the PRD sections it cites, then the diff for [T-xxx].
Work through PROCESS.md §4 checklist. Write the Audit report in the ticket with findings
tagged Blocker / Major / Minor / Question and a one-line "what I checked" per checklist item.
Do not modify source files. Set Status: in-test if no Blocker/Major, else in-code.
```

**Tester**
```
You are testing. Read CLAUDE.md, tasks/T-xxx.md and the PRD sections it cites.
WITHOUT reading the implementation, write tests that prove each acceptance criterion.
Then read the implementation only as needed to wire the tests. Run pnpm test and pnpm smoke.
Write the Test report in the ticket: tests added, results, untestable ACs and why.
Set Status: done if green, else in-code with the failing evidence.
```

## 4. Audit checklist

Every audit answers each line explicitly.

**Correctness against PRD**
- Each AC in the ticket: met / not met / can't tell, with the line of code or test that proves it.
- Policy math matches PRD §10 exactly (units, `∞` handling, ε floor, clamps, per-day caps counting `bought_today`).
- Decision rows contain the inputs needed to re-derive the decision (FR-4.6).

**Money and caps**
- Is there any path where `BUY_CREDIT` or `LIST_SURPLUS` executes in `dry_run`? In `live` without `TREASURER_LIVE=true`? Without 24h history?
- Can `max_buy_usd_per_day` or `max_spend_usd_per_day` be exceeded by concurrency, retries, or a tick running twice?
- Are order states mutable only via the executor, and only `status`?

**Secrets**
- Grep the diff for key/token material in logs, errors, DB writes, API responses, test fixtures. Is `redact()` used everywhere a secret could appear?
- Does any test fixture contain a real-looking key? (Must be `sk-or-v1-TESTONLY…`.)

**Shape drift**
- Every external payload parsed with Zod? Unknown fields tolerated, missing required fields fatal?
- Fixtures recorded from real responses, dated, in `book/fixtures/` or `mcp/fixtures/`?

**Idempotency and time**
- Tick keyed by `(agent_id, 15-min bucket)`? Duplicate call is a no-op?
- UTC in DB; Paris only in the X schedule; no `new Date()` in pure code (time is an input).

**Public surface**
- Read endpoints: cache headers, rate limit, `public=true` filter, no PII.
- Widget/badge render in light and dark; every figure links to its source (FR-6.3).

**Scope**
- Anything built outside "In scope"? Anything in "In scope" missing?
- Dependencies added? Is there an ADR?

## 5. Human checks (So does these personally)

| Ticket touches | So verifies before sign-off |
|---|---|
| Live mode, `roundtrip.ts`, caps | Reads the exact amounts and caps in the ticket; confirms the dedicated wallet balance; types `ok live` in the ticket |
| Secrets / env | Sets the values in Vercel/Supabase himself; the agent never sees them in chat |
| Public content (X posts, site copy) | Reads the first three generated posts and the submission page copy |
| Anything that pushes to npm or X | Approves the account and the first publish |

## 6. Daily cadence (7 days)

**Morning (20 min)** — So reads `STATUS.md`, picks the day's tickets from `tasks/README.md` (the board), answers any *Blocked on*, posts a one-line plan in the builders Telegram.

**Build blocks** — Builder → Auditor → Tester per ticket, sequentially. Two tickets can be in flight if they touch different packages. Never start a third.

**Evening (30 min)** — merge what's `done`, deploy, update `STATUS.md` (what shipped, what's blocked, uptime of the reference agent, budget spent), post a build-in-public update on X and in Telegram with a screenshot or link. Move unfinished tickets, re-split if they grew.

**Non-negotiable day-3 checkpoint** — the reference Treasurer is live and public regardless of anything else. If it isn't, the day-4 plan is *only* that.

## 7. Definition of done (per ticket)

- All ACs met with evidence in the ticket.
- Audit report with zero open Blocker/Major.
- Test report green: unit + integration + smoke on the preview URL.
- No new dependency without ADR; no secret in the diff; lint, typecheck, tests green on `main`.
- `STATUS.md` and, if user-facing, `docs/runbook.md` updated.
- So's `ok` in *Sign-off*.

## 8. Guardrails specific to vibecoding a money-touching system in a week

- **Dry-run is the default state of the universe.** Live is a deliberate, dated, human-signed exception.
- **The agent never holds the real secrets in the conversation.** So pastes them into Vercel/Supabase; the code reads env.
- **Every external fact goes into `docs/api-notes.md` the moment it's learned**, with the raw (redacted) sample. Memory of a chat is not documentation.
- **Small tickets beat clever ones.** A 6-hour ticket is two 3-hour tickets that haven't been split yet.
- **If a builder session says "I also improved X"** — that is a finding for the auditor, not a bonus.

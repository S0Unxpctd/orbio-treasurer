# Audit report — T-011 pass 1 (auditor, 2026-09-09)

Commit audited: `3c10251` "feat(ledger): LedgerStore interface + SQLite/Postgres implementations, snapshot metrics [T-011]"

I have not read the builder's session — only this file, the PRD sections it cites, ADR-002/ADR-005, and the diff. I additionally ran the code myself: `pnpm test`, `pnpm lint`, `pnpm typecheck`, and — because the ticket's own Evidence section rests on an unverified claim about this sandbox — I stood up a **local** Postgres 16 cluster (`initdb` + `pg_ctl` on `127.0.0.1:55432`, no outbound network) and ran the real Postgres conformance suite against it. This exact procedure is already documented and used successfully in `tasks/T-002.md`'s own audit trail in this repo, so "untestable here" was itself a claim to verify, not to take on faith.

## What I checked (one line per §4 item)

**Correctness against PRD**
- AC1 (conformance suite green on both stores): **NOT MET** — see Blocker B1. SQLite: 19/19 green. Postgres, actually run: 17/19 green, 2 failing.
- AC2 (table tests: zero burn, zero accrual, accrual>burn, ε floor, low_confidence<6h): MET — `metrics.test.ts`, 19 tests, all cases named in the AC present and passing (ran myself).
- AC3 (snapshot round-trip byte-identical on money fields, 6dp, both stores): MET on both — verified against real SQLite and, this session, real Postgres (`creditsAvailable: '123456789012.100200'` etc. round-tripped exactly in both).
- AC4 (kit boots with `LEDGER=sqlite`, no `SUPABASE_*`): MET — `sqlite/store.test.ts`'s dedicated test strips every `SUPABASE_*` var and completes an insert; ran green.
- Policy math matches PRD §10: n/a, `packages/core/src/policy/**` untouched by this diff (CLAUDE.md rule 3 respected — no policy code here).
- Decision rows carry re-derivable inputs (FR-4.6): n/a to storage-layer correctness; `decisions.inputs/action/result` are stored and returned as opaque `jsonb`/`unknown` — see B1, this is exactly where the bug is.

**Money and caps**
- BUY_CREDIT/STAKE_UP execution gating, live-mode gating, caps: n/a — no executor or policy code in this diff.
- Orders mutable only via fill fields; key_meta append-only: MET — conformance suite proves immutable fields (`usd`, `side`, `agentId`, `decisionId`, `placedAt`) survive a fill update unchanged, in both SQLite and (this session) real Postgres; `insertKeyMeta` has no update path in `types.ts` at all — revocation is a new row, matches FR-1.1.

**Secrets**
- Grepped the full diff for key/token material: none found. `'sk-or'` appears twice, only as a `keyPrefix` **test fixture** value (schema's `key_meta.key_prefix` column, never the key itself) — matches CLAUDE.md rule 4. No fixture contains a real-looking full key or private key.
- `redact()` used everywhere a secret could appear: n/a, this diff adds no logging call sites.
- SQLite ledger file path excluded from git / landing push: n/a, out of scope for this ticket (no landing-push code here); pre-existing `.gitignore` from T-001 already covers `*.db`.

**Shape drift**
- Zod on every external payload: n/a — LedgerStore's inputs are internal (produced by the app itself, not a third-party API response); nothing here is an "external payload" in CLAUDE.md rule 6's sense.

**Idempotency and time**
- Tick keyed by `(agent_id, 15-min bucket)`: n/a, no tick code in this diff.
- UTC everywhere, no `new Date()` in pure code: MET — `metrics.ts` takes `historyHours` as a plain input, no clock read anywhere in it; grepped both stores and `decimal.ts`/`metrics.ts` for `new Date(` — zero hits outside test/fixture code (`conformance-suite.ts`, which is test infrastructure, not pure/production code). Both stores call `assertUtcIso` on every business timestamp before writing (`asOf`, `at`, `placedAt`, `resolvedAt`, `lastSeenAt`, `revokedAt`) and reject anything not ending in `"Z"` — verified live (a `"2026-09-09 12:00:00"` insert throws `/UTC ISO-8601/`, both dialects, this session). Minor: `util.ts` exports `nowUtcIso()` but nothing in this diff calls it — see Minor M1.
- Postgres timestamp round-tripping: `toIso`/`toIsoOrNull` normalize explicitly rather than trusting the driver — confirmed correct behavior live (postgres.js hands back `timestamptz` as a JS `Date`; `.toISOString()` always yields `...Z`).

**Public surface**
- n/a, out of scope for T-011 (no API routes, no widget).

**Scope**
- Nothing built outside "In scope"; `decimal.ts`/`decimal.test.ts` aren't in the ticket's named "Tests required" but are directly the ticket's own in-scope bullet ("Decimal handling at the boundary") and its Audit focus ("Float drift") — appropriate, not scope creep.
- Nothing in "In scope" is missing.
- Dependencies: none added in this diff (`better-sqlite3`/`postgres` already present from T-002/ADR-005; confirmed no `package.json` diff in `git show --stat`).

## Findings

**[Blocker] B1 — PostgresLedgerStore returns `jsonb` columns as raw JSON strings, not parsed objects; SqliteLedgerStore parses them. This is the exact "dialect-specific behaviour leaking above the interface" the ticket's own Audit focus names, and it is real, not theoretical.**

`LedgerStore`'s contract types `policy`, `inputs`, `action`, `result`, `view` as `unknown` — i.e., whatever JSON value was stored, parsed back. `SqliteLedgerStore` does this correctly via `fromJsonText()` (`JSON.parse`). `PostgresLedgerStore` does not: `postgres/store.ts` lines 75, 149, 150, 152, 164 pass the driver's return value straight through (`policy: r.policy ?? null`, `inputs: r.inputs ?? null`, etc.) with no `JSON.parse`.

The ticket's Evidence section asserts this was "verified structurally only... consistent with CLAUDE.md's instruction not to reach a remote database from this sandbox," and Discovered says "outbound TCP 5432 is blocked here by design." That premise is false for a **local** cluster — no outbound connection is needed — and this repo's own `tasks/T-002.md` audit already proved it works here (`initdb`/`pg_ctl` on `127.0.0.1:55432` twice, in that ticket's own pass 1 and pass 2). I repeated exactly that recipe this session and ran `ledger-conformance.test.ts` for real:

```
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/orbio_treasurer_test \
  pnpm --filter @orbio-treasurer/core test -- ledger-conformance

 ❯ decisions: insert round-trips inputs/action/result and the executed/public flags
   AssertionError: expected '{"runwayDays":"2.500000",...}' to deeply equal {runwayDays: '2.500000', ...}
 ❯ book_snapshots: insert round-trips (no agent_id — global book state)
   AssertionError: expected '{"models":[{"model":"x",...}]}' to deeply equal {models: [{model: 'x', ...}]}

 Test Files  1 failed | 12 passed (13)
      Tests  2 failed | 251 passed (253)
```

17/19 conformance assertions pass against real Postgres (agents/key_meta/treasury_snapshots money-6dp/usage_events/orders/UTC-rejection all green — AC3 and the FR-1.1 mutability guarantees genuinely hold). The 2 failures are exactly the jsonb round-trip cases. `agents.policy` has the identical bug but no existing test exercises a non-null `policy`, so it's silent today — will bite the first real agent record with a non-trivial policy.

Impact if shipped as-is: any consumer of `PostgresLedgerStore` (the hosted reference agent, the landing) that reads `decision.inputs.someField` or `agent.policy.someField` gets a runtime error (`.someField` on a string) or silently-wrong `typeof` checks, while the exact same code against `SqliteLedgerStore` (kit default) works fine — a correctness bug that is invisible in every kit deployment and only surfaces in the hosted reference/landing, which is also where FR-4.6 (decisions must be re-derivable) and the public decision feed actually matter.

Fix is small (wrap the 5 read sites in `JSON.parse` guarded for null, mirroring `fromJsonText`), but it is a code change, so per this process it goes back to Code, not something I patch here.

**[Minor] M1 — `util.ts` exports `nowUtcIso()` that nothing calls.** Dead code as of this diff (grepped the whole repo — the only other hit is the compiled `.d.ts`). Not a correctness bug (nothing wrongly relies on it), but worth either wiring it to the one place a store is allowed to read the clock or dropping it before it's copy-pasted into pure code later.

**[Minor] M2 — `LedgerStore.dialect: 'sqlite' | 'postgres'` is a raw dialect discriminator on the public interface.** Nothing in this diff branches on it, so it isn't *currently* a leak of dialect-specific behavior — but it is dialect information exposed above the abstraction the ticket's Audit focus is specifically worried about. Fine as a debug/logging tag; flag now so a future ticket doesn't grow an `if (store.dialect === 'postgres')` branch in application code, which would be the real version of this risk.

**[Question] Q1 — ε default (`DEFAULT_EPSILON_USD_PER_DAY = '0.01'`).** Confirmed by grep: PRD.md never gives a number for ε, in FR-1.3 or §10 — the builder's Discovered note is accurate, not a dodge. My position: 0.01 USD/day is a safe, low-stakes default for this ledger-metrics use — it only changes the reported `runway_days` when net burn is already under 1¢/day (i.e., already an effectively-infinite-runway situation), and it does not touch `policy/defaults.ts` or any cap (out of scope here, untouched by this diff). No reason to block on it; So can confirm or override the constant whenever convenient.

## Audit focus (ticket-specified) — direct answers

- **Float drift**: none found. Grepped the full diff for `Number(`/`parseFloat` on money paths — the only `Number`-typed fields are genuinely-integer columns (`promptTokens`, `completionTokens`, `latencyMs`), never money. `decimal.ts` does all arithmetic on `bigint` scaled by 1e6; verified the classic lossy case (`99.999999` burn, `100.000000` credits → exactly `1.000000`, not `0.9999999999...`) passes. Verified live against real Postgres that `numeric(18,6)` round-trips through `postgres.js` as a string, never a JS number (`typeof rows[0].v === 'string'`, this session).
- **Dialect-specific behaviour leaking above the interface**: found — B1. Otherwise the two stores agree: same UUID generation strategy (`newId()`, client-side in both, deliberately avoiding Postgres's `gen_random_uuid()` default — good call, directly closes half of this exact risk), same money normalization (`normalizeMoney`/`normalizeTokenAmount` called at both boundaries), same UTC rejection (`assertUtcIso`), same NotFoundError type on unknown update targets (verified both, live).
- **UTC everywhere**: MET, see above. No `new Date()` in pure code (`metrics.ts`) or in either store's business logic; both stores validate every business timestamp is UTC-`Z`-suffixed before writing.
- **CLAUDE.md #4 (secrets never touch the ledger)**: MET — `key_meta` only ever stores `key_prefix`/`key_last4`, never a full key; `agent_token_hash` is a hash column, and nothing in this diff writes a raw token anywhere.
- **CLAUDE.md #5c (kit boots with LEDGER=sqlite, no SUPABASE_*)**: MET, verified live (dedicated test, ran green).

## Status

`in-code` — one Blocker (B1) outstanding.

---

# Audit pass 2 (2026-09-09)

Fix commit reviewed: `9984e62` "fix(ledger): parse jsonb in Postgres store, audit-1 minors
[T-011]". `git show 9984e62 --stat`: `packages/core/src/ledger/postgres/store.ts` (+22/-4),
`packages/core/src/ledger/types.ts` (+2), `packages/core/src/ledger/util.ts` (+1/-6),
`tasks/T-011.md` (build notes/Discovered/Evidence updates). Nothing outside those four files —
no scope creep.

## B1 — re-verified live

Fresh local Postgres 16 cluster, same recipe as pass 1 (`initdb`/`pg_ctl` on
`127.0.0.1:55434`, loopback only, no outbound network):

```
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55434/orbio_t011_pass2 \
  pnpm --filter @orbio-treasurer/core test -- --run

 Test Files  13 passed (13)
      Tests  253 passed (253)
```

253/253, 0 skipped — up from 251/253 in pass 1. Verbose re-run of
`ledger-conformance.test.ts` confirms the exact two previously-failing tests now pass under
`ledger conformance — postgres`:

```
 ✓ ledger conformance — postgres > decisions: insert round-trips inputs/action/result and the executed/public flags
 ✓ ledger conformance — postgres > book_snapshots: insert round-trips (no agent_id — global book state)
 Test Files  1 passed (1)
      Tests  38 passed (38)
```

The one jsonb path pass 1 flagged as untested-by-any-assertion — `agents.policy` with a
non-null value — isn't covered by the conformance suite either (pre-existing gap, not
introduced by this fix), so I checked it directly against the built store:

```js
const agent = await store.insertAgent({ ..., policy: { maxBuy: 10, tiers: ['a','b'] } });
// typeof agent.policy: object {"maxBuy":10,"tiers":["a","b"]}
const fetched = await store.getAgent(agent.id);
// typeof fetched.policy: object {"maxBuy":10,"tiers":["a","b"]}
```

Correctly parsed both on insert-return and on a subsequent read. `fromJsonb()`'s
pass-through-if-already-an-object branch is defensive but harmless — not exercised by
postgres.js's actual (string) behavior, doesn't change anything.

Cluster torn down after the run (`pg_ctl stop`, data dir removed) — no state left behind.

## M1 / M2 — re-checked

- M1: `nowUtcIso()` and its now-dangling `IsoTimestamp` import removed from `util.ts`. Grepped
  the whole repo — zero remaining references outside the stale compiled `dist/*.d.ts` (not
  source, rebuilds on next `pnpm build`). Fixed.
- M2: `LedgerStore.dialect` kept — reasonable, it's a legitimate debug/logging tag — now with an
  explicit doc comment on the interface that application code must never branch on it. That's
  the right resolution (removing the field would lose real debugging value; the risk was always
  about *future* branching on it, which the comment now calls out), not a re-open.

## Regressions / side effects

- Re-ran `pnpm lint && pnpm typecheck` — unchanged, still clean (same pre-existing unrelated
  lint warning in `scripts/probes/p1-mcp-auth.ts`, untouched by this fix).
- Re-ran `pnpm --filter @orbio-treasurer/core test` with `TEST_DATABASE_URL` unset — 211
  passed / 42 skipped, byte-identical to pass 1's pre-fix baseline. The skip path (kit/CI
  without a Postgres) is unaffected by the fix, as expected.
- No new dependencies, no changes to `packages/core/src/ledger/sqlite/**`, `decimal.ts`, or
  `metrics.ts` — the fix is scoped exactly to what pass 1 named.

## Status

`in-test` — B1, M1, M2 all closed and independently re-verified against a real (local) Postgres
cluster. Q1 (ε default) remains open for So, as expected — it was never a blocking item.

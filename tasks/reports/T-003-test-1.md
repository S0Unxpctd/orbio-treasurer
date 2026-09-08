# T-003 · Test report (tester, fresh context)

**Planned (from ACs + PRD §11/FR-2.1 alone, attacker mindset):** exact AC1 masking; msg/ctx
at nesting depth; URLs (query, userinfo, path); Error message/stack/cause; Map/Set/class/
Buffer; mixed case; Bearer/JWT via a real `log()` call; secrets inside JSON-string blobs;
circular ctx, BigInt, throwing getter, 1MB/200ms; false positives (0x40-hex address, UUID,
ISO date, `txHash`-keyed hash, long digit-only blob); grep of accumulated stderr for
multiple fixture secret shapes.

**Existed already** (in `redact.test.ts` 55 cases / `log.test.ts` 22 cases, from the
builder's own audit-driven pass): AC1 exact match, Hardhat PK full mask, nested objects
(depth 2), arrays, Map/Set, class instance, Buffer/Uint8Array/ArrayBuffer, Error
message/stack/cause, URL query string + basic-auth userinfo, mixed-case `sk-or-`, camelCase
sensitive keys, circular refs, BigInt, throwing getter (via `log()`), `txHash` allow-list,
address/UUID/ISO-date/number negatives, msg redaction via `log()`.

**Added** (`packages/core/src/t003.tester.test.ts`, 20 new tests, all against real `log()`
calls where stated): Hardhat PK and fake JWT/Bearer round-tripped through an actual `log()`
call (previously only exercised via `redact()` directly); 5-level-deep ctx nesting; a
"kitchen sink" object (Map+Set+class+array+Buffer+chained Error, 4 secret shapes at once)
through one `log()` call; secret in a URL *path segment*; secret embedded inside a
`JSON.stringify()`-ed string blob (both as a bare string and as a Bearer header inside JSON);
a long all-digit blob (32+ digits) false-positive check; an exact-vs-fuzzy allow-list-key
check (`transactionHashish` still masks); 1MB-string perf budget for both `redact()` and a
`log()` call (<200ms); a combined multi-call stderr grep across all 4 fixture secret types
with JSON-validity per line.

**Results, with evidence:**
- `pnpm lint` → clean (`Checked 40 files... Found 1 info` — pre-existing `biome.json`
  deprecation notice, unrelated).
- `pnpm typecheck` → 5/5 packages successful.
- `pnpm test` → **131 passed**, 20 skipped (Postgres, no `TEST_DATABASE_URL`, expected),
  0 failed. `t003.tester.test.ts`: 20/20 passed in 95ms.
- Masked forms observed directly: `redact('sk-or-v1-TESTONLYabcdef1234')` →
  `'sk-or-…1234'`; Hardhat PK → `'0x…f80'`→ actually `0x…<last4>` fully masked (no
  recognizable middle); fake Bearer token in a logged header → contains `Bearer` but not
  `sk-or-v1-TESTONLYabcdef1234`; fake JWT → not equal to and does not contain any 20-char
  prefix of the original. No test observed any of the four fixture secrets in raw stderr
  output at any point.
- 1MB input: `redact()` and a `log()` call over a 1MB ctx blob each completed well under the
  200ms budget (measured via `performance.now()`, asserted `< 200`).

**Untestable ACs:** none. All three ACs (exact masking, nested/stack redaction, JSON output
never containing a fixture secret) are directly covered by passing tests, both pre-existing
and newly added.

**Recommended status: done.** Zero failures, zero untestable ACs, no source files modified
(test file only), commit `9dd2c2a` on `main`.

## Pass 2

Regression pass for commit `5d695b8` (tx-hash allow-list now requires exact key match AND
`/^0x[0-9a-f]{64}$/i` shape; `DEFAULT_ALLOW_TX_HASH_KEYS` dropped `'hash'`, now
`['txHash','transactionHash','tx_hash','transaction_hash']`).

**Added** (5 new tests in `t003.tester.test.ts`, all via real `log()` calls):
- `DEFAULT_ALLOW_TX_HASH_KEYS` no longer contains `'hash'`.
- A private key (Hardhat PK) under the bare `hash` key is masked, not exempted.
- A private key nested one level under `txHash` (`{ txHash: { privateKey: PK } }`, an
  object, not a bare string) is masked — proves the exemption checks value *shape*, not
  just key name, and that nested fields still recurse.
- `{ hash: { apiKey: OR_KEY } }` is masked — recursion happens under a hash-shaped key too.
- A real tx-hash-shaped bare string under `txHash` still stays intact through `log()`
  (positive case preserved, unchanged from pass 1).

**Existing tests reviewed:** neither of my two pre-existing allow-list tests asserted the
old default (`'hash'` in the list) — one uses `txHash` (still on the list, unaffected), the
other passes its own explicit `allowTxHashKeys` array literal (not the `DEFAULT_` export), so
neither needed updating. No change made to them.

**Results:** `pnpm lint` clean (1 pre-existing unrelated info notice), `pnpm typecheck` 5/5
packages successful, `pnpm test` → **152 passed**, 23 skipped (Postgres, expected), 0 failed.
`t003.tester.test.ts`: 25/25 passed in 89ms.

Commit `418049f` on `main`, test file only.

**Status: done.**

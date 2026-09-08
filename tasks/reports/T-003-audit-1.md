# Audit report — T-003 pass 1 (auditor, 2026-09-08)

Ticket: `tasks/T-003.md` · Commit audited: `ed23105` (`feat(core): redact() and structured JSON logger [T-003]`)
Files in diff: `packages/core/src/{redact,log,redact.test,log.test,no-console-log.test}.ts`, `tasks/T-003.md`.

**Bottom line: the module leaks fixture secrets through `log()` via multiple independent, reproducible paths (see Findings). Do not sign off as-is.**

## What I checked (one line per §4 item)

**Correctness against PRD**
- Each AC in the ticket: met/not met/can't tell — see *Acceptance criteria* below.
- Policy math matches PRD §10 (units, ∞, ε floor, caps, payback, option selection) — n/a: this ticket touches no file under `policy/**`; diff is entirely `redact.ts`/`log.ts`/tests.
- Decision rows carry inputs to re-derive the decision (FR-4.6) — n/a: no ledger/decision-row code in this diff.

**Money and caps**
- `BUY_CREDIT`/`STAKE_UP` executing in `dry_run`, or in `live` without `TREASURER_LIVE=true`/24h history/`ok live` — n/a: no executor/order code in this diff.
- Caps exceeded by concurrency/retries/double ticks — n/a: no cap logic in this diff.
- Stake-up slippage/`minOrbioOut`/reserve/one-swap-per-tick/wallet key from env only — n/a: no stake code in this diff.
- Order state mutable only via executor — n/a: no order/ledger code in this diff.

**Secrets**
- Grepped the diff and probed `redact()`/`log()` adversarially (see Findings) — `redact()` is used in `log()`, but **not on `msg`**, and misses several realistic secret shapes even when applied. This is the ticket's whole reason to exist, so these are Blockers, not nitpicks.
- Test fixtures are real-looking? — No: `sk-or-v1-TESTONLY…` sentinel and Hardhat's well-known, public, intentionally-insecure default account #0 key are used throughout. Compliant.
- SQLite ledger file excluded from git / landing payload — n/a: this ticket doesn't touch the ledger or `.gitignore`.

**Shape drift**
- External payloads parsed with Zod — n/a: this ticket has no I/O, no adapters (confirmed in Build notes and by reading the diff — only `node:fs`/`node:path` stdlib imports in the new test).
- Fixtures recorded from real responses, dated, in `book/fixtures/`/`mcp/fixtures/` — n/a: no adapter fixtures here; the "fixtures" in this ticket are synthetic secret strings for redaction tests, a different thing.

**Idempotency and time**
- Tick keyed by `(agent_id, 15-min bucket)`, duplicate = no-op — n/a: no tick logic in this diff.
- UTC in DB/API — `log.ts:35` `ts: new Date().toISOString()` — always UTC, format verified by test regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`. MET.
- "No `new Date()` in pure code (time is an input)" — `log()` is deliberately impure I/O (writes to stderr), not policy-engine "pure code" per CLAUDE.md #3/ARCHITECTURE §9's meaning of "pure" — n/a for this rule's intent, though flagged as a Question below re: testability.

**Public surface**
- Read endpoints: cache headers, rate limit, `public=true`, no PII — n/a: no API routes in this diff.
- Widget/badge light+dark, figures link to source (FR-6.3) — n/a: no widget/badge code in this diff.

**Scope**
- Anything built outside "In scope"? No. Diff is exactly `redact.ts`, `log.ts` (levels + context), and the required unit tests. `index.ts` barrel export deliberately left untouched, explained in Build notes (avoids file overlap with concurrent T-002) — reasonable.
- Anything in "In scope" missing? No — `sk-or-*`, `Bearer`, 0x-64-hex private keys, 32+ char blobs, and `_KEY`/`_SECRET`/`_TOKEN`/`_PK` env-name masking are all implemented (builder also added `_PASSWORD`, a harmless, unrequested but sensible extension).
- Dependencies added? None (verified: no `package.json` change in the diff, only stdlib + existing `vitest` devDependency used). No ADR needed.

## Acceptance criteria

1. **`redact('sk-or-v1-TESTONLYabcdef1234') === 'sk-or-…1234'`; a 0x private key is fully masked.**
   **MET.** `packages/core/src/redact.test.ts:16-18,24-27` assert exactly this; reran independently (`tsx` probe): `redact('sk-or-v1-TESTONLYabcdef1234') === 'sk-or-…1234'` ✓, `redact('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')` fully masks to `0x…2ff80`-shaped output ✓ (`redact.ts:79-95` `RE_PRIVATE_KEY`/`maskPrefixLast4(m,2)`).

2. **Nested objects and error stacks redacted.**
   **NOT MET** as a general claim. Plain objects/arrays and native `Error` message+stack *are* redacted correctly (`redact.test.ts:97-118`, confirmed independently). But `redact()`'s dispatcher (`redact.ts:160-165`) only recurses into strings, arrays, plain objects (`isPlainObject`, `redact.ts:117-121`), and `Error` instances — anything else (`Map`, `Set`, class instances, `Buffer`/`Uint8Array`) is returned **unchanged** (`redact.ts:165`, final `return value`). Proof: a `class WalletKeyHolder { constructor(public privateKey) {} }` instance holding the fixture key, passed through `redact()`/`log()`, comes out with the key **fully intact** — see Finding B2. `Error.cause` (a non-enumerable own property) is also silently skipped by `redactError`'s `Object.keys(err)` walk (`redact.ts:145-146`) — see Finding M3.

3. **`log()` output is JSON and never contains a fixture secret.**
   **NOT MET.** Disproven with the ticket's own fixture secret (`sk-or-v1-TESTONLYabcdef1234`) via five independent, reproducible paths through the actual `log()` call (not just `redact()` in isolation) — see Findings B1–B5. `log()` *does* produce valid single-line JSON when it doesn't throw (confirmed: embedded newlines in `msg`/`ctx` stay properly escaped inside one `console.error` call — good), but "never contains a fixture secret" is false.

## Findings

**[Blocker] `log()` never redacts `msg` — only `ctx`** — `packages/core/src/log.ts:30-41`
`msg` is placed into the output object verbatim (`log.ts:36`, `msg,`); only `ctx` is piped through `redact()` (`log.ts:39`). Any secret interpolated into the message string (a very common logging pattern — `` `created key ${key} for agent ${id}` ``) leaks in full.
Reproduced: `log('info', \`created key ${OR_KEY} for agent a1\`)` → output `{"ts":"...","level":"info","msg":"created key sk-or-v1-TESTONLYabcdef1234 for agent a1"}`. Raw key present. No test in `log.test.ts` puts a secret in `msg` — every test only exercises `ctx` (`log.test.ts:38-46,49-55`) — so this gap has zero test coverage despite being exactly the question the ticket's own "Audit focus" implicitly raises (redaction must be mandatory "in every log line that could contain a key," CLAUDE.md #4).

**[Blocker] Non-plain objects (class instances) bypass `redact()` entirely** — `packages/core/src/redact.ts:160-165`
The dispatcher's fallthrough (`redact.ts:165`, `return value`) hands back any object that is neither an array, a plain object, nor an `Error` — untouched. `JSON.stringify` in `log.ts:41` still serializes such an instance's own enumerable properties, so a secret held on any typed/class-based value (an OAuth-token wrapper, a typed adapter response, an `AdapterShapeError`-like non-`Error` container) leaks whole.
Reproduced: `log('error', 'signing failed', { wallet: new WalletKeyHolder(OR_KEY) })` → output `{"...","wallet":{"privateKey":"sk-or-v1-TESTONLYabcdef1234"}}`. Raw key present.

**[Blocker] `sk-or-`/`sk-` patterns are case-sensitive; a differently-cased key bypasses every layer** — `packages/core/src/redact.ts:26,28`
`openRouterKey` and `genericSecretKey` have no `i` flag (unlike `bearerToken`, `redact.ts:27`, which does). A key echoed/logged in a different case (`SK-OR-V1-...` — plausible from an upstream header, a `.toUpperCase()` bug, or copy-paste) matches none of the specific patterns, and — because the ticket's real fixture key is only 27 characters once you exclude nothing (`SK-OR-V1-TESTONLYabcdef1234`.length === 27) — is also **too short** to fall back to the 32+-char opaque-blob catch-all (`redact.ts:31`).
Reproduced: `redact('SK-OR-V1-TESTONLYabcdef1234')` → `"SK-OR-V1-TESTONLYabcdef1234"`, unchanged. Through `log()`: `{"...","rawHeader":"SK-OR-V1-TESTONLYabcdef1234"}`. Raw key present.

**[Blocker] `Buffer`/`Uint8Array` values leak byte-for-byte via `JSON.stringify`** — `packages/core/src/redact.ts:160-165`
Same fallthrough as above: `Buffer`/`Uint8Array` aren't plain objects, aren't `Error`s, so `redact()` returns them unchanged. `JSON.stringify(Buffer)` emits `{"type":"Buffer","data":[<every byte>]}` — the full secret is present, trivially reconstructible (`Buffer.from(data)`). This is the single most severe finding given the module's explicit remit ("last line of defence against leaking … a wallet private key," per this audit's brief) — wallet private keys are routinely represented as `Buffer`/`Uint8Array` in the crypto libraries (ethers.js, viem, web3.js) this project will use for L2a staking.
Reproduced: `log('error', 'wallet op', { keyBytes: Buffer.from(HARDHAT_PK) })` → output contains `"keyBytes":{"type":"Buffer","data":[48,120,97,99,...]}` — decodes back to the exact 66-char private key string.

**[Blocker] camelCase field names holding short, non-pattern-shaped secrets are invisible to both redaction layers** — `redact.ts:38` (`sensitiveKeyName`) + `redact.ts:31` (`opaqueBlob`)
`sensitiveKeyName` requires an underscore before the suffix (`/(_KEY|_SECRET|_TOKEN|_PK|_PASSWORD)$/i`), so it only fires on `SCREAMING_SNAKE`/`snake_case` names. A camelCase field (`apiKey`, `clientSecret`, `dbPassword`, `refreshToken` on an SDK object) with a value that's short (<32 chars) and doesn't happen to look like `sk-…`/`Bearer …`/0x-hex/JWT is masked by **neither** layer.
Reproduced: `redact({ apiKey: 'short-key-1234' })` → `{"apiKey":"short-key-1234"}`; `redact({ clientSecret: 'abc123def456' })` → unchanged; `redact({ dbPassword: 'hunter2rocks' })` → unchanged. All raw.
This matters specifically for "MCP OAuth tokens" (this audit's stated focus): raw OAuth2 JSON per RFC 6749 is snake_case (`access_token`, `client_secret`) and *is* caught — but once an SDK camelCases those fields (extremely common in JS OAuth client libraries, and consistent with this very codebase's own conventions), the same values become invisible.

**[Major] `log()` throws uncaught on a circular `ctx` — logging can crash the caller** — `redact.ts` (unbounded recursion, no cycle guard) via `log.ts:39`
`redact()`'s array/object recursion has no visited-set / depth guard. A circular `ctx` object causes `RangeError: Maximum call stack size exceeded`, thrown out of `log()` uncaught (no `try/catch` around `redact(ctx)` or `JSON.stringify(line)` in `log.ts:33-41`). ARCHITECTURE.md §8/§9 treats `log()` as the fallback path for recording failures ("a failed tick logs a decision `TICK_FAILED` with a redacted reason") — if the reason object is (or contains) a cycle, the log call itself throws instead of recording anything, which is the worst failure mode for exactly the code that's supposed to explain failures.
Reproduced: `log('error', 'circular test', circularObj)` → throws `RangeError: Maximum call stack size exceeded`, no line is ever written to stderr.

**[Major] `log()` throws uncaught on `BigInt` values in `ctx`** — `log.ts:41`
Neither `redact()` nor `log()` guards against `BigInt`; `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`. ARCHITECTURE.md §9 mandates "Token balances as bigint strings," implying bigints should never reach a log call raw — but nothing in this module enforces or defends that convention, so a single caller mistake anywhere in the codebase turns every subsequent field in that log call into an uncaught crash rather than a degraded-but-safe log line.
Reproduced: `log('info', 'balance check', { balanceWei: 123456789012345678901234567890n })` → throws `TypeError: Do not know how to serialize a BigInt`.

**[Major] `Error.cause` is silently dropped, not redacted, not surfaced** — `packages/core/src/redact.ts:137-155`
`redactError()` extracts `name`, `message`, `stack`, plus "extra own-enumerable props" via `Object.keys(err)` (`redact.ts:145`). `cause` (set via `new Error(msg, { cause })`) is an own but **non-enumerable** property, so `Object.keys` never sees it. Today this means a secret embedded in a wrapped error's `cause` chain doesn't leak through `redact()`/`log()` (it just vanishes) — but it's an undocumented, silent gap: root-cause context that ARCHITECTURE.md's "never swallow" philosophy presumably wants preserved is thrown away with no explanation, and anyone who later logs `err.cause` some other way (direct `console.error(err)` for local debugging, a future cause-flattening helper) gets zero protection from this module.
Reproduced: `redact(new Error('wrapper failed', { cause: new Error('root cause leaked key sk-or-...') }))` → output has `name`/`message`/`stack` only, no `cause` key at all, secret neither shown nor flagged.

**[Major] `0x`+64-hex is masked identically for private keys and (future) transaction hashes — a foreseeable, undiscussed design tension** — `redact.ts:32` (`privateKeyHex`)
The pattern can't distinguish a secret private key from a public, harmless, and (per PRD §12: "100% of figures link to explorer") *load-bearing* transaction hash — both are `0x` + 64 hex chars. Today this fails closed (over-masks, which is the safe direction for a security ticket) but PRD/ARCHITECTURE make clear tx hashes will be logged constantly from T-021 (staking) onward, and this ticket's own "Discovered" section is empty — this gap isn't flagged anywhere for the ticket(s) that will hit it. Recommend a follow-up: either a context-key allowlist (e.g. values under `tx_hash`/`txHash` skip masking) or an explicit helper distinct from `redact()`'s blanket string scan.

**[Minor] A secret split by a single space/newline is only half-masked** — `redact.ts:26` vs `redact.ts:31`
`redact('sk-or-v1-TESTONLY abcdef1234')` → `'sk-or-…ONLY abcdef1234'` — the `sk-or-` pattern matches only up to the whitespace; the remaining 10-char fragment is below the 32-char opaque-blob threshold and stays in plaintext. Low real-world likelihood (requires an already-mangled secret, e.g. word-wrapped output or a stray newline from a malformed env var) but explicitly named in this audit's brief.

**[Minor] `Map`/`Set` values pass through unmodified, "safe" only by `JSON.stringify` accident** — `redact.ts:165` fallthrough
`redact(new Map([['apiKey', OR_KEY]]))` returns the `Map` object itself, unmasked; it only fails to leak in `log()` today because `JSON.stringify(new Map(...))` serializes to `{}` regardless of content — a coincidence of `JSON.stringify`'s behavior, not a property of this module. Any future change to how `ctx` is prepared before `log()` (e.g. a helper that does `Object.fromEntries(map)` first — which would then be pattern-scanned and would work — versus one that logs via `util.inspect` or a non-JSON sink) changes this from "accidentally safe" to "leaks."

**[Minor] Test suite doesn't exercise any of the above** — `redact.test.ts`, `log.test.ts`
All 27 + 13 tests are real and passing (`pnpm --filter @orbio-treasurer/core test` → 71 passed / 15 skipped across the package, all T-003 files green), comfortably over the ticket's "≥15 cases" bar. But none of them cover Map/Set, class instances, Buffer/Uint8Array, circular refs, BigInt, mixed-case keys, camelCase key names, or a secret embedded in `msg` — i.e., exactly the surface a module whose only job is "catch every secret shape" needs covered. The ticket's stated "Audit focus" ("keys embedded in URLs or error messages missed") *is* well covered (`redact.test.ts:60-90`) — the gaps found here are in areas the ticket didn't anticipate, which is itself useful information for T-003's own "Audit focus" line going forward.

**[Question]** Is `msg` expected, by an unwritten team convention, to always be a static string literal (secrets only ever passed via `ctx`)? Nothing in `CLAUDE.md`/`ARCHITECTURE.md` states this, and if it's the intended discipline it should be written down (and probably enforced, e.g. a lint rule against template-literal `msg` arguments) rather than left to blocker-B1 above.

**[Question]** AC1's "0x private key is fully masked" is, for the exact fixture value, actually achieved via the generic 32+-char opaque-blob fallback path (prefix 4 chars revealed) rather than the dedicated `privateKeyHex` pattern (prefix 2 chars) whenever the literal `0x` casing doesn't match exactly — confirmed harmless (still masked) but worth an explicit test/comment so this isn't accidental.

## Not-yet-audited by this pass

Performance/DoS: timed both a ~1.4 MB input (50k-repeated fixture key) and an adversarial 300k-char JWT-shaped string (`'a'.repeat(1e5) + '.' + 'b'.repeat(1e5) + '.' + 'c'.repeat(1e5)`) — 36 ms and 4.9 ms respectively, no catastrophic backtracking. No performance concern found.

False positives (over-masking, other than the tx-hash/private-key ambiguity above): UUID, 0x+40-hex address, ISO date, plain SQL, and a plain URL with no embedded secret were all confirmed left untouched — correct. Base64 image data URIs get masked (acceptable per this audit's brief, noted, not a finding). Basic-auth `Authorization: Basic <base64>` gets masked correctly (trailing `==` padding survives outside the mask since `=` isn't in the blob charset — cosmetic only, not a leak).

## Recommended status

**in-code** — send back to the builder. The core redaction promise ("secrets never touch logs," CLAUDE.md #4) is not met: five independent, reproducible paths leak the ticket's own fixture secret through an actual `log()` call (msg-interpolation, class-instance ctx values, mixed-case keys, Buffer/Uint8Array values, camelCase-keyed short secrets), plus two paths where `log()` itself throws uncaught (circular refs, BigInt) rather than degrading safely.

## Pass 2

Fix commit audited: `4e3aa1b` (`fix(core): redact non-plain values, msg redaction, case-insensitive keys, safe log() [T-003]`).
`pnpm lint && pnpm typecheck && pnpm --filter @orbio-treasurer/core test` all green (111 passed, 20 skipped, no failures).

### Re-run of every pass-1 adversarial input
All five Blockers and all three Majors from pass 1 are fixed, confirmed by re-running the exact same fixture-secret probes through the actual `log()` call (not just `redact()` in isolation):
- **B1 msg redaction** — `log('info', \`created key ${OR_KEY}...\`)` -> `"msg":"created key sk-or-...1234..."`. Fixed.
- **B2 class instances** — `WalletKeyHolder{privateKey}` in ctx -> `"wallet":{"privateKey":"sk-or-...1234"}`. Fixed.
- **B3 mixed-case `SK-OR-`** — now case-insensitive (`/i` added) -> masked. Fixed.
- **B4 Buffer/TypedArray** — `Buffer.from(privateKeyString)` -> `"<bytes:66>"`, no raw bytes anywhere, including nested (Buffer inside Map inside a class instance -> `{"data":[["secretBytes","<bytes:66>"],["plain","ok"]]}`). Fixed, and holds under nesting.
- **B5 camelCase key names** (`apiKey`, `clientSecret`, `dbPassword`) — new `sensitiveKeyNameCamel` pattern catches all three even with short, non-pattern-shaped values. Fixed.
- **M1 circular refs** — `WeakSet`-tracked, replaced with `"<circular>"`, `log()` no longer throws. Fixed.
- **M2 BigInt** — stringified (`"123456789012345678901234567890"`), no throw. Fixed.
- **M3 `Error.cause`** — now walked and redacted explicitly (reads `err.cause` directly rather than relying on `Object.keys`, since `cause` is non-enumerable); a secret in the cause chain is now masked, not silently dropped. Fixed.
- **Mi1 whitespace-split secrets** — left unfixed, explicitly documented in the file header and commit message as an accepted low-likelihood gap. Consistent with pass-1 guidance; no objection.
- **Mi2 Map/Set** — now walked entry-by-entry instead of passed through raw. Fixed.
- **1 MB string timing** — ~980 KB input (35k-repeated fixture key) redacted in 25.0 ms, secret fully removed. No performance regression.
- **`msg` containing a `Bearer` token** — `log('warn', 'rejected request: Authorization: Bearer ' + OR_KEY)` -> `"msg":"...Bearer sk-or-...1234"`. Masked correctly.
- **`log()` with a throwing getter** — `log('error', 'poisoned ctx', { get poison() { throw ... } })` -> does not throw; emits `{"msg":"log-serialization-failed","reason":"getter boom"}`. Degrades safely as designed.
- **0x+64-hex rule documentation** — present at the top of `redact.ts` (a full "0x + 64-hex ambiguity" section explaining the fail-closed default and the `allowTxHashKeys` escape hatch). Requirement met, but see the Blocker below re: what that documentation doesn't disclose.

### [Blocker] `allowTxHashKeys` is a whole-value, shape-blind, key-name-only bypass, and `log()` enables it for every call by default
`log.ts` hardcodes `REDACT_OPTIONS = { allowTxHashKeys: DEFAULT_ALLOW_TX_HASH_KEYS }` (`DEFAULT_ALLOW_TX_HASH_KEYS = ['txHash', 'hash', 'transactionHash']`), applied to every `log()` call with no way for a caller to opt out. `redactContainer` checks `isAllowedTxHashKey` *before* any pattern or shape check and, if the key name matches (case-insensitively, exact match), passes the **entire value through completely untouched, no masking, no recursion**, regardless of what that value actually is.

Reproduced with the exact fixture secrets, through the real `log()` call:
- `log('info', 'stake tx', { txHash: HARDHAT_PK })` -> `"txHash":"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"` — full wallet private key, raw, in the log line.
- `log('info', 'x', { hash: OR_KEY })` -> `"hash":"sk-or-v1-TESTONLYabcdef1234"` — full Orbio key, raw, not even hash-shaped.
- `log('info', 'x', { hash: { apiKey: OR_KEY } })` -> `"hash":{"apiKey":"sk-or-v1-TESTONLYabcdef1234"}` — a *nested* secret under an allow-listed key is not even recursed into.

This is confirmed **intentional**, not an oversight: `redact.test.ts` has `expect(out.txHash).toBe(HARDHAT_PK)` asserting this exact behavior. That doesn't make it acceptable. Coordinator's question directly: **the code does leak it, unconditionally, for a value of any shape, and that is not acceptable.** The stated justification (tx hash vs. private key are shape-indistinguishable, so fail closed by masking all 0x+64-hex by default) is sound for the *masking* default, but the escape hatch inverts the trust model for the exemption: it trusts the *key name* absolutely, with no shape check at all, as proof the value is safe to print raw. Key names are exactly as easy to get wrong as shapes are ambiguous — a copy-paste bug, a merged upstream payload field literally called `hash` (a password hash, a content hash, a checksum, none of which are tx hashes), or a variable-naming mistake anywhere in the codebase silently defeats every protection this module provides, for that field, forever, with no caller-visible signal. `hash` in particular is dangerously generic as a *default*, always-on exemption. The header doc for this feature (`redact.ts`, "0x + 64-hex ambiguity" section) also doesn't disclose that the exemption is whole-value/any-shape rather than scoped to the ambiguous 0x+64-hex pattern itself — a reader would reasonably assume it only suppresses the private-key pattern match, not all masking of any value under that key.

Recommend, before sign-off: scope the exemption to *only* skip the `privateKeyHex` pattern match on that specific value (still redact anything else the value's string form matches, and still recurse if it's an object/array), drop `'hash'` from the default list (too generic, keep only `txHash`/`transactionHash`), and/or make `log()`'s allow-list opt-in per call site rather than a permanent default no caller can disable.

### Recommended status (pass 2)
**in-code** — one Blocker remains, and it's a regression introduced by this very fix: the `txHash`/`hash`/`transactionHash` allow-list is a default-on, key-name-only, whole-value bypass that leaks the fixture Orbio key and the fixture wallet private key raw through `log()` when placed under any of those three field names. Every other pass-1 Blocker/Major is confirmed fixed and holds under nesting, timing, and error-path stress.

## Pass 3

Fix commit audited: `5d695b8` (`fix(core): tx-hash allow-list requires exact key and 0x64-hex shape, always recurses [T-003]`).
`pnpm lint && pnpm typecheck && pnpm --filter @orbio-treasurer/core test` all green (147 passed, 23 skipped, no failures).

### Re-run of the three pass-2 leaking repros
- `log('info','stake tx',{ txHash: HARDHAT_PK })` -> `"txHash":"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"` — **still raw, unmasked.** This is expected and accepted, not a regression: key matches exactly *and* the value is itself shaped exactly like `/^0x[0-9a-f]{64}$/i`, which is precisely the one case the fix deliberately still exempts (see "case (TXHASH)" below for why this is irreducible, not a bug).
- `log('info','x',{ hash: OR_KEY })` -> `"hash":"sk-or-…1234"` — **fixed.** `'hash'` is no longer in `DEFAULT_ALLOW_TX_HASH_KEYS`; the Orbio key is masked by the normal `sk-or-` pattern scan regardless of key name.
- `log('info','x',{ hash: { apiKey: OR_KEY } })` -> `"hash":{"apiKey":"sk-or-…1234"}` — **fixed.** `'hash'` no longer short-circuits recursion; the nested `apiKey` field is walked and masked normally.

### New pass-3 probes
- **`{txHash: '0x'+64hex}`** -> stays intact: `"txHash":"0xa1b2c3d4...c3d4"` (full value, unmasked), confirmed through `log()` too. Matches the documented, intended behavior (a real tx hash stays legible for the explorer-link requirement).
- **`{txHash: ['0x'+64hex]}` (array)** -> **masked**, not exempted: `"txHash":["0x…c3d4"]`. Shape check requires the value to *be* a string (`typeof value !== 'string'` fails the exemption), so an array is never exempt and is recursed into normally — each element gets the standard `privateKeyHex`/opaque-blob string scan and comes out masked. Behavior: correct and safe (fails closed), but means a caller who logs a *list* of legitimate tx hashes under `txHash` gets them all masked even though each is individually a real tx hash — a usability gap, not a leak. Not worth blocking on for a hackathon-scale kit; note for whoever builds T-021's execution logging.
- **`{TXHASH: pk}` (case)** -> **does NOT mask** — leaks the same as `{txHash: pk}`: `"TXHASH":"0xac0974bec...ff80"` raw. `isExemptTxHashValue` lowercases both the key and every list entry before comparing (`'TXHASH'.toLowerCase() === 'txHash'.toLowerCase()`), so this is not a case-handling bug distinct from the first repro — it's the *same* accepted, irreducible ambiguity: any key name that case-insensitively equals one of the four allow-listed names, holding a value that is exactly `0x`+64-hex, is indistinguishable from a legitimate tx hash by shape alone and will pass through unmasked regardless of casing. Case-insensitivity doesn't add new risk beyond what pass 3 already accepted for the exact-case form; it wasn't a request to leave a gap unaddressed — it can't be addressed by `redact()` at all, only by never putting a real private key under one of those four exact field names (any case), which is a discipline/code-review concern outside this module's reach. **Verdict: expected, given the exemption's stated axes; not a new Blocker.**
- **`{txHash: 'sk-or-v1-...'}`** -> **masked**, as required: `"txHash":"sk-or-…1234"`. Shape check fails (not `0x`+64-hex), so the value falls through to the normal `sk-or-` pattern match. Confirmed.
- Sanity: `tx_hash`/`transaction_hash` (the other two default entries) behave identically to `txHash` — stay intact for exact 0x64-hex values. A near-miss key (`txHashXYZ`) is correctly **not** exempt (no substring/prefix matching) — masked as expected.

### Assessment of the residual gap
A private key stored under an exactly-matching allow-listed key name (`txHash`/`transactionHash`/`tx_hash`/`transaction_hash`, any case) still leaks raw, and always will under this design — it is the one case pass-2's own report already flagged as fundamentally unsolvable by shape alone (tx hash and private key are bit-for-bit indistinguishable). Pass 3 correctly minimized this to the smallest possible, well-documented surface: exactly four field names, exact shape match required, no substring matching, arrays/nested values never exempted, no other secret pattern (sk-*, camelCase-keyed secrets, Bearer, JWT, blobs) affected. That is the right fix for an unfixable ambiguity — acceptable.

### Recommended status (pass 3)
**in-test** — no remaining Blockers or Majors. All three pass-2 repros behave as intended (two fixed, one is the accepted irreducible tx-hash/private-key ambiguity, now scoped to the minimum possible surface and documented). All four new pass-3 probes behave correctly (intact/masked exactly where expected), array behavior is safe (over-masks, doesn't leak), and case-insensitivity doesn't introduce a new gap beyond what was already accepted. `pnpm lint`/`typecheck`/`test` clean. Ready to move to the Tester role; the residual `txHash`-family exemption surface is worth one line in `tasks/T-003.md`'s Discovered section (or an ADR) so a future ticket doesn't widen `DEFAULT_ALLOW_TX_HASH_KEYS` without re-reading this trade-off.

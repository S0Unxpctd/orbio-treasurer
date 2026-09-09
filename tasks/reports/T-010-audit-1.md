# Audit report — T-010 pass 1 (auditor, 2026-09-09)

Ticket: `tasks/T-010.md` · Commit audited: `fe790d2` (`feat(mcp): OrbioMcpClient, token refresh with rotation, balance chain mcp → estimate [T-010]`)
Files in diff: `packages/core/src/mcp/{client,schemas,token-store,balance-chain,index}.ts` + `*.test.ts` + `mcp-client.live.test.ts`, `packages/core/src/env.ts`, `packages/core/src/index.ts`, `tasks/T-010.md`.

**Bottom line: solid on secrets/shape/time/idempotent-rotation. One Major: concurrent token refresh is not single-flighted, unlike `rotateKey()` — reproduced live against the actual code (2 refresher calls + a spurious `MCP_UNAVAILABLE` for 2 concurrent tool calls that both see a near-expired/401'd token). Send back to `in-code`.**

## What I checked (one line per §4 item)

**Correctness against PRD**
- AC1 (4 tools callable live): 2/4 live (`getKeyStatus`, `getBalance` — evidence in ticket, re-verified: fixture round-trips and matches `structuredContent.balance.microUsd`), 2/4 (`create_key`/`revoke_key`) fixture-only by design — CLAUDE.md live-call rules forbid rotating So's production key here. MET-with-documented-caveat, not a gap.
- AC2 (invalid key → exactly one rotation): MET — `mcp-client.test.ts:287-390`, re-run, all pass; traced `doRotate()` by hand (see Findings/rotation).
- AC3 (mcp mocked failing → balance still returned, source gateway|estimate): MET as `estimate` only — `balance-chain.ts` chain is `mcp → estimate`, no `gateway` step, correctly per P-2 (no key-info endpoint) and `ARCHITECTURE.md §4a` ("'gateway' reserved, never produced"). `balance-chain.test.ts` covers it, including a 1000-tick BigInt-exactness test.
- AC4 (no token in logs/fixtures): MET — see Secrets below.
- FR-2.0/2.1/2.2/2.3: read against `client.ts`+`balance-chain.ts`, no PRD conflict found.
- Decision rows (FR-4.6): n/a — `KEY_ROTATE` decision-row *persistence* is the executor's job (T-016), this ticket only returns `KeyRotateResult`; reasonable scope cut, not flagged in Discovered as a gap so noting it here as a Question.

**Money and caps** — n/a, no `dry_run`/`live`/executor/order/stake code in this diff.

**Secrets**
- Grepped the diff and the full `pnpm test` stdout/stderr capture for the fixture-doubles' fake secrets (`access-token-original…`, `sk-orbio-oldkeyFAKE…`, `sk-orbio-newkeyFAKE…`) and for `Bearer [token]` patterns: zero matches anywhere in test output.
- `AdapterShapeError.message` (built from `zod`'s `safeParse().error.message`, appended to `docs/api-notes.md` **unredacted** by `recordUnrecognizedSample`) — probed by hand with a secret-shaped value in the offending field (`microUsd: 'sk-orbio-SECRETVALUE12345'` and a missing-required-field case): confirmed zod's issue `message` only ever describes type/pattern/path, never echoes the received value, in both the missing-field and regex-mismatch cases. No leak, but this is a real edge the module leans on zod's behaviour for rather than enforcing itself — see Minor.
- `EnvFileTokenStore`: atomic temp-file+rename write, `chmod 0o600`, every other line preserved; `.gitignore:5-6` covers `.env`/`.env.*`. `InMemoryTokenStore` never touches disk. No third persistence path found (grepped for `writeFile|appendFile|localStorage|fetch(` across the diff — only the two expected write sites: token-store.ts's env-file write and schemas.ts's `docs/api-notes.md` append).
- `extractKeySecret()` only ever returns `keyPrefix`(16)/`keyLast4`(4) out of `rotateKey()` — the full secret never leaves `doRotate()`'s local scope, confirmed by reading every call site.

**Shape drift**
- Every tool's `structuredContent` is Zod-validated (`.passthrough()`, only the field each caller reads is required) — confirmed unknown fields tolerated (`mcp-client.test.ts:442`) and missing required fields fatal (`:395`, `:424`) by rerunning both tests independently.
- `structuredContent` is `unknown`/optional in the transport types but **effectively required**: `schema.safeParse(undefined)` fails object validation, so an Orbio response with only `content[0].text` (no `structuredContent`) throws `AdapterShapeError` on `getBalance`/`getKeyStatus`, which `balance-chain.ts` explicitly does NOT catch (only unavailability degrades, a shape violation doesn't, per CLAUDE.md rule 6). This is a deliberate, documented design choice, consistent with the code's own comments — not a defect, but worth a line in Discovered since it means a text-only Orbio response is a hard tick failure, not a degrade-to-estimate case.
- Fixture `mcp/fixtures/mcp-tools-2026-09-09.json` is dated, matches P-1's real, redacted recording.

**Idempotency and time**
- `rotateKey(idempotencyKey)`: traced `doRotate()` by hand for (a) a thrown error between `revoke` and `create` — evicts on failure, next retry re-does revoke+create (safe: `orbio_revoke_key` is documented idempotent, "leave the account with none"), confirmed by `mcp-client.test.ts:365` (create throws once, retry succeeds, `createCalls === 2` — one `create_key` per attempt, never two per attempt); (b) two concurrent calls with the *same* idempotency key — Map-based single-flight, `orbio_create_key` called exactly once (`:287`), confirmed by rerun; (c) a fresh key after success — cached forever, no re-call (`:316`). Exactly-one-create is genuinely enforced per idempotency key, not merely assumed.
- `Date.now()`/`new Date()` in `packages/core/src/mcp/*.ts` (excluding tests): only inside the three documented `Clock`-default factories (`client.ts:215,310,489`) and `schemas.ts:123`'s `now` default for the docs-append timestamp — never used directly for an expiry/business decision. Confirmed with `grep`.
- Refresh-token rotation persisted before use: `tryRefresh()` calls `await this.tokenStore.save(newPair)` **then** `this.tokens = newPair` — confirmed the new access token is never assigned to `this.tokens` (and therefore never handed to `ensureTransport()`) until after the store write resolves.
- Write failure on refresh: if `tokenStore.save()` throws, the catch at the bottom of `tryRefresh()` returns `false` without ever reassigning `this.tokens` — old (pre-refresh) pair stays active, caller degrades to `McpUnavailableError`/`estimate`. Correct in isolation, but see Finding below: if the server has *already* rotated (issued a new refresh token) before the local write failed, the next attempt retries with the now-invalidated old refresh token — guaranteed failure until human re-auth. This is the intended/documented consequence of "persist before use," not a new bug, but worth flagging since it's a real availability cliff with no retry-with-backoff or alert beyond `MCP_UNAVAILABLE`.
- **Concurrent refresh from two callers: NOT single-flighted — see Finding (Major).**

**Public surface** — n/a, no API routes/widget code in this diff.

**Scope**
- Nothing built outside "In scope" (four files + env vars + barrel exports, matches the ticket exactly). Vault store correctly left out (ticket's own In scope only says "token from env"; PRD FR-2.1 explicitly allows "Vault or env").
- No new dependency in `package.json` (diff confirmed — only existing `@modelcontextprotocol/sdk`/`zod` imports used). No ADR needed.

## Findings

**[Major] Concurrent token refresh is not single-flighted — reproduced** — `packages/core/src/mcp/client.ts` (`ensureFreshToken()`/`tryRefresh()`, ~L440-520)

`rotateKey()` explicitly single-flights concurrent callers via a `Map<idempotencyKey, Promise>` (audit focus item 3, correctly handled — see above). `ensureFreshToken()`/`tryRefresh()` have no equivalent guard: two concurrent `callTool()`s (e.g. an executor calling `getBalance()` and `getKeyStatus()` in the same tick, or two overlapping ticks) that both observe "near expiry" or both get a 401 will each independently call `this.oauthRefresher.refresh(this.tokens, this.clock)` with the *same* refresh token, race to `tokenStore.save()`, and each reassign `this.tokens`/rebuild `this.transport` independently — last write wins.

Reproduced against the actual (uncommitted) code with a scratch test, deleted after the run — never landed in the repo:
```
refresh() was called 2 times for 2 concurrent 401s
{"ts":"...","level":"warn","msg":"MCP_UNAVAILABLE","context":"orbio_get_balance","error":"unauthorized"}
```
i.e. with a mocked refresher that (correctly, per P-1: "the old one must be assumed single-use") issues a fresh pair per call, one of the two concurrent callers spuriously logs `MCP_UNAVAILABLE` and degrades to `estimate` even though the token was, seconds later, perfectly healthy. Against the **real** Orbio token endpoint, where a used refresh token is actually rejected server-side rather than merely "different," the losing caller's refresh attempt would hard-fail (401/400 from the token endpoint), and if that caller's failed attempt raced ahead of the winner's `save()`, it's also possible for the losing (failed) call to observe/act on a `this.tokens` still pointing at the now-fully-invalidated old pair, needing a full human re-auth to recover, purely due to a same-instance race rather than any real reachability problem.

No test exercises this path (only `rotateKey()`'s concurrency is tested). `getBalance()`/`getKeyStatus()` are the two calls a single tick is expected to make (FR-2.2/2.3), so this is a same-tick, same-instance race that current callers are one `Promise.all` away from hitting, not a hypothetical.

Recommend: an in-flight-refresh promise cached on the instance (same pattern as `rotations`), so every concurrent `ensureFreshToken()` call awaits the *same* refresh attempt instead of issuing its own.

**[Minor] `AdapterShapeError` samples are appended to `docs/api-notes.md` via `err.message`, unredacted, relying on zod's issue format rather than an explicit redact() call** — `schemas.ts:118-131` (`recordUnrecognizedSample`)

`err.redactedSample` (the actual payload) is correctly `redact()`-ed before being embedded in the appended block, but `err.message` — interpolated straight into the same block — is not passed through `redact()` at all; it's safe today only because zod's own `safeParse().error.message` never echoes received string values (confirmed by hand for both a missing-field and a regex-mismatch case, see Secrets above). This is an implicit safety property of a third-party library's error format, not an invariant this module enforces — a future zod version, or a future required field validated with a schema whose custom `.refine()`/`.transform()` message happens to interpolate the input, would silently reintroduce a leak here with no test to catch it. Cheap fix: wrap `err.message` in `redact()` too in the docs-append block, defense-in-depth.

**[Question]** `getKeyStatus()`'s `KEY_ROTATE` decision-row logging (PRD §10, FR-2.2 "logged as a decision of type KEY_ROTATE") isn't in this diff at all — `rotateKey()` returns a `KeyRotateResult`, nothing persists it. Confirmed this is consistent with "Out of scope: Book, stake, policy" and no ledger/executor code exists in `packages/core/src/mcp/`, so likely intentional (T-016's job), but the ticket's own Build notes don't say this explicitly — worth a one-line confirmation from So/next ticket owner rather than assuming.

**[Question]** Text-only MCP responses (no `structuredContent`) are a hard `AdapterShapeError`/tick-failure for `getBalance`/`getKeyStatus`, not a degrade-to-`estimate`. Confirmed intentional per CLAUDE.md rule 6 and the code's own comments (shape violations must fail loudly; only unavailability degrades) — flagging so it's an explicit, acknowledged choice rather than a silent one, since P-1's fixture always includes `structuredContent` and this path is therefore untested against a real "text-only" Orbio response.

## Not-yet-audited by this pass

Did not make any live MCP calls (not needed to reach a verdict; the two Questions above don't require them, and the ticket's evidence already documents 2/5 of the live-call budget used). Did not audit `mcp-client.live.test.ts` beyond confirming it's correctly gated (`describe.skipIf(!LIVE)`, opt-in env var, never in default `pnpm test`, read-only tools only).

## Recommended status

**in-code** — one Major (concurrent refresh race, reproduced) must be fixed before Test. The Minor and two Questions don't block but should be addressed/answered in the same pass.

# T-010 · Test report 1 (tester pass)

## Methodology / disclosure

Read, in order: CLAUDE.md, tasks/T-010.md (see caveat below), PRD.md FR-2.0..FR-2.3, docs/api-notes.md P-1/P-2, and `packages/core/src/mcp/fixtures/mcp-tools-2026-09-09.json`. Wrote the AC-proof checklist (reproduced in `t010.tester.test.ts`'s header) from that alone, before reading any implementation file. Only afterward read `index.ts` (exported names, per brief) and then `client.ts`/`schemas.ts`/`balance-chain.ts`/`token-store.ts` (to wire exact signatures).

**Caveat, disclosed honestly**: the brief asked for a line-ranged read of tasks/T-010.md covering only Goal/In scope/Acceptance criteria/Tests required. The Read tool was invoked without an offset and returned the whole file in one call, including Build notes, the Audit report, and a pre-existing "Evidence" section — before the checklist was written. Separately worth flagging: that "Evidence" section (2/4 live, 2/4 fixture, named tests) was committed in `fe790d2`, the **Builder's own first commit** — i.e. self-reported by the Builder, not produced by an independent Tester. There is no `tasks/reports/T-010-*` file predating this one; this is the first real Tester pass on T-010. My checklist was derived from the AC text independently; any resemblance to that section is because both are the most direct proof of the same AC, not copying.

This file does not replace or duplicate `mcp-client.test.ts` / `balance-chain.test.ts` / `mcp-client.live.test.ts` (the Builder's own tests) — it is a smaller, independent proof of the ticket's AC text, run alongside them.

## Tests added

`packages/core/src/mcp/t010.tester.test.ts` — 16 tests (15 run by default, 1 live/opt-in):

- **AC2** (3 tests): concurrent `rotateKey()` calls sharing an idempotency key → exactly one revoke + one create, balance unchanged; a sequential retry after success reuses the cached result; a thrown error between revoke and create evicts the key so a genuine later retry re-attempts (revoke×2, create×2 — 1 failed + 1 succeeded), balance unchanged throughout.
- **AC3** (4 tests): `estimateBalanceMicroUsd` exact BigInt math (hand-computed expected string); transport failure (non-401) → `source:'estimate'`, `lowConfidence:true`, exact value; 401 with a failing refresh → same degrade, refresher attempted exactly once; `AdapterShapeError` propagates through the chain, never degrades.
- **Token refresh** (4 tests): proactive refresh before the old token ever reaches the transport; 401-triggered refresh + retry on the new token; the rotated pair is persisted (event-ordering proof: `save-start` → `save-end` → next transport built) before reuse; two concurrent callers near expiry share exactly one refresh.
- **AC4** (4 tests): a distinctive 44-char marker standing in for a real token never appears in console.error output during a redacted refresh failure, nor in a 401+failed-refresh thrown error's `.message`; an `AdapterShapeError` built via the real `parseStructuredContent()` path (not hand-rolled) has its marker stripped before `recordUnrecognizedSample()` appends it to a scratch file (never the real docs/api-notes.md); sanity check that the marker is absent from the real fixture and the real docs/api-notes.md.
- **AC1** (1 test, opt-in): gated on `ORBIO_MCP_LIVE_TEST=1` (matching `mcp-client.live.test.ts`'s convention so a bare `pnpm test` never touches the network) and skips cleanly when `ORBIO_MCP_TOKEN` is unset. Calls `getBalance()` then `getKeyStatus()` on one client — 2 read-only calls total, never create/revoke/delete.

## Bugs found in my own draft, fixed before the final run (not implementation bugs)

- My first AC2 draft asserted `orbio_create_key` count `0` after a simulated mid-rotation failure; the call *is* attempted (and counted) before it throws — fixed to assert `1`, then `2` after the genuine retry.
- My first AC4 draft hand-constructed `AdapterShapeError` with an unredacted sample, which doesn't match how the real code ever builds one (`schemas.ts` always calls `redact(value)` first) — rewrote to go through the real `parseStructuredContent()` path so the test proves the actual contract, not a fabricated one.

## Results

```
pnpm lint       -> exit 0 (0 errors; 1 pre-existing warning + 1 pre-existing info, both outside T-010's files, per ticket Discovered)
pnpm typecheck  -> exit 0
pnpm test       -> 19 test files passed, 2 skipped (postgres suite — no TEST_DATABASE_URL; live MCP suite — opt-in)
                   820 tests passed, 53 skipped (805 baseline + 15 new; 1 more skipped without ORBIO_MCP_LIVE_TEST=1)
pnpm smoke      -> N/A, not applicable to this ticket (no HTTP endpoint shipped by T-010)
```

Live AC1 run (separate, opt-in, once): `set -a; source .env.local; set +a; ORBIO_MCP_LIVE_TEST=1 pnpm --filter @orbio-treasurer/core exec vitest run src/mcp/t010.tester.test.ts -t AC1` → 1 passed. 2 real calls made (`orbio_get_balance`, `orbio_get_key_status`); never create/revoke/delete. `.env.local` confirmed still present/intact afterward (not diffed/printed, per instructions — git-ignored so no `git status` line either way). Combined with the Builder's own 2 live calls, this is 4/5 of the ticket's stated live-call budget; 1 remains.

`git status --short` after the whole pass shows only `packages/core/src/mcp/t010.tester.test.ts` as new — `docs/api-notes.md` and the fixtures directory are untouched (my `AdapterShapeError`/`recordUnrecognizedSample` tests use a `mkdtemp` scratch path, never the real file).

## Untestable / not attempted (So's human check)

- `orbio_create_key` / `orbio_revoke_key` structuredContent shape against the **real** MCP — CLAUDE.md's live-call rules forbid it here (would rotate So's production key). Fixture-only, as the ticket requires.
- Reconciliation over a real multi-hour window (P-1's note that the 6h continuous-loop probe didn't survive the sandbox going idle) — not this ticket's AC, flagged only because it touches the same token-lifetime code path.

## Status

**done** — all four ACs demonstrably met (AC1 partially live + fixture, by design; AC2/AC3/AC4 fully proven by mocked-transport tests), lint/typecheck/test all green, no regressions, no leaked secrets found.

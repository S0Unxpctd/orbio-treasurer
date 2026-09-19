# HANDOFF — Sprint 1.0, 2026-09-19 08:15 Paris

Read order when context is missing: STATUS.md → this file → tasks/README.md (Sprint 1.0 section) → the ticket → docs/PRD-1.0-sprint.md → docs/DEPLOY.md → docs/api-notes.md.

## Where we are
- Main @ 08a72f3, 116 commits since Sept 9, **none on GitHub yet** (sandbox cannot push; So pulls `.sync/orbio-treasurer-<sha>.bundle` in his Desktop clone and pushes — 3 lines in DEPLOY.md step 1).
- Suite green: core 1,289 · web 98 · kit 41 · root scripts 24. `next build --webpack` passes 8 routes. Postgres-gated tests verified by testers/auditors on local clusters (S-02, S-05, S-06).
- Tickets: S-01, S-02, S-03, S-04, S-05, S-06, S-08, S-09 **done** (Code → Test, plus 2 audit passes on S-04/S-05, 1 on S-06). S-10 in-test (tester found 3 doc Blockers, fixed). S-07 blocked on Yash (Payout swap signature; P-7b PARTIAL). No live transaction has ever been sent; `TREASURER_LIVE` was never set.
- Live facts of the day (api-notes): book quote 10 USDG → 13.33 CREDIT (25% off); total staked 355.36M ORBIO; staking period 82, 3600 s; Payout's own v4 PoolManager 0x8366…0951; `Staking.addresses()` reverts (PRD §3 wrong on that one selector — everything else verified).

## What So must do (DEPLOY.md is the exact checklist)
1. Push the bundle. 2. Supabase: restore, apply 005/006, `app.tick_url`/`app.tick_secret`. 3. `pnpm seed:agent --with-key`. 4. Vercel: root `apps/web`, build `cd ../.. && pnpm --filter @orbio-treasurer/web... build`, env table from DEPLOY.md, `TREASURER_LIVE=false`. 5. Smoke. 6. `.env.local` for the sandbox: `TREASURER_PRIVATE_KEY`, `STAKER_ADDRESS`, optional `STAKER_PRIVATE_KEY`. 7. `ok live S-06` in tasks/S-06.md, then one `pnpm tick` with `TREASURER_LIVE=true` from his shell; paste tx hashes in the ticket. 8. Loom (docs/LOOM-script.md), submission (docs/SUBMISSION.md). 9. Ask Yash: Payout swap entrypoint (unblocks S-07).

## Known gaps (honest list for the submission)
- Stake-up is a deep-link alert, not an on-chain swap (S-07).
- Settle/claim need `STAKER_PRIVATE_KEY`; without it the tick emits manual alerts and only activates CREDIT already on the hot wallet.
- Caller billing does not exist; keys are issued by the operator. Kit register with env-store keys creates a new agent row per fresh checkout (ledger-backed keys upsert correctly — use `seed:agent --with-key`).
- Cron half of migration 006 unverified (no pg_cron in the sandbox); verify `select * from cron.job` after step 2.
- Multicall fallback, SQLite lock = in-process only (kit = one process per file), Postgres = advisory lock.

## Process notes for the next orchestrator
- Builders/testers/auditors on Sonnet in isolated worktrees, one branch per role per ticket; merge with `--no-ff`; remove worktrees after each round (Biome fails on nested configs).
- `turbo` drops env vars for the `test` task: run `SKIP_LIVE=1 npx vitest run` per package, with `TEST_DATABASE_URL` for Postgres.
- `next dev` leaves a worker alive (`.next/dev/lock`); tests that spawn it must kill the pid.
- Live RPC test may hit TLS on the second RPC under turbo; direct vitest is fine.

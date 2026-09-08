# Handoff — end of Day 0, 2026-09-08 (Paris evening)

Read `docs/PROJECT-PROMPT.md` first if you are a new session. This file is the state as of the last commit.

## Where we are
- **Docs**: PRD 0.3.1 (deadline Sept 20; week 1 unchanged, go-live target **Sept 11**, hard limit Sept 12; week 2 = L2b integration + onboarding + multi-key view; freeze Sept 18 18:00; FR-4.8 predictive prebuy; FR-6.5 measured savings with a 7-day gate; §18 breaking-the-wall analysis). Board: `tasks/README.md` (24 committed + 8 probes + conditional L2a/L2b + T-052 x402 spike + week-2 tickets).
- **Code**: T-001 scaffold, T-002 ledger schema (both dialects, RLS, append-only, cron SQL, env.ts), T-003 redact()/logger — all **in-test, awaiting So's sign-off** (he has not typed `ok` yet). 152 tests green, 23 Postgres tests skip without `TEST_DATABASE_URL`. Full audit/test reports in `tasks/reports/`.
- **Probes done**: P-2 NO (no key-info endpoint; `/models` pricing available), P-4 YES (`usage.cost`), P-10 YES (USDG EIP-3009 on RH chain). P-7 input received (Uniswap v4 pool ORBIO/NVDIA, two-hop for USDG — likely keeps L2a designed-not-shipped). P-1, P-3, P-5, P-6, P-8 **not run**.
- **Secrets**: `.env.local` in the sandbox holds GH token, Orbio key, gateway URL, Supabase URL/service key/DATABASE_URL (direct host — IPv6-only, unreachable from the sandbox). Never print it.
- **Not done / blocked**: GitHub push (sandbox git proxy refuses unregistered repos → So pushes the bundle from his Mac or registers the repo as a session source); Supabase migrations not applied (need the **Session pooler** URI); MCP OAuth token (P-1 needs So in the loop: agent generates auth URL → So opens → pastes redirect URL); X keys (console.x.com, Pay Per Use plan, Default Project → Voir les apps → Keys and tokens); Vercel project (not before Sept 10).

## Open with Orbio (Telegram)
Q2 grant on a separate balance? Q3 book read endpoint? Q4 surplus listing agentic? Q5 API to list a credit-limited OpenRouter key? Q6 (§18) proposed two rails: Whop off-session charge (card) + x402 USDG on RH chain (wallet, self-hosted facilitator) — offer to build the buyer side + reference facilitator config if Yash is in (T-052). The drafted message is in the previous conversation's last x402 answer; rewrite from §18 if needed.

## Next actions, in order (Day 1, Sept 9)
1. So: type `ok T-001 T-002 T-003` + `ok ADR-004` (or objections) → orchestrator writes Sign-off lines; push bundle to GitHub → paste CI link in T-001 Evidence.
2. So: replace `DATABASE_URL` with the Session pooler URI (Supabase → Connect → Session pooler); confirm `pg_cron` + `pg_net` enabled. Orchestrator (no agent needed): apply `supabase/migrations/001–004` with psql, check `select * from cron.job`, paste in T-002 Evidence (AC4).
3. Probe **P-1** with So (MCP OAuth headless): Sonnet builder writes `scripts/probes/p1-mcp-auth.ts` (dynamic client registration + PKCE, prints auth URL, waits for pasted redirect URL, exchanges code, stores tokens in `.env.local` as `ORBIO_MCP_TOKEN`/`ORBIO_MCP_REFRESH_TOKEN`, then calls `orbio_get_balance` every 10 min for 6h). Record token lifetime → sets FR-2.0 default.
4. Probes P-3 (book read source), P-5 (Vercel tick budget — needs Vercel), P-6 (X post once), P-8 (pg_cron → route). P-7 via Uniswap v4 StateView on chain 4663 (find addresses).
5. Tickets, each through Builder → Auditor → Tester on Sonnet: **T-011** (LedgerStore repos, both stores; can start now, depends only on T-002), **T-010** (MCP client + balance chain mcp → estimate, per P-2), **T-012** (ReadOnlyBookClient or NullBookClient per P-3), **T-014** (tick + cron route + kit scheduler). Then Day 2: T-015 policy (incl. FR-4.8), T-016 executors, T-017 metering (usage.cost authoritative per P-4), T-018 L2b mock.
6. Every evening: So reads the three reports per ticket, signs off; orchestrator updates `STATUS.md`, board statuses, commits, hands So a bundle if GitHub push is still manual.

## Decisions taken today that a new session must not reopen
No buy/list execution (ADR-003); stake-up conditional on P-7; SQLite kit ledger (ADR-002); Next 16 + tsx (ADR-004); Postgres driver `postgres` + `better-sqlite3` (ADR-005); orders' mutable set = fill fields, `key_meta` append-only (PRD 0.3.1); tx-hash allow-list = exact key + 0x64-hex shape (T-003); roles on Sonnet, orchestration only on the main model.

## Budget notes
So's credits are the constraint, not wall-clock. Builders/auditors/testers on Sonnet cost ~250–300k tokens per ticket for a full loop. Keep orchestrator messages short; don't re-read large files; rely on this handoff and `STATUS.md`.

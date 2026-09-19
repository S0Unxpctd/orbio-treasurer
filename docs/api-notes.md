# Orbio API notes

Everything learned about Orbio's real interfaces, appended as learned, with dated and **redacted** raw samples. Never rewrite history; add a new dated entry and mark the old one superseded.

## Known before build (2026-09-07, from public pages)

- MCP endpoint: `https://www.orbio.so/api/mcp` (Streamable HTTP, OAuth). Install: `claude mcp add --transport http --scope user orbio https://www.orbio.so/api/mcp`, then authenticate.
- MCP tools: `orbio_get_balance`, `orbio_create_key`, `orbio_get_key_status` (usage and remaining quota at OpenRouter pricing), `orbio_revoke_key` (halts on next request, balance untouched). A second `orbio_create_key` replaces a leaked key while keeping the balance.
- MCP tool list observed 2026-09-09 (probe P-3 session): `orbio_get_balance`, `orbio_get_key_status`, `orbio_create_key`, `orbio_revoke_key`, `orbio_delete_key` — **`orbio_delete_key` is new** since 2026-09-07/08 (not previously listed above); behavior not yet probed, presumably removes a revoked key's record rather than just halting it.
- Fee → credit: "50% of every fee $ORBIO collects is converted into OpenRouter credits and distributed to holders"; "split by time-weighted balance across each window"; windows are hourly.
- Sellers site: list an OpenRouter key with a credit limit; discount 10–80% in 2% steps; "deeper sells first"; paid "the price less your discount" per request served; claim ≥ $5; 7-day settlement via Whop; first-month cap $200 across keys. Holder surplus: "paid in USDG within minutes of a sale".
- Chain: Robinhood Chain (Blockscout explorer, links on the leaderboard). Leaderboard: `https://www.orbio.so/leaderboard` — top addresses and all-time distributed total.
- Build Week: $100 inference per builder; +20% boost on holder credits during the week.

## Open questions

1. ~~Book write API?~~ Answered 2026-09-08: no (see Answers).
2. Is the $100 grant on a separate key/balance from holder credits? (asked 2026-09-07)
2b. Infra facts learned 2026-09-08: Supabase direct DB host is IPv6-only (unreachable from the cloud sandbox) → use the **Session pooler** URI (`aws-x-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`) in `DATABASE_URL`. The sandbox's git proxy refuses pushes to repos not registered as session sources → So pushes from his Mac (git bundle) or adds the repo to the session's sources. X API console is now `console.x.com`, plan **Pay Per Use** (no free tier); keys come from Default Project → Voir les apps → Keys and tokens.
3. ~~Read endpoint for the book, or may we use the page's JSON endpoint?~~ Answered 2026-09-09: no (see Probe results, P-3). Follow-up: is there a planned read-only JSON endpoint for the book, or keep scraping the homepage's embedded sales feed?
4. Is listing holder surplus agentic today? (asked 2026-09-08)
5. Is there (or could there be) an API to list a credit-limited OpenRouter key on the book? OpenRouter provisioning keys make the key side agentic; the listing side is the gap. (to ask — v2 sell side)

## Probe results (PRD §13a)

_(P-1 … P-8: date, yes/no, evidence, default set)_

### P-1 · MCP headless auth — **YES** (2026-09-09, `scripts/probes/p1-mcp-auth.ts` + one-off refresh call)
- Discovery: RFC 9728 protected-resource metadata **and** RFC 8414 AS metadata both served; AS = `https://www.orbio.so`; `token_endpoint` `https://www.orbio.so/api/mcp/oauth/token`, `revocation_endpoint` `…/oauth/revoke`; `grant_types_supported` = `authorization_code, refresh_token`; `token_endpoint_auth_methods_supported` = `none`; scope `orbio:credits`.
- Dynamic client registration (RFC 7591) works: public client, no secret. Authorize URL `https://www.orbio.so/mcp/authorize`, PKCE S256, redirect to `http://localhost:3333/callback` accepted; So approved once in a browser and pasted the callback URL (headless flow works).
- Access token: Bearer, **`expires_in` 3600 s** (observed: issued 01:22:05Z, rejected at 02:39:14Z with `{"error":"unauthorized","error_description":"The access token is invalid, expired, or was revoked."}` — the 401 surfaces on the Streamable HTTP initialize POST, not only on tool calls).
- Refresh: `grant_type=refresh_token` with `client_id` only → **200 in 769 ms**, new `access_token` (3600 s), **new `refresh_token` (rotated — the old one must be assumed single-use; persist the new pair atomically before using it)**, `scope`, `resource`, `token_type=Bearer`. Right after refresh: `list_tools` + `orbio_get_balance` ok (218 ms).
- Calls before expiry: 5/5 `orbio_get_balance` ok over 40 min, 228–794 ms. The 6 h loop did not survive the sandbox going idle (background process killed, no error) — token lifetime and refresh were therefore verified with an expired token at 02:39Z rather than by a continuous run.
- Tool list observed: `orbio_get_balance`, `orbio_get_key_status`, `orbio_create_key`, `orbio_revoke_key`, `orbio_delete_key` (delete_key not in the public docs).
- Response shapes recorded (read-only tools, 02:41Z) in `packages/core/src/mcp/fixtures/mcp-tools-2026-09-09.json` (redacted). Both tools return `content[0].text` (human sentence) **and** `structuredContent`. `orbio_get_balance.structuredContent` = `{ wallets: [address], accrued|purchased|deposited|depositBalance|spent|claimed|balance: { usd: number, microUsd: string }, depositFrozen: boolean }` → **use `microUsd` (exact integer string), never `usd` (float)**. `orbio_get_key_status.structuredContent` = `{ hasKey, prefix, createdAt, lastUsedAt, baseUrl, legacy }` (ISO timestamps with +00:00 offset, not Z). Observation: the $100 grant shows up inside `accrued` ("earned"), i.e. on the same balance as trading-fee accrual — partial answer to open question Q2 (grant not on a separate balance).
- **Default set (FR-2.0): `balance_source` chain = `mcp` → `estimate`** (no gateway step, per P-2). MCP client (T-010) must: refresh proactively when `expires_at − now < 5 min`, refresh once on 401 at connect *or* tool call, persist rotated refresh tokens atomically, and fall to `estimate` + `MCP_UNAVAILABLE` if refresh fails (the refresh token then needs one human re-auth).

### P-3 · Book read source — **NO** (2026-09-09)

- Method: curl, no auth, no session cookies, GET only, ~26 requests total, 1s apart, ≤30min. Checked `robots.txt`/`sitemap.xml`, homepage HTML/RSC payload, `/api/{book,orders,market,listings,credits,sales,orderbook}` on `www.orbio.so`, `/api/v1/{book,orders,market,listings,credits}` on the gateway (`api.orbio.so`), and dedicated pages (`/book`, `/market`, `/credits`, `/leaderboard`). All `/api/*` and page candidates → **404** (Next.js catch-all HTML, not JSON). `GET /credits` → 308 redirect to `/` (no separate book page; the homepage *is* the book page). `GET /leaderboard` → 308 to `https://sellers.orbio.so/leaderboard` (200, public, but that's the leaderboard, not the book).
- **`www.orbio.so/` (GET, 200, no auth) does embed real book/sales data**, but only inside the page's Next.js RSC payload (`self.__next_f.push(...)`), not as a separate response: a flat "recent settled sales" feed — `{ label (source-masked email), creditMicroUsd, discountBps, settledAt }` per sale — plus one headline "$N,NNN credits available" figure. No per-model breakdown, no depth-at-2%-steps curve, no listings array anywhere on the page: **FR-5.2's target `BookView` shape (best discount, depth, total USD per model) is not present**, only an aggregate total + flat sales feed.
- This embedded data is React Server Component wire format (numbered chunks, internal backreference paths), undocumented and tied to the exact Next.js build — not a versioned/announced contract. Reading it means regex-scraping the full homepage HTML on every tick, not calling an endpoint.
- CSP evidence (response header on `www.orbio.so`, report-only): `connect-src` allow-lists only `'self'`, Privy, WalletConnect, and Tolt (affiliate) — **no `api.orbio.so` or any book/market host**, confirming the browser itself never calls out to a separate JSON API for book data.
- Fixture (redacted): `packages/core/src/book/fixtures/p3-2026-09-09.json` — full endpoint/status matrix, CSP evidence, and a redacted sample of the embedded sales-feed shape.
- **Default set: `BOOK read = none`.** Per FR-5.2, L1 degrades to "no book data"; the X post drops the book lines this week.
- Question for Yash: is there (or will there be, alongside the agentic-buy endpoint) a read-only JSON endpoint for the book/order-depth, or should we keep scraping the homepage's embedded sales feed as a best-effort signal?

### P-2 · Gateway key-info / credits endpoint — **NO** (2026-09-08, curl with the real key)

- `ORBIO_GATEWAY_BASE_URL = https://api.orbio.so/api/v1` (from So's dashboard). `GET /models` → 200, OpenAI-style list **with OpenRouter-style `pricing` per model** (prompt/completion/input_cache_read per token) → a live price table is available for FR-3.2's fallback.
- `GET /auth/key`, `GET /credits`, `GET /key` → HTML (the Next.js site), i.e. not implemented on the gateway. **Remaining quota cannot be read from the gateway**; balance source = MCP (P-1) else `estimate`. Default set: `balance_source` chain = mcp → estimate (no `gateway` step).

### P-4 · Per-call cost from the gateway — **YES** (2026-09-08)

- `POST /chat/completions` with `"usage":{"include":true}` on `inception/mercury-2.5` (6 in / 6 out tokens) returned `usage.cost = 1.14e-06` plus `usage.cost_details.{upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost}`, `is_byok`, token detail blocks. Response also carries `provider`, `service_tier`, `system_fingerprint`. Cost of the probe: $0.0000011.
- Default set: metering uses `usage.cost` as authoritative; fallback = `/models` pricing × tokens, flagged `estimated`.

### P-7 · Stake pool — **pending**, input received (2026-09-08)

- So supplied a Uniswap **v4 pool id** (bytes32) on Robinhood Chain: `0xa95b1fbdccb15d2b07509b980f63adab8a94303b1781f5ebc53b72942d12ddc1`, pair **ORBIO / NVDIA** (tokenized NVIDIA stock), *not* ORBIO/USDG. Consequences for L2a: the swap path is USDG → NVDIA → ORBIO (two hops) or the agent holds NVDIA as its reserve asset; quote/impact must be read via Uniswap v4 `StateView`/`Quoter` on chain 4663 (addresses to find). Probe P-7 must: read pool liquidity/price, quote a $10 two-hop swap, measure impact, and decide whether a two-hop route is acceptable this week (likely: L2a stays designed-not-shipped unless a direct ORBIO/USDG pool exists).

### P-10 · USDG on Robinhood Chain supports EIP-3009 — **YES** (2026-09-08, read-only eth_call via public RPC)

- RPC `https://rpc.mainnet.chain.robinhood.com` → `eth_chainId` = `0x1237` (4663). Public RPC is documented as rate-limited, "not recommended for production" (Robinhood docs). Testnet chain id 46630. Gas token ETH. Explorer `robinhoodchain.blockscout.com`.
- USDG address (Paxos docs, Robinhood Mainnet): `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. `name()` = "Global Dollar", `decimals()` = 6.
- `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` = `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267` (canonical EIP-3009). `PERMIT_TYPEHASH()` = canonical EIP-2612. `version()` reverts (no such function).
- `DOMAIN_SEPARATOR()` = `0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036`, reproduced exactly with EIP-712 domain **{ name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: 0x5fc5…d168 }**. These are the signing parameters for an x402 EIP-3009 payload on this chain.
- Consequence: PRD §18 path B is technically viable; the missing piece is a facilitator for `eip155:4663` (self-hosted) and Orbio's merchant endpoint.

## S-03 chain reads (2026-09-19)

Live, read-only `eth_call`s via `https://robinhood-rpc.publicnode.com` (viem), no rate limit hit
in ~15 calls over the session. `https://rpc.ordofi.network` also confirmed live (`eth_chainId` ->
4663). All addresses per PRD §3.

- `eth_chainId` -> `4663` on both RPCs.
- Multicall3 (standard CREATE2 address `0xca11bde05977b3631167028862be2a173976ca11`) **IS**
  deployed on 4663 — `eth_getCode` returned 7618 bytes of bytecode. `readTreasury()` uses
  `client.multicall()` for the 9 non-ETH reads (allowFailure: true, so a reverting `getQuote`
  degrades to `null` without failing the batch) and falls back to 9 sequential `readContract`
  calls only if the multicall call itself throws.
- `Staking.totalStaked()` = `355360274239331697639652256` (raw, 18 dec -> ~355,360,274.24 ORBIO staked).
- `Staking.MIN_POSITION()` = `1000000000000000000000` — confirms PRD §3's `1000e18`.
- `Staking.PERIOD()` = `3600` — confirms PRD §3's hourly periods.
- `Staking.positionOf(0x0)` = `0`, `Staking.settledOf(0x0)` = `0` — zero address has no position,
  as expected; used to confirm AC1's "well-formed snapshot with zeros" path (no `STAKER_ADDRESS`
  configured in this sandbox — no real staking wallet address was available to read against).
- `CREDIT.decimals()` = `6`, `USDG.decimals()` = `6` — confirms PRD §3.
- `CREDIT.balanceOf(0x0)` = `0`, `USDG.balanceOf(0x0)` = `0`.
- `getBalance(0x0)` (native ETH) = `4986956241336233746` (~4.987 ETH sitting at the zero
  address — a well-known chain artifact, not a Treasurer balance).
- `Exchange.getQuote(10 USDG, 10)` = `{ creditOut: 13333332, usdgSpent: 10000000, feeAtoms: 0,
  fills: 2, reason: 0 }` -> 13.333332 CREDIT for 10 USDG, a **25% discount**
  (`1 - usdgSpent/creditOut`). Note the book has moved since the 2026-09-16 probe's 22.22 CREDIT
  / 55% discount reading (PRD §3) — the book's depth changes call to call, as expected; this is
  a live snapshot, not a fixed constant. The published `exchange.json` ABI (fetched
  2026-09-19 from `https://www.orbio.so/protocol/abi/exchange.json`) shows `getQuote` returns
  the *full* `{creditOut, usdgSpent, feeAtoms, fills, reason}` tuple, richer than the
  `(creditOut, fills)` shorthand in PRD §3's prose.

**Discovered**: the PRD's own printed USDG address, `0x5fc5360d0400a0Fd4f2af552ADD042D716F1d168`
(docs/PRD-1.0-sprint.md §3, lowercase `d` right after `5fc5360`), is **not a valid EIP-55
checksum** — viem's `getAddress()` on the all-lowercase form produces
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (uppercase `D` there instead), which matches the
same address used elsewhere (e.g. this session's own project-instructions header). Not a
different address — same 20 bytes either way — just a one-character transcription slip in the
PRD's mixed-case rendering. `chain/contracts.ts`'s `loadChainAddresses()` re-checksums via
`getAddress()` regardless of input casing, so this is harmless in code; flagging it so the PRD
text itself gets fixed and nobody hand-copies the bad casing into a context that *does* do a
strict checksum comparison. `.env.example` and `docs/runbook.md` both use the corrected casing.

**Wallet-signed key derivation (AC4)** — throwaway key via viem's `generatePrivateKey()` (never
printed, never committed, discarded after this session): `deriveOrbioKey(pk, 0)` produced a
`sk-orb-0-<88-char base64 sig>` key; `GET https://api.orbio.so/api/v1/key` with
`Authorization: Bearer <that key>` returned:

```
status: 401
body: {"error":{"message":"This Orbio API key is unknown or has been revoked.","type":"invalid_request_error","code":"invalid_api_key","param":null}}
```

"unknown or has been revoked" (not "malformed") is exactly the acceptable evidence the ticket
names — the key is well-formed enough for the gateway to recognize the shape and look it up; it
simply has no activated balance (a throwaway wallet was never funded/activated). Confirms the
derivation message string (`"Orbio API key · chain 4663 · epoch 0"`, with its two
U+00B7 MIDDLE DOT characters) matches the gateway's own derivation.

## Answers

**2026-09-08, Yash (Orbio), builders Telegram**, on the agent boilerplate with a self-sustaining cycle that buys credits off the order book:

> okay so agent boilerplate using orbio self sustainable cycle? that automatically buys credits off the orderbook?
> question: the buying process inolved fiat payments, so how would you get rid of this human in the loop?
> it would be good if you actually build a project on top of this template as well, or a landing page, with a loom demo or so (if you can)
> i think it would get traction
> you can buy with crypto on whop checkout page but thats not agentic
> and thats the bottleneck
> and im trying to solve this, so agents can buy credits on their own
> will have something this week

Consequence: PRD 0.2 / ADR-003. Asked back (2026-09-08): read endpoint for the book? is listing holder surplus agentic? (§ Open questions 3–4.)

## S-04 period discovery (2026-09-19)

Live, read-only `eth_call`s via `https://robinhood-rpc.publicnode.com` (viem, no wallet, no
`STAKER_ADDRESS` configured in this sandbox — every call below used the zero address or a bare
period id). Time-boxed to 45 min per tasks/S-04.md; resolved well inside that — **not** blocked.

- `Staking.rewardPeriod(0)` → **reverts** with selector `0x86bea250` (a custom error, no string
  reason decoded from the 4-byte selector alone).
- `Staking.rewardPeriod(1)` → `[1789480800, 1789484400, 81496947, 3017000000000000000000000,
  81496947]`.
- `Staking.rewardPeriod(2)` → `[1789484400, 1789488000, 94746096, 4506503303974465381709490780,
  94746093]`.
- `Staking.rewardPeriod(82)` → `[1789772400, 1789776000, 95103973, 1277452906707641120178295554314,
  10187183]`. `Staking.rewardPeriod(83)` → reverts, same `0x86bea250` selector.
- At call time, `latest block.timestamp = 1789782340`. `Staking.rewardOf(0x0, 82)` → `0`
  (succeeds — period 82 exists). `Staking.rewardOf(0x0, 83)` → reverts, same `0x86bea250`
  selector as `rewardPeriod(83)`. `Staking.rewardOf(0x0, 0)` → also reverts, same selector.

**Derivation** (ticket AC6 "derive which field is the period start"):
- `rewardPeriod(id)[1]` of period *n* always equals `rewardPeriod(id)[0]` of period *n+1*
  (`1789484400` closes period 1 and opens period 2) and the gap is always exactly `3600`
  (`Staking.PERIOD()`, confirmed S-03). So **field[0] = periodStart (unix seconds)**,
  **field[1] = periodEnd = periodStart + PERIOD**.
- Periods are **not** unix-epoch-hour-indexed (a period id computed as `floor(now/3600)`, e.g.
  `497161` at call time, reverts) — they're a small sequential counter starting at **1** (id `0`
  reverts), created lazily as the contract runs. At call time the highest existing id was **82**
  (`83` reverts) and `rewardPeriod(82)`'s own `periodEnd` (`1789776000`) was already ~1.76 h in
  the past — i.e. the latest *existing* period had already ended with no id `83` yet created, so
  "latest id" and "latest finalized id" are the same read (an id that reverts is simply "doesn't
  exist yet", not "exists but unfinalized").
- Field[2] and field[4] track together but aren't identical for recent periods (id 2:
  `94746096` vs `94746093`; id 82: `95103973` vs `10187183`) while they're exactly equal for the
  oldest probed period (id 1: `81496947` = `81496947`) — consistent with `{periodStart,
  periodEnd, totalReward, totalWeight, settledReward}`, where `settledReward` (field[4]) trails
  `totalReward` (field[2]) until every staker in that period has settled, and field[3]
  (`~3.0e24`–`1.28e30` range, far larger than the other three) is the period's total staking
  weight (amount × time), not a reward figure — not required for S-04's flow, not relied on.
- Discovery algorithm implemented in `chain/claim.ts`'s `discoverLatestPeriodId()`: exponential
  search doubling from `STAKING_LAST_PERIOD_HINT` (or `1` if unset) until a call reverts, then
  binary search the gap — the same "revert = doesn't exist yet" signal this probe used by hand.
  `STAKING_SETTLE_PERIODS` (comma list) remains available as a manual override per the ticket's
  fallback clause, used whenever set (skips discovery entirely) — kept even though the 45-min
  probe resolved, since this sandbox has no real `STAKER_ADDRESS`/`STAKER_PRIVATE_KEY` to run
  `rewardOf(staker, id) > 0` against for real, so the "which ids does *our* staker still owe
  settlement for" half of the algorithm is untested against live data (fake-client tests only —
  see tasks/S-04.md Blocked on).

## Endpoints discovered

_(one section per endpoint: method, URL, auth, request sample, response sample (redacted), quirks)_

## Unrecognized samples

_(appended automatically by AdapterShapeError; redacted; triage daily)_

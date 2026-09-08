# Orbio API notes

Everything learned about Orbio's real interfaces, appended as learned, with dated and **redacted** raw samples. Never rewrite history; add a new dated entry and mark the old one superseded.

## Known before build (2026-09-07, from public pages)

- MCP endpoint: `https://www.orbio.so/api/mcp` (Streamable HTTP, OAuth). Install: `claude mcp add --transport http --scope user orbio https://www.orbio.so/api/mcp`, then authenticate.
- MCP tools: `orbio_get_balance`, `orbio_create_key`, `orbio_get_key_status` (usage and remaining quota at OpenRouter pricing), `orbio_revoke_key` (halts on next request, balance untouched). A second `orbio_create_key` replaces a leaked key while keeping the balance.
- Fee → credit: "50% of every fee $ORBIO collects is converted into OpenRouter credits and distributed to holders"; "split by time-weighted balance across each window"; windows are hourly.
- Sellers site: list an OpenRouter key with a credit limit; discount 10–80% in 2% steps; "deeper sells first"; paid "the price less your discount" per request served; claim ≥ $5; 7-day settlement via Whop; first-month cap $200 across keys. Holder surplus: "paid in USDG within minutes of a sale".
- Chain: Robinhood Chain (Blockscout explorer, links on the leaderboard). Leaderboard: `https://www.orbio.so/leaderboard` — top addresses and all-time distributed total.
- Build Week: $100 inference per builder; +20% boost on holder credits during the week.

## Open questions

1. ~~Book write API?~~ Answered 2026-09-08: no (see Answers).
2. Is the $100 grant on a separate key/balance from holder credits? (asked 2026-09-07)
2b. Infra facts learned 2026-09-08: Supabase direct DB host is IPv6-only (unreachable from the cloud sandbox) → use the **Session pooler** URI (`aws-x-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`) in `DATABASE_URL`. The sandbox's git proxy refuses pushes to repos not registered as session sources → So pushes from his Mac (git bundle) or adds the repo to the session's sources. X API console is now `console.x.com`, plan **Pay Per Use** (no free tier); keys come from Default Project → Voir les apps → Keys and tokens.
3. Read endpoint for the book, or may we use the page's JSON endpoint? (asked 2026-09-08, gates probe P-3)
4. Is listing holder surplus agentic today? (asked 2026-09-08)
5. Is there (or could there be) an API to list a credit-limited OpenRouter key on the book? OpenRouter provisioning keys make the key side agentic; the listing side is the gap. (to ask — v2 sell side)

## Probe results (PRD §13a)

_(P-1 … P-8: date, yes/no, evidence, default set)_

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

## Endpoints discovered

_(one section per endpoint: method, URL, auth, request sample, response sample (redacted), quirks)_

## Unrecognized samples

_(appended automatically by AdapterShapeError; redacted; triage daily)_

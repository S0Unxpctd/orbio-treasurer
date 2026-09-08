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
3. Read endpoint for the book, or may we use the page's JSON endpoint? (asked 2026-09-08, gates probe P-3)
4. Is listing holder surplus agentic today? (asked 2026-09-08)

## Probe results (PRD §13a)

_(P-1 … P-8: date, yes/no, evidence, default set)_

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

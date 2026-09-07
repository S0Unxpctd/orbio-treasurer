# Orbio API notes

Everything learned about Orbio's real interfaces, appended as learned, with dated and **redacted** raw samples. Never rewrite history; add a new dated entry and mark the old one superseded.

## Known before build (2026-09-07, from public pages)

- MCP endpoint: `https://www.orbio.so/api/mcp` (Streamable HTTP, OAuth). Install: `claude mcp add --transport http --scope user orbio https://www.orbio.so/api/mcp`, then authenticate.
- MCP tools: `orbio_get_balance`, `orbio_create_key`, `orbio_get_key_status` (usage and remaining quota at OpenRouter pricing), `orbio_revoke_key` (halts on next request, balance untouched). A second `orbio_create_key` replaces a leaked key while keeping the balance.
- Fee → credit: "50% of every fee $ORBIO collects is converted into OpenRouter credits and distributed to holders"; "split by time-weighted balance across each window"; windows are hourly.
- Sellers site: list an OpenRouter key with a credit limit; discount 10–80% in 2% steps; "deeper sells first"; paid "the price less your discount" per request served; claim ≥ $5; 7-day settlement via Whop; first-month cap $200 across keys. Holder surplus: "paid in USDG within minutes of a sale".
- Chain: Robinhood Chain (Blockscout explorer, links on the leaderboard). Leaderboard: `https://www.orbio.so/leaderboard` — top addresses and all-time distributed total.
- Build Week: $100 inference per builder; +20% boost on holder credits during the week.

## Open questions (asked 2026-09-07 in builders Telegram)

1. Book write API (buy / list / cancel)? Auth, rate limits, per-model vs per-listing, fill fees?
2. Is the $100 grant on a separate key/balance from holder credits?

## Answers

_(paste verbatim, dated)_

## Endpoints discovered

_(one section per endpoint: method, URL, auth, request sample, response sample (redacted), quirks)_

## Unrecognized samples

_(appended automatically by AdapterShapeError; redacted; triage daily)_

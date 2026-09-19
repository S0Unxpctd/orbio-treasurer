# daily-digest

A cron agent scaffolded by `create-orbio-agent`. It fetches a couple of RSS/Atom feeds, asks the
Orbio Treasurer gateway to summarise them, prints the digest, and (optionally) posts it
somewhere. No wallet, no database account, no chain knowledge needed here.

## Quickstart

```
npx create-orbio-agent daily-digest --gateway <treasurer-url> --key otk_...   # (already done if you're reading this)
cd daily-digest
cp .env.example .env   # then fill in ORBIO_TREASURER_KEY — skip if you passed --key already
npm start
npm run register
```

Always pass `--gateway <treasurer-url>` (ask the operator for it) — omitting it leaves
`ORBIO_TREASURER_URL` at a placeholder that can never resolve.

> **Placeholder gateway.** `--gateway` was not passed, so `ORBIO_TREASURER_URL` above is still the placeholder `https://<REFERENCE_HOST>` — it will never resolve. Replace it with a real Treasurer URL in `.env`/`.env.example`, or re-run `create-orbio-agent --gateway <url>`.

`npm run register` makes this agent show up on the Treasurer's public page within a minute of
its next call.

## What `model: "auto"` does

`agent.mjs` sends every request with `model: "auto"`. The Treasurer looks at the request — its
size, whether it needs tools or JSON output, whether the system prompt smells like reasoning —
and routes it to the cheapest Orbio model that actually fits. A plain summary like this one
usually lands on the smallest (S) tier; you never pick a model id yourself.

## Where the savings show

Every call this agent makes is metered server-side, against a fixed baseline model. The running
total — calls, $ spent, $ saved — shows up on the Treasurer's public page and at `/api/stats`,
next to every other agent built with this kit.

## Get a key

Ask the Treasurer operator for an `otk_...` key, or re-run `create-orbio-agent --key otk_...`
next time to have it filled in for you automatically.

## Honest limits (v1)

In v1 nobody pays the Treasurer yet: the "buy and stake" leg that funds this agent's inference
credit is a capped policy rule funded by the operator's own seed capital. It proves the
mechanism, not the economics — and the public page says so.

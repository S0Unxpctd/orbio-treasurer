# Orbio Treasurer

Orbio Treasurer is a gateway other agents call to make their recurring LLM tasks cheaper. The
caller changes one line (`base_url`) and sends `model: "auto"`. The Treasurer routes each call to
the cheapest model that fits, pays for inference with Orbio CREDIT it sources below list price
(claimed from a staked $ORBIO position, or bought at a discount on the on-chain book), meters
every call, and shows the savings and the treasury on a public page with on-chain proof. The
loop: volume → margin → buy $ORBIO → stake → more CREDIT → cheaper inference → more volume. In v1
nobody pays us yet: the "buy and stake" leg is a capped policy rule funded by So's seed capital.
It proves the mechanism, not the economics, and the page says so.

> One base_url change. Your agents' crons cost less, because we route smarter and source inference below list on Orbio, and you can verify it on-chain.

Built for Orbio Build Week (deadline 2026-09-20). Status: see [STATUS.md](STATUS.md) and
[docs/HANDOFF.md](docs/HANDOFF.md).

## Use it in 60 seconds

Ask the operator for an `otk_...` key (or seed your own local instance — see "Run it locally"
below).

**1. curl** — swap `base_url` for the Treasurer's, keep everything else:

```
curl -s https://<treasurer-host>/v1/chat/completions \
  -H "Authorization: Bearer otk_..." \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"one sentence: is the treasury healthy?"}]}'
```

**2. Python / JS, OpenAI SDK** — one `base_url` change, `model: "auto"`:

```python
from openai import OpenAI
client = OpenAI(base_url="https://<treasurer-host>/v1", api_key="otk_...")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "..."}])
```

```js
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'https://<treasurer-host>/v1', apiKey: 'otk_...' });
await client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: '...' }] });
```

**3. Scaffold a cron agent** — no wallet, no database account, no chain knowledge:

```
npx create-orbio-agent my-agent --gateway https://<treasurer-host> --key otk_...
cd my-agent && npm start && npm run register
```

`npm run register` makes the agent show up on the public page within a minute of its next call.

## What `auto` does

`model: "auto"` picks the cheapest Orbio model that fits, in this order:
- `tools` or JSON `response_format` present → at least tier M.
- Prompt over 24k characters → at least tier M.
- System prompt mentions "reason", "analy[sis/ze]", "code" or "plan" → at least tier M.
- Otherwise → tier S (cheapest).

Tiers come from Orbio's live `/models` pricing (S ≤ $0.40/M input tokens, M ≤ $3/M, L above),
cached 10 minutes. `auto:S` / `auto:M` / `auto:L` forces a floor tier; the Treasurer's own policy
mode (`eco` when runway is tight) can raise that floor further, never lower it.

## Where the proof is

The public page (`/`) shows calls routed, $ spent, $ baseline, $ saved, and the treasury (staked
ORBIO, CREDIT claimed/activated, current mode, runway). Every on-chain action links to its
transaction on the Robinhood Chain explorer, `robin.etherscan.io`. `/api/stats` is the same data
as JSON, for the kit and for scripted checks.

## Honest limits (v1)

v1: the buy-and-stake leg is funded by seed capital and capped; caller billing is not live. Every on-chain action above links to its transaction.

Concretely: So funds the treasury's buy/stake actions out of pocket, under fixed daily caps
(`BUY_MAX_USDG_PER_TX`, `BUY_MAX_PER_DAY`, `STAKEUP_MAX_USDG_PER_DAY`, `ACTIVATE_MAX_PER_DAY`).
Callers are metered but not charged — the loop the pitch describes (volume funds the buy) is
real code, run on real capital, but the "volume" side of the loop has no real callers yet.

## Numbers (live, dated)

- Book quote 2026-09-19: 10 USDG → 13.33 CREDIT (25% discount on the on-chain Exchange). This
  moves call to call — it is a live snapshot, not a fixed rate.
- 355.36M $ORBIO staked protocol-wide, 2026-09-19.
- Staking periods are hourly (`Staking.PERIOD() = 3600`).
- Holder yield at launch is on the order of $0.00005 per token per week — light agents are fully
  covered by a small position; heavy ones are not. The book discount above is the main lever.

## Architecture, in 8 lines

- `apps/web` — the gateway (Next.js on Vercel): `/v1/chat/completions`, `/v1/models` (router +
  forwarder), `/api/tick` (policy loop, cron-driven), `/api/agents`, `/api/stats`, `/` (public page).
- `packages/core/src/router` — pure `route()`: picks a tier and a model, no I/O.
- `packages/core/src/policy` — pure `decide()`: mode (normal/eco/critical), claim/buy/stake-up
  actions from a treasury snapshot and burn rate. No I/O, no model calls, ever.
- `packages/core/src/chain` — viem reads/writes against Robinhood Chain 4663 (Staking, Exchange,
  CREDIT, USDG, ORBIO, Payout).
- `packages/core/src/ledger` — SQLite (kit) or Postgres (hosted) store: calls, treasury events,
  snapshots, agents, caller keys.
- `packages/create-orbio-agent` — the kit: `npx create-orbio-agent` scaffolds a caller.
- `examples/daily-digest` — the reference caller the kit generates.
- Money is gated: `TREASURER_LIVE` defaults `false`; live actions need capped env vars and So's
  written `ok live` in the ticket (`PROCESS.md`, `CLAUDE.md`).

## Run it locally

No database account, no chain access, no Supabase — SQLite only. Two variants:

**Zero external accounts** (a judge can run this — no Orbio key needed either; the gateway is
pointed at an in-process fake upstream replaying real, dated fixtures, `apps/web/test/fake-upstream.ts`):

```
pnpm install
pnpm --filter @orbio-treasurer/core build
pnpm dev:mock   # http://localhost:3000
```

In another shell, seed a reference agent and a key, then hit the gateway:

```
pnpm seed:agent --with-key --label local
curl -s http://localhost:3000/v1/models | jq '.data[].id'
```

**Real inference** (real Orbio pricing/CREDIT, needs an Orbio account): set two server-side env
vars before `cd apps/web && pnpm dev --webpack` — `ORBIO_GATEWAY_BASE_URL=https://api.orbio.so/api/v1`
and either `ORBIO_KEY=<an Orbio key with balance>` or `TREASURER_PRIVATE_KEY=0x<64 hex>` (a
Robinhood Chain wallet key the gateway derives an Orbio key from). Without one of these two, every
`/v1/*` call fails with a config error — the mock variant above exists so a stranger with neither
can still run the quickstart end to end.

`pnpm test` runs every package's suite (core, web, kit). `pnpm lint` / `pnpm typecheck` check the
whole repo. `pnpm smoke` hits a running instance (`SMOKE_BASE_URL`, default `localhost:3000`).

## Roadmap (out of scope in v1)

Shown here and on the page, honestly: caller billing (x402 over USDG on chain 4663 — USDG
implements EIP-3009, the path is proven, not built), prebuying credit ahead of predicted cron
demand, selling surplus CREDIT back on the book, a multi-key balance view, exit/unstake, an MCP
tool interface, and a per-caller quality feedback loop.

## More

- [docs/PRD-1.0-sprint.md](docs/PRD-1.0-sprint.md) — what we build and why for this sprint
  (supersedes [PRD.md](PRD.md))
- [ARCHITECTURE.md](ARCHITECTURE.md) — how, stack locked
- [PROCESS.md](PROCESS.md) — Code → Audit → Test loop
- [CLAUDE.md](CLAUDE.md) — instructions the coding agent reads first
- [docs/api-notes.md](docs/api-notes.md) — everything learned about Orbio's real API, dated,
  with raw evidence
- [docs/DEPLOY.md](docs/DEPLOY.md) — the deploy checklist
- [docs/SUBMISSION.md](docs/SUBMISSION.md) — the Orbio Build Week submission text
- [docs/LOOM-script.md](docs/LOOM-script.md) — the 3-minute walkthrough script
- [STATUS.md](STATUS.md) — daily status, judge-readable
- [tasks/README.md](tasks/README.md) — the ticket board

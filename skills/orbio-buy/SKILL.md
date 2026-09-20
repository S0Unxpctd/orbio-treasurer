---
name: orbio-buy
description: Buy Orbio CREDIT off the order book, but only when the NET discount (after both the book fee and the activation fee) clears a target you set. Refuses with a typed reason otherwise. Use when runway is short, when asked to top up inference credit, buy credit, check the book price, or decide whether now is a good time to buy. Moves real money: dry run by default, and sending requires explicit approval.
---

# orbio-buy

Orbio's own `agents.md` gives the buy flow and then says the agent's budget
rules decide when to use it. It gives no budget rules. **This skill is the
budget rule.** That gap is the whole reason this exists — a skill that restates
their doc adds nothing.

## Net, never gross

Two fees apply and they compound:

| fee | where | reads | taken from |
|---|---|---|---|
| book fee | `Exchange.feeBps()` | **200** (2%) | out of `usdgIn` |
| activation fee | `CREDIT.activationFeeBps()` | **500** (5%) | from the CREDIT bought |

Measured live on chain 4663, block 68,028,304, 2026-09-20:

```
10 USDG  ->  12.254901 CREDIT bought    gross 18.40%
         ->  11.642155 CREDIT activated NET   14.11%
```

**Gross overstates the discount by 4.29 points.** An agent that quotes
`creditOut / usdgIn` believes it got 18.4% and got 14.1%. Always compute:

```
net discount = 1 − (usdgSpent + feeAtoms) / previewActivation(creditOut).credited
```

Note where these live: `feeBps`, `MAX_FILLS`, `getQuote`, `buyAndActivate` are
on **Exchange**. `activationFeeBps` and `previewActivation` are on **CREDIT**.
Calling the latter two on Exchange reverts — that is a real mistake that was
made and cost an hour.

Both fees are read live on every run, never hardcoded. They have moved twice in
four days, and the net discount went 55% (09-16) → ~17% (09-19) → **14.11%**
(09-20). Always state the figure with its date. Sell the rule, not the rate.

## Commands

```bash
B=skills/orbio-buy/scripts/orbio-buy.ts

pnpm tsx $B quote 10                          # read-only: fees, quote, gross vs net
pnpm tsx $B plan 10 --min-discount 12          # decide; prints plan or typed refusal
pnpm tsx $B buy 10 --min-discount 12 --yes     # also needs ORBIO_LIVE=true
```

Flags: `--max-fills <n>` (default 64, matching `MAX_FILLS()`), `--beneficiary <0x…>`.

`--min-discount` is **required** on `plan` and `buy`. Refusing a bad fill is the
product; a buy with no target is just a market order.

## Refusals

Typed, with an exit code of 2, and nothing is sent:

- `discount_too_low` — net below target. The normal case. Report it as a
  decision, not a failure: "net 14.11% < target 20%, waiting."
- `fills_exceeded` — the quote needs more makers than allowed.
- `quote_stop_reason` — the book stopped early; `reason` is non-zero.

Before sending it also checks USDG balance, ETH for gas, and allowance, then
`simulateContract` so a revert is caught before gas is spent.

## Safety

Three independent gates, all required:

1. `buy` subcommand (not `quote`/`plan`)
2. `--yes` on the invocation
3. `ORBIO_LIVE=true` in the environment

Missing any one prints the dry run. **Per `CLAUDE.md` rule 5, do not set
`ORBIO_LIVE` and do not send a transaction unless So has written `ok live` in
the ticket.** No live transaction has been sent from this skill.

Other invariants: approve is for the **exact** amount, never infinite.
`minCreditOut` is `quote × 0.98`, truncated with bigint division so rounding can
only ever favour the buyer. Addresses come from env — never literals in source
(`CLAUDE.md` #5).

Be honest about the boundary: an agent with shell access can edit its own env
and bypass these caps. A script cannot prevent that. **The real security
boundary is the wallet balance.** Fund the hot wallet with what you are willing
to lose — roughly 0.005 ETH and 10 USDG — and say so in bold in the README.

## Setup

```bash
EXCHANGE_ADDRESS=0x6951ffd32630b05e06f50062aea801625a58ebc0
CREDIT_ADDRESS=0xe33322da1380e61e5ae5dfb21e7f62924c73004c
USDG_ADDRESS=0x5fc5360d0400a0fd4f2af552add042d716f1d168
ORBIO_PRIVATE_KEY=0x...        # hot wallet, buy only
# RH_RPC_URLS=...              # optional, comma separated
```

Addresses are Orbio's published values (`https://www.orbio.so/protocol/agents.md`,
§ Robinhood Chain). Requires `viem` — already a dependency on the restored
branch (`viem ^2.56.8`).

## Where this sits

`orbio-cost` decides *whether* to buy: runway short → check the book. This skill
decides *whether the price is good enough*, and buys if so. `orbio-inference`
spends the credit afterwards.

After a successful buy, confirm off-chain — activated credit should show up in
`GET /key`:

```bash
skills/orbio-cost/scripts/orbio-cost balance
```

Then record the hash. A money-moving skill with no transaction hash in the
README is documentation, not a product.

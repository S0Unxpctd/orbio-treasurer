---
name: orbio-cost
description: Know what inference costs on Orbio before spending, what it actually cost after, how fast the balance is burning, and how many days of runway remain. Also renders the proof-of-self-funding artifact. Use when asked "what will this cost", "how much have we spent", "how long until we run out", "which model should we use", "is Orbio cheaper", or when deciding whether it is time to buy credit. Read-only: never sends a completion, never signs a transaction.
---

# orbio-cost

The decision trigger for the whole pack. Buying credit at a target discount is
arbitrary unless something decided you needed credit. This is that something.

Nothing here spends money. `/models` is public, `/key` is a read, and no
completion is ever sent. The API key is read for `/key` only and is never
printed — you get prefix and last4.

## The one thing to get right

**Orbio's per-token prices are identical to OpenRouter's list price.** Measured
2026-09-20: 442 of 442 comparable models, none cheaper, none more expensive. Two
real completions billed to the last digit of the published table.

So if you try to show "cheaper inference" by comparing `/models`, you get **0%**
and conclude the pitch is false. The discount is not in the token rate. It is in
**credit acquisition** — paying under face value for CREDIT on the order book.

Effective cost per token is therefore:

```
effective $/token  =  list $/token  ×  (usdgSpent / creditActivated)
```

`creditActivated` is net of **both** fees: the book fee (`feeBps`, 200 = 2% as of
2026-09-20) and the activation fee (`activationFeeBps`, 500 = 5%, capped at 10%).
Quote alone gives you gross and overstates the discount by about 4 points.
Both fees moved twice in four days — read them live, never hardcode.

State the discount with its date. It was 55% on 2026-09-16, ~25% on 09-19, ~17%
net on 09-20. Sell the rule, not the rate.

## Forecast and reconcile

```bash
C=skills/orbio-cost/scripts/orbio-cost

$C estimate anthropic/claude-haiku-4.5 50000 2000   # before the call
$C verify inception/mercury-2.5 8 331 0.00004997    # after: table vs billed
$C cheapest 15 [--free] [--all]                     # chat models only by default
$C models claude                                    # filter the live table
$C price <model-id>                                 # one model in full
$C audit                                            # the Orbio-vs-OpenRouter evidence
```

`estimate` is a forecast and must be labelled **estimated** wherever you surface
it (PRD FR-3.2). `usage.cost` on a real response is authoritative. `verify`
bridges them and has reproduced probe P-4 exactly.

Two traps in the price table: prices are **per token as strings** (multiply by
1e6 for $/M), and `"-1"` means dynamically priced — the `openrouter/auto*`
routers pick a model at request time, so their cost cannot be known in advance.
`estimate` and `verify` refuse those by design.

## Treasury

```bash
$C balance      # available / used / all-time activated, plus rate limits
$C snapshot     # record a datapoint
$C burn         # spend per day across snapshots
$C runway       # days of inference left, with a warning under 7
$C proof [--chain <file>]
```

`burn` and `runway` need **two snapshots**. Take one now and one later; a window
under an hour is flagged as noisy. Snapshots append to `.orbio/cost-snapshots.jsonl`.

Burn is measured from `used` on `GET /key`, not from summing `usage.cost` on
successful responses. That distinction is not pedantic: **a call that times out
still bills.** A request was billed $0.0992 on 2026-09-20 and returned zero
bytes. Summing successful responses would have missed it entirely; `used` caught
it. Always reconcile against `used`.

`/key` also returns `available_micro_usd` and `used_micro_usd` as integer
micro-USD. Prefer those for arithmetic — no float rounding, and they are the
same precision the ledger wants.

## Proof

`proof` renders the submission artifact as markdown: staked → claimed →
activated → burned → % covered, with explorer links. Paste it into the README;
that is your widget.

Gateway figures are read live. On-chain figures come from `--chain <file>`,
written by the chain layer in `packages/core/src/chain/` — those selectors need
keccak and belong in TypeScript, not in this script. Without `--chain` the
artifact renders with the on-chain rows marked "not supplied" rather than
inventing numbers.

Coverage is **credit the position produced ÷ inference burned**, capped at 100%.

Two distinctions that protect the claim:

- It is not `burned ÷ activated`, which is a utilization ratio and reads
  absurdly low.
- It counts `activated_from_claim` only. Credit **bought** on the book was paid
  for in USDG and is reported on its own row. Counting a purchase as
  self-funding would overstate the one claim the submission rests on, so with a
  buy and no claim the artifact says **0% covered by the position** and names
  the purchase. Say the honest number.

Schema written by `orbio-buy --write-proof` and read here: `buy_tx`,
`usdg_spent`, `bought_credit`, `activated_from_buy`, `net_discount`. The staking
path adds `claimed_credit`, `claim_tx`, `activated_from_claim`, `activate_tx`,
`staked_orbio`, `staking_contract`. `--write-proof` merges rather than
overwrites, so a later buy does not erase the stake rows. A rename on either
side silently drops a row — keep them in step.

## Rules

1. **Never print the key.** `redact()` in `packages/core/src/redact.ts` for any
   log line that could carry one (CLAUDE.md §4).
2. **Unrecognized `/key` shape → stop.** Typed `AdapterShapeError`, redacted
   sample appended to `docs/api-notes.md` under "Unrecognized samples", loudly
   (CLAUDE.md §6). The script already refuses a `/key` body with no `balance`.
3. **No LLM calls anywhere near `packages/core/src/policy/**`.** Pure TypeScript,
   no I/O (CLAUDE.md §3).
4. **Estimates are labelled.** Never present a table-derived figure as measured.

## Related

- `orbio-buy` — acts on what this skill decides. Runway short + net discount
  clears target → buy.
- `orbio-inference` — spends the credit. The only skill here that costs money.
- `reference.md` in this folder — verified endpoint shapes, the price-parity
  evidence, and the probe dates behind every number above.

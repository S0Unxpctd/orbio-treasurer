# SUBMISSION.md — Orbio Build Week

Draft submission text (≤ 300 words). Fill the bracketed links before submitting; nothing else
to fill.

---

## Orbio Treasurer

Orbio Treasurer is a gateway other agents call to make recurring LLM tasks cheaper. Change one
line (`base_url`), send `model: "auto"`. It routes each call to the cheapest model that fits,
pays with Orbio CREDIT sourced below list — claimed from a staked $ORBIO position, or bought at
a discount on-chain — meters every call, and shows savings and treasury in public, on-chain. The
loop: volume → margin → buy $ORBIO → stake → more CREDIT → cheaper inference → more volume.

**Live:** the gateway/router (`auto` tier routing on real Orbio pricing), metering against a
savings baseline, treasury reads on Robinhood Chain 4663 (staked position, claimable/activated
CREDIT, book quote), the policy loop (mode, claim → activate, capped buy — gated behind
`TREASURER_LIVE` and daily caps), the public page + `/api/stats`, and a kit
(`npx create-orbio-agent`) scaffolding a caller with no chain or database knowledge.

**Designed, not automated:** stake-up (buy then stake $ORBIO) has no confirmed public swap
entrypoint on 4663 yet — both legs of the route have real liquidity, `Payout` is the likely
execution contract, but its signature isn't confirmed (probe P-7b). Policy emits it as a public
alert with a deep link; a human completes it by hand until then.

**Honestly not real:** nobody pays the Treasurer yet. Caller billing is out of scope for v1 — the
buy-and-stake leg runs on capped seed capital, not caller revenue, and the page says so. USDG on
4663 implements EIP-3009, so x402 billing is provable, not built.

**Numbers, 2026-09-19:** 10 USDG → 13.33 CREDIT (25% book discount, live); 355.36M $ORBIO staked
protocol-wide; hourly periods. Launch holder yield (~$0.00005/token/week) covers light agents;
the book discount matters more for heavier ones.

**Ask:** the `Payout` swap signature (or a Quoter on 4663) turns stake-up into a real tx. An
agentic buy endpoint for CREDIT turns "our capital funds the loop" into "callers do" — the
actual pitch.

Links: repo — [ ]. Live page — [ ]. Loom — [ ].

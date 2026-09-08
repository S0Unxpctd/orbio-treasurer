# ADR-003 · No buy/list execution this week; stake-up as the agentic deficit response

2026-09-08 · accepted

## Context
Orbio confirmed (Telegram, 2026-09-08) that buying credit off the book goes through a Whop checkout page (fiat or crypto) and is not agentic, that this is their known bottleneck, and that they are building agentic buying themselves this week. Listing holder surplus is unverified and out of scope. Building buy/list execution would duplicate the platform's own in-flight work and could not be done without a human anyway.

## Decision
Do not build buy or list execution. Keep `BookClient.buy()` as an adapter with a documented interface, Zod schemas drafted from Orbio's description, and contract tests against a local mock, so integrating Orbio's endpoint is a one-day ticket when it ships (L2b). Make the agentic deficit response **stake-up** (L2a): swap stablecoin already in the agent's wallet for $ORBIO on a verified Robinhood Chain DEX pool, under a daily cap, slippage guard and reserve, raising the agent's hourly credit accrual. Stake-up is gated by probe P-7 (pool exists, liquidity ≥ $50k, impact < 1.5% on $10), 24h of dry-run, a $5 live round-trip, and So's written approval. The policy chooses between buying credit (closes the gap now) and staking (closes it over a payback period) by cost, and falls back to a `SIGNAL_FUND` deep link when neither is available.

## Consequences
The product's honest framing changes: the Treasurer manages the gap between what a position earns and what an agent burns; it does not promise free inference. Stake-up is a purchase of a volatile asset and is labelled as such on the widget and landing (payback in days with a confidence flag, no APY). It also puts trading fees into the pool every holder earns from, which buying credit does not. Tickets T-013, T-020, T-033 (buy/list) are dropped; T-020 is reused for the stake client; a mock-contract ticket for L2b is added. If Orbio ships agentic buying mid-week, integration displaces the lowest-priority open ticket.

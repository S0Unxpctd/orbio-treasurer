# P-7b · Probe: USDG → ORBIO swap path on chain 4663 (read-only)
Sprint 1.0 · 60 min max · gates S-07 · PRD: docs/PRD-1.0-sprint.md §3 (ORBIO/NVDA pool, Payout), §4 T-7

## Question
Is there a callable, quotable on-chain route to buy ORBIO with USDG on Robinhood Chain that our hot wallet can use from viem, and what are the exact contract addresses?

## Method (read-only, no tx, no private key)
1. `Staking.addresses()` (verified selector, 7 addresses) and `Payout` bytecode: extract every 20-byte address constant from Payout's runtime bytecode (`eth_getCode`), check each with `eth_getCode` and label by probing well-known selectors (`poolManager()`, `WETH9()`, `execute(bytes,bytes[])` → UniversalRouter; `unlock(bytes)`/`extsload` → v4 PoolManager; `quoteExactInputSingle` → v4 Quoter/StateView). Record.
2. If a v4 PoolManager is found: compute the pool id for ORBIO/NVDA and NVDA/USDG candidates (fee 0/500/3000/10000, tickSpacing accordingly, hooks 0x0) and read `StateView.getSlot0(poolId)` if a StateView exists, else `PoolManager.extsload` of the slot0 slot; report `sqrtPriceX96` and whether liquidity > 0.
3. Explorer check via HTTPS fetch of `https://robin.etherscan.io/address/<addr>` HTML is allowed if reachable (the sandbox egress may block it; say so).
4. Output a table: contract → address → evidence → confidence. Then the answer: YES (route + addresses + a quoted price for 1 USDG) / PARTIAL (pool found, no quoter) / NO. Append to `docs/api-notes.md` under "P-7b (2026-09-19)".

## Deliverable
`docs/api-notes.md` section + this ticket's Evidence + a one-paragraph recommendation for S-07: automated swap (with the exact call sequence) or manual deep link (with the exact URL a human would use).

## Status
todo

## Evidence

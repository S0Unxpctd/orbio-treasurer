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
done

## Evidence

**Verdict: PARTIAL.** Full detail in `docs/api-notes.md` "P-7b (2026-09-19)"; script:
`scripts/probes/p7b-swap-route.ts` (viem, read-only, no tx, no private key, both RPCs).

- `Staking.addresses()` **reverted live** on both RPCs — contradicts PRD §3's "verified
  selector, 7 addresses" claim. Flagged in api-notes.md *Discovered*.
- `Payout` bytecode (2,937 bytes) extraction (proper PUSH-immediate-skipping disassembly, not
  a blind regex) found 6 address constants: USDG, ORBIO, NVDA, EXCHANGE (all known) + one new
  contract + one no-code address. `Payout.poolManager()` **succeeds**, returning the new
  contract `0x8366a39CC670B4001A1121B8F6A443A643e40951` — a real (non-canonical) Uniswap v4
  PoolManager: 24,009 bytes, `owner()` == `extsload(0x0)` (v4-core's `Owned` slot-0 pattern),
  `unlock(bytes)` selector present in both Payout's and this contract's own bytecode dispatch
  table.
- Canonical v4 PoolManager (`0x000000000004444c5dc75cB358380D2e3dE08A90`) confirmed **no code**
  on 4663 (PRD §3's claim, now directly verified live). Canonical UniversalRouter
  (`0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af`) **does** have code but its `poolManager()`
  points at that dead canonical address — deployed but non-functional here, do not use.
- Pool reads via `extsload` of the computed `Pool.State` slot (v4-periphery `StateView.sol`'s
  own `POOLS_SLOT=6` formula, unverified against this exact deployment but internally
  consistent — decoded `lpFee` from storage matches the fee tier used to compute each poolId):
  ORBIO/NVDA (So's known pool id) has nonzero liquidity, plausible tick/fees; NVDA/USDG
  candidate pools at fee 500 and fee 3000 also have nonzero liquidity with matching decoded
  `lpFee`. **Both legs of the USDG → NVDA → ORBIO route have real on-chain liquidity.**
- No Quoter/StateView contract found; no confirmed public swap-entrypoint signature on Payout
  (the strong candidate contract) within the 60-min box. Explorer check (`robin.etherscan.io`)
  returned HTTP 403 / Cloudflare challenge from this sandbox — unreachable, as anticipated.

**Recommendation for S-07/T-7**: ask Yash for Payout's exact swap-trigger signature (fastest —
Payout is almost certainly the contract PRD §3 already names); in parallel ship PRD §T-7's
manual fallback (alert + deep link) exactly as specified. Do not target the canonical
UniversalRouter/PoolManager addresses — confirmed dead on this chain. Manual deep link for a
human (unconfirmed — explorer unreachable to verify a write tab exists):
`https://robin.etherscan.io/address/0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5#writeContract`.

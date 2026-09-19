# ABIs (S-03, docs/PRD-1.0-sprint.md §3)

- `credit.json`, `exchange.json`, `erc20.json` — fetched verbatim from
  `https://www.orbio.so/protocol/abi/<name>.json` on **2026-09-19** and committed as-is
  (pretty-printed, no fields added/removed). Re-fetch and diff before trusting a stale copy if
  Orbio redeploys the proxies.
  - `exchange.json`'s `getQuote(uint256 usdgIn, uint256 maxFills)` returns a single `tuple`
    `{ creditOut, usdgSpent, feeAtoms, fills, reason }` — richer than the `(creditOut, fills)`
    shorthand in PRD §3; `chain/read.ts` decodes the full tuple and only surfaces `creditOut`
    (and `fills`) to `ChainSnapshot`, per the ticket's scope.
- `staking.json` — **hand-written**, not published by Orbio. Function selectors and the four
  read-only signatures that gate live calls (`totalStaked`, `MIN_POSITION`, `PERIOD`,
  `positionOf`/`settledOf`) are the ones PRD §3 marks "verified by eth_call on 2026-09-16".
  `rewardOf(address,uint256)`, `rewardPeriod(uint256) -> 5×uint256`, `settle`, `claim`, `stake`
  and `addresses()` are **unverified return shapes** (PRD §3 says so explicitly) — this file
  encodes PRD §3's stated signatures with a best-guess output shape (`uint256` for the four
  single-value reads guessed unnamed to tolerate whatever the real names turn out to be;
  `rewardPeriod` as 5 unnamed `uint256`; `addresses()` as `address[7]`). S-03 confirms the
  read-only ones (`positionOf`, `settledOf`, `totalStaked`, `MIN_POSITION`, `PERIOD`) against
  the live contract and records the raw decoded output in `docs/api-notes.md` under
  "S-03 chain reads (2026-09-19)". `settle`, `claim`, `stake` are `nonpayable` and are never
  called from S-03 (read-only ticket) — their shapes stay unverified until S-04/S-07 call them
  for real (gated, `TREASURER_LIVE`). `unstakeAll` is deliberately not in this file — PRD §3:
  "plausible, unverified: never call it."

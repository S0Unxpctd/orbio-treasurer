# LOOM-script.md — 3-minute walkthrough

For So to record. Keep each segment to its time box; total ≤ 3:00. Record the page and terminal
at 1080p; no editing required beyond a hard cut between segments if a take runs long.

| Time | Segment | What to show | What to say |
|---|---|---|---|
| 0:00–0:20 | The page | Open the live page. Scroll past the header to the Savings block, then Treasury, then Proof. | "This is Orbio Treasurer — a treasury for AI agents on Orbio. It earns inference credit, meters what it burns, and shows the gap in public. Everything below is live." |
| 0:20–0:55 | One call through the gateway | Terminal: run the `curl` from the README against the live gateway with `model: "auto"`, show the JSON response and the `x-treasurer-model` / `-cost-usd` / `-baseline-usd` response headers. | "One line change — `base_url` — and `model: auto`. The Treasurer just routed this to [model], costing $[x] against a $[y] baseline. No key exposed on screen — it's a throwaway demo key." |
| 0:55–1:20 | The usage row on the page | Reload the page (or `/api/stats`), point at the Savings numbers moving (calls +1, $ spent, $ saved). | "That call just landed here — calls routed, dollars spent, dollars saved versus the baseline model, updated within the page's 60-second cache window." |
| 1:20–1:55 | `pnpm tick` output | Terminal: run `pnpm tick` (dry-run, or live if So has already flipped it), show the printed JSON summary (bucket, mode, action list). | "This is the policy loop — it runs every 15 minutes on a cron. It decides the mode from runway, and claims, buys, or stakes when the numbers say to. [If live:] this one is live — that's a real decision, not a simulation." |
| 1:55–2:25 | The tx on the explorer | Browser: open the `robin.etherscan.io/tx/<hash>` link from the page's Proof block (the row the last tick just wrote, if live; otherwise the most recent real one). | "Every action links to its transaction, on-chain, on Robinhood Chain. Anyone can check this — that's the 'public proof' part, not a claim." |
| 2:25–2:50 | `npx create-orbio-agent` in 60s | Terminal: `npx create-orbio-agent my-agent --gateway <host> --key <demo key>`, then `cd my-agent && npm start` printing a digest, then `npm run register`. | "Anyone can build a caller. No wallet, no database, no chain knowledge — this scaffolds a cron agent, runs it once, and registers it. It'll show up on the Agents block within a minute." |
| 2:50–3:00 | The caveat | Cut back to the page footer. | "Honest caveat: the buy-and-stake leg is funded by our own seed capital, capped — not caller revenue. Caller billing isn't live yet. Everything else you just saw is real." |

## Notes for the recording

- Use a demo/throwaway `otk_...` key on screen, never a production one.
- If `TREASURER_LIVE` is still `false` at recording time, say "dry-run" explicitly during the
  `pnpm tick` segment rather than implying a live transaction — the Proof block's own dry-run
  rows are greyed out with a reason, which reads honestly on camera.
- If the stake-up leg hasn't been automated by recording time (P-7b still blocked per
  `docs/api-notes.md`), skip any claim about it moving — the manual-fallback alert with a deep
  link is what's real, and the caveat segment already covers "not everything is automated".

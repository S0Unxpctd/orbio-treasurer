# Router fixtures (S-01)

All files in this directory are **synthetic** — hand-written to be OpenAI/Orbio-shaped (per
PRD-1.0-sprint.md §3: "OpenAI-compatible ... `GET /models` has per-token pricing ... each
completion returns `usage.cost`"), dated 2026-09-19. None of them were recorded from a real
Orbio API response. They exist so `apps/web/app/v1/chat/completions/route.test.ts` and
`apps/web/app/v1/models/route.test.ts` can run an in-process fake upstream without ever calling
the real gateway (CLAUDE.md: never call the real Orbio gateway in tests).

- `models-catalog.2026-09-19.json` — a `GET /models` body with entries in all three price tiers.
- `chat-completion.nonstream.2026-09-19.json` — a non-stream `POST /chat/completions` response.
- `chat-completion.stream.2026-09-19.sse` — the matching `stream: true` response, raw SSE frames.

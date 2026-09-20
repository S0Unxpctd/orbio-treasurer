# Orbio gateway — verified reference

Everything here was probed live. Each claim carries the date it was verified.
Unverified claims are labelled as such. When you learn something new, append it
to `docs/api-notes.md` (append, never rewrite history — `CLAUDE.md`), then
update this file.

Base URL: `https://api.orbio.so/api/v1` (also served at `https://www.orbio.so/api/v1`).
Auth: `Authorization: Bearer <ORBIO_API_KEY>`. Key format seen so far: `sk-orbio-…`.

## Endpoint matrix — probed 2026-09-20

| Endpoint | Auth | Result |
|---|---|---|
| `GET /models` | none needed | **200 JSON**, 604 models with per-token pricing |
| `GET /key` | required | **401 JSON** on a bad key, `x-matched-path: /api/v1/key` → **route exists** |
| `GET /auth/key` | required | 401 JSON, route exists |
| `GET /credits` | — | 404 HTML (Next.js catch-all) — not implemented |
| `POST /chat/completions` | required | 200 JSON; 401 JSON on a bad key |

### The `/key` contradiction — resolved 2026-09-20

`docs/api-notes.md` P-2 (probed 2026-09-08) recorded `GET /key` → HTML, and
concluded "remaining quota cannot be read from the gateway".
`docs/PRD-1.0-sprint.md:20` claims `GET /key` returns
`{balance:{currency,available,used}, rate_limit:{requests_per_minute:120, concurrent:32}}`.

As of 2026-09-20 the route **is implemented**: a bad key gets a structured JSON
401, not the Next.js HTML page, and Vercel reports `x-matched-path:
/api/v1/key`. P-2 is stale; the PRD is very likely right.

**Not yet confirmed:** the 200 response body shape, because that needs a valid
key. `scripts/orbio balance` checks this at runtime and tells you which way it
went. Once you have run it with a real key, record the 200 shape in
`docs/api-notes.md` and delete this paragraph.

## `GET /models` — model catalogue and prices

The catalogue and every pricing question (shape, gotchas, `"-1"` dynamic
pricing, `:free` and `:batch` variants, Orbio-vs-OpenRouter comparison) live in
the **`orbio-cost`** skill's `reference.md`. That endpoint is public
and free to read, so it does not belong in a skill that spends money.

## `POST /chat/completions`

Standard OpenAI request body. One Orbio/OpenRouter-specific field matters:

```json
{ "model": "...", "messages": [...], "usage": { "include": true } }
```

`usage.include` makes the response carry real cost. **Always send it.**

Response (verified 2026-09-08, probe P-4, `docs/api-notes.md:55`):

```jsonc
{
  "choices": [ { "message": { "role": "assistant", "content": "..." } } ],
  "model": "inception/mercury-2.5",
  "provider": "...",                  // upstream provider that served it
  "service_tier": "...",
  "system_fingerprint": "...",
  "usage": {
    "prompt_tokens": 6,
    "completion_tokens": 6,
    "cost": 1.14e-06,                 // USD, AUTHORITATIVE
    "cost_details": {
      "upstream_inference_cost": ...,
      "upstream_inference_prompt_cost": ...,
      "upstream_inference_completions_cost": ...
    },
    "is_byok": false
  }
}
```

`usage.cost` is the number to meter on. The `/models` price table × token count
is the **fallback only**, and anything derived that way must be flagged
`estimated` (PRD FR-3.2).

Response header `X-Orbio-Balance` carries the balance *before* the request
(per `docs/PRD-1.0-sprint.md:20`; not yet observed directly — needs a real key).
`scripts/orbio chat` prints it when present.

## Errors — verified 2026-09-20

OpenAI-standard error envelope:

```json
{ "error": { "message": "This Orbio API key is unknown or has been revoked.",
             "type": "invalid_request_error",
             "code": "invalid_api_key",
             "param": null } }
```

| Status | Meaning | What to do |
|---|---|---|
| 401 `invalid_api_key` | key unknown or revoked | check `ORBIO_API_KEY`; the MCP tool `orbio_get_key_status` says whether it was revoked |
| 404 | wrong model id, or wrong path | `orbio-cost models <vendor>` |
| 429 | rate limited | documented ceiling 120 req/min, 32 concurrent; back off |

A 401 returns **no** `X-Orbio-Balance` header, so you cannot use a failed call
as a balance probe.

## Related surfaces (not this skill)

- **MCP** `https://www.orbio.so/api/mcp` — OAuth, interactive. Tools:
  `orbio_get_balance`, `orbio_create_key`, `orbio_get_key_status`,
  `orbio_revoke_key`. Probe P-1 = YES. This is the balance source of record
  while `/key`'s 200 shape is unconfirmed. Adapter lives in
  `packages/core/src/mcp/`.
- **Book / order depth** — no JSON API. Probe P-3 = NO
  (`docs/api-notes.md:40`): every `/api/*` candidate on both hosts 404s, and the
  site's CSP `connect-src` does not allow-list `api.orbio.so`, which confirms
  the browser never fetches book data from a separate API. The homepage embeds a
  sales feed in the RSC payload only. Default set: `BOOK read = none`.
- **Buying credit** — Whop checkout, not agentic. Yash said (2026-09-08) an
  agentic buy path was coming "this week"; re-ask before designing against it.

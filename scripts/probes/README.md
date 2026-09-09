# Probes (PRD §13a)

One file per probe, `p<n>-<name>.ts`. Each answers one yes/no question in ≤ 30 minutes, prints redacted evidence, and never moves money. Results go to `docs/api-notes.md` → "Probe results". Run with `pnpm probe P-<n>`.

## P-1 · MCP headless auth (`p1-mcp-auth.ts`)

Answers: can a server process call `orbio_get_balance` for > 6h with a token obtained
once, and is there a refresh token? Needs a human once, at the start, to approve the
OAuth authorization in a browser — the rest is unattended.

```
pnpm probe P-1                              # default: every 10 min for 6h
pnpm probe P-1 --once                       # one call, then stop (smoke-test the auth)
pnpm probe P-1 --interval-min 15 --hours 2  # override the schedule
pnpm probe P-1 --reauth                     # force a fresh OAuth flow, ignore any saved token
pnpm probe P-1 --help
```

**First run (or `--reauth`):** the script does RFC 9728 / RFC 8414 discovery, registers
a client with the Orbio MCP (RFC 7591, PKCE S256), then prints an authorization URL and
waits on stdin. Open that URL in a browser on **any** machine, sign in, approve. The
browser will then try to load `http://localhost:3333/callback` and fail — that's
expected, nothing is listening there. Copy the **full URL from the address bar anyway**
(it carries `?code=...&state=...`) and paste it back at the prompt. The script validates
`state`, exchanges the code, and writes `ORBIO_MCP_TOKEN` / `ORBIO_MCP_REFRESH_TOKEN` /
`ORBIO_MCP_TOKEN_EXPIRES_AT` / `ORBIO_MCP_CLIENT_ID` / `ORBIO_MCP_CLIENT_SECRET` into
`.env.local` (values are never printed).

**Later runs:** if `.env.local` already has `ORBIO_MCP_TOKEN`, auth is skipped and the
saved token is reused directly.

**While it runs:** one redacted JSON line per `orbio_get_balance` call, to stdout. A
`401` triggers exactly one refresh attempt (logged), then either a retried call or a
stop — the loop never opens a second interactive auth flow on its own. `Ctrl-C` (or the
`--hours` window ending) prints a one-paragraph summary formatted to paste straight into
`docs/api-notes.md` under "Probe results".

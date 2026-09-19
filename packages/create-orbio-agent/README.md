# create-orbio-agent

Scaffolds a cron agent that calls the [Orbio Treasurer](https://github.com/S0Unxpctd/orbio-treasurer)
gateway with `model: "auto"` and, optionally, registers it so it shows up on the Treasurer's
public page. No dependencies beyond Node 22 built-ins — no wallet, no database account, no chain
knowledge needed.

## Use

```
npx create-orbio-agent my-agent --gateway https://<treasurer-host> --key otk_...
cd my-agent
npm start              # fetches a couple of RSS feeds, asks the gateway to summarise them, prints it
npm run register       # shows up on the Treasurer's public page within a minute
```

Ask the Treasurer operator for the gateway URL and an `otk_...` key. `--gateway` and `--key` are
both optional at scaffold time — omit either and fill `.env` yourself, following the generated
`README.md`. **Always pass `--gateway`** if you have the URL: without it, the scaffold's
`ORBIO_TREASURER_URL` is left at a placeholder that can never resolve, and the CLI prints a
warning saying so.

## Flags

| Flag | Required | Default | What |
|---|---|---|---|
| `<name>` | yes | — | folder to create; must not already exist |
| `--gateway <url>` | no | the package's built-in placeholder | the Treasurer gateway's base URL |
| `--key <otk_...>` | no | — | an API key, written to a fresh, git-ignored `.env` (never to the committed `.env.example`) |

## What you get

`package.json`, `agent.mjs` (the cron task — RSS in, `model: "auto"` summary out, optional
webhook post), `register.mjs` (idempotent registration against `/api/agents`), `cron.example`
and a GitHub Actions workflow (`.github/workflows/daily.yml`) so it can run with no server,
`.env.example`, and a `README.md` explaining what `model: "auto"` does, where the savings show
up, and v1's honest limits.

See the main repo's [README](https://github.com/S0Unxpctd/orbio-treasurer#readme) for what the
Treasurer itself is.

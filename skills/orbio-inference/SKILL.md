---
name: orbio-inference
description: Run LLM inference through the Orbio gateway (OpenAI-compatible, https://api.orbio.so/api/v1). Use when asked to send a prompt to Orbio, run a completion, check the Orbio credit balance, measure what a call actually cost, or repoint existing OpenAI-compatible code at the gateway. Spends real money: the model and the prompt come from the user, never from the agent's own choice. For choosing a model or deciding whether a price is lower, use orbio-cost instead.
---

# Orbio inference

Orbio is an OpenRouter reseller. The gateway is **OpenAI-compatible**, so
anything that speaks `POST /chat/completions` works by changing two things: base
URL and API key.

The discount is in how credits are *bought*, not in the per-token rate. Measured
on chain 4663 on 2026-09-20: **14.11% net** (18.40% gross, minus a 5% activation
fee). It moves fast — 55% on 09-16, ~17% on 09-19 — so read it live with
`orbio-buy quote` and never quote it without its date.

Everything below is verified against the live gateway (see `reference.md` for
evidence and dates).

## Setup check — always run first

```bash
skills/orbio-inference/scripts/orbio check
```

This prints whether `ORBIO_API_KEY` and `ORBIO_API_URL` resolve, and the key's
redacted prefix/last4. **It never prints the key.** If it reports a missing key,
stop and tell the human to add it to `.env`:

```
ORBIO_API_KEY=sk-orbio-...
ORBIO_API_URL=https://api.orbio.so/api/v1
```

`ORBIO_API_URL` defaults to `https://api.orbio.so/api/v1` when unset, so in
practice only the key is required.

## Picking a model

Model choice lives in the **`orbio-cost`** skill, not here. It is
read-only and free, while everything in this skill spends money:

```bash
skills/orbio-cost/scripts/orbio-cost cheapest 15
skills/orbio-cost/scripts/orbio-cost models claude
skills/orbio-cost/scripts/orbio-cost price anthropic/claude-haiku-4.5
```

Do not guess model ids — there are 604 and the list changes. Ids are
OpenRouter-style (`vendor/model`), not bare OpenAI names.

One thing worth knowing before you route anything here: **Orbio's per-token
rates are identical to OpenRouter's** (441/441 comparable models, re-verified
2026-09-20). Switching to this gateway does not by itself lower the sticker
price of a token. The savings come from model choice, `:batch` variants, and
buying credit below face value (`orbio-buy`). `orbio-cost audit` has the
evidence.

## Running a completion

**The model and the prompt are the user's, not yours.** This is the one rule in
this skill that is about judgment rather than mechanics, so it comes first.

- **No model named in the request?** Do not guess, and do not reach for whatever
  you used last time. Run `orbio-cost cheapest 10`, then put two or three
  candidates in front of the user with their `$/M` figures and a one-line reason
  each. Let them choose.
- **No prompt given?** Ask. Never invent one, paraphrase one, or reuse an
  example from this file. "Say hi in five words" is a smoke test, not a task.
- **Changing an existing call?** Keep the user's wording. If you think the
  prompt is the problem, say so and propose an edit — do not silently rewrite it
  and report on the result of a different question.
- **The only thing you may run unattended** is a `:free` model, and only to
  prove the path works. It costs nothing, so nobody needs to approve it.

The script enforces this rather than trusting it. A paid or dynamically priced
model refuses to run without `--yes`, and an unknown model id fails closed:

```
$ orbio chat anthropic/claude-haiku-4.5 "hello"
orbio: anthropic/claude-haiku-4.5 is a PAID model ($1/M prompt tokens).
orbio: confirm the model and the prompt with the user, then re-run with --yes.
```

`--yes` means *the user picked this model and this prompt*. It is not a way to
get past the message. Passing it on your own initiative is the failure this gate
exists to prevent.

### Usage

```bash
orbio chat <model> "<prompt>" --yes
orbio chat <model> - --yes < prompt.txt          # long prompt via stdin
orbio chat <model> "<prompt>" --yes --system "You are terse." --max-tokens 200
orbio chat inclusionai/ling-3.0-flash-vl:free "..."   # free, no --yes needed
```

The script always sends `"usage": {"include": true}`, so every response carries
the **authoritative** `usage.cost` in USD. It prints the completion text on
stdout, then a cost line on stderr:

```
cost=$0.00004997 tokens=8in/331out model=inception/mercury-2.5 provider=Inception balance_before=95.773165
```

Use `--json` for the raw envelope.

Report real measured cost from `usage.cost`. Never estimate it from the price
table when you have an actual response in hand — estimates are for forecasting
only, and must be labelled `estimated` if you surface them.

**Set `--max-tokens` on anything you meter.** Cost is driven by output tokens,
and some models pad badly: `mercury-2.5` answered "say hi in exactly five words"
with 331 completion tokens, 40x the input.

## Balance

```bash
scripts/orbio balance
```

The repo's docs disagree about whether the gateway exposes balance.
`docs/PRD-1.0-sprint.md:20` says `GET /key` returns a balance object;
`docs/api-notes.md` P-2 (probed 2026-09-08) says `GET /key` returns the Next.js
HTML page, i.e. not implemented.

**Probed 2026-09-20: the PRD is right and P-2 is stale.** `GET /key` now
answers a bad key with a structured JSON 401 and `x-matched-path:
/api/v1/key` — the route exists. What is still unconfirmed is the 200 body
shape, which needs a valid key.

So: run `scripts/orbio balance`. If it prints the balance, append the observed
shape to `docs/api-notes.md` under "Endpoints discovered" (append, never rewrite
history — CLAUDE.md) so P-2 stops misleading the next session. If it still
fails, fall back to the MCP chain (`orbio_get_balance`, probe P-1 = YES) and say
so plainly — do not invent a number.

## Repointing existing code at Orbio

Because the gateway is OpenAI-compatible, migration is a config change, not a
rewrite. No new dependency is needed — `fetch` is enough, which matters because
`CLAUDE.md §7` requires an ADR for any dep outside `ARCHITECTURE.md §1`.

```ts
const res = await fetch(`${process.env.ORBIO_API_URL}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.ORBIO_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: prompt }],
    usage: { include: true },   // <- returns usage.cost, keep it on
  }),
});
```

If a codebase already uses the `openai` SDK, only `baseURL` and `apiKey` change:

```ts
new OpenAI({ baseURL: process.env.ORBIO_API_URL, apiKey: process.env.ORBIO_API_KEY });
```

Model ids are OpenRouter-style (`vendor/model`), not bare OpenAI names. Map them
with `orbio-cost models <vendor>` before swapping.

## Rules for this repo

These come from `CLAUDE.md` and are not optional:

1. **Never log, echo, print, or commit the key.** Store only `key_prefix` and
   `key_last4`. Route any log line that could carry it through
   `redact()` in `packages/core/src/redact.ts`.
2. **No LLM calls in `packages/core/src/policy/**`.** That directory is pure
   TypeScript with no I/O. If a ticket seems to want inference there, it is
   wrong — stop and write it in the ticket's *Discovered* section.
3. **Validate every gateway response with Zod** before using it. Unknown shape →
   typed `AdapterShapeError` + redacted sample appended to `docs/api-notes.md`
   under "Unrecognized samples" (CLAUDE.md §6).
4. **Completions cost real money and are not dry-run.** Individually tiny (a
   12-token round trip on a cheap model is ~$0.000001), but they are spends.
   Never run a paid call the user did not ask for — not to test, not to compare,
   not to "check something quickly". `--yes` records their decision, not your
   confidence. Before any batch or loop, state the total cost first and get
   agreement.

## More detail

Read `reference.md` in this folder for the verified response shapes, the full
endpoint matrix (what exists and what 404s), error codes, and the probe
evidence behind every claim here.

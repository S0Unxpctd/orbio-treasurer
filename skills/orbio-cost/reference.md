# Inference pricing — verified reference

Every claim here was probed live and carries the date. Unverified claims are
labelled. When you learn something new, append it to `docs/api-notes.md`
(append, never rewrite history — `CLAUDE.md`), then update this file.

Sources, both public and free to read:

- Orbio: `https://api.orbio.so/api/v1/models` — 604 models (2026-09-20)
- OpenRouter (Orbio's upstream): `https://openrouter.ai/api/v1/models` — 447 models

## Orbio vs OpenRouter — measured 2026-09-20

| | |
|---|---|
| Comparable models (both lists, fixed price) | **442** |
| Identical per-token price | **442** |
| Orbio cheaper | 0 |
| Orbio more expensive | **0** |

**Orbio's per-token rates are a pass-through of OpenRouter list price.** Routing
through the gateway does not lower the sticker price of a token.

A note on measurement noise: an earlier run minutes before showed exactly one
model (`inference-net/schematron-v2-small`) about 4% cheaper on Orbio
($0.048/$0.219 per M vs $0.05/$0.23). The gap had closed on re-fetch. Orbio
mirrors OpenRouter with a short propagation lag, so treat a single-model
difference as lag until a re-run confirms it.

Orbio lists **157 models OpenRouter's public list does not** (image, video and
embedding models, plus some `:batch` variants). Those have no comparison
baseline — `compare` says so rather than guessing.

## Where the savings actually are

1. **Model choice — up to 10x.** `anthropic/claude-fable-5.1` $10/$50 per M vs
   `anthropic/claude-haiku-4.5` $1/$5 vs `anthropic/claude-3-haiku` $0.25/$1.25.
2. **`:batch` variants — about 2x.** `claude-haiku-4.5:batch` $0.5/$2.5,
   `claude-fable-5.1:batch` $5/$25. Batch latency; right for a daily job, wrong
   for a user-facing tick.
3. **Credit acquisition — 10–80%.** Orbio's actual discount: buying credits
   below face value on the order book, funded by $ORBIO trading fees. A treasury
   question, not a routing question. This is what the repo's PRD is about.

Live figures, 2026-09-20:

| Model | $/M in | $/M out |
|---|---|---|
| `anthropic/claude-fable-5.1` | 10 | 50 |
| `anthropic/claude-fable-5.1:batch` | 5 | 25 |
| `anthropic/claude-haiku-4.5` | 1 | 5 |
| `anthropic/claude-haiku-4.5:batch` | 0.5 | 2.5 |
| `anthropic/claude-3-haiku` | 0.25 | 1.25 |
| `inclusionai/ling-3.0-flash` | 0.021 | 0.063 |
| `mistralai/mistral-nemo` | 0.019 | 0.03 |
| `ibm-granite/granite-4.0-h-micro` | 0.017 | 0.112 |
| `inclusionai/ling-3.0-flash-vl:free` | 0 | 0 |

## `GET /models` response shape

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "anthropic/claude-haiku-4.5",     // OpenRouter-style vendor/model
      "object": "model",
      "created": 1789754046,
      "owned_by": "anthropic",
      "name": "Anthropic: Claude Haiku 4.5",
      "context_length": 200000,
      "pricing": {                             // USD PER TOKEN, as strings
        "prompt": "0.000001",                  //   = $1 / M tokens
        "completion": "0.000005",              //   = $5 / M tokens
        "input_cache_read": "..."              //   present on some models
      },
      "architecture": {
        "modality": "text+image+file->text",
        "input_modalities": ["text", "image", "file"],
        "output_modalities": ["text"],         // <- how to tell chat from embeddings
        "tokenizer": "Claude",
        "instruct_type": null
      },
      "supported_parameters": ["tools", "temperature", "structured_outputs", ...]
    }
  ]
}
```

Gotchas:

- **Prices are per token and are strings.** `tonumber` before arithmetic.
  Multiply by 1e6 for the familiar $/M figure.
- **`"-1"` means dynamic.** The `openrouter/auto`, `openrouter/fusion`,
  `openrouter/pareto-code`, `openrouter/bodybuilder` routers choose a model at
  request time. Cost is unknowable in advance. Do not use them where the PRD
  needs a predictable per-call cost.
- **The cheap end of the list is not chat models.** Sorting 604 models by price
  puts embedding models (`text->embeddings`, $0.004/M) and image/video models on
  top. Filter on `architecture.output_modalities` containing `"text"`.
  `orbio-cost cheapest` does this by default; `--all` turns it off.
- **`:free` variants exist** (`inclusionai/ling-3.0-flash-vl:free`,
  `nex-agi/nex-n2.5-mini:free`, …) at genuinely $0. Rate-limited, quality
  varies. Good for smoke tests and fixtures.
- **`:batch` variants are ~50% off** (`openai/gpt-5-nano:batch`,
  `anthropic/claude-haiku-4.5:batch`) with batch latency. Worth it for the
  daily book job, not for a user-facing tick.

## Does the bill match the table?

Probe P-4 (`docs/api-notes.md:55`, 2026-09-08) recorded a real call:
`inception/mercury-2.5`, 6 prompt tokens, 6 completion tokens,
`usage.cost = 1.14e-06`.

The table says `prompt 0.00000004` and `completion 0.00000015` per token:

```
(0.00000004 x 6) + (0.00000015 x 6) = 0.00000114
```

Exact match. `orbio-cost verify inception/mercury-2.5 6 6 0.00000114` reproduces
this, which is the evidence that the published table can be trusted for
forecasting.

`usage.cost` remains authoritative for metering. The table is the fallback, and
anything derived from it must be flagged `estimated` (PRD FR-3.2).

## Getting a real cost back

Send `"usage": {"include": true}` in the request body. The response then carries
`usage.cost` (USD), `usage.cost_details.{upstream_inference_cost,
upstream_inference_prompt_cost, upstream_inference_completions_cost}`,
`is_byok`, and token detail blocks, plus `provider`, `service_tier` and
`system_fingerprint`. Running the call is the `orbio-inference` skill's job.

## Why routing alone is not the lever

Restating the conclusion, because it is the one people get wrong.

An earlier draft of this file assumed Orbio's 10–80% discount showed up as a
lower per-token rate, so `usage.cost` would land under the table figure. **That
is false.** Two measurements killed it:

- 442/442 comparable models are priced identically to OpenRouter (2026-09-20).
- Probe P-4's real `usage.cost` matched the table to the last digit.

The discount is applied when credits are **bought**, not when tokens are spent.
A dollar of Orbio credit buys the same tokens as a dollar of OpenRouter credit;
it just cost less than a dollar to acquire.

So when someone asks "will moving to Orbio cut our inference bill?", the honest
answer has two parts:

1. **Per-token rate: no change.** Moving the base URL saves nothing.
2. **Effective cost: yes, if credits are bought below face value** — and that is
   a treasury problem (the order book, `$ORBIO` fees, the buy path), not an
   integration problem.

Meanwhile the lever nobody needs permission for is **model choice**: frontier →
`claude-haiku-4.5` is 10x, and `:batch` on top is another 2x. That beats any
routing decision on this page.

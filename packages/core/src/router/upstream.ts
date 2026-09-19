/**
 * Forwarding to the real Orbio gateway (S-01, ticket "Upstream" bullet). Handles both non-stream
 * and `stream: true` (SSE passthrough, reading the final `usage` chunk) and the 402/5xx mapping.
 * Not part of `route.ts`'s pure surface — this is the I/O edge `route()`'s decision feeds into.
 */
import type { Hex } from 'viem';
import { z } from 'zod';

import { deriveOrbioKey } from '../chain/key.js';
import { AdapterShapeError } from './errors.js';

const usageSchema = z
  .object({
    prompt_tokens: z.coerce.number(),
    completion_tokens: z.coerce.number(),
    cost: z.coerce.number(),
  })
  .passthrough();

export interface UsageResult {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
}

export interface ForwardChatCompletionParams {
  readonly baseUrl: string;
  readonly upstreamKey: string;
  /** The caller's body with `model` already replaced by the routed model id. */
  readonly body: Record<string, unknown>;
  readonly stream: boolean;
  readonly fetchImpl?: typeof fetch;
}

export type ForwardChatCompletionResult =
  | { readonly kind: 'treasury_empty' }
  | { readonly kind: 'upstream_error'; readonly status: number; readonly body: unknown }
  | {
      readonly kind: 'ok_nonstream';
      readonly status: number;
      readonly body: unknown;
      readonly usage: UsageResult | null;
      readonly shapeError?: AdapterShapeError;
    }
  | {
      readonly kind: 'ok_stream';
      readonly status: number;
      readonly bodyStream: ReadableStream<Uint8Array>;
      readonly contentType: string;
      /** Resolves once the tail of the stream has been read; `null` if no `usage` chunk arrived
       *  before the stream ended. Never rejects. */
      readonly usage: Promise<UsageResult | null>;
    };

// Only trimmed for the error object attached to the exception — the route handler logs through
// the real `redact()`; this just keeps an accidentally-huge or secret-shaped string out of the
// error's own `redactedSample` before that.
function trimSample(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) =>
        typeof v === 'string' && v.length > 64 ? `${v.slice(0, 8)}…` : v,
      ),
    );
  } catch {
    return '<unserializable>';
  }
}

async function parseErrorBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reads a teed SSE branch to completion looking for the final `usage` chunk (Orbio, like
 *  OpenAI's `stream_options.include_usage`, sends `usage` on the last content chunk before
 *  `data: [DONE]`). Swallows any parse error on an individual line — a stream's SSE framing being
 *  slightly off should never crash the recorder's usage extraction. */
async function extractUsageFromSseStream(
  stream: ReadableStream<Uint8Array>,
): Promise<UsageResult | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastUsage: UsageResult | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          const parsedJson: unknown = JSON.parse(payload);
          const usageField = (parsedJson as { usage?: unknown } | null)?.usage;
          const parsedUsage = usageSchema.safeParse(usageField);
          if (parsedUsage.success) {
            lastUsage = {
              promptTokens: parsedUsage.data.prompt_tokens,
              completionTokens: parsedUsage.data.completion_tokens,
              costUsd: parsedUsage.data.cost,
            };
          }
        } catch {
          // malformed SSE data line — ignore and keep reading
        }
      }
    }
  } catch {
    // stream read failure — return whatever usage (if any) was already captured
  } finally {
    reader.releaseLock();
  }
  return lastUsage;
}

/**
 * `POST ${baseUrl}/chat/completions`. `402`/insufficient-balance → `{ kind: 'treasury_empty' }`
 * (route handler maps to 503); `5xx` → `{ kind: 'upstream_error' }` (route handler maps to 502
 * with the upstream status in the body). Non-stream: reads `usage.cost`/`*_tokens`, Zod-validated;
 * a missing/invalid `usage` comes back as `usage: null` plus a `shapeError` — the body is still
 * returned untouched (ticket: "response still returned to the caller, record marked
 * `status:\"no_usage\"`"). Stream: the response body is teed — one branch is the exact passthrough
 * the caller gets, the other is read in the background for the final `usage` chunk.
 */
export async function forwardChatCompletion(
  params: ForwardChatCompletionParams,
): Promise<ForwardChatCompletionResult> {
  const { baseUrl, upstreamKey, body, stream, fetchImpl = fetch } = params;
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${upstreamKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 402) {
    await res.text().catch(() => undefined); // drain — never inspected, never logged
    return { kind: 'treasury_empty' };
  }
  if (res.status >= 500) {
    return {
      kind: 'upstream_error',
      status: res.status,
      body: trimSample(await parseErrorBody(res)),
    };
  }

  if (stream) {
    if (!res.body) {
      return {
        kind: 'upstream_error',
        status: res.status,
        body: {
          error: {
            type: 'upstream_error',
            message: 'upstream sent no body for a streaming request',
          },
        },
      };
    }
    const [passthrough, forUsage] = res.body.tee();
    return {
      kind: 'ok_stream',
      status: res.status,
      bodyStream: passthrough,
      contentType: res.headers.get('content-type') ?? 'text/event-stream',
      usage: extractUsageFromSseStream(forUsage),
    };
  }

  const rawBody: unknown = await res.json().catch(() => undefined);
  const parsedUsage = usageSchema.safeParse((rawBody as { usage?: unknown } | undefined)?.usage);
  if (!parsedUsage.success) {
    const shapeError = new AdapterShapeError(
      'chat_completion',
      'missing or invalid usage on non-stream response',
      trimSample(rawBody),
    );
    return { kind: 'ok_nonstream', status: res.status, body: rawBody, usage: null, shapeError };
  }
  return {
    kind: 'ok_nonstream',
    status: res.status,
    body: rawBody,
    usage: {
      promptTokens: parsedUsage.data.prompt_tokens,
      completionTokens: parsedUsage.data.completion_tokens,
      costUsd: parsedUsage.data.cost,
    },
  };
}

// S-03: derived key cache, keyed on the exact (privateKey, epoch) pair. `deriveOrbioKey()` is
// deterministic (chain/key.test.ts's AC4 test) so caching is a pure perf/no-repeat-signing
// optimization, never a correctness concern — a changed `TREASURER_PRIVATE_KEY` (or epoch, once
// rotation exists) simply misses the cache and re-derives. Never logged; the cache only ever
// holds values that were already in `env` (also never logged) and the key they derive.
let derivedKeyCache: {
  readonly privateKey: string;
  readonly epoch: number;
  readonly key: string;
} | null = null;

const DEFAULT_KEY_EPOCH = 0;

/**
 * The upstream-key seam (ticket: "wallet-signed key derivation lands in S-03; keep a
 * `getUpstreamKey()` seam"). S-03: if `TREASURER_PRIVATE_KEY` is set, derive
 * `sk-orb-0-<base64(sig)>` from it (chain/key.ts's `deriveOrbioKey`) and use that; otherwise
 * fall back to the plain `ORBIO_KEY` from env, as in S-01. Throws (never logging either value)
 * if neither is set, which the route handler turns into a safe 500.
 */
export async function getUpstreamKey(env: {
  readonly ORBIO_KEY?: string | undefined;
  readonly TREASURER_PRIVATE_KEY?: string | undefined;
}): Promise<string> {
  if (env.TREASURER_PRIVATE_KEY) {
    if (
      derivedKeyCache &&
      derivedKeyCache.privateKey === env.TREASURER_PRIVATE_KEY &&
      derivedKeyCache.epoch === DEFAULT_KEY_EPOCH
    ) {
      return derivedKeyCache.key;
    }
    const key = await deriveOrbioKey(env.TREASURER_PRIVATE_KEY as Hex, DEFAULT_KEY_EPOCH);
    derivedKeyCache = { privateKey: env.TREASURER_PRIVATE_KEY, epoch: DEFAULT_KEY_EPOCH, key };
    return key;
  }
  if (!env.ORBIO_KEY) {
    throw new Error('Neither TREASURER_PRIVATE_KEY nor ORBIO_KEY is set');
  }
  return env.ORBIO_KEY;
}

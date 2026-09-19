/**
 * `POST /v1/chat/completions` (S-01, docs/PRD-1.0-sprint.md §4 T-1). Node runtime (streaming SSE
 * passthrough needs a real socket, not the edge runtime).
 *
 * Flow: authenticate (`Authorization: Bearer otk_<32 hex>`) → parse body → fetch/cache the model
 * catalog → `route()` (pure, in `@orbio-treasurer/core`) → forward to Orbio → map the result to a
 * response, adding `x-treasurer-*` headers → record the call, fire-and-forget.
 */
import {
  type CallRecord,
  type CallStatus,
  computeBaselineCostUsd,
  forwardChatCompletion,
  getUpstreamKey,
  type RouteInput,
  RouterError,
  recordFireAndForget,
  redact,
  route as routeRequest,
  selectBaselineModel,
} from '@orbio-treasurer/core';

import {
  getCatalog,
  getEnv,
  getGatewayBaseUrl,
  getMode,
  getRecorder,
  getRouterAllowList,
  resolveCaller,
} from '../../_gateway.js';

export const runtime = 'nodejs';

function jsonError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

function formatUsd(value: number): string {
  return value.toFixed(6);
}

function logError(msg: string, ctx: Record<string, unknown>): void {
  // apps/web's Biome override turns `noConsole` off; `redact()` is still mandatory (CLAUDE.md #4,
  // this ticket's AC6). `console.error`, not `.log` — matches core's own `log.ts` convention.
  console.error(JSON.stringify(redact({ msg, ...ctx })));
}

interface ParsedBody {
  readonly model: string;
  readonly messages: RouteInput['messages'];
  readonly tools: unknown;
  // Deliberately excludes `undefined` (unlike RouteInput's own optional field) — parseBody()
  // always resolves this to an object or `null`, never `undefined`, so the RouteInput literal
  // built from it never assigns an explicit `undefined` under `exactOptionalPropertyTypes`.
  readonly responseFormat: { readonly type?: string } | null;
  readonly stream: boolean;
  readonly forwardBody: Record<string, unknown>;
}

function parseBody(raw: unknown): ParsedBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.model !== 'string' || obj.model.length === 0) return null;
  if (!Array.isArray(obj.messages)) return null;
  const responseFormat =
    obj.response_format && typeof obj.response_format === 'object'
      ? (obj.response_format as { type?: string })
      : null;
  return {
    model: obj.model,
    messages: obj.messages as RouteInput['messages'],
    tools: obj.tools,
    responseFormat,
    stream: obj.stream === true,
    forwardBody: obj,
  };
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();

  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (err) {
    logError('v1/chat/completions: env config error', { err });
    return jsonError(500, 'config', 'server misconfigured');
  }

  const caller = await resolveCaller(env, request.headers.get('authorization'));
  if (!caller) {
    return jsonError(401, 'auth', 'missing or invalid API key');
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, 'invalid_request', 'request body must be valid JSON');
  }
  const parsed = parseBody(rawBody);
  if (!parsed) {
    return jsonError(
      400,
      'invalid_request',
      '"model" (string) and "messages" (array) are required',
    );
  }

  let baseUrl: string;
  let upstreamKey: string;
  try {
    baseUrl = getGatewayBaseUrl(env);
    upstreamKey = await getUpstreamKey(env);
  } catch (err) {
    logError('v1/chat/completions: env config error', { err });
    return jsonError(500, 'config', 'server misconfigured');
  }

  let catalogEntries: Awaited<ReturnType<typeof getCatalog>>['entries'];
  try {
    catalogEntries = (await getCatalog(env)).entries;
  } catch (err) {
    logError('v1/chat/completions: catalog fetch failed', { err });
    return jsonError(502, 'upstream_error', 'could not load model catalog');
  }

  const allowList = getRouterAllowList(env);
  const routeInput: RouteInput = {
    requestedModel: parsed.model,
    messages: parsed.messages,
    tools: parsed.tools,
    responseFormat: parsed.responseFormat,
  };

  const mode = await getMode(env);

  let routed: ReturnType<typeof routeRequest>;
  try {
    routed = routeRequest(routeInput, catalogEntries, {
      mode,
      ...(allowList ? { allowList } : {}),
    });
  } catch (err) {
    if (err instanceof RouterError && err.code === 'unknown_model') {
      return jsonError(400, 'invalid_request', err.message);
    }
    logError('v1/chat/completions: routing failed', { err });
    return jsonError(500, 'router_error', 'no model available to route this request');
  }

  const baselineHeader = request.headers.get('x-baseline-model');
  const baseline = selectBaselineModel(catalogEntries, allowList, baselineHeader);

  const recorder = await getRecorder(env);
  const baseRecordFields = {
    keyId: caller.keyId,
    agentId: caller.agentId,
    requestedModel: parsed.model,
    routedModel: routed.model,
    tier: routed.tier,
    reason: routed.reason,
    stream: parsed.stream,
    baselineModel: baseline?.id ?? null,
  } as const;

  const forwardResult = await forwardChatCompletion({
    baseUrl,
    upstreamKey,
    body: { ...parsed.forwardBody, model: routed.model },
    stream: parsed.stream,
  });

  const record = (fields: {
    promptTokens: number | null;
    completionTokens: number | null;
    costUsd: number | null;
    baselineCostUsd: number | null;
    status: CallStatus;
  }): void => {
    const rec: CallRecord = {
      ts: new Date().toISOString(),
      ...baseRecordFields,
      ...fields,
      latencyMs: Date.now() - startedAt,
    };
    recordFireAndForget(recorder, rec, (err) =>
      logError('v1/chat/completions: recorder failed twice', { err }),
    );
  };

  if (forwardResult.kind === 'treasury_empty') {
    record({
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      baselineCostUsd: null,
      status: 'treasury_empty',
    });
    return jsonError(
      503,
      'treasury_empty',
      'the Treasurer has no inference credit available right now',
    );
  }

  if (forwardResult.kind === 'upstream_error') {
    logError('v1/chat/completions: upstream error', {
      status: forwardResult.status,
      body: forwardResult.body,
    });
    record({
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      baselineCostUsd: null,
      status: 'upstream_error',
    });
    return Response.json(
      {
        error: {
          type: 'upstream_error',
          upstream_status: forwardResult.status,
          body: forwardResult.body,
        },
      },
      { status: 502 },
    );
  }

  if (forwardResult.kind === 'ok_stream') {
    void forwardResult.usage.then((usage) => {
      const baselineCostUsd =
        baseline && usage
          ? computeBaselineCostUsd(baseline, usage.promptTokens, usage.completionTokens)
          : null;
      record({
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        baselineCostUsd,
        status: usage ? 'ok' : 'no_usage',
      });
    });

    const headers = new Headers({
      'content-type': forwardResult.contentType,
      'x-treasurer-model': routed.model,
      'x-treasurer-tier': routed.tier,
      'x-treasurer-reason': routed.reason,
    });
    // Cost/baseline for a streaming response are only known once the stream ends — they can't be
    // set as headers on a response whose headers go out before the body. They're still captured
    // in the recorded call above (AC3); see Build notes for this deliberate deviation from the
    // header list on the non-stream path.
    return new Response(forwardResult.bodyStream, { status: forwardResult.status, headers });
  }

  // ok_nonstream
  if (forwardResult.shapeError) {
    logError('v1/chat/completions: non-stream usage shape error', {
      shapeError: forwardResult.shapeError.message,
      sample: forwardResult.shapeError.redactedSample,
    });
  }
  const usage = forwardResult.usage;
  const baselineCostUsd =
    baseline && usage
      ? computeBaselineCostUsd(baseline, usage.promptTokens, usage.completionTokens)
      : null;
  record({
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    costUsd: usage?.costUsd ?? null,
    baselineCostUsd,
    status: usage ? 'ok' : 'no_usage',
  });

  const headers = new Headers({
    'content-type': 'application/json',
    'x-treasurer-model': routed.model,
    'x-treasurer-tier': routed.tier,
    'x-treasurer-reason': routed.reason,
  });
  if (usage) {
    headers.set('x-treasurer-cost-usd', formatUsd(usage.costUsd));
    if (baselineCostUsd !== null)
      headers.set('x-treasurer-baseline-usd', formatUsd(baselineCostUsd));
  }

  return new Response(JSON.stringify(forwardResult.body), {
    status: forwardResult.status,
    headers,
  });
}

/**
 * `POST /api/tick` (S-06, docs/PRD-1.0-sprint.md §4 T-6, §6; tasks/S-06.md "In scope") — the one
 * HTTP entry point `runTick()` runs behind. Called by the `treasurer-tick` cron job (migration
 * 006, every 15 min) and by a human hitting it manually; `runTick()`'s own 15-min-bucket
 * idempotency marker (`tick/tick.ts`) is what makes both safe to fire in the same window
 * (audit focus: "tick running twice (cron + manual) in one bucket").
 *
 * Auth: header `x-tick-secret` must equal env `TICK_SECRET`, compared in constant time (audit
 * focus: "`TICK_SECRET` compared in constant time") — both sides are hashed first so the
 * comparison never branches on the two strings' raw lengths, then compared with Node's own
 * `timingSafeEqual`. An unset `TICK_SECRET` means every call 401s (same convention as
 * `GATEWAY_KEYS` unset in `router/keys.ts`) — never a 500, and never treated as "no secret
 * required". `GET` is explicitly unsupported (405) — this route only ever *does* something, it
 * never has anything to read.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { redact, runTick } from '@orbio-treasurer/core';

import { getLedgerStore } from '../../_ledger.js';
import { getEnv } from '../../v1/_gateway.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

function jsonError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

function logError(msg: string, ctx: Record<string, unknown>): void {
  console.error(JSON.stringify(redact({ msg, ...ctx })));
}

/** Constant-time string equality: both inputs are hashed to a fixed-length digest first (so the
 *  comparison never short-circuits on the two RAW strings' differing lengths — `timingSafeEqual`
 *  itself throws on mismatched-length buffers), then compared with Node's own
 *  `timingSafeEqual`. Neither `a` nor `b` (nor the hash) is ever logged by this function. */
function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export async function POST(request: Request): Promise<Response> {
  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (err) {
    logError('api/tick POST: env config error', { err });
    return jsonError(500, 'config', 'server misconfigured');
  }

  const provided = request.headers.get('x-tick-secret');
  if (!env.TICK_SECRET || !provided || !safeEqual(provided, env.TICK_SECRET)) {
    return jsonError(401, 'auth', 'missing or invalid tick secret');
  }

  try {
    const store = getLedgerStore(env);
    const summary = await runTick({
      store,
      agentSlug: env.REFERENCE_AGENT_SLUG,
      now: new Date(),
      env,
    });
    // AC8 ("no secret in tick summary, logs, events"): `summary` is `runTick()`'s own
    // `RunTickResult` — bucket, agentId, mode, runwayDays, action outcomes, never a key or
    // secret (see tick/tick.ts's `TickSummary` type) — returned as-is, no redaction needed.
    return Response.json(summary, { status: 200 });
  } catch (err) {
    // A thrown config error (`ChainEnvValidationError`/`EnvValidationError`, per tick.ts's own
    // doc comment) or an unexpected failure — redacted only here, at the log boundary
    // (CLAUDE.md #4), never inside the thrown error itself.
    logError('api/tick POST: tick failed', { err });
    return jsonError(500, 'tick_error', 'tick failed');
  }
}

export async function GET(): Promise<Response> {
  return jsonError(405, 'method_not_allowed', 'GET is not supported on /api/tick; use POST');
}

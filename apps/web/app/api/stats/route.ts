/**
 * `GET /api/stats` (S-08 AC3) — the same data the public page renders, as JSON, for the kit and
 * the Loom. `{agent, savings: {h24, all, byTier}, treasury, events, generatedAt}` per the ticket;
 * `Cache-Control: public, s-maxage=60` matches the page's own 60s freshness window.
 */
import { redact } from '@orbio-treasurer/core';

import { loadRenderModelInput } from '../../_data.js';
import { renderModel } from '../../model.js';
import { getEnv } from '../../v1/_gateway.js';

export const runtime = 'nodejs';

function logError(msg: string, ctx: Record<string, unknown>): void {
  console.error(JSON.stringify(redact({ msg, ...ctx })));
}

export async function GET(): Promise<Response> {
  const now = new Date().toISOString();

  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (err) {
    logError('api/stats: env config error', { err });
    return Response.json(
      { error: { type: 'config', message: 'server misconfigured' } },
      { status: 500 },
    );
  }

  let model: ReturnType<typeof renderModel>;
  try {
    const input = await loadRenderModelInput(env, now);
    model = renderModel(input);
  } catch (err) {
    logError('api/stats: ledger read failed', { err });
    return Response.json(
      { error: { type: 'ledger_error', message: 'could not read the ledger' } },
      { status: 500 },
    );
  }

  return Response.json(
    {
      agent: model.agent,
      savings: {
        h24: model.savings.h24,
        all: model.savings.all,
        byTier: model.savings.byTier,
      },
      treasury: model.treasury,
      events: model.events,
      agents: model.agents,
      generatedAt: model.generatedAt,
    },
    { status: 200, headers: { 'cache-control': 'public, s-maxage=60' } },
  );
}

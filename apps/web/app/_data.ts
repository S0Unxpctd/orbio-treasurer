/**
 * Fetches everything `renderModel()` needs (S-08) — the one place that talks to the
 * `LedgerStore`. `page.tsx` and `app/api/stats/route.ts` both call this and then `renderModel()`,
 * so the two surfaces are guaranteed to render the same data (ticket: "Same data as the page").
 */
import { burnDaily, type Env, savings } from '@orbio-treasurer/core';

import { getLedgerStore } from './_ledger.js';
import { type RenderModelInput, ZERO_SAVINGS } from './model.js';

/** Fetches the reference agent's data (AC1: a missing agent row returns zeros, never throws)
 *  plus the always-present public agents list. `now` is the caller's single `new Date()` read
 *  for this request — everything downstream treats it as a plain input (metrics.ts's own
 *  discipline), so one request logs one consistent instant everywhere. */
export async function loadRenderModelInput(env: Env, now: string): Promise<RenderModelInput> {
  const store = getLedgerStore(env);

  const agent = await store.getAgentBySlug(env.REFERENCE_AGENT_SLUG);
  const publicAgents = await store.listPublicAgents();

  if (!agent) {
    return {
      now,
      agent: null,
      savings24h: ZERO_SAVINGS,
      savingsAll: ZERO_SAVINGS,
      burnDailyUsd: '0.010000',
      chainSnapshot: null,
      treasuryEvents: [],
      publicAgents,
    };
  }

  const [savings24h, savingsAll, burnDailyUsd, chainSnapshot, treasuryEvents] = await Promise.all([
    savings(store, agent.id, '24h', now),
    savings(store, agent.id, 'all', now),
    burnDaily(store, agent.id, now),
    store.latestChainSnapshot(agent.id),
    store.listTreasuryEvents(agent.id, 20),
  ]);

  return {
    now,
    agent,
    savings24h,
    savingsAll,
    burnDailyUsd,
    chainSnapshot,
    treasuryEvents,
    publicAgents,
  };
}

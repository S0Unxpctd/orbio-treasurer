/**
 * LedgerCallRecorder — S-02 (PRD 1.0 §4 T-2, §6). The `CallRecorder` the gateway (T-1/S-01) calls
 * fire-and-forget after every metered inference call; writes one `usage_events` row through the
 * `LedgerStore` interface, so it works unchanged against SqliteLedgerStore or PostgresLedgerStore.
 */
import type { CallRecord, CallRecorder } from './recorder-types.js';
import type { LedgerStore } from './types.js';

export class LedgerCallRecorder implements CallRecorder {
  constructor(private readonly store: LedgerStore) {}

  async record(r: CallRecord): Promise<void> {
    await this.store.insertUsageEvent({
      agentId: r.agentId,
      at: r.at,
      model: r.model,
      tierServed: r.tier,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      status: r.status,
      error: r.error ?? null,
      requestedModel: r.requestedModel,
      routeReason: r.reason,
      baselineCostUsd: r.baselineCostUsd,
      callerKeyId: r.callerKeyId,
    });
  }
}

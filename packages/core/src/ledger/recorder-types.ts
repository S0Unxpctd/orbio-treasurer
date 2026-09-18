/**
 * CallRecord / CallRecorder — S-02 (PRD 1.0 §4 T-2, §6).
 *
 * `packages/core/src/router/recorder.ts` does not exist on this branch (S-01 is in flight in
 * parallel and may add it — see tasks/S-02.md's own instruction for exactly this case). This
 * file defines the identical interface locally, verbatim, so `LedgerCallRecorder` (recorder.ts
 * in this same directory) has something to implement. If/when `router/recorder.ts` lands, it
 * should re-export from here (or this file should re-export from there) rather than the two
 * interfaces drifting — flagged in tasks/S-02.md Discovered.
 */
import type { IsoTimestamp } from './types.js';

export interface CallRecord {
  readonly at: IsoTimestamp;
  readonly agentId: string;
  readonly callerKeyId: string | null;
  readonly requestedModel: string;
  readonly model: string;
  readonly tier: 'S' | 'M' | 'L';
  readonly reason: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: string;
  readonly baselineCostUsd: string;
  readonly latencyMs: number;
  readonly status: 'ok' | 'no_usage' | 'upstream_error' | 'treasury_empty';
  readonly error?: string;
}

export interface CallRecorder {
  record(r: CallRecord): Promise<void>;
}

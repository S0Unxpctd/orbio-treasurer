/**
 * `CallRecorder` — one record per gateway call (S-01, ticket: "Every call → `recorder.record
 * (CallRecord)` … Fire-and-forget, one retry, never blocks the response. The ledger-backed
 * recorder is S-02/S-06."). Ships two implementations here: `InMemoryCallRecorder` (tests) and
 * `JsonlStdoutCallRecorder` (redacted JSONL to stdout, for local/dev visibility ahead of S-02's
 * ledger writer).
 */
import { redact } from '../redact.js';
import type { Tier } from './types.js';

export type CallStatus = 'ok' | 'no_usage' | 'treasury_empty' | 'upstream_error' | 'auth_error';

export interface CallRecord {
  readonly ts: string; // ISO — set by the caller (route handler), never inside this pure-ish module
  readonly keyId: string;
  readonly agentId: string | null;
  readonly requestedModel: string;
  readonly routedModel: string;
  readonly tier: Tier;
  readonly reason: string;
  readonly stream: boolean;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  readonly baselineModel: string | null;
  readonly baselineCostUsd: number | null;
  readonly latencyMs: number;
  readonly status: CallStatus;
}

export interface CallRecorder {
  record(rec: CallRecord): Promise<void> | void;
}

/** Collects every record in memory, in order. Used by tests and by the integration test to assert
 *  "the recorder still receives a record with costUsd" (AC3). */
export class InMemoryCallRecorder implements CallRecorder {
  readonly records: CallRecord[] = [];

  record(rec: CallRecord): void {
    this.records.push(rec);
  }
}

/**
 * Writes one redacted JSON line per call. Uses `process.stdout.write` directly rather than
 * `console.log` — Biome's `noConsole` rule (allow: ["error"] only) applies to `packages/core`, and
 * this is genuinely meant for stdout (a JSONL stream a caller can pipe/tail), not the stderr
 * structured logger in `log.ts`.
 */
export class JsonlStdoutCallRecorder implements CallRecorder {
  record(rec: CallRecord): void {
    const line = JSON.stringify(redact(rec));
    process.stdout.write(`${line}\n`);
  }
}

/**
 * Fire-and-forget with one retry, per the ticket. Never throws and never returns a promise the
 * caller has to await — a `record()` failure (including a rejected retry) is swallowed after
 * being logged, so a broken recorder can never turn into a broken response.
 */
export function recordFireAndForget(
  recorder: CallRecorder,
  rec: CallRecord,
  onError?: (err: unknown) => void,
): void {
  void (async () => {
    try {
      await recorder.record(rec);
    } catch (firstErr) {
      try {
        await recorder.record(rec);
      } catch (secondErr) {
        onError?.(secondErr ?? firstErr);
      }
    }
  })();
}

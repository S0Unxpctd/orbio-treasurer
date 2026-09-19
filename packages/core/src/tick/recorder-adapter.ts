/**
 * `RouterToLedgerCallRecorder` — the adapter `packages/core/src/index.ts`'s "merge note" points
 * at (S-06, docs/PRD-1.0-sprint.md §4 T-6; tasks/S-06.md "In scope": "Recorder: replace the
 * JSONL/in-memory recorder with S-02's `LedgerCallRecorder` when a ledger is configured"). The
 * router's `CallRecord` (`router/recorder.ts`, S-01) and the ledger's (`ledger/recorder-types.ts`,
 * S-02) were built in parallel with different shapes; this file is the one place that converts
 * between them, so the gateway route handler keeps calling the router's `CallRecorder` interface
 * unchanged while the record actually lands in `usage_events` through `LedgerCallRecorder`.
 *
 * Two shape gaps this adapter closes, both one-way (router → ledger, never the reverse — nothing
 * reads a ledger row back into a router `CallRecord`):
 *
 *  - **Nullability.** The router's `promptTokens`/`completionTokens`/`costUsd`/`baselineCostUsd`
 *    are `| null` (no usage was ever returned — `no_usage`/`upstream_error`/`treasury_empty`
 *    statuses); the ledger's `CallRecord` declares them non-nullable. `null` becomes `0` /
 *    `"0.000000"` — the row's own `status` field already flags "no real usage happened here", so
 *    a reader is never misled into treating a zero-cost error row as a free call.
 *  - **`agentId`/`callerKeyId`.** The router's `agentId` is `null` whenever the caller key has no
 *    ledger-backed agent association (S-01's env-only `EnvCallerKeyStore` always returns `null`
 *    here); the ledger's `agentId` is required. `null` falls back to `fallbackAgentId` — the
 *    reference Treasurer agent the tick itself meters (every call through this gateway belongs
 *    to *some* agent's ledger, even when the caller key isn't individually tracked). Separately,
 *    the router's `keyId` is *always* a string (used for logging/redaction, `route.ts`), but only
 *    sometimes a real `caller_keys.id` — `router/keys.ts`'s env-backed store hands out a synthetic
 *    `key_<16 hex>` display id for a key with no ledger row at all. `usage_events.caller_key_id`
 *    is a real Postgres foreign key (`references caller_keys(id)`); forwarding that synthetic id
 *    would be a constraint violation, not a harmless no-op. `isLedgerRowId()` below is the one
 *    gate: only a real UUID (`ledger/util.ts`'s `newId()` on both dialects) is ever forwarded as
 *    `callerKeyId` — anything else (including the synthetic env id) becomes `null`.
 */
import { formatDecimal, parseDecimal } from '../ledger/decimal.js';
import type {
  CallRecord as LedgerCallRecord,
  CallRecorder as LedgerCallRecorderContract,
} from '../ledger/recorder-types.js';
import type {
  CallRecord as RouterCallRecord,
  CallRecorder as RouterCallRecorder,
  CallStatus as RouterCallStatus,
} from '../router/recorder.js';

const ZERO_MONEY = formatDecimal(parseDecimal('0'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** See this file's header — only a real ledger row id (a UUID) is ever forwarded as
 *  `callerKeyId`; the env-backed store's synthetic `key_<16 hex>` display id is not. */
export function isLedgerRowId(keyId: string): boolean {
  return UUID_RE.test(keyId);
}

/** `router/recorder.ts`'s `CallStatus` has one member (`auth_error`) the ledger's status union
 *  doesn't: it's never actually reached (`route.ts` 401s before ever calling the recorder for an
 *  unauthenticated request), but this map is total anyway — an adapter bug elsewhere must degrade
 *  to a mislabeled status, never a runtime throw mid-request. */
const STATUS_MAP: Record<RouterCallStatus, LedgerCallRecord['status']> = {
  ok: 'ok',
  no_usage: 'no_usage',
  treasury_empty: 'treasury_empty',
  upstream_error: 'upstream_error',
  auth_error: 'upstream_error',
};

/** `number | null` (USD, router-side) → a `Money` decimal string, never a float in the ledger
 *  (ADR-002) — `null` becomes `"0.000000"`, per this file's header. */
function toMoney(value: number | null): string {
  if (value === null) return ZERO_MONEY;
  return formatDecimal(parseDecimal(value.toFixed(6)));
}

/**
 * Pure conversion — exported directly so `recorder-adapter.test.ts` can assert on the mapping
 * without a fake `LedgerCallRecorderContract` in the loop.
 */
export function toLedgerCallRecord(
  record: RouterCallRecord,
  fallbackAgentId: string,
): LedgerCallRecord {
  return {
    at: record.ts,
    agentId: record.agentId ?? fallbackAgentId,
    callerKeyId: isLedgerRowId(record.keyId) ? record.keyId : null,
    requestedModel: record.requestedModel,
    model: record.routedModel,
    tier: record.tier,
    reason: record.reason,
    promptTokens: record.promptTokens ?? 0,
    completionTokens: record.completionTokens ?? 0,
    costUsd: toMoney(record.costUsd),
    baselineCostUsd: toMoney(record.baselineCostUsd),
    latencyMs: record.latencyMs,
    status: STATUS_MAP[record.status],
  };
}

/**
 * Implements the router's `CallRecorder` (so `apps/web/app/v1/_gateway.ts`'s call sites need no
 * change) by converting and forwarding every record to a ledger-backed `CallRecorder` — in
 * practice `LedgerCallRecorder` (`ledger/recorder.ts`), but this class depends only on the
 * `LedgerCallRecorderContract` interface, so a test can fake it without a real store.
 */
export class RouterToLedgerCallRecorder implements RouterCallRecorder {
  constructor(
    private readonly ledgerRecorder: LedgerCallRecorderContract,
    /** The reference Treasurer agent's ledger id — used only when `record.agentId` is `null`
     *  (see this file's header). */
    private readonly fallbackAgentId: string,
  ) {}

  async record(record: RouterCallRecord): Promise<void> {
    await this.ledgerRecorder.record(toLedgerCallRecord(record, this.fallbackAgentId));
  }
}

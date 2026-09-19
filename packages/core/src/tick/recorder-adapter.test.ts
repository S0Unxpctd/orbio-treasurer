/**
 * `recorder-adapter.ts` — S-06, tasks/S-06.md "Tests required": `tick/recorder-adapter.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CallRecord as LedgerCallRecord } from '../ledger/recorder-types.js';
import type { CallRecord as RouterCallRecord } from '../router/recorder.js';
import {
  isLedgerRowId,
  RouterToLedgerCallRecorder,
  toLedgerCallRecord,
} from './recorder-adapter.js';

const FALLBACK_AGENT_ID = 'fallback-agent-id';
const REAL_UUID = '4b7c1a2e-9b0e-4c9a-8f4e-1234567890ab';
const ENV_KEY_DISPLAY_ID = 'key_0123456789abcdef';

function baseRecord(overrides: Partial<RouterCallRecord> = {}): RouterCallRecord {
  return {
    ts: '2026-09-19T12:00:00.000Z',
    keyId: ENV_KEY_DISPLAY_ID,
    agentId: null,
    requestedModel: 'auto',
    routedModel: 'gpt-cheap',
    tier: 'S',
    reason: 'rule:default',
    stream: false,
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.0012,
    baselineModel: 'gpt-expensive',
    baselineCostUsd: 0.01,
    latencyMs: 42,
    status: 'ok',
    ...overrides,
  };
}

describe('isLedgerRowId', () => {
  it("accepts a real UUID (both stores' newId() shape)", () => {
    expect(isLedgerRowId(REAL_UUID)).toBe(true);
    expect(isLedgerRowId(REAL_UUID.toUpperCase())).toBe(true);
  });

  it("rejects the env store's synthetic key_<16 hex> display id", () => {
    expect(isLedgerRowId(ENV_KEY_DISPLAY_ID)).toBe(false);
  });

  it('rejects an arbitrary string', () => {
    expect(isLedgerRowId('not-a-uuid')).toBe(false);
    expect(isLedgerRowId('')).toBe(false);
  });
});

describe('toLedgerCallRecord', () => {
  it('maps every field 1:1 when the router record is fully populated with a real ledger key id', () => {
    const result = toLedgerCallRecord(baseRecord({ keyId: REAL_UUID }), FALLBACK_AGENT_ID);
    expect(result).toEqual<LedgerCallRecord>({
      at: '2026-09-19T12:00:00.000Z',
      agentId: FALLBACK_AGENT_ID, // record.agentId was null -> falls back
      callerKeyId: REAL_UUID,
      requestedModel: 'auto',
      model: 'gpt-cheap',
      tier: 'S',
      reason: 'rule:default',
      promptTokens: 10,
      completionTokens: 5,
      costUsd: '0.001200',
      baselineCostUsd: '0.010000',
      latencyMs: 42,
      status: 'ok',
    });
  });

  it('prefers record.agentId over the fallback when the caller key IS agent-associated', () => {
    const result = toLedgerCallRecord(baseRecord({ agentId: 'real-agent' }), FALLBACK_AGENT_ID);
    expect(result.agentId).toBe('real-agent');
  });

  it("never forwards the env store's synthetic keyId as callerKeyId (FK safety)", () => {
    const result = toLedgerCallRecord(baseRecord({ keyId: ENV_KEY_DISPLAY_ID }), FALLBACK_AGENT_ID);
    expect(result.callerKeyId).toBeNull();
  });

  it('maps null promptTokens/completionTokens to 0, never null (ledger type is non-nullable)', () => {
    const result = toLedgerCallRecord(
      baseRecord({ promptTokens: null, completionTokens: null, status: 'no_usage' }),
      FALLBACK_AGENT_ID,
    );
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('maps null costUsd/baselineCostUsd to "0.000000", never a float or null', () => {
    const result = toLedgerCallRecord(
      baseRecord({ costUsd: null, baselineCostUsd: null, status: 'treasury_empty' }),
      FALLBACK_AGENT_ID,
    );
    expect(result.costUsd).toBe('0.000000');
    expect(result.baselineCostUsd).toBe('0.000000');
  });

  it('formats a real cost as a fixed 6dp decimal string, never scientific notation or drift', () => {
    const result = toLedgerCallRecord(
      baseRecord({ costUsd: 0.1, baselineCostUsd: 3 }),
      FALLBACK_AGENT_ID,
    );
    expect(result.costUsd).toBe('0.100000');
    expect(result.baselineCostUsd).toBe('3.000000');
  });

  it.each([
    ['ok', 'ok'],
    ['no_usage', 'no_usage'],
    ['treasury_empty', 'treasury_empty'],
    ['upstream_error', 'upstream_error'],
    // auth_error never actually reaches the recorder in practice (route.ts 401s first) but the
    // map must still be total, never throw.
    ['auth_error', 'upstream_error'],
  ] as const)('status %s maps to ledger status %s', (routerStatus, ledgerStatus) => {
    const result = toLedgerCallRecord(baseRecord({ status: routerStatus }), FALLBACK_AGENT_ID);
    expect(result.status).toBe(ledgerStatus);
  });

  it("passes tier and requestedModel/routedModel through unchanged (name differs, value doesn't)", () => {
    const result = toLedgerCallRecord(
      baseRecord({ tier: 'L', requestedModel: 'auto:L', routedModel: 'big-model' }),
      FALLBACK_AGENT_ID,
    );
    expect(result.tier).toBe('L');
    expect(result.requestedModel).toBe('auto:L');
    expect(result.model).toBe('big-model');
  });
});

describe('RouterToLedgerCallRecorder', () => {
  it('forwards the converted record to the wrapped ledger recorder', async () => {
    const received: LedgerCallRecord[] = [];
    const fakeLedgerRecorder = { record: async (r: LedgerCallRecord) => void received.push(r) };
    const recorder = new RouterToLedgerCallRecorder(fakeLedgerRecorder, FALLBACK_AGENT_ID);

    await recorder.record(baseRecord({ keyId: REAL_UUID, agentId: null }));

    expect(received).toHaveLength(1);
    expect(received[0]?.agentId).toBe(FALLBACK_AGENT_ID);
    expect(received[0]?.callerKeyId).toBe(REAL_UUID);
  });

  it("propagates a rejection from the wrapped recorder rather than swallowing it (fire-and-forget/retry is the caller's job, per router/recorder.ts's recordFireAndForget)", async () => {
    const failingRecorder = {
      record: async () => {
        throw new Error('ledger write failed');
      },
    };
    const recorder = new RouterToLedgerCallRecorder(failingRecorder, FALLBACK_AGENT_ID);
    await expect(recorder.record(baseRecord())).rejects.toThrow('ledger write failed');
  });
});

/**
 * Shared LedgerStore conformance suite (T-011, FR-1.0: "same schema, same append-only
 * guarantees, same tests run against both [stores]").
 *
 * This is not itself a `*.test.ts` file — vitest won't collect it directly. It's imported and
 * invoked by `ledger-conformance.test.ts` once per dialect, so the exact same assertions run
 * against `SqliteLedgerStore` and `PostgresLedgerStore`. A behaviour that diverges between the
 * two — a dialect-specific quirk leaking above the LedgerStore interface (T-011 Audit focus) —
 * fails here for whichever store gets it wrong, not silently.
 *
 * Scope: this tests the LedgerStore abstraction (insert/read/the two guarded updates). The
 * SQL-level append-only trigger guarantees (raw UPDATE/DELETE on the four append-only tables
 * are rejected) are T-002's job and already covered by schema.sqlite.test.ts /
 * schema.postgres.test.ts — not duplicated here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerStore } from './types.js';
import { NotFoundError } from './types.js';

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Registers a `describe("ledger conformance — <label>", ...)` block exercising `openStore()`
 * (called once, in `beforeAll`) against the full LedgerStore surface. Callers are responsible
 * for any dialect-specific setup `openStore` needs (e.g. Postgres: migrations already applied)
 * and for wrapping the call in `describe.skip` upstream when a dialect can't run in this
 * environment (see ledger-conformance.test.ts's Postgres branch).
 */
export function defineLedgerConformanceSuite(
  label: string,
  openStore: () => LedgerStore | Promise<LedgerStore>,
): void {
  describe(`ledger conformance — ${label}`, () => {
    let store: LedgerStore;

    beforeAll(async () => {
      store = await openStore();
    });

    afterAll(async () => {
      await store.close();
    });

    async function seedAgent(overrides: Partial<Parameters<LedgerStore['insertAgent']>[0]> = {}) {
      return store.insertAgent({
        slug: uniqueSlug('agent'),
        name: 'Conformance Agent',
        mode: 'dry_run',
        ...overrides,
      });
    }

    async function seedDecision(agentId: string) {
      return store.insertDecision({
        agentId,
        at: new Date().toISOString(),
        type: 'ROUTE',
      });
    }

    it('agents: insertAgent -> getAgent / getAgentBySlug round-trip; UTC timestamps; defaults applied', async () => {
      const slug = uniqueSlug('roundtrip');
      const inserted = await store.insertAgent({ slug, name: 'RT Agent', mode: 'dry_run' });

      expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(inserted.chain).toBe('robinhood'); // schema.ts default
      expect(inserted.public).toBe(true); // schema.ts default
      expect(inserted.createdAt).toMatch(/Z$/);

      const byId = await store.getAgent(inserted.id);
      const bySlug = await store.getAgentBySlug(slug);
      expect(byId).toEqual(inserted);
      expect(bySlug).toEqual(inserted);
    });

    it('agents: getAgent / getAgentBySlug return null, not throw, for an unknown lookup', async () => {
      expect(await store.getAgent(randomUUID())).toBeNull();
      expect(await store.getAgentBySlug(uniqueSlug('does-not-exist'))).toBeNull();
    });

    it('agents: updateAgent changes only the supplied mutable fields (FR-1.1)', async () => {
      const agent = await seedAgent({ name: 'Before', repoUrl: 'https://example.com/before' });
      const updated = await store.updateAgent(agent.id, { name: 'After' });
      expect(updated.name).toBe('After');
      expect(updated.repoUrl).toBe('https://example.com/before'); // untouched
      expect(updated.slug).toBe(agent.slug); // immutable field, unchanged
    });

    it('agents: updateAgent rejects an empty patch', async () => {
      const agent = await seedAgent();
      await expect(store.updateAgent(agent.id, {})).rejects.toThrow();
    });

    it('agents: updateAgent on an unknown id throws NotFoundError', async () => {
      await expect(store.updateAgent(randomUUID(), { name: 'nobody' })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('key_meta: insertKeyMeta round-trips; revocation is a new row, not an update (FR-1.1)', async () => {
      const agent = await seedAgent();
      const created = await store.insertKeyMeta({
        agentId: agent.id,
        keyPrefix: 'sk-or',
        keyLast4: '1234',
      });
      expect(created.revokedAt).toBeNull();

      const revoked = await store.insertKeyMeta({
        agentId: agent.id,
        keyPrefix: 'sk-or',
        keyLast4: '1234',
        revokedAt: new Date().toISOString(),
        reason: 'rotated',
      });
      expect(revoked.id).not.toBe(created.id);
      expect(revoked.revokedAt).toMatch(/Z$/);
    });

    it('treasury_snapshots: foreign key is enforced — an unknown agent_id is rejected', async () => {
      await expect(
        store.insertTreasurySnapshot({
          agentId: randomUUID(),
          asOf: new Date().toISOString(),
          state: 'COMFORTABLE',
          balanceSource: 'mcp',
        }),
      ).rejects.toThrow();
    });

    it('treasury_snapshots: insert -> latestTreasurySnapshot round-trip; money fields byte-identical at 6dp (AC3)', async () => {
      const agent = await seedAgent();
      const asOf = new Date().toISOString();
      const inserted = await store.insertTreasurySnapshot({
        agentId: agent.id,
        asOf,
        creditsAvailable: '123456789012.100200', // 18 significant digits, scale 6 — fits numeric(18,6) exactly
        creditsAccruedDelta: '0.500000',
        keySpentTotal: '10',
        keyRemaining: '5.1',
        orbioBalanceTokens: '123456789012345678901234567890', // 30-digit token amount
        orbioPriceUsd: '0.000123',
        accrualRatePerDay: '1.234567',
        burnRatePerDay: '2.000000',
        burnLowConfidence: true,
        runwayDays: null, // infinite runway
        coverageRatio: '0.916667',
        state: 'TIGHT',
        reconciliationDelta: '-0.010000',
        balanceSource: 'gateway',
        stableBalanceUsd: '3.000000',
        yieldPerTokenPerDay: '0.000001',
        yieldLowConfidence: false,
      });

      expect(inserted.asOf).toBe(asOf);
      expect(inserted.creditsAvailable).toBe('123456789012.100200');
      expect(inserted.creditsAccruedDelta).toBe('0.500000');
      expect(inserted.keySpentTotal).toBe('10.000000');
      expect(inserted.keyRemaining).toBe('5.100000');
      expect(inserted.orbioBalanceTokens).toBe('123456789012345678901234567890');
      expect(inserted.runwayDays).toBeNull();
      expect(inserted.reconciliationDelta).toBe('-0.010000');
      expect(inserted.burnLowConfidence).toBe(true);
      expect(inserted.yieldLowConfidence).toBe(false);
      expect(inserted.balanceSource).toBe('gateway');

      const latest = await store.latestTreasurySnapshot(agent.id);
      expect(latest).toEqual(inserted);
    });

    it('treasury_snapshots: latestTreasurySnapshot picks the most recent as_of', async () => {
      const agent = await seedAgent();
      const older = await store.insertTreasurySnapshot({
        agentId: agent.id,
        asOf: '2026-01-01T00:00:00.000Z',
        state: 'COMFORTABLE',
        balanceSource: 'mcp',
      });
      const newer = await store.insertTreasurySnapshot({
        agentId: agent.id,
        asOf: '2026-01-01T01:00:00.000Z',
        state: 'COMFORTABLE',
        balanceSource: 'mcp',
      });
      const latest = await store.latestTreasurySnapshot(agent.id);
      expect(latest?.id).toBe(newer.id);
      expect(latest?.id).not.toBe(older.id);
    });

    it('treasury_snapshots: latestTreasurySnapshot returns null for an agent with no snapshots', async () => {
      const agent = await seedAgent();
      expect(await store.latestTreasurySnapshot(agent.id)).toBeNull();
    });

    it('usage_events: insert stores an exact decimal cost, never float-rounded', async () => {
      const agent = await seedAgent();
      const inserted = await store.insertUsageEvent({
        agentId: agent.id,
        at: new Date().toISOString(),
        model: 'openrouter/economy-model',
        costUsd: '0.030102', // a value lossy if it ever touched a JS float sum
        promptTokens: 100,
        completionTokens: 20,
        status: 'ok',
      });
      expect(inserted.costUsd).toBe('0.030102');
      expect(inserted.status).toBe('ok');
    });

    it('decisions: insert round-trips inputs/action/result and the executed/public flags', async () => {
      const agent = await seedAgent();
      const inserted = await store.insertDecision({
        agentId: agent.id,
        at: new Date().toISOString(),
        type: 'ROUTE',
        ruleId: 'R-ROUTE-TIGHT',
        stateBefore: 'COMFORTABLE',
        stateAfter: 'TIGHT',
        inputs: { runwayDays: '2.500000', tier: 'standard' },
        action: { route: 'standard' },
        executed: true,
        result: { ok: true },
        human: 'Routing to standard: runway is tight.',
        public: true,
      });
      expect(inserted.inputs).toEqual({ runwayDays: '2.500000', tier: 'standard' });
      expect(inserted.action).toEqual({ route: 'standard' });
      expect(inserted.result).toEqual({ ok: true });
      expect(inserted.executed).toBe(true);
      expect(inserted.public).toBe(true);
    });

    it('decisions: executed and public default correctly when omitted (false / true)', async () => {
      const agent = await seedAgent();
      const inserted = await store.insertDecision({
        agentId: agent.id,
        at: new Date().toISOString(),
        type: 'ALERT_TICK_MISSED',
      });
      expect(inserted.executed).toBe(false);
      expect(inserted.public).toBe(true);
    });

    it('book_snapshots: insert round-trips (no agent_id — global book state)', async () => {
      const inserted = await store.insertBookSnapshot({
        at: new Date().toISOString(),
        source: 'api',
        view: { models: [{ model: 'x', discountPct: '10.000000' }] },
        totalAvailableUsd: '500.000000',
        bestDiscountPct: '10.000000',
      });
      expect(inserted.source).toBe('api');
      expect(inserted.view).toEqual({ models: [{ model: 'x', discountPct: '10.000000' }] });
      expect(inserted.totalAvailableUsd).toBe('500.000000');
    });

    it('orders: insertOrder -> updateOrderFill round-trip; only the fill fields change (FR-1.1)', async () => {
      const agent = await seedAgent();
      const decision = await seedDecision(agent.id);
      const placedAt = new Date().toISOString();
      const order = await store.insertOrder({
        agentId: agent.id,
        decisionId: decision.id,
        side: 'buy',
        usd: '10',
        status: 'pending',
        placedAt,
      });
      expect(order.status).toBe('pending');
      expect(order.usd).toBe('10.000000');

      const resolvedAt = new Date().toISOString();
      const filled = await store.updateOrderFill(order.id, {
        status: 'filled',
        filledUsd: '10.000000',
        feeUsd: '0.100000',
        externalId: 'tx-123',
        resolvedAt,
      });

      expect(filled.status).toBe('filled');
      expect(filled.filledUsd).toBe('10.000000');
      expect(filled.feeUsd).toBe('0.100000');
      expect(filled.externalId).toBe('tx-123');
      expect(filled.resolvedAt).toBe(resolvedAt);
      // Immutable fields are untouched by the fill update.
      expect(filled.usd).toBe(order.usd);
      expect(filled.side).toBe(order.side);
      expect(filled.agentId).toBe(order.agentId);
      expect(filled.decisionId).toBe(order.decisionId);
      expect(filled.placedAt).toBe(order.placedAt);
    });

    it('orders: getOrder returns null for an unknown id', async () => {
      expect(await store.getOrder(randomUUID())).toBeNull();
    });

    it('orders: updateOrderFill rejects an empty patch', async () => {
      const agent = await seedAgent();
      const decision = await seedDecision(agent.id);
      const order = await store.insertOrder({
        agentId: agent.id,
        decisionId: decision.id,
        side: 'stake',
        usd: '5',
        status: 'pending',
        placedAt: new Date().toISOString(),
      });
      await expect(store.updateOrderFill(order.id, {})).rejects.toThrow();
    });

    it('orders: updateOrderFill on an unknown id throws NotFoundError', async () => {
      await expect(store.updateOrderFill(randomUUID(), { status: 'filled' })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('rejects a non-UTC business timestamp at the boundary (audit focus: UTC everywhere)', async () => {
      const agent = await seedAgent();
      await expect(
        store.insertTreasurySnapshot({
          agentId: agent.id,
          asOf: '2026-09-09 12:00:00', // no "Z" — not UTC-ISO
          state: 'COMFORTABLE',
          balanceSource: 'mcp',
        }),
      ).rejects.toThrow(/UTC ISO-8601/);
    });
  });
}

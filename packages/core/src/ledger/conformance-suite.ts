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
import { CallerKeyAlreadyRevokedError, InvalidTxHashError, NotFoundError } from './types.js';

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

    it('agents: listPublicAgents returns only public = true rows (S-08)', async () => {
      const pub = await seedAgent({ name: 'Public One', public: true });
      await seedAgent({ name: 'Private One', public: false });

      const rows = await store.listPublicAgents();
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(pub.id);
      for (const row of rows) {
        expect(row.public).toBe(true);
      }
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

    // --- S-02: usage_events new fields + listUsageEvents ---------------------------------------

    it('usage_events: insert round-trips requestedModel/routeReason/baselineCostUsd/callerKeyId (S-02)', async () => {
      const agent = await seedAgent();
      const callerKey = await store.insertCallerKey({
        keyHash: uniqueSlug('hash'),
        keyPrefix: 'otk_',
      });
      const inserted = await store.insertUsageEvent({
        agentId: agent.id,
        at: new Date().toISOString(),
        model: 'openrouter/economy-model',
        tierServed: 'S',
        costUsd: '0.030102',
        baselineCostUsd: '0.100000',
        requestedModel: 'auto',
        routeReason: 'short prompt, no tools',
        callerKeyId: callerKey.id,
        status: 'ok',
      });
      expect(inserted.requestedModel).toBe('auto');
      expect(inserted.routeReason).toBe('short prompt, no tools');
      expect(inserted.baselineCostUsd).toBe('0.100000');
      expect(inserted.callerKeyId).toBe(callerKey.id);
    });

    it('usage_events: the S-02 fields default to null when omitted', async () => {
      const agent = await seedAgent();
      const inserted = await store.insertUsageEvent({
        agentId: agent.id,
        at: new Date().toISOString(),
        model: 'openrouter/economy-model',
        status: 'ok',
      });
      expect(inserted.requestedModel).toBeNull();
      expect(inserted.routeReason).toBeNull();
      expect(inserted.baselineCostUsd).toBeNull();
      expect(inserted.callerKeyId).toBeNull();
    });

    it('usage_events: listUsageEvents returns an agent’s events, most recent first, optionally since a timestamp (S-02)', async () => {
      const agent = await seedAgent();
      const first = await store.insertUsageEvent({
        agentId: agent.id,
        at: '2026-01-01T00:00:00.000Z',
        model: 'm1',
        status: 'ok',
      });
      const second = await store.insertUsageEvent({
        agentId: agent.id,
        at: '2026-01-02T00:00:00.000Z',
        model: 'm2',
        status: 'ok',
      });
      const all = await store.listUsageEvents(agent.id);
      expect(all.map((e) => e.id)).toEqual([second.id, first.id]);

      const sinceSecond = await store.listUsageEvents(agent.id, {
        sinceAt: '2026-01-01T12:00:00.000Z',
      });
      expect(sinceSecond.map((e) => e.id)).toEqual([second.id]);
    });

    // --- S-02: caller_keys -----------------------------------------------------------------------

    it('caller_keys: insertCallerKey -> getCallerKeyByHash round-trip; agent_id may be null (S-02)', async () => {
      const keyHash = uniqueSlug('hash');
      const inserted = await store.insertCallerKey({
        keyHash,
        keyPrefix: 'otk_ab12',
        label: 'demo agent',
      });
      expect(inserted.agentId).toBeNull();
      expect(inserted.revokedAt).toBeNull();
      expect(inserted.keyHash).toBe(keyHash);

      const byHash = await store.getCallerKeyByHash(keyHash);
      expect(byHash).toEqual(inserted);
    });

    it('caller_keys: getCallerKeyByHash returns null for an unknown hash (S-02)', async () => {
      expect(await store.getCallerKeyByHash(uniqueSlug('no-such-hash'))).toBeNull();
    });

    it('caller_keys: revokeCallerKey sets revoked_at once; only that column changes (AC3, S-02)', async () => {
      const agent = await seedAgent();
      const created = await store.insertCallerKey({
        agentId: agent.id,
        keyHash: uniqueSlug('hash'),
        keyPrefix: 'otk_cd34',
      });
      const at = new Date().toISOString();
      const revoked = await store.revokeCallerKey(created.id, at);
      expect(revoked.revokedAt).toBe(at);
      expect(revoked.keyHash).toBe(created.keyHash);
      expect(revoked.keyPrefix).toBe(created.keyPrefix);
      expect(revoked.agentId).toBe(created.agentId);
    });

    it('caller_keys: revokeCallerKey throws CallerKeyAlreadyRevokedError on a second call (AC3, S-02)', async () => {
      const created = await store.insertCallerKey({
        keyHash: uniqueSlug('hash'),
        keyPrefix: 'otk_ef56',
      });
      await store.revokeCallerKey(created.id, new Date().toISOString());
      await expect(store.revokeCallerKey(created.id, new Date().toISOString())).rejects.toThrow(
        CallerKeyAlreadyRevokedError,
      );
    });

    it('caller_keys: revokeCallerKey on an unknown id throws NotFoundError (S-02)', async () => {
      await expect(store.revokeCallerKey(randomUUID(), new Date().toISOString())).rejects.toThrow(
        NotFoundError,
      );
    });

    it('caller_keys: no column ever holds the full key material (AC8, S-02)', async () => {
      const created = await store.insertCallerKey({
        keyHash: uniqueSlug('hash'),
        keyPrefix: 'otk_gh78',
      });
      for (const value of Object.values(created)) {
        if (typeof value === 'string') {
          expect(value).not.toMatch(/^otk_[A-Za-z0-9_-]{20,}$/);
        }
      }
    });

    // --- S-02: treasury_events ---------------------------------------------------------------------

    it('treasury_events: insert -> listTreasuryEvents round-trip, most recent first (S-02)', async () => {
      const agent = await seedAgent();
      const first = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-01-01T00:00:00.000Z',
        kind: 'dry_run',
      });
      const second = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: '2026-01-02T00:00:00.000Z',
        kind: 'claim',
        amount: '1000',
        token: 'CREDIT',
        usdValue: '10.000000',
        txHash: `0x${'a'.repeat(64)}`,
        meta: { periodIds: [1, 2, 3] },
      });
      expect(second.amount).toBe('1000');
      expect(second.token).toBe('CREDIT');
      expect(second.usdValue).toBe('10.000000');
      expect(second.txHash).toBe(`0x${'a'.repeat(64)}`);
      expect(second.meta).toEqual({ periodIds: [1, 2, 3] });

      const list = await store.listTreasuryEvents(agent.id, 10);
      expect(list.map((e) => e.id)).toEqual([second.id, first.id]);
    });

    it('treasury_events: listTreasuryEvents respects limit (S-02)', async () => {
      const agent = await seedAgent();
      for (let i = 0; i < 3; i += 1) {
        await store.insertTreasuryEvent({
          agentId: agent.id,
          at: new Date().toISOString(),
          kind: 'alert',
        });
      }
      const list = await store.listTreasuryEvents(agent.id, 2);
      expect(list).toHaveLength(2);
    });

    it('treasury_events: foreign key is enforced — an unknown agent_id is rejected (S-02)', async () => {
      await expect(
        store.insertTreasuryEvent({
          agentId: randomUUID(),
          at: new Date().toISOString(),
          kind: 'alert',
        }),
      ).rejects.toThrow();
    });

    it('treasury_events: tx_hash outside ^0x[0-9a-f]{64}$ is rejected at the store boundary (AC4, S-02)', async () => {
      const agent = await seedAgent();
      await expect(
        store.insertTreasuryEvent({
          agentId: agent.id,
          at: new Date().toISOString(),
          kind: 'claim',
          txHash: '0xnothex',
        }),
      ).rejects.toThrow(InvalidTxHashError);
      await expect(
        store.insertTreasuryEvent({
          agentId: agent.id,
          at: new Date().toISOString(),
          kind: 'claim',
          txHash: `0x${'A'.repeat(64)}`, // uppercase hex — not the exact allow-listed shape
        }),
      ).rejects.toThrow(InvalidTxHashError);
    });

    it('treasury_events: a well-formed tx_hash is accepted (S-02)', async () => {
      const agent = await seedAgent();
      const txHash = `0x${'f'.repeat(64)}`;
      const inserted = await store.insertTreasuryEvent({
        agentId: agent.id,
        at: new Date().toISOString(),
        kind: 'buy',
        txHash,
      });
      expect(inserted.txHash).toBe(txHash);
    });

    // --- S-02: chain_snapshots ---------------------------------------------------------------------

    it('chain_snapshots: insert -> latestChainSnapshot round-trip; token/money fields byte-identical (S-02)', async () => {
      const agent = await seedAgent();
      const inserted = await store.insertChainSnapshot({
        agentId: agent.id,
        asOf: new Date().toISOString(),
        stakedOrbio: '123456789012345678901234567890',
        settledCredit: '500',
        creditWallet: '250',
        creditApiAvailable: '12.340000',
        creditApiUsed: '1.100000',
        quoteCreditPerUsdg: '2.222000',
        ethBalance: '5000000000000000',
        usdgBalance: '10000000',
        mode: 'dry_run',
        rpcUrlHost: 'robinhood-rpc.publicnode.com',
      });
      expect(inserted.stakedOrbio).toBe('123456789012345678901234567890');
      expect(inserted.creditApiAvailable).toBe('12.340000');
      expect(inserted.mode).toBe('dry_run');

      const latest = await store.latestChainSnapshot(agent.id);
      expect(latest).toEqual(inserted);
    });

    it('chain_snapshots: latestChainSnapshot picks the most recent as_of (S-02)', async () => {
      const agent = await seedAgent();
      const older = await store.insertChainSnapshot({
        agentId: agent.id,
        asOf: '2026-01-01T00:00:00.000Z',
      });
      const newer = await store.insertChainSnapshot({
        agentId: agent.id,
        asOf: '2026-01-01T01:00:00.000Z',
      });
      const latest = await store.latestChainSnapshot(agent.id);
      expect(latest?.id).toBe(newer.id);
      expect(latest?.id).not.toBe(older.id);
    });

    it('chain_snapshots: latestChainSnapshot returns null for an agent with no snapshots (S-02)', async () => {
      const agent = await seedAgent();
      expect(await store.latestChainSnapshot(agent.id)).toBeNull();
    });

    it('chain_snapshots: foreign key is enforced — an unknown agent_id is rejected (S-02)', async () => {
      await expect(
        store.insertChainSnapshot({ agentId: randomUUID(), asOf: new Date().toISOString() }),
      ).rejects.toThrow();
    });
  });
}

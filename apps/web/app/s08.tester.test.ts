/**
 * Tester pass for S-08 (tasks/S-08.md) — written from the ticket's Goal / In scope / Acceptance
 * criteria / Tests required sections ALONE, before reading `page.tsx`, `model.ts` or the route
 * handlers' bodies (PROCESS.md §3). Only the necessary wiring names (`loadRenderModelInput`,
 * `getLedgerStore`/`resetLedgerStoreForTesting`, the route handlers' `GET`/`POST` exports, and
 * `renderModel`'s already-documented `RenderModelInput`/`RenderModel` shapes) were looked up
 * afterwards to call the code, exactly as the tester brief allows.
 *
 * Every ledger row is written through the public `LedgerStore` API from `@orbio-treasurer/core`
 * (`openSqliteLedger`, `LEDGER=sqlite`, a fresh temp file per test) — never a raw SQL insert —
 * per the tester brief.
 *
 * AC5 ("footer sentence present verbatim in the HTML") and AC7's HTML-outside-href claim are only
 * fully checkable against real server-rendered HTML; that half of the evidence is the `next dev`
 * + `pnpm smoke` run described in the ticket's Test report, not this file. What IS checked here
 * for AC7 is the render-model's OWN separation of "full value" vs. "display value" — the page
 * has no other source of a full 0x string than what `renderModel()` hands it, so if the model
 * never puts a full hash/address in a *Display field, the page can't leak one outside an href
 * either (see `describe('S-08 AC7 ...')` below).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AgentRow, type LedgerStore, openSqliteLedger, savings } from '@orbio-treasurer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadRenderModelInput } from './_data.js';
import { resetLedgerStoreForTesting } from './_ledger.js';
import { GET as getAgents, POST as postAgents } from './api/agents/route.js';
import { GET as getStats } from './api/stats/route.js';
import {
  FOOTER_SENTENCE,
  NO_AGENTS_NOTE,
  NO_DATA_NOTE,
  NO_PROOF_NOTE,
  renderModel,
} from './model.js';

// --- env plumbing ----------------------------------------------------------------------------

const ENV_KEYS = [
  'LEDGER',
  'LEDGER_SQLITE_PATH',
  'REFERENCE_AGENT_SLUG',
  'GATEWAY_KEYS',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let tmpDir: string;

function freshDbPath(): string {
  return join(tmpDir, `s08-${randomBytes(4).toString('hex')}.db`);
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmpDir = mkdtempSync(join(tmpdir(), 's08-tester-'));
  process.env.LEDGER = 'sqlite';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DATABASE_URL;
  resetLedgerStoreForTesting();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetLedgerStoreForTesting();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Distinct from anything a builder/auditor test might use — PROCESS.md §3: tester independence.
const TESTER_CALLER_KEY = `otk_${'d'.repeat(32)}`;
const TX_HASH_1 = `0x${'a'.repeat(64)}`;
const TX_HASH_2 = `0x${'b'.repeat(64)}`;

const NOW = '2026-09-19T12:00:00.000Z';

function minutesAgo(n: number): string {
  return new Date(new Date(NOW).getTime() - n * 60_000).toISOString();
}

/**
 * Seeds a fresh SQLite ledger via the public `LedgerStore` API only, per the AC2 fixture:
 * 10 usage events (S/M/L mix), 1 chain snapshot, 3 treasury events (incl. 1 dry_run), 2 agents
 * (one private). Costs alternate 0.10 / 0.20 on purpose (AC "money formatting" line: "seed a
 * cost of 0.1+0.2 style values") — classic float-drift bait (0.1 + 0.2 !== 0.3 in IEEE-754) that
 * exact decimal-string arithmetic must still total to exactly 1.50.
 */
async function seedAc2Ledger(dbPath: string): Promise<{
  readonly store: LedgerStore;
  readonly agent: AgentRow;
  readonly privateAgent: AgentRow;
}> {
  const store = openSqliteLedger(dbPath);

  const agent = await store.insertAgent({
    slug: 'treasurer',
    name: 'Orbio Treasurer',
    mode: 'dry_run',
    public: true,
  });
  const privateAgent = await store.insertAgent({
    slug: 'ghost-agent',
    name: 'Ghost Agent',
    mode: 'dry_run',
    public: false,
  });

  const tiers: readonly ('S' | 'M' | 'L')[] = ['S', 'S', 'S', 'S', 'M', 'M', 'M', 'L', 'L', 'L'];
  for (let i = 0; i < tiers.length; i += 1) {
    const tier: 'S' | 'M' | 'L' = tiers[i] ?? 'S';
    const cost = i % 2 === 0 ? '0.100000' : '0.200000';
    const baseline = i % 2 === 0 ? '0.300000' : '0.600000';
    await store.insertUsageEvent({
      agentId: agent.id,
      at: minutesAgo(tiers.length - i),
      model: 'orbio/test-model',
      tierRequested: tier,
      tierServed: tier,
      promptTokens: 10,
      completionTokens: 20,
      costUsd: cost,
      baselineCostUsd: baseline,
      latencyMs: 100,
      status: 'ok',
    });
  }

  await store.insertChainSnapshot({
    agentId: agent.id,
    asOf: minutesAgo(2),
    stakedOrbio: '1234500000000000000000', // 1234.5 ORBIO, 18dp
    settledCredit: '500250000', // 500.25 CREDIT, 6dp
    creditWallet: '250000000', // 250.00 CREDIT, 6dp
    creditApiAvailable: '123.450000',
    creditApiUsed: '10.000000',
    quoteCreditPerUsdg: '1.100000',
    ethBalance: '2500000000000000000', // 2.5 ETH, 18dp
    usdgBalance: '75000000', // 75.00 USDG, 6dp
    mode: 'dry_run',
  });

  await store.insertTreasuryEvent({
    agentId: agent.id,
    at: minutesAgo(30),
    kind: 'buy',
    amount: '1000000000000000000000',
    token: 'ORBIO',
    usdValue: '50.000000',
    txHash: TX_HASH_1,
  });
  await store.insertTreasuryEvent({
    agentId: agent.id,
    at: minutesAgo(20),
    kind: 'stake',
    amount: '1000000000000000000000',
    token: 'ORBIO',
    usdValue: '50.000000',
    txHash: TX_HASH_2,
  });
  await store.insertTreasuryEvent({
    agentId: agent.id,
    at: minutesAgo(10),
    kind: 'dry_run',
    meta: { reason: 'TREASURER_LIVE not set' },
  });

  return { store, agent, privateAgent };
}

// ================================================================================================
// AC1 — fresh SQLite ledger, no agent row → zeros + "no data yet", never a crash.
// ================================================================================================

describe('S-08 AC1 — empty ledger, no reference agent', () => {
  it('renderModel() reports hasAgent=false, the no-data note, and zeros everywhere', async () => {
    const dbPath = freshDbPath();
    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';

    const env = { LEDGER: 'sqlite', LEDGER_SQLITE_PATH: dbPath, REFERENCE_AGENT_SLUG: 'treasurer' };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);

    expect(model.hasAgent).toBe(false);
    expect(model.agent).toBeNull();
    expect(model.noDataNote).toBe(NO_DATA_NOTE);
    expect(model.savings.h24.calls).toBe(0);
    expect(model.savings.h24.costUsd).toBe('0.000000');
    expect(model.savings.all.calls).toBe(0);
    expect(model.treasury).toBeNull();
    expect(model.events).toEqual([]);
    expect(model.noProofNote).toBe(NO_PROOF_NOTE);
    expect(model.agents).toEqual([]);
    expect(model.noAgentsNote).toBe(NO_AGENTS_NOTE);
    expect(model.footer).toBe(FOOTER_SENTENCE);
  });

  it('GET /api/stats returns 200 with zeros (no crash) against the empty ledger', async () => {
    process.env.LEDGER_SQLITE_PATH = freshDbPath();
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';

    const res = await getStats();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent).toBeNull();
    expect(body.savings.h24.calls).toBe(0);
    expect(body.savings.all.calls).toBe(0);
    expect(body.treasury).toBeNull();
    expect(body.events).toEqual([]);
  });

  it('GET /api/agents returns 200 with an empty public agents list against the empty ledger', async () => {
    process.env.LEDGER_SQLITE_PATH = freshDbPath();
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';

    const res = await getAgents();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([]);
  });
});

// ================================================================================================
// AC2 — seeded ledger: savings == core's savings(), exact proof-row / agent counts, formatting.
// ================================================================================================

describe('S-08 AC2 — seeded ledger', () => {
  it("savings numbers equal S-02's savings() output, for both 24h and all-time", async () => {
    const dbPath = freshDbPath();
    const { store, agent } = await seedAc2Ledger(dbPath);

    const expected24h = await savings(store, agent.id, '24h', NOW);
    const expectedAll = await savings(store, agent.id, 'all', NOW);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    const env = { LEDGER: 'sqlite', LEDGER_SQLITE_PATH: dbPath, REFERENCE_AGENT_SLUG: 'treasurer' };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);

    expect(model.savings.h24.calls).toBe(expected24h.calls);
    expect(model.savings.h24.costUsd).toBe(expected24h.costUsd);
    expect(model.savings.h24.baselineUsd).toBe(expected24h.baselineUsd);
    expect(model.savings.h24.savedUsd).toBe(expected24h.savedUsd);
    expect(model.savings.h24.savedPct).toBe(expected24h.savedPct);

    expect(model.savings.all.calls).toBe(expectedAll.calls);
    expect(model.savings.all.costUsd).toBe(expectedAll.costUsd);
    expect(model.savings.all.baselineUsd).toBe(expectedAll.baselineUsd);
    expect(model.savings.all.savedUsd).toBe(expectedAll.savedUsd);
    expect(model.savings.all.savedPct).toBe(expectedAll.savedPct);

    // Sanity on the fixture itself: 10 calls, S/M/L = 4/3/3, total cost exactly 1.50 (no drift).
    expect(expectedAll.calls).toBe(10);
    expect(expectedAll.costUsd).toBe('1.500000');
    expect(expectedAll.byTier.S.calls).toBe(4);
    expect(expectedAll.byTier.M.calls).toBe(3);
    expect(expectedAll.byTier.L.calls).toBe(3);

    for (const line of model.savings.byTier) {
      const t = expectedAll.byTier[line.tier];
      expect(line.calls).toBe(t.calls);
      expect(line.costUsd).toBe(t.costUsd);
    }
  });

  it('treasury numbers are formatted 2dp with thousands separators (18dp ORBIO, 6dp CREDIT/USDG)', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    const env = { LEDGER: 'sqlite', LEDGER_SQLITE_PATH: dbPath, REFERENCE_AGENT_SLUG: 'treasurer' };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);

    expect(model.treasury).not.toBeNull();
    // 1234500000000000000000 raw / 1e18 = 1234.5 ORBIO -> "1,234.50" (thousands separator + 2dp).
    expect(model.treasury?.stakedOrbioDisplay).toBe('1,234.50');
    // 500250000 raw / 1e6 = 500.25 CREDIT.
    expect(model.treasury?.creditClaimableDisplay).toBe('500.25');
    // 250000000 raw / 1e6 = 250.00 CREDIT.
    expect(model.treasury?.creditWalletDisplay).toBe('250.00');
    expect(model.treasury?.apiAvailableDisplay).toBe('$123.45');
    expect(model.treasury?.apiUsedDisplay).toBe('$10.00');
    expect(model.treasury?.usdgDisplay).toBe('75.00');
    expect(model.treasury?.mode).toBe('dry_run');
    // Quote: quoteCreditPerUsdg=1.1 -> 10 USDG buys 11 CREDIT; discount = (11-10)/11 = 9.09...%.
    expect(model.treasury?.quote).not.toBeNull();
    expect(model.treasury?.quote?.usdgIn).toBe('10.00');
    expect(model.treasury?.quote?.creditOut).toBe('11.00');
  });

  it('exactly 2 proof rows carry an explorer link and exactly 1 is a greyed dry-run row', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    const env = { LEDGER: 'sqlite', LEDGER_SQLITE_PATH: dbPath, REFERENCE_AGENT_SLUG: 'treasurer' };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);

    expect(model.events).toHaveLength(3);
    const withLinks = model.events.filter((e) => e.explorerUrl !== null);
    const dryRuns = model.events.filter((e) => e.dryRun);
    expect(withLinks).toHaveLength(2);
    expect(dryRuns).toHaveLength(1);
    expect(
      withLinks.every((e) => e.explorerUrl?.startsWith('https://robin.etherscan.io/tx/0x')),
    ).toBe(true);
    expect(dryRuns[0]?.explorerUrl).toBeNull();
    expect(dryRuns[0]?.reason).toBe('TREASURER_LIVE not set');
    expect(model.noProofNote).toBeNull();
  });

  it('exactly 1 agent is listed (the private one is excluded)', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    const env = { LEDGER: 'sqlite', LEDGER_SQLITE_PATH: dbPath, REFERENCE_AGENT_SLUG: 'treasurer' };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);

    expect(model.agents).toHaveLength(1);
    expect(model.agents[0]?.slug).toBe('treasurer');
    expect(model.noAgentsNote).toBeNull();
  });
});

// ================================================================================================
// Money formatting: no float artefacts.
// ================================================================================================

describe('S-08 — money formatting has no float artefacts', () => {
  it('0.10 + 0.20 repeated (classic IEEE-754 drift bait) sums to an exact "$1.50", never "$1.4999999999999998" or similar', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    const env = { LEDGER: 'sqlite', LEDGER_SQLITE_PATH: dbPath, REFERENCE_AGENT_SLUG: 'treasurer' };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);

    expect(model.savings.all.costUsd).toBe('1.500000');
    expect(model.savings.all.costUsdDisplay).toBe('$1.50');
    expect(model.savings.all.costUsdDisplay).not.toMatch(/9{4,}/);
    expect(model.savings.all.costUsdDisplay).not.toMatch(/0{4,}\d/);

    // Per-tier sub-sums (S: 0.6, M: 0.4, L: 0.5) are also exact.
    const s = model.savings.byTier.find((t) => t.tier === 'S');
    const m = model.savings.byTier.find((t) => t.tier === 'M');
    const l = model.savings.byTier.find((t) => t.tier === 'L');
    expect(s?.costUsdDisplay).toBe('$0.60');
    expect(m?.costUsdDisplay).toBe('$0.40');
    expect(l?.costUsdDisplay).toBe('$0.50');
  });
});

// ================================================================================================
// AC3 — /api/stats: JSON shape (own Zod schema) + Cache-Control.
// ================================================================================================

// Independently written from the ticket's stated shape ("`{agent, savings: {h24, all, byTier},
// treasury, events: [...20], generatedAt}`"), not copied from the route handler's own schema/types.
const savingsWindowSchema = z.object({
  calls: z.number(),
  costUsd: z.string(),
  baselineUsd: z.string(),
  savedUsd: z.string(),
  savedPct: z.string(),
});
const tierLineSchema = z.object({
  tier: z.enum(['S', 'M', 'L']),
  calls: z.number(),
  costUsd: z.string(),
});
const statsResponseSchema = z.object({
  agent: z.object({ slug: z.string(), name: z.string() }).nullable(),
  savings: z.object({
    h24: savingsWindowSchema,
    all: savingsWindowSchema,
    byTier: z.array(tierLineSchema),
  }),
  treasury: z.record(z.string(), z.unknown()).nullable(),
  events: z.array(z.record(z.string(), z.unknown())).max(20),
  generatedAt: z.string(),
});

describe('S-08 AC3 — GET /api/stats', () => {
  it('response validates against the ticket-shaped Zod schema and carries Cache-Control', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';

    const res = await getStats();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBeTruthy();

    const body = await res.json();
    const parsed = statsResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.events).toHaveLength(3);
  });
});

// ================================================================================================
// AC4 — /api/agents: POST 401/400/200, GET public-only.
// ================================================================================================

describe('S-08 AC4 — /api/agents', () => {
  it('POST without a key -> 401', async () => {
    process.env.LEDGER_SQLITE_PATH = freshDbPath();
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-key-agent' }),
    });
    const res = await postAgents(req);
    expect(res.status).toBe(401);
  });

  it('POST with a valid key -> 200 and the agent row exists afterwards', async () => {
    const dbPath = freshDbPath();
    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    process.env.GATEWAY_KEYS = TESTER_CALLER_KEY;

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TESTER_CALLER_KEY}`,
      },
      body: JSON.stringify({ name: 'S-08 Tester Agent', repoUrl: 'https://example.com/repo' }),
    });
    const res = await postAgents(req);
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.name).toBe('S-08 Tester Agent');
    expect(typeof created.slug).toBe('string');

    // Row really exists — read it back through the public API, not a raw SQL query.
    const listRes = await getAgents();
    const listed = await listRes.json();
    expect(listed.agents.some((a: { slug: string }) => a.slug === created.slug)).toBe(true);
  });

  it('malformed body (missing required "name") -> 400', async () => {
    process.env.LEDGER_SQLITE_PATH = freshDbPath();
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    process.env.GATEWAY_KEYS = TESTER_CALLER_KEY;

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TESTER_CALLER_KEY}`,
      },
      body: JSON.stringify({ notName: 'oops' }),
    });
    const res = await postAgents(req);
    expect(res.status).toBe(400);
  });

  it('malformed JSON body -> 400 (not a 500)', async () => {
    process.env.LEDGER_SQLITE_PATH = freshDbPath();
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    process.env.GATEWAY_KEYS = TESTER_CALLER_KEY;

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TESTER_CALLER_KEY}`,
      },
      body: '{not json',
    });
    const res = await postAgents(req);
    expect(res.status).toBe(400);
  });

  it('GET lists only public agents, never the private one', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';

    const res = await getAgents();
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = body.agents.map((a: { slug: string }) => a.slug);
    expect(slugs).toContain('treasurer');
    expect(slugs).not.toContain('ghost-agent');
    expect(body.agents).toHaveLength(1);
  });
});

// ================================================================================================
// AC5 — footer sentence, verbatim (the exact ticket text — see also model.ts's own FOOTER_SENTENCE
// constant, checked here independently against the ticket's literal wording).
// ================================================================================================

describe('S-08 AC5 — footer sentence', () => {
  const TICKET_FOOTER =
    'v1: the buy-and-stake leg is funded by seed capital and capped; caller billing is not live. ' +
    'Every on-chain action above links to its transaction.';

  it('renderModel().footer matches the ticket wording verbatim, byte for byte', async () => {
    process.env.LEDGER_SQLITE_PATH = freshDbPath();
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    const env = {
      LEDGER: 'sqlite',
      LEDGER_SQLITE_PATH: process.env.LEDGER_SQLITE_PATH,
      REFERENCE_AGENT_SLUG: 'treasurer',
    };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);
    expect(model.footer).toBe(TICKET_FOOTER);
    expect(FOOTER_SENTENCE).toBe(TICKET_FOOTER);
  });

  it('the raw HTML check (footer literally present in the served page) is the pnpm smoke run — see Test report Evidence', () => {
    expect(true).toBe(true);
  });
});

// ================================================================================================
// AC7 — no full 0x address / full tx hash outside an href-only field.
// ================================================================================================

describe('S-08 AC7 — no full 0x material outside href-carrying fields', () => {
  it('proof rows only expose the full tx hash via txHash/explorerUrl (the href source); every other text field is shortened or hash-free', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';
    const env = { LEDGER: 'sqlite', LEDGER_SQLITE_PATH: dbPath, REFERENCE_AGENT_SLUG: 'treasurer' };
    const input = await loadRenderModelInput(env as never, NOW);
    const model = renderModel(input);

    for (const row of model.events) {
      if (row.txHash) {
        // The full hash is allowed only where the page uses it to build an href.
        expect(row.explorerUrl).toBe(`https://robin.etherscan.io/tx/${row.txHash}`);
        // The text label shown to the reader is short, and is NOT the full hash.
        expect(row.txShort).not.toBe(row.txHash);
        expect(row.txShort?.length).toBeLessThan(row.txHash.length);
        expect(row.txShort).toContain('…');
        // No other row field repeats the full hash as displayable text.
        expect(row.kind).not.toContain(row.txHash);
        expect(row.amountDisplay ?? '').not.toContain(row.txHash);
        expect(row.usdValueDisplay ?? '').not.toContain(row.txHash);
        expect(row.reason ?? '').not.toContain(row.txHash);
      }
    }

    // Agent rows carry no wallet-address field at all in the view model (only slug/name/repoUrl/
    // lastSeenAt) — AgentRow.walletAddress never reaches the page.
    for (const a of [...model.agents, ...(model.agent ? [model.agent] : [])]) {
      expect(Object.keys(a)).not.toContain('walletAddress');
    }
  });

  it('/api/stats JSON never includes a full 0x-address-shaped agent.walletAddress field', async () => {
    const dbPath = freshDbPath();
    const { store } = await seedAc2Ledger(dbPath);
    await store.close();

    process.env.LEDGER_SQLITE_PATH = dbPath;
    process.env.REFERENCE_AGENT_SLUG = 'treasurer';

    const res = await getStats();
    const body = await res.json();
    expect(body.agent).not.toHaveProperty('walletAddress');
  });
});

/**
 * Unit tests for the pure `renderModel()` view function (S-08 AC1, AC2, AC5, AC7). No ledger, no
 * network — every input is a plain fixture object, matching PROCESS.md's "derive tests from the
 * ticket's acceptance criteria" discipline for the Tester role, applied here by the Builder per
 * this ticket's "unit-tested" requirement on the render model specifically.
 */
import type {
  AgentRow,
  ChainSnapshotRow,
  SavingsResult,
  TreasuryEventRow,
} from '@orbio-treasurer/core';
import { describe, expect, it } from 'vitest';

import {
  FOOTER_SENTENCE,
  HOW_TO_USE_LINE,
  PITCH_LINE,
  PRODUCT_NAME,
  type RenderModelInput,
  ROBINHOOD_LINE,
  renderModel,
  STATUS_HINT,
  ZERO_SAVINGS,
} from './model.js';

const NOW = '2026-09-19T12:00:00.000Z';

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'agent-1',
    slug: 'treasurer',
    name: 'Treasurer',
    walletAddress: null,
    chain: 'robinhood',
    repoUrl: 'https://github.com/example/treasurer',
    xHandle: null,
    template: null,
    policy: null,
    mode: 'dry_run',
    agentTokenHash: null,
    public: true,
    lastSeenAt: '2026-09-19T11:58:00.000Z',
    createdAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

function savingsResult(overrides: Partial<SavingsResult> = {}): SavingsResult {
  return {
    calls: 10,
    costUsd: '1.500000',
    baselineUsd: '3.000000',
    savedUsd: '1.500000',
    savedPct: '0.5000',
    byTier: {
      S: { calls: 6, costUsd: '0.600000' },
      M: { calls: 3, costUsd: '0.700000' },
      L: { calls: 1, costUsd: '0.200000' },
    },
    ...overrides,
  };
}

function chainSnapshot(overrides: Partial<ChainSnapshotRow> = {}): ChainSnapshotRow {
  return {
    id: 'snap-1',
    agentId: 'agent-1',
    asOf: '2026-09-19T11:58:00.000Z',
    stakedOrbio: '1234560000000000000000', // 1234.56 ORBIO (18dp)
    settledCredit: '5250000', // 5.25 CREDIT (6dp)
    creditWallet: '1000000', // 1.00 CREDIT
    creditApiAvailable: '48.000000',
    creditApiUsed: '2.000000',
    quoteCreditPerUsdg: '2.222000', // 10 USDG -> 22.22 CREDIT, 55% discount
    ethBalance: '5000000000000000', // 0.005 ETH (18dp)
    usdgBalance: '10000000', // 10.00 USDG (6dp)
    mode: 'dry_run',
    rpcUrlHost: 'rpc.ordofi.network',
    createdAt: NOW,
    ...overrides,
  };
}

function baseInput(overrides: Partial<RenderModelInput> = {}): RenderModelInput {
  return {
    now: NOW,
    agent: agent(),
    savings24h: savingsResult(),
    savingsAll: savingsResult({ calls: 100, costUsd: '15.000000', baselineUsd: '30.000000' }),
    burnDailyUsd: '4.000000',
    chainSnapshot: chainSnapshot(),
    treasuryEvents: [],
    publicAgents: [],
    ...overrides,
  };
}

describe('renderModel — AC1: no reference agent', () => {
  it('returns zeros and a "no data yet" note, never throws, when agent is null', () => {
    const model = renderModel({
      now: NOW,
      agent: null,
      savings24h: ZERO_SAVINGS,
      savingsAll: ZERO_SAVINGS,
      burnDailyUsd: '0.010000',
      chainSnapshot: null,
      treasuryEvents: [],
      publicAgents: [],
    });

    expect(model.hasAgent).toBe(false);
    expect(model.agent).toBeNull();
    expect(model.noDataNote).toBeTruthy();
    expect(model.savings.h24.calls).toBe(0);
    expect(model.savings.h24.costUsdDisplay).toBe('$0.00');
    expect(model.treasury).toBeNull();
    expect(model.events).toEqual([]);
    expect(model.agents).toEqual([]);
    expect(model.noProofNote).toBeTruthy();
    expect(model.noAgentsNote).toBeTruthy();
  });
});

describe("renderModel — AC2: savings numbers equal savings()'s own output", () => {
  it('passes h24/all raw fields through byte-for-byte from the SavingsResult given', () => {
    const s24 = savingsResult();
    const sAll = savingsResult({ calls: 42, costUsd: '9.990000', baselineUsd: '20.000000' });
    const model = renderModel(baseInput({ savings24h: s24, savingsAll: sAll }));

    expect(model.savings.h24.calls).toBe(s24.calls);
    expect(model.savings.h24.costUsd).toBe(s24.costUsd);
    expect(model.savings.h24.baselineUsd).toBe(s24.baselineUsd);
    expect(model.savings.h24.savedUsd).toBe(s24.savedUsd);
    expect(model.savings.h24.savedPct).toBe(s24.savedPct);

    expect(model.savings.all.calls).toBe(sAll.calls);
    expect(model.savings.all.costUsd).toBe(sAll.costUsd);
    expect(model.savings.all.baselineUsd).toBe(sAll.baselineUsd);
  });

  it('byTier lines mirror savingsAll.byTier for all three tiers, including zero-call tiers', () => {
    const sAll = savingsResult({
      byTier: {
        S: { calls: 0, costUsd: '0.000000' },
        M: { calls: 5, costUsd: '1.230000' },
        L: { calls: 0, costUsd: '0.000000' },
      },
    });
    const model = renderModel(baseInput({ savingsAll: sAll }));
    expect(model.savings.byTier).toHaveLength(3);
    expect(model.savings.byTier.map((t) => t.tier)).toEqual(['S', 'M', 'L']);
    expect(model.savings.byTier[1]).toMatchObject({ tier: 'M', calls: 5, costUsd: '1.230000' });
    expect(model.savings.byTier[1]?.costUsdDisplay).toBe('$1.23');
  });

  it('formats savedPct (a 0-1 ratio) as a percentage label', () => {
    const model = renderModel(baseInput({ savings24h: savingsResult({ savedPct: '0.5000' }) }));
    expect(model.savings.h24.savedPctDisplay).toBe('50.00%');
  });
});

describe('renderModel — treasury formatting', () => {
  it('formats 18dp/6dp raw token amounts to 2dp with thousands separators', () => {
    const model = renderModel(baseInput());
    expect(model.treasury?.stakedOrbioDisplay).toBe('1,234.56');
    expect(model.treasury?.creditClaimableDisplay).toBe('5.25');
    expect(model.treasury?.creditWalletDisplay).toBe('1.00');
    expect(model.treasury?.usdgDisplay).toBe('10.00');
    expect(model.treasury?.ethGasDisplay).toBe('0.005000');
  });

  it('rounds half away from zero, not by truncation', () => {
    const model = renderModel(
      baseInput({
        chainSnapshot: chainSnapshot({ stakedOrbio: '1000005000000000000000' }), // 1000.005000... ORBIO (18dp)
      }),
    );
    expect(model.treasury?.stakedOrbioDisplay).toBe('1,000.01');
  });

  it('computes the book quote (10 USDG -> CREDIT out, discount %) from quoteCreditPerUsdg', () => {
    const model = renderModel(baseInput());
    expect(model.treasury?.quote).toEqual({
      usdgIn: '10.00',
      creditOut: '22.22',
      discountPct: '55.0%',
    });
  });

  it('reports "quote unavailable" (quote: null) when quoteCreditPerUsdg is null', () => {
    const model = renderModel(
      baseInput({ chainSnapshot: chainSnapshot({ quoteCreditPerUsdg: null }) }),
    );
    expect(model.treasury?.quote).toBeNull();
  });

  it('runwayDays = creditApiAvailable / burnDaily; "∞" only when the caller floors burn at 0', () => {
    const model = renderModel(
      baseInput({
        chainSnapshot: chainSnapshot({ creditApiAvailable: '40.000000' }),
        burnDailyUsd: '4.000000',
      }),
    );
    expect(model.treasury?.runwayDays).toBe('10.000000');
    expect(model.treasury?.runwayDisplay).toBe('10.0 d');
  });

  it('never crashes when the chain snapshot is null (agent exists, no tick yet)', () => {
    const model = renderModel(baseInput({ chainSnapshot: null }));
    expect(model.treasury).toBeNull();
  });

  it('reports snapshot age in whole minutes', () => {
    const model = renderModel(
      baseInput({
        now: '2026-09-19T12:02:30.000Z',
        chainSnapshot: chainSnapshot({ asOf: '2026-09-19T12:00:00.000Z' }),
      }),
    );
    expect(model.treasury?.ageDisplay).toBe('2 min ago');
  });
});

describe('renderModel — proof block (treasury_events)', () => {
  function txEvent(overrides: Partial<TreasuryEventRow> = {}): TreasuryEventRow {
    return {
      id: 'ev-1',
      agentId: 'agent-1',
      at: '2026-09-19T11:00:00.000Z',
      kind: 'claim',
      amount: '5000000000000000000', // 5 ORBIO
      token: 'ORBIO',
      usdValue: '12.500000',
      txHash: `0x${'a'.repeat(64)}`,
      meta: null,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('links a real event to the explorer and shortens the hash for display', () => {
    const model = renderModel(baseInput({ treasuryEvents: [txEvent()] }));
    const row = model.events[0];
    expect(row?.explorerUrl).toBe(`https://robin.etherscan.io/tx/0x${'a'.repeat(64)}`);
    expect(row?.txShort).toBe('0xaaaa…aaaa');
    expect(row?.dryRun).toBe(false);
    expect(row?.amountDisplay).toBe('5.00 ORBIO');
    expect(row?.usdValueDisplay).toBe('$12.50');
  });

  it('greys out a dry_run row and surfaces its reason, with no tx link', () => {
    const dryRun = txEvent({
      kind: 'dry_run',
      txHash: null,
      amount: null,
      token: null,
      usdValue: null,
      meta: { reason: 'TREASURER_LIVE is false' },
    });
    const model = renderModel(baseInput({ treasuryEvents: [dryRun] }));
    const row = model.events[0];
    expect(row?.dryRun).toBe(true);
    expect(row?.reason).toBe('TREASURER_LIVE is false');
    expect(row?.explorerUrl).toBeNull();
    expect(row?.txShort).toBeNull();
  });

  it('exactly N rows in, N rows out, in the given order; empty -> "no on-chain action yet"', () => {
    const empty = renderModel(baseInput({ treasuryEvents: [] }));
    expect(empty.noProofNote).toBeTruthy();

    const three = renderModel(
      baseInput({
        treasuryEvents: [
          txEvent({ id: 'a' }),
          txEvent({ id: 'b' }),
          txEvent({ id: 'c', kind: 'dry_run', txHash: null }),
        ],
      }),
    );
    expect(three.events).toHaveLength(3);
    expect(three.noProofNote).toBeNull();
  });
});

describe('renderModel — agents block', () => {
  it('maps public agents to the display shape; empty -> the kit one-liner note', () => {
    const empty = renderModel(baseInput({ publicAgents: [] }));
    expect(empty.noAgentsNote).toMatch(/npx create-orbio-agent/);

    const withOne = renderModel(
      baseInput({ publicAgents: [agent({ slug: 'digest-bot', name: 'Digest Bot' })] }),
    );
    expect(withOne.agents).toEqual([
      {
        slug: 'digest-bot',
        name: 'Digest Bot',
        repoUrl: 'https://github.com/example/treasurer',
        lastSeenAt: '2026-09-19T11:58:00.000Z',
      },
    ]);
    expect(withOne.noAgentsNote).toBeNull();
  });
});

describe('renderModel — header block (S-10, tasks/S-10.md "In scope")', () => {
  it('carries the verbatim PRD §1 pitch line and product name, regardless of agent/data state', () => {
    const withAgent = renderModel(baseInput());
    const withoutAgent = renderModel({
      now: NOW,
      agent: null,
      savings24h: ZERO_SAVINGS,
      savingsAll: ZERO_SAVINGS,
      burnDailyUsd: '0.010000',
      chainSnapshot: null,
      treasuryEvents: [],
      publicAgents: [],
    });

    for (const model of [withAgent, withoutAgent]) {
      expect(model.header.productName).toBe('Orbio Treasurer');
      expect(model.header.productName).toBe(PRODUCT_NAME);
      expect(model.header.pitchLine).toBe(PITCH_LINE);
      expect(model.header.pitchLine).toBe(
        "One base_url change. Your agents' crons cost less, because we route smarter and " +
          'source inference below list on Orbio, and you can verify it on-chain.',
      );
    }
  });

  it('the "how to use" one-liner names base_url and model: "auto"', () => {
    const model = renderModel(baseInput());
    expect(model.header.howToUse).toBe(HOW_TO_USE_LINE);
    expect(model.header.howToUse).toContain('base_url');
    expect(model.header.howToUse).toContain('model: "auto"');
  });

  it('carries the verbatim Robinhood line', () => {
    const model = renderModel(baseInput());
    expect(model.header.robinhoodLine).toBe(ROBINHOOD_LINE);
    expect(model.header.robinhoodLine).toBe(
      'Robinhood gave agents a trading account. Orbio Treasurer gives them a treasury that ' +
        'pays for their inference, on Robinhood Chain, with public proof.',
    );
  });

  it('carries the "read the footer" status hint', () => {
    const model = renderModel(baseInput());
    expect(model.header.statusHint).toBe(STATUS_HINT);
    expect(model.header.statusHint).toMatch(/^Status: v1/);
    expect(model.header.statusHint.toLowerCase()).toContain('footer');
  });
});

describe('renderModel — footer (AC5)', () => {
  it('carries the verbatim PRD §1 sentence', () => {
    const model = renderModel(baseInput());
    expect(model.footer).toBe(FOOTER_SENTENCE);
    expect(model.footer).toBe(
      'v1: the buy-and-stake leg is funded by seed capital and capped; caller billing is not live. ' +
        'Every on-chain action above links to its transaction.',
    );
  });
});

/**
 * `runExecutors()` — S-06, tasks/S-06.md "Tests required": `tick/executors.test.ts`. AC3:
 * "Executor error isolation: a throwing `buyCredit` does not prevent `claimAndActivate` from
 * running; the error is recorded redacted."
 */
import type { Address, Hex, TransactionReceipt } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBuyCaps } from '../chain/buy.js';
import { resolveClaimCaps } from '../chain/claim.js';
import type { ChainAddresses } from '../chain/contracts.js';
import { openSqliteLedger } from '../ledger/sqlite/store.js';
import type { LedgerStore } from '../ledger/types.js';
import { DEFAULT_SPRINT_POLICY_CONFIG, decide, type SprintAction } from '../policy/sprint.js';
import { runExecutors, type TickExecClient } from './executors.js';

const HOT: Address = '0x1111111111111111111111111111111111111111';
const ADDRESSES: ChainAddresses = {
  credit: '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C',
  staking: '0xE0710011278BFb63E57C5f227E5980984B1EDDca',
  exchange: '0x6951fFd32630b05e06F50062AEA801625A58eBC0',
  orbio: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  payout: '0x4Cbbbf652B11eD1294dF0Ac49D8322394310CfC5',
};

const NOW = new Date('2026-09-19T12:00:00.000Z');

/** Everything reads as zero/empty by default (claim_activate's hot-leg becomes a harmless
 *  no_op); `readContractOverride` lets one test make a specific call throw. */
function fakeClient(opts: { readContractOverride?: (fn: string) => unknown } = {}): TickExecClient {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (opts.readContractOverride) {
      const override = opts.readContractOverride(args.functionName);
      if (override !== undefined) {
        if (override instanceof Error) throw override;
        return override;
      }
    }
    if (args.functionName === 'getQuote') return { creditOut: 0n, fills: 0n };
    return 0n; // positionOf, settledOf, balanceOf, allowance, MIN_POSITION, etc.
  });
  const getBalance = vi.fn(async () => 10n ** 18n);
  const writeContract = vi.fn(async (): Promise<Hex> => {
    throw new Error('fakeClient: writeContract should never be called (caps.treasurerLive=false)');
  });
  const waitForTransactionReceipt = vi.fn(
    async (): Promise<TransactionReceipt> =>
      ({ status: 'success', logs: [] }) as unknown as TransactionReceipt,
  );
  return { readContract, getBalance, writeContract, waitForTransactionReceipt };
}

describe('runExecutors', () => {
  let store: LedgerStore;

  afterEach(async () => {
    await store?.close();
  });

  async function seedAgent(): Promise<string> {
    store = openSqliteLedger(':memory:');
    const agent = await store.insertAgent({
      slug: `s06-exec-${Math.random().toString(36).slice(2)}`,
      name: 'S-06 executors test agent',
      mode: 'dry_run',
    });
    return agent.id;
  }

  function baseDeps(agentId: string, client: TickExecClient) {
    return {
      store,
      agentId,
      client,
      addresses: ADDRESSES,
      hot: HOT,
      claimCaps: resolveClaimCaps({ env: { TREASURER_LIVE: false } }),
      buyCaps: resolveBuyCaps({ env: { TREASURER_LIVE: false } }),
      periodIdsToSettle: [] as const,
      idempotencyKey: '2026-09-19T12:00-exec-test',
      now: () => NOW,
    };
  }

  it('claim_activate action -> claimAndActivate runs and its ledger rows land (no_op here, nothing owed)', async () => {
    const agentId = await seedAgent();
    const client = fakeClient();
    const action: SprintAction = {
      kind: 'claim_activate',
      reason: 'claimable_settled',
      inputs: {} as never,
    };
    const result = await runExecutors([action], 'normal', 'normal', baseDeps(agentId, client));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.kind).toBe('claim_activate');
    expect(result.results[0]?.outcome).toBe('ok');
  });

  it('buy action -> buyCredit runs and writes a dry_run row (caps.treasurerLive is false)', async () => {
    const agentId = await seedAgent();
    const client = fakeClient({
      readContractOverride: (fn) =>
        fn === 'getQuote' ? { creditOut: 13_333_332n, fills: 2n } : undefined,
    });
    const action: SprintAction = {
      kind: 'buy',
      usdg: '10.000000',
      reason: 'runway_below_buy_threshold',
      inputs: {} as never,
    };
    const result = await runExecutors([action], 'critical', 'critical', baseDeps(agentId, client));
    expect(result.results[0]?.kind).toBe('buy');
    expect(result.results[0]?.outcome).toBe('ok');
    const events = await store.listTreasuryEvents(agentId, 10);
    expect(events.some((e) => e.kind === 'dry_run')).toBe(true);
  });

  it('stakeup action -> always writes exactly one alert row with the usdg amount and a deep link, never a chain call', async () => {
    const agentId = await seedAgent();
    const client = fakeClient();
    const action: SprintAction = {
      kind: 'stakeup',
      usdg: '1.000000',
      reason: 'stakeup_interval_reached',
      inputs: {} as never,
    };
    const result = await runExecutors([action], 'normal', 'normal', baseDeps(agentId, client));
    expect(result.results[0]).toEqual({
      kind: 'stakeup',
      outcome: 'alerted',
      usdg: '1.000000',
      deepLink: `https://robin.etherscan.io/address/${ADDRESSES.orbio}`,
    });
    const events = await store.listTreasuryEvents(agentId, 10);
    const alerts = events.filter((e) => e.kind === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.meta).toMatchObject({
      action: 'stakeup',
      usdg: '1.000000',
      reason: 'stakeup_interval_reached',
    });
    expect(client.writeContract).not.toHaveBeenCalled();
  });

  it("mode_change is written when previousMode differs from this tick's mode", async () => {
    const agentId = await seedAgent();
    const client = fakeClient();
    await runExecutors([], 'critical', 'normal', baseDeps(agentId, client));
    const events = await store.listTreasuryEvents(agentId, 10);
    const modeChanges = events.filter((e) => e.kind === 'mode_change');
    expect(modeChanges).toHaveLength(1);
    expect(modeChanges[0]?.meta).toEqual({ from: 'normal', to: 'critical' });
  });

  it('mode_change is NOT written when previousMode equals the current mode', async () => {
    const agentId = await seedAgent();
    const client = fakeClient();
    await runExecutors([], 'normal', 'normal', baseDeps(agentId, client));
    const events = await store.listTreasuryEvents(agentId, 10);
    expect(events.some((e) => e.kind === 'mode_change')).toBe(false);
  });

  it("mode_change is NOT written when previousMode is null (agent's first-ever tick)", async () => {
    const agentId = await seedAgent();
    const client = fakeClient();
    await runExecutors([], 'normal', null, baseDeps(agentId, client));
    const events = await store.listTreasuryEvents(agentId, 10);
    expect(events.some((e) => e.kind === 'mode_change')).toBe(false);
  });

  it('AC3: a throwing buy does not prevent claim_activate from running; the error is recorded redacted', async () => {
    const agentId = await seedAgent();
    const secretLookingValue = 'sk-orb-0-verysecretlookingvalue';
    const client = fakeClient({
      readContractOverride: (fn) =>
        fn === 'getQuote' ? new Error(`upstream exploded: ${secretLookingValue}`) : undefined,
    });
    const actions: SprintAction[] = [
      { kind: 'claim_activate', reason: 'claimable_settled', inputs: {} as never },
      { kind: 'buy', usdg: '10.000000', reason: 'runway_below_buy_threshold', inputs: {} as never },
    ];
    const result = await runExecutors(actions, 'critical', 'critical', baseDeps(agentId, client));

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.kind).toBe('claim_activate');
    expect(result.results[0]?.outcome).toBe('ok'); // ran to completion, unaffected by buy's throw
    expect(result.results[1]?.kind).toBe('buy');
    expect(result.results[1]?.outcome).toBe('error');

    const events = await store.listTreasuryEvents(agentId, 10);
    const alert = events.find(
      (e) => e.kind === 'alert' && (e.meta as { action?: string })?.action === 'buy',
    );
    expect(alert).toBeDefined();
    // Redacted: the secret-shaped substring must not survive into the stored row.
    expect(JSON.stringify(alert?.meta)).not.toContain(secretLookingValue);
  });

  it('decide() actions feed straight into runExecutors without adaptation (end-to-end sanity)', async () => {
    const agentId = await seedAgent();
    const client = fakeClient({
      readContractOverride: (fn) =>
        fn === 'getQuote' ? { creditOut: 13_333_332n, fills: 2n } : undefined,
    });
    const decision = decide(
      {
        snapshot: {
          asOf: NOW.toISOString(),
          stakedOrbio: '0',
          settledCredit: '0',
          creditWalletHot: '0',
          creditWalletStaker: '0',
          usdgBalanceHot: '0',
          ethBalanceHot: '0',
          quote: null,
          totalStaked: '0',
          minPosition: '1000000000000000000000',
          period: '3600',
          rpcUrlHost: null,
          usedMulticall: true,
        },
        apiBalance: { available: '0', used: '0' },
        burnDaily: '3',
        callsSinceLastStakeup: 0,
        buysToday: 0,
        activatedToday: '0',
        claimable: '0',
        now: NOW,
        live: false,
      },
      DEFAULT_SPRINT_POLICY_CONFIG,
    );
    expect(decision.actions.map((a) => a.kind)).toEqual(['buy']);
    const result = await runExecutors(
      decision.actions,
      decision.mode,
      decision.mode,
      baseDeps(agentId, client),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.outcome).toBe('ok');
  });
});

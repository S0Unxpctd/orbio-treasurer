/**
 * `runTick()` — the whole S-06 loop, end to end (docs/PRD-1.0-sprint.md §1 "the loop", §4 T-6,
 * §6; tasks/S-06.md "In scope"): read the position, decide deterministically, act within the
 * gates, record everything. Called by `apps/web/app/api/tick/route.ts` (cron/manual) and
 * `pnpm tick` (CLI) — both just resolve `env`/`store` and call this.
 *
 * Idempotency (ticket): the bucket is the 15-min UTC window `now` falls in
 * (`computeTickBucket()` — `YYYY-MM-DDTHH:MM`, minute floored to 00/15/30/45). A `treasury_events`
 * row of kind `tick` (migration 006 adds `tick` to that column's CHECK list, both dialects)
 * carrying `meta.bucket` is this tick's marker; a second call in the same bucket for the same
 * agent — the cron firing *and* a manual `pnpm tick`, or a retried cron invocation — finds that
 * marker and returns `{skipped:'duplicate'}` without touching the chain or writing anything else.
 *
 * The whole body — the duplicate check, claiming the bucket, every read and every executor call —
 * runs inside one `store.withAgentLock(agentId, ...)` (audit focus: "lock held across the whole
 * tick... check it releases on throw" — `withAgentLock` rejects, and releases, exactly like any
 * other promise if `fn` throws; nothing here catches and re-throws around it).
 *
 * `readTreasury()` is called once (not through `chain/snapshot.ts`'s `snapshotTreasury()`, which
 * would read-then-persist before this tick's `mode` is known) — the *one* `chain_snapshots` row
 * this tick writes (AC2: "writes 1 chain snapshot") is inserted directly, once `decide()` has
 * already run against that same read, so its `mode` column holds this tick's real decision, not
 * a placeholder a later tick would have to overwrite (append-only tables can't be overwritten at
 * all — PRD 0.3.1).
 */
import type { Account, Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createRobinhoodClient,
  createRpcTracker,
  discoverPeriodsToSettle,
  loadChainAddresses,
  parseRhRpcUrls,
  readApiBalance,
  readTreasury,
  resolveBuyCaps,
  resolveClaimCaps,
  resolveMaxFeeGweiCap,
  utcDateKey,
} from '../chain/index.js';
import type { ChainSnapshot, TreasuryReadClient } from '../chain/read.js';
import type { Env } from '../env.js';
import { formatDecimal } from '../ledger/decimal.js';
import { burnDaily } from '../ledger/metrics.js';
import type { Id, LedgerStore, TreasuryEventRow } from '../ledger/types.js';
import { DEFAULT_SPRINT_POLICY_CONFIG, decide, type SprintDecideInput } from '../policy/sprint.js';
import type { Mode } from '../router/types.js';
import { getUpstreamKey } from '../router/upstream.js';
import { type ExecutorActionResult, runExecutors, type TickExecClient } from './executors.js';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const DEFAULT_LOOKBACK = 500;

/** `YYYY-MM-DDTHH:MM`, `now`'s UTC minute floored to the containing 15-min slot (`00`/`15`/`30`/
 *  `45`) — the tick's idempotency bucket. Exported for `apps/web/app/api/tick/route.ts` and the
 *  CLI to log, and for direct unit testing. */
export function computeTickBucket(now: Date): string {
  const flooredMinute = Math.floor(now.getUTCMinutes() / 15) * 15;
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const min = String(flooredMinute).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Total gateway calls (`usage_events` rows) since the most recent `stakeup` alert this ticket's
 *  own executor wrote (or, if S-07 ever lands a real `stake` event, since that) — or every call
 *  ever recorded, if neither exists yet. `decide()`'s `callsSinceLastStakeup` input, purely a
 *  count of activity, never gated on here (the `>= STAKEUP_EVERY_CALLS` comparison is
 *  `decide()`'s own job). */
async function countCallsSinceLastStakeup(
  store: LedgerStore,
  agentId: Id,
  lookback: number,
): Promise<number> {
  const events = await store.listTreasuryEvents(agentId, lookback);
  const lastStakeup = events.find(
    (e) =>
      e.kind === 'stake' || (e.kind === 'alert' && isRecord(e.meta) && e.meta.action === 'stakeup'),
  );
  const usageEvents = await store.listUsageEvents(
    agentId,
    lastStakeup ? { sinceAt: lastStakeup.at } : undefined,
  );
  return usageEvents.length;
}

/** Count of *executed* `buy` treasury_events today (UTC) — echoed into `decide()`'s input for
 *  FR-4.6-style re-derivability; `decide()` itself never gates on it (`chain/buy.ts`'s own
 *  `BUY_MAX_PER_DAY` cap already does, per that file's `resolveBuyCaps()`). */
function countBuysToday(events: readonly TreasuryEventRow[], now: Date): number {
  const todayKey = utcDateKey(now.toISOString());
  return events.filter((e) => e.kind === 'buy' && utcDateKey(e.at) === todayKey).length;
}

/** Total CREDIT activated today (UTC), decimal string — same "echoed, not gated on" reasoning
 *  (`ACTIVATE_MAX_PER_DAY` is `claimAndActivate()`'s own gate, per `chain/claim.ts`). */
function sumActivatedToday(events: readonly TreasuryEventRow[], now: Date): string {
  const todayKey = utcDateKey(now.toISOString());
  let total = 0n;
  for (const e of events) {
    if (e.kind === 'activate' && utcDateKey(e.at) === todayKey && e.amount) {
      total += BigInt(e.amount); // raw CREDIT atoms — same 6dp scale as Money (see tick.ts header).
    }
  }
  return formatDecimal(total);
}

export interface RunTickParams {
  readonly store: LedgerStore;
  readonly agentSlug: string;
  readonly now: Date;
  readonly env: Env;
  /** Injectable for tests (AC2: "against fakes ... fake chain client"). Defaults to a real
   *  ordered-RPC-fallback client built from `env.RH_RPC_URLS`. */
  readonly client?: TickExecClient & TreasuryReadClient;
  /** Injectable for tests (AC2: "fake gateway fetch"). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface TickActionSummary {
  readonly kind: ExecutorActionResult['kind'];
  readonly outcome: ExecutorActionResult['outcome'];
}

export interface TickSummary {
  readonly bucket: string;
  readonly agentId: Id;
  readonly mode: Mode;
  readonly previousMode: string | null;
  readonly modeChanged: boolean;
  readonly runwayDays: string;
  readonly actions: readonly TickActionSummary[];
}

export type RunTickResult = { readonly skipped: 'duplicate' } | TickSummary;

async function resolveApiBalance(
  env: Env,
  fetchImpl: typeof fetch,
): Promise<{ readonly available: string; readonly used: string }> {
  if (!env.ORBIO_GATEWAY_BASE_URL) return { available: '0.000000', used: '0.000000' };
  try {
    const key = await getUpstreamKey(env);
    return await readApiBalance(env.ORBIO_GATEWAY_BASE_URL, key, fetchImpl);
  } catch {
    // A gateway/key read failure must not sink the whole tick (claim/buy/mode still run off a
    // conservative $0 balance, which only ever makes the policy MORE cautious, never less) — the
    // caller sees this reflected as an unusually low runway/critical mode, not a crashed tick.
    return { available: '0.000000', used: '0.000000' };
  }
}

async function runTickLocked(
  store: LedgerStore,
  agentId: Id,
  bucket: string,
  now: Date,
  env: Env,
  client: TickExecClient & TreasuryReadClient,
  fetchImpl: typeof fetch,
): Promise<RunTickResult> {
  const recent = await store.listTreasuryEvents(agentId, DEFAULT_LOOKBACK);
  const alreadyRan = recent.some(
    (e) => e.kind === 'tick' && isRecord(e.meta) && e.meta.bucket === bucket,
  );
  if (alreadyRan) return { skipped: 'duplicate' };

  // Claim the bucket immediately — before any read/write below — so a second call that enters
  // this locked body later (a manual `pnpm tick` racing the cron, say) sees the marker as soon
  // as it acquires the lock, even if this run goes on to fail partway through.
  await store.insertTreasuryEvent({
    agentId,
    at: now.toISOString(),
    kind: 'tick',
    meta: { bucket },
  });

  const previousSnapshot = await store.latestChainSnapshot(agentId);
  const previousMode = previousSnapshot?.mode ?? null;

  const addresses = loadChainAddresses(env);
  const hotAccount: Account | undefined = env.TREASURER_PRIVATE_KEY
    ? privateKeyToAccount(env.TREASURER_PRIVATE_KEY as `0x${string}`)
    : undefined;
  const hot: Address = hotAccount?.address ?? ZERO_ADDRESS;
  const stakerAccount: Account | undefined = env.STAKER_PRIVATE_KEY
    ? privateKeyToAccount(env.STAKER_PRIVATE_KEY as `0x${string}`)
    : undefined;
  const staker = (env.STAKER_ADDRESS as Address | undefined) ?? stakerAccount?.address;

  const rpcTracker = createRpcTracker();
  const apiBalance = await resolveApiBalance(env, fetchImpl);
  const burnDailyUsd = await burnDaily(store, agentId, now.toISOString());

  const snapshot: ChainSnapshot = await readTreasury(client, addresses, {
    hot,
    ...(staker ? { staker } : {}),
    now: () => now,
    rpcUrlHost: () => rpcTracker.lastHost,
  });

  const claimable = formatDecimal(BigInt(snapshot.settledCredit));
  const buysToday = countBuysToday(recent, now);
  const activatedToday = sumActivatedToday(recent, now);
  const callsSinceLastStakeup = await countCallsSinceLastStakeup(store, agentId, DEFAULT_LOOKBACK);

  const decideInput: SprintDecideInput = {
    snapshot,
    apiBalance,
    burnDaily: burnDailyUsd,
    callsSinceLastStakeup,
    buysToday,
    activatedToday,
    claimable,
    now,
    live: env.TREASURER_LIVE,
  };
  const decision = decide(decideInput, DEFAULT_SPRINT_POLICY_CONFIG);

  // The one chain_snapshots row this tick writes (AC2) — see this file's header for why it's
  // inserted directly here rather than through `chain/snapshot.ts`'s `snapshotTreasury()`.
  await store.insertChainSnapshot({
    agentId,
    asOf: snapshot.asOf,
    stakedOrbio: snapshot.stakedOrbio,
    settledCredit: snapshot.settledCredit,
    creditWallet: snapshot.creditWalletHot,
    creditApiAvailable: apiBalance.available,
    creditApiUsed: apiBalance.used,
    quoteCreditPerUsdg: snapshot.quote ? formatDecimal(BigInt(snapshot.quote.creditOut)) : null,
    ethBalance: snapshot.ethBalanceHot,
    usdgBalance: snapshot.usdgBalanceHot,
    mode: decision.mode,
    rpcUrlHost: snapshot.rpcUrlHost,
  });

  const claimCaps = resolveClaimCaps({ env });
  const buyCaps = resolveBuyCaps({ env });
  const maxFeeGweiCap = resolveMaxFeeGweiCap(env);
  const periodIdsToSettle = env.STAKING_SETTLE_PERIODS
    ? env.STAKING_SETTLE_PERIODS.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => BigInt(s))
    : staker
      ? await discoverPeriodsToSettle(
          client,
          addresses,
          staker,
          env.STAKING_LAST_PERIOD_HINT ? { hint: BigInt(env.STAKING_LAST_PERIOD_HINT) } : {},
        )
      : [];

  const { modeChanged, results } = await runExecutors(
    decision.actions,
    decision.mode,
    previousMode,
    {
      store,
      agentId,
      client,
      addresses,
      hot,
      ...(staker ? { staker } : {}),
      ...(stakerAccount ? { account: stakerAccount } : {}),
      ...(hotAccount ? { hotAccount } : {}),
      claimCaps,
      buyCaps,
      periodIdsToSettle,
      maxFeeGweiCap,
      idempotencyKey: `${bucket}-${agentId}`,
      now: () => now,
    },
  );

  return {
    bucket,
    agentId,
    mode: decision.mode,
    previousMode,
    modeChanged,
    runwayDays: decision.runwayDays,
    actions: results.map((r) => ({ kind: r.kind, outcome: r.outcome })),
  };
}

/**
 * Resolves (creating if missing, same convention as `scripts/treasury-claim.ts`/
 * `treasury-buy.ts`) the agent this tick runs against, then runs the whole locked body above.
 * Never throws past a configuration error redacted (CLAUDE.md #4) — a thrown
 * `ChainEnvValidationError`/`EnvValidationError` still propagates (a genuine setup bug the
 * caller — the route handler or the CLI — must surface loudly, not silently dry-run around); an
 * *executor*-level error never reaches here at all (`runExecutors()` isolates those, per its own
 * header).
 */
export async function runTick(params: RunTickParams): Promise<RunTickResult> {
  const { store, agentSlug, now, env } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  let agent = await store.getAgentBySlug(agentSlug);
  if (!agent) {
    agent = await store.insertAgent({ slug: agentSlug, name: 'Orbio Treasurer', mode: 'dry_run' });
  }
  const agentId = agent.id;

  const client: TickExecClient & TreasuryReadClient =
    params.client ??
    (createRobinhoodClient(parseRhRpcUrls(env.RH_RPC_URLS)) as TickExecClient & TreasuryReadClient);

  const bucket = computeTickBucket(now);

  // A thrown configuration error (`ChainEnvValidationError`/`EnvValidationError`, missing chain
  // addresses or gateway config) propagates as-is — a genuine setup bug the caller (the route
  // handler or the CLI) must surface loudly, redacting only at the point it logs it (CLAUDE.md
  // #4 — `redact()` belongs at the log/response boundary, not baked into the thrown error's own
  // shape, which would lose e.g. `ChainEnvValidationError.missing`). `withAgentLock` itself
  // already releases on a throw (audit focus) — nothing here needs to help it do that.
  return store.withAgentLock(agentId, () =>
    runTickLocked(store, agentId, bucket, now, env, client, fetchImpl),
  );
}

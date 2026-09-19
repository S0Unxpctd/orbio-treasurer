#!/usr/bin/env tsx
/**
 * `pnpm treasury:claim [--live]` — S-04, tasks/S-04.md "In scope": "CLI `pnpm treasury:claim
 * [--live]` with the same `yes-send` guard as S-05."
 *
 * Gates, all required before a single `writeContract` call happens, exactly mirroring S-05's
 * `treasury-buy.ts`:
 *   1. `resolveCliArgs()` (chain/claim.ts) — pure argument/env resolution, checked FIRST: refuses
 *      outright (before deriving any account, reading any balance, or touching the network) when
 *      `STAKER_PRIVATE_KEY` is set without `TREASURER_PRIVATE_KEY` (S-04 audit pass 1, Blocker
 *      #1 — the staker_key flow activates CREDIT to the hot wallet, and there is no
 *      hot-address-only env var in this codebase, so this CLI must never default `hot` to the
 *      zero address), or when neither key is set at all for a `--live` run.
 *   2. env `TREASURER_LIVE=true` (never set in this sandbox — CLAUDE.md rule 5), and
 *   3. typing exactly `yes-send` when prompted (only asked when a live send is actually about
 *      to happen — never for a dry run or a read-only manual/alert tick).
 *
 * Which flow runs depends on which env vars are set (see claim.ts's header comment):
 *   - `STAKER_PRIVATE_KEY` set -> the automated settle -> claim -> activate flow (requires
 *     `TREASURER_PRIVATE_KEY` too, per gate 1 above).
 *   - only `STAKER_ADDRESS` set -> the manual read-only alert flow (never sends anything on the
 *     staker side; may still activate from hot if `TREASURER_PRIVATE_KEY` is set and hot holds
 *     CREDIT already).
 *   - `periodIdsToSettle` comes from `STAKING_SETTLE_PERIODS` (comma list) if set, else from
 *     `discoverPeriodsToSettle()` (live read-only calls) when a staker address is configured.
 *
 * Idempotency key = the same 15-min UTC tick bucket S-06's tick loop uses
 * (`computeTickBucket()`, `tick/tick.ts`) — S-04 audit pass 1, Major #2: the CLI previously keyed
 * on `new Date().toISOString()` (unique to the millisecond on every invocation), which never
 * actually exercised `claimAndActivate()`'s own idempotency check. Two `pnpm treasury:claim
 * --live` runs inside the same 15-minute bucket are now a replay, same as two tick firings would
 * be.
 *
 * Ledger: every run (dry or live) goes through `claimAndActivate()`, so it leaves the same
 * `treasury_events` trail a tick would — against a `default`-slug agent in the local SQLite
 * ledger (kit-default, CLAUDE.md rule 5c: no Supabase account required to run this).
 */
import { createInterface } from 'node:readline/promises';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  claimAndActivate,
  createRobinhoodClient,
  discoverPeriodsToSettle,
  loadChainAddresses,
  parseRhRpcUrls,
  resolveClaimCaps,
  resolveClaimMaxFeeGweiCap,
  resolveCliArgs,
} from '../src/chain/index.js';
import { loadEnv } from '../src/env.js';
import { openSqliteLedger } from '../src/ledger/sqlite/store.js';
import { redact } from '../src/redact.js';
import { computeTickBucket } from '../src/tick/tick.js';

const AGENT_SLUG = 'default';
const CONFIRMATION_PHRASE = 'yes-send';

function parsePeriodIds(raw: string | undefined): readonly bigint[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s));
}

async function confirmSend(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Type "${CONFIRMATION_PHRASE}" to send this transaction, anything else to abort: `,
    );
    return answer.trim() === CONFIRMATION_PHRASE;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();

  // Gate 1 (S-04 audit pass 1, Blocker #1): pure, checked before any account is derived, any
  // balance read, or the network is touched at all. See resolveCliArgs()'s own doc comment.
  const resolution = resolveCliArgs({ env, argv: process.argv.slice(2) });
  if (resolution.outcome === 'refuse') {
    console.error(`refusing: ${resolution.reason}`);
    process.exit(1);
  }
  const { live, treasurerLiveEnv, hasStakerKey, hasHotKey, wantsLiveSend } = resolution;

  const addresses = loadChainAddresses(env);
  const rpcUrls = parseRhRpcUrls(env.RH_RPC_URLS);
  const client = createRobinhoodClient(rpcUrls);

  const stakerAccount = hasStakerKey
    ? privateKeyToAccount(env.STAKER_PRIVATE_KEY as `0x${string}`)
    : undefined;
  const hotAccount = hasHotKey
    ? privateKeyToAccount(env.TREASURER_PRIVATE_KEY as `0x${string}`)
    : undefined;
  // Never default to the zero address (S-04 audit pass 1, Blocker #1): `hot` is only ever a real
  // address derived from TREASURER_PRIVATE_KEY, or absent entirely. `resolveCliArgs()` above
  // already guarantees `hasHotKey` whenever `hasStakerKey` is true, so `hot` is defined whenever
  // the staker_key flow could run.
  const hot: Address | undefined = hotAccount?.address;
  const staker = (env.STAKER_ADDRESS as Address | undefined) ?? stakerAccount?.address;

  const resolvedCaps = resolveClaimCaps({ env });
  // Gate 2: --live is required on top of whatever env already says (CLAUDE.md rule 5 belt and
  // braces — this sandbox never has TREASURER_LIVE=true, but the CLI doesn't rely on that alone).
  const caps = live ? resolvedCaps : { ...resolvedCaps, treasurerLive: false };
  const maxFeeGweiCap = resolveClaimMaxFeeGweiCap(env);

  if (live && !treasurerLiveEnv) {
    console.log(
      '--live was passed but TREASURER_LIVE is not "true" in env — printing the plan only, nothing will send.',
    );
  }

  // Period discovery: STAKING_SETTLE_PERIODS always wins (manual override); otherwise, when a
  // staker address is known, run the live read-only discovery (see docs/api-notes.md "S-04
  // period discovery" — resolved within the ticket's 45-min time-box, so this is exercised for
  // real here rather than only against a fake client in tests).
  const envPeriods = parsePeriodIds(env.STAKING_SETTLE_PERIODS);
  const hint = env.STAKING_LAST_PERIOD_HINT ? BigInt(env.STAKING_LAST_PERIOD_HINT) : undefined;
  const periodIdsToSettle =
    envPeriods.length > 0
      ? envPeriods
      : staker
        ? await discoverPeriodsToSettle(client, addresses, staker, hint ? { hint } : {})
        : [];

  const store = openSqliteLedger(env.LEDGER_SQLITE_PATH);
  try {
    let agent = await store.getAgentBySlug(AGENT_SLUG);
    if (!agent) {
      agent = await store.insertAgent({
        slug: AGENT_SLUG,
        name: 'Orbio Treasurer',
        mode: 'dry_run',
      });
    }

    if (wantsLiveSend) {
      if (!hot) {
        // Unreachable given resolveCliArgs()'s gate (hasStakerKey implies hasHotKey, and
        // wantsLiveSend implies hasStakerKey || hasHotKey) — kept as a second, independent
        // check rather than trusting that invariant alone before a real send.
        console.error('refusing: no hot wallet address resolved — aborting before any send.');
        process.exit(1);
      }
      console.log(
        redact({
          about_to_send: true,
          hot,
          staker: staker ?? null,
          periodIdsToSettle: periodIdsToSettle.map(String),
          caps: {
            activateMaxPerDayAtoms: caps.activateMaxPerDayAtoms.toString(),
          },
        }),
      );
      const confirmed = await confirmSend();
      if (!confirmed) {
        console.log('aborted: confirmation phrase did not match.');
        process.exit(1);
      }
    }

    const effectiveCaps = wantsLiveSend ? caps : { ...caps, treasurerLive: false };
    // Major #2 (S-04 audit pass 1): the same 15-min UTC bucket S-06's tick loop uses, not
    // `new Date().toISOString()` — two CLI runs in the same bucket are now a replay.
    const idempotencyKey = `cli-${computeTickBucket(new Date())}`;
    const result = await claimAndActivate({
      store,
      agentId: agent.id,
      client,
      addresses,
      ...(hot ? { hot } : {}),
      ...(staker ? { staker } : {}),
      ...(wantsLiveSend && stakerAccount ? { account: stakerAccount } : {}),
      ...(wantsLiveSend && hotAccount ? { hotAccount } : {}),
      periodIdsToSettle,
      caps: effectiveCaps,
      maxFeeGweiCap,
      idempotencyKey,
    });

    console.log(JSON.stringify(redact(result), null, 2));
  } finally {
    await store.close();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify(redact({ error: err instanceof Error ? err.message : String(err) })),
  );
  process.exitCode = 1;
});

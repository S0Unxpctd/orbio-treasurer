#!/usr/bin/env tsx
/**
 * `pnpm treasury:claim [--live]` — S-04, tasks/S-04.md "In scope": "CLI `pnpm treasury:claim
 * [--live]` with the same `yes-send` guard as S-05."
 *
 * Three independent gates, all required before a single `writeContract` call happens, exactly
 * mirroring S-05's `treasury-buy.ts`:
 *   1. the `--live` flag on this invocation,
 *   2. env `TREASURER_LIVE=true` (never set in this sandbox — CLAUDE.md rule 5), and
 *   3. typing exactly `yes-send` when prompted (only asked when a live send is actually about
 *      to happen — never for a dry run or a read-only manual/alert tick).
 *
 * Which flow runs depends on which env vars are set (see claim.ts's header comment):
 *   - `STAKER_PRIVATE_KEY` set -> the automated settle -> claim -> activate flow.
 *   - only `STAKER_ADDRESS` set -> the manual read-only alert flow (never sends anything on the
 *     staker side; may still activate from hot if `TREASURER_PRIVATE_KEY` is set and hot holds
 *     CREDIT already).
 *   - `periodIdsToSettle` comes from `STAKING_SETTLE_PERIODS` (comma list) if set, else from
 *     `discoverPeriodsToSettle()` (live read-only calls) when a staker address is configured.
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
} from '../src/chain/index.js';
import { loadEnv } from '../src/env.js';
import { openSqliteLedger } from '../src/ledger/sqlite/store.js';
import { redact } from '../src/redact.js';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const AGENT_SLUG = 'default';
const CONFIRMATION_PHRASE = 'yes-send';

function parseArgs(argv: readonly string[]): { readonly live: boolean } {
  return { live: argv.includes('--live') };
}

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
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const addresses = loadChainAddresses(env);
  const rpcUrls = parseRhRpcUrls(env.RH_RPC_URLS);
  const client = createRobinhoodClient(rpcUrls);

  const stakerAccount = env.STAKER_PRIVATE_KEY
    ? privateKeyToAccount(env.STAKER_PRIVATE_KEY as `0x${string}`)
    : undefined;
  const hotAccount = env.TREASURER_PRIVATE_KEY
    ? privateKeyToAccount(env.TREASURER_PRIVATE_KEY as `0x${string}`)
    : undefined;
  const hot: Address = hotAccount?.address ?? ZERO_ADDRESS;
  const staker = (env.STAKER_ADDRESS as Address | undefined) ?? stakerAccount?.address;

  const resolvedCaps = resolveClaimCaps({ env });
  // Gate 1: --live is required on top of whatever env already says (CLAUDE.md rule 5 belt and
  // braces — this sandbox never has TREASURER_LIVE=true, but the CLI doesn't rely on that alone).
  const caps = args.live ? resolvedCaps : { ...resolvedCaps, treasurerLive: false };
  const maxFeeGweiCap = resolveClaimMaxFeeGweiCap(env);

  if (args.live && caps.treasurerLive && !stakerAccount && !hotAccount) {
    console.error(
      'refusing: --live requires either STAKER_PRIVATE_KEY or TREASURER_PRIVATE_KEY to be set',
    );
    process.exit(1);
  }
  if (args.live && !caps.treasurerLive) {
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

    const wantsLiveSend = args.live && caps.treasurerLive && (stakerAccount || hotAccount);
    if (wantsLiveSend) {
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
    const result = await claimAndActivate({
      store,
      agentId: agent.id,
      client,
      addresses,
      hot,
      ...(staker ? { staker } : {}),
      ...(wantsLiveSend && stakerAccount ? { account: stakerAccount } : {}),
      ...(wantsLiveSend && hotAccount ? { hotAccount } : {}),
      periodIdsToSettle,
      caps: effectiveCaps,
      maxFeeGweiCap,
      idempotencyKey: `cli-${new Date().toISOString()}`,
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

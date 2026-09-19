#!/usr/bin/env tsx
/**
 * `pnpm treasury:buy --usdg 10 [--live]` — S-05, tasks/S-05.md "In scope": "CLI `pnpm
 * treasury:buy --usdg 10 [--live]`: prints the plan; sends only with `--live` AND
 * `TREASURER_LIVE=true` AND a typed confirmation `yes-send` on stdin. Not a test target."
 *
 * Three independent gates, all required before a single `writeContract` call happens:
 *   1. the `--live` flag on this invocation,
 *   2. env `TREASURER_LIVE=true` (never set in this sandbox — CLAUDE.md rule 5), and
 *   3. typing exactly `yes-send` when prompted.
 * Missing `--live` forces the plan to `dryRun: true` regardless of what `TREASURER_LIVE` says
 * (gate 1 is enforced here, in the CLI, on top of whatever `resolveBuyCaps()` already read from
 * env) — so running this with no flags, in any environment, only ever prints a plan.
 *
 * Ledger: every run (dry or live) goes through `buyCredit()`, so it leaves the same
 * `treasury_events` trail a tick would — against a `default`-slug agent in the local SQLite
 * ledger (kit-default, CLAUDE.md rule 5c: no Supabase account required to run this).
 */
import { createInterface } from 'node:readline/promises';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buyCredit,
  createRobinhoodClient,
  createRpcTracker,
  loadChainAddresses,
  parseRhRpcUrls,
  resolveBuyCaps,
  resolveMaxFeeGweiCap,
} from '../src/chain/index.js';
import { loadEnv } from '../src/env.js';
import { parseDecimal } from '../src/ledger/decimal.js';
import { openSqliteLedger } from '../src/ledger/sqlite/store.js';
import { redact } from '../src/redact.js';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const AGENT_SLUG = 'default';
const CONFIRMATION_PHRASE = 'yes-send';

interface Args {
  readonly usdg: string;
  readonly live: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let usdg: string | undefined;
  let live = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--usdg') {
      usdg = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--live') {
      live = true;
    }
  }
  if (!usdg) {
    console.error('usage: pnpm treasury:buy --usdg <amount> [--live]');
    process.exit(2);
  }
  return { usdg, live };
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
  const tracker = createRpcTracker();
  const client = createRobinhoodClient(rpcUrls, { tracker });

  const account = env.TREASURER_PRIVATE_KEY
    ? privateKeyToAccount(env.TREASURER_PRIVATE_KEY as `0x${string}`)
    : undefined;
  const hot: Address = account?.address ?? ZERO_ADDRESS;

  const resolvedCaps = resolveBuyCaps({ env });
  // Gate 1: --live is required on top of whatever env already says (CLAUDE.md rule 5 belt and
  // braces — this sandbox never has TREASURER_LIVE=true, but the CLI doesn't rely on that alone).
  const caps = args.live ? resolvedCaps : { ...resolvedCaps, treasurerLive: false };
  const maxFeeGweiCap = resolveMaxFeeGweiCap(env);

  const usdgIn = parseDecimal(args.usdg);

  if (args.live && caps.treasurerLive && !account) {
    console.error('refusing: --live requires TREASURER_PRIVATE_KEY to be set');
    process.exit(1);
  }

  if (args.live && !caps.treasurerLive) {
    console.log(
      '--live was passed but TREASURER_LIVE is not "true" in env — printing the plan only, nothing will send.',
    );
  }

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

    const wantsLiveSend = args.live && caps.treasurerLive && account !== undefined;
    if (wantsLiveSend) {
      console.log(
        redact({
          about_to_send: true,
          usdgIn: usdgIn.toString(),
          hot,
          caps: {
            buyMaxUsdgPerTxAtoms: caps.buyMaxUsdgPerTxAtoms.toString(),
            buyMaxPerDay: caps.buyMaxPerDay,
            minDiscountRatio: caps.minDiscountRatio,
          },
        }),
      );
      const confirmed = await confirmSend();
      if (!confirmed) {
        console.log('aborted: confirmation phrase did not match.');
        process.exit(1);
      }
    }

    const result = await buyCredit({
      store,
      agentId: agent.id,
      client,
      addresses,
      hot,
      ...(wantsLiveSend && account !== undefined ? { account } : {}),
      usdgIn,
      caps: wantsLiveSend ? caps : { ...caps, treasurerLive: false },
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

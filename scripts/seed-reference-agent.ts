#!/usr/bin/env tsx
/**
 * `pnpm seed:agent [--with-key --label <text>]` (S-10, docs/PRD-1.0-sprint.md §4 T-10;
 * tasks/S-10.md "In scope").
 *
 * Idempotently creates the reference agent row (`env.REFERENCE_AGENT_SLUG`, public, name
 * "Orbio Treasurer (reference)") on whichever ledger `LEDGER` points at — same
 * `openSqliteLedger`/`openPostgresLedger` dispatch as `apps/web/app/_ledger.ts`. Running this
 * twice is a no-op on the agent row: `getAgentBySlug` is checked first, `insertAgent` only runs
 * when nothing is there yet.
 *
 * `--with-key --label <text>` additionally inserts one ledger-backed caller key (same shape and
 * hashing as `packages/core/scripts/keys-create.ts`) and prints the raw `otk_...` value to stdout
 * exactly once — CLAUDE.md #4: the raw key is never written to the ledger, only its sha256 hash
 * plus `key_prefix`.
 *
 * Also closes S-06's tester note (tasks/S-06.md Test report): the very first tick raced on
 * creating the reference agent row itself when two ticks both saw "no agent yet" and both tried
 * to insert one. Running this once, before the first tick/cron fire, means the row already
 * exists by the time any tick runs, so that race path is never taken in practice — this script
 * does not itself change `tick.ts`'s own get-or-create logic (out of scope for S-10).
 */
import { randomBytes } from 'node:crypto';

import {
  hashKey,
  isValidKeyShape,
  loadEnv,
  openPostgresLedger,
  openSqliteLedger,
} from '@orbio-treasurer/core';

const REFERENCE_AGENT_NAME = 'Orbio Treasurer (reference)';

function parseArgs(argv: readonly string[]): {
  readonly withKey: boolean;
  readonly label: string | null;
} {
  let withKey = false;
  let label: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--with-key') withKey = true;
    if (argv[i] === '--label') label = argv[i + 1];
  }
  if (withKey && (!label || label.length === 0)) {
    console.error('usage: pnpm seed:agent [--with-key --label <text>]');
    process.exit(1);
  }
  return { withKey, label: label ?? null };
}

function generateKey(): string {
  const key = `otk_${randomBytes(16).toString('hex')}`;
  if (!isValidKeyShape(key)) {
    // Unreachable in practice (16 bytes -> exactly 32 hex chars), kept as a total, defensive
    // check rather than assuming randomBytes' own output shape forever (same discipline as
    // packages/core/scripts/keys-create.ts's own generateKey()).
    throw new Error('seed-reference-agent: generated key does not match the otk_<32 hex> shape');
  }
  return key;
}

async function main(): Promise<void> {
  const { withKey, label } = parseArgs(process.argv.slice(2));
  const env = loadEnv();

  const store =
    env.LEDGER === 'postgres'
      ? openPostgresLedger(
          env.DATABASE_URL ??
            (() => {
              throw new Error('LEDGER=postgres requires DATABASE_URL');
            })(),
        )
      : openSqliteLedger(env.LEDGER_SQLITE_PATH);

  try {
    const slug = env.REFERENCE_AGENT_SLUG;
    let agent = await store.getAgentBySlug(slug);
    if (agent) {
      console.log(`Reference agent "${slug}" already exists (id ${agent.id}) — no-op.`);
    } else {
      agent = await store.insertAgent({
        slug,
        name: REFERENCE_AGENT_NAME,
        mode: 'dry_run',
        public: true,
      });
      console.log(`Created reference agent "${slug}" (id ${agent.id}).`);
    }

    if (withKey && label) {
      const key = generateKey();
      const row = await store.insertCallerKey({
        agentId: agent.id,
        keyHash: hashKey(key),
        keyPrefix: key.slice(0, 10),
        label,
      });

      console.log('');
      console.log('New Orbio Treasurer gateway key — shown ONCE, save it now:');
      console.log(key);
      console.log(
        JSON.stringify(
          { id: row.id, agentId: row.agentId, keyPrefix: row.keyPrefix, label: row.label },
          null,
          2,
        ),
      );
    }
  } finally {
    await store.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

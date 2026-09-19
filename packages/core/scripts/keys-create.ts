#!/usr/bin/env tsx
/**
 * `pnpm keys:create --label x` — S-06, tasks/S-06.md "In scope": "add CLI `pnpm keys:create
 * --label x` that inserts a key and prints it ONCE."
 *
 * Generates a fresh `otk_<32 hex>` (same shape `router/keys.ts`'s `isValidKeyShape()` requires),
 * inserts only its sha256 hash + a display prefix into the ledger's `caller_keys` table
 * (CLAUDE.md #4: the raw key itself is never stored, never logged after this one print), and
 * prints the raw key to stdout exactly once — there is no `keys:show`, by design; losing it means
 * generating a new one. The key is associated with `env.REFERENCE_AGENT_SLUG`'s agent (creating
 * it if it doesn't exist yet, same convention as `tick.ts`/`_gateway.ts`'s `getReferenceAgentId`)
 * unless `--agent <slug>` names a different one.
 */
import { randomBytes } from 'node:crypto';

import { loadEnv } from '../src/env.js';
import { openSqliteLedger } from '../src/ledger/sqlite/store.js';
import { hashKey, isValidKeyShape } from '../src/router/keys.js';

function parseArgs(argv: readonly string[]): {
  readonly label: string;
  readonly agentSlug: string | null;
} {
  let label: string | undefined;
  let agentSlug: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--label') label = argv[i + 1];
    if (argv[i] === '--agent') agentSlug = argv[i + 1];
  }
  if (!label || label.length === 0) {
    console.error('usage: pnpm keys:create --label <text> [--agent <slug>]');
    process.exit(1);
  }
  return { label, agentSlug: agentSlug ?? null };
}

function generateKey(): string {
  const key = `otk_${randomBytes(16).toString('hex')}`;
  if (!isValidKeyShape(key)) {
    // Unreachable in practice (16 bytes -> exactly 32 hex chars) — kept as a total, defensive
    // check rather than assuming randomBytes' own output shape forever.
    throw new Error('keys-create: generated key does not match the expected otk_<32 hex> shape');
  }
  return key;
}

async function main(): Promise<void> {
  const { label, agentSlug } = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const store = openSqliteLedger(env.LEDGER_SQLITE_PATH);
  try {
    const slug = agentSlug ?? env.REFERENCE_AGENT_SLUG;
    let agent = await store.getAgentBySlug(slug);
    if (!agent) {
      agent = await store.insertAgent({ slug, name: 'Orbio Treasurer', mode: 'dry_run' });
    }

    const key = generateKey();
    const row = await store.insertCallerKey({
      agentId: agent.id,
      keyHash: hashKey(key),
      keyPrefix: key.slice(0, 10),
      label,
    });

    console.log('New Orbio Treasurer gateway key — shown ONCE, save it now:');
    console.log(key);
    console.log(
      JSON.stringify(
        { id: row.id, agentId: row.agentId, keyPrefix: row.keyPrefix, label: row.label },
        null,
        2,
      ),
    );
  } finally {
    await store.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

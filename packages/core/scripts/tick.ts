#!/usr/bin/env tsx
/**
 * `pnpm tick` — S-06, tasks/S-06.md "In scope": "CLI `pnpm tick` runs one tick locally (dry-run
 * unless env says otherwise; the CLI never flips live)."
 *
 * Deliberately has NO `--live` flag (unlike `treasury-claim.ts`/`treasury-buy.ts`, S-04/S-05's own
 * CLIs) — whether this tick can send anything live is entirely `env.TREASURER_LIVE`'s call
 * (CLAUDE.md rule 5); this script never overrides it either way. Same kit-default store as the
 * other CLIs (`openSqliteLedger(env.LEDGER_SQLITE_PATH)`, CLAUDE.md #5c: no Supabase account
 * needed to run this locally) and the same reference-agent slug the router/tick route use
 * (`env.REFERENCE_AGENT_SLUG`), so a local `pnpm tick` run and a deployed cron tick share one
 * agent identity.
 */
import { loadEnv } from '../src/env.js';
import { openSqliteLedger } from '../src/ledger/sqlite/store.js';
import { redact } from '../src/redact.js';
import { runTick } from '../src/tick/tick.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const store = openSqliteLedger(env.LEDGER_SQLITE_PATH);
  try {
    const summary = await runTick({
      store,
      agentSlug: env.REFERENCE_AGENT_SLUG,
      now: new Date(),
      env,
    });
    // `runTick()`'s result never carries a secret (tick/tick.ts's `TickSummary`/`RunTickResult`
    // types) — `redact()` here is belt-and-braces, matching every other CLI's own convention.
    console.log(JSON.stringify(redact(summary), null, 2));
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

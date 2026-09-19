#!/usr/bin/env tsx
/**
 * `pnpm dev:mock` (S-10 fix, tasks/S-10.md Test report Blocker 1) — starts the S-01 fake Orbio
 * upstream (`apps/web/test/fake-upstream.ts`, a real `node:http` server replaying synthetic,
 * dated fixtures — CLAUDE.md: "Never call the real Orbio gateway in tests") and points a
 * `next dev --webpack` child process at it via `ORBIO_GATEWAY_BASE_URL`/`ORBIO_KEY`. This is the
 * zero-external-accounts path README.md's "Run it locally" quickstart documents: no real Orbio
 * key, no chain wallet, no Supabase — just SQLite (the kit's own default, CLAUDE.md #5c) plus
 * this in-process fake.
 *
 * `startMockUpstream()` is exported so `scripts/readme-quickstart.test.ts` can drive the exact
 * same upstream directly (without spawning a child `next dev`) to assert the README's literal
 * `/v1/models` claim against it.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type FakeUpstream, startFakeUpstream } from '../apps/web/test/fake-upstream.js';

const WEB_APP_DIR = fileURLToPath(new URL('../apps/web/', import.meta.url));
const NEXT_BIN = join(WEB_APP_DIR, 'node_modules', '.bin', 'next');

/** Starts the fake upstream on an ephemeral port (same as the test suite) — the caller reads
 *  back the real `baseUrl` rather than a script guessing a fixed port. */
export function startMockUpstream(): Promise<FakeUpstream> {
  return startFakeUpstream('ok');
}

async function main(): Promise<void> {
  const upstream = await startMockUpstream();
  console.log(
    `[dev:mock] fake Orbio upstream (in-process, synthetic fixtures) at ${upstream.baseUrl}`,
  );
  console.log(
    '[dev:mock] no real Orbio account needed — ORBIO_GATEWAY_BASE_URL/ORBIO_KEY below point at it.',
  );

  // Extra CLI args (e.g. `-p 3919`) are forwarded to `next dev` — used by
  // `scripts/dev-mock.test.ts` to pin a non-default port instead of colliding with a real `pnpm
  // dev:mock` a developer might have running on 3000.
  const extraArgs = process.argv.slice(2);
  const child = spawn(NEXT_BIN, ['dev', '--webpack', ...extraArgs], {
    cwd: WEB_APP_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      ORBIO_GATEWAY_BASE_URL: upstream.baseUrl,
      ORBIO_KEY: process.env.ORBIO_KEY ?? 'mock-dev-key-not-real',
    },
  });

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void upstream.close().finally(() => process.exit(code));
  };
  child.on('exit', (code) => shutdown(code ?? 0));
  child.on('error', (err) => {
    console.error('[dev:mock] failed to start next dev:', err);
    shutdown(1);
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// Only run the server when invoked directly (`tsx scripts/mock-upstream.ts` / `pnpm dev:mock`) —
// not when imported for its `startMockUpstream()` export by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

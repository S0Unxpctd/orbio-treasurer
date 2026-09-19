/**
 * Exercises README.md's "Run it locally" — "Zero external accounts" quickstart literally: spawns
 * `pnpm dev:mock` (this repo's real `next dev --webpack`, pointed at the in-process fake Orbio
 * upstream by `scripts/mock-upstream.ts`) as a real child process, then runs the exact documented
 * `curl -s http://localhost:<port>/v1/models` against it — no `ORBIO_KEY`/`ORBIO_GATEWAY_BASE_URL`
 * set by this test itself; the script sets them internally, which is the whole point of Blocker 1
 * (tasks/S-10.md Test report) this test guards against regressing.
 *
 * Slow (spawns a real Next dev server) — given a generous timeout and run once, not per-file-watch.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3919; // distinct from the default 3000 so this never collides with a developer's own `pnpm dev:mock`.

let child: ChildProcess | undefined;

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status === 200 || res.status === 404) return; // server is up and routing
    } catch {
      // not listening yet
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`dev:mock did not become ready within ${timeoutMs}ms`);
    }
    await delay(250);
  }
}

afterAll(() => {
  child?.kill('SIGTERM');
});

describe('pnpm dev:mock — README "Run it locally" zero-external-accounts quickstart', () => {
  it("GET /v1/models (the README's literal curl target) returns real Orbio-shaped ids with no ORBIO_KEY/ORBIO_GATEWAY_BASE_URL set here", async () => {
    const childEnv = { ...process.env };
    delete childEnv.ORBIO_KEY;
    delete childEnv.ORBIO_GATEWAY_BASE_URL;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/mock-upstream.ts', '-p', String(PORT)],
      { cwd: REPO_ROOT, env: childEnv },
    );

    await waitForReady(`http://localhost:${PORT}/api/health`, 20_000);

    const res = await fetch(`http://localhost:${PORT}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'orbio/tiny-instruct',
        'orbio/small-chat',
        'orbio/mid-reasoner',
        'orbio/large-flagship',
        'auto',
        'auto:S',
        'auto:M',
        'auto:L',
      ]),
    );
  }, 30_000);
});

/**
 * S-09 AC2/AC3/AC4/AC6 — the kit's generated agent driven as a child process against a REAL
 * local gateway (`next dev --webpack`, per this ticket's builder brief), a fake Orbio upstream
 * (S-01's `startFakeUpstream`, reused per the brief), and a fake RSS server. Nothing here ever
 * calls the real Orbio gateway or a real feed.
 *
 * Two things this file works around, both discovered while building it (see tasks/S-09.md
 * Build notes):
 *
 *  - The fake upstream/RSS servers run *in this same process* (plain `node:http`, like S-01's
 *    `startFakeUpstream`). Every child process this file spawns and waits on therefore uses
 *    ASYNC `spawn()` + an event-based wait, never `spawnSync()` — `spawnSync` blocks this
 *    process's entire event loop until the child exits, which would starve those in-process
 *    servers of the very requests the child is making, deadlocking the run.
 *  - `next dev` (Next 16) runs a single *persistent* dev server per directory: closing the CLI
 *    process it prints from does not stop the actual `next-server` worker it forked, and a
 *    second `next dev` in the same `apps/web` directory refuses to start while one is still up
 *    (tracked in `apps/web/.next/dev/lock`, `{pid, port, ...}`). `stopGateway()` below kills both
 *    the spawned wrapper and the pid the lock file names, then removes the lock — otherwise a
 *    killed-but-not-reaped run leaks into the next one.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FakeUpstream, startFakeUpstream } from '../../../apps/web/test/fake-upstream.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const BIN_PATH = join(PACKAGE_ROOT, 'bin', 'create-orbio-agent.js');
const WEB_APP_DIR = join(REPO_ROOT, 'apps', 'web');
const NEXT_BIN = join(WEB_APP_DIR, 'node_modules', '.bin', 'next');
const NEXT_DEV_LOCK = join(WEB_APP_DIR, '.next', 'dev', 'lock');

const TEST_KEY = `otk_${'e'.repeat(32)}`;
const UPSTREAM_KEY = 'sk-or-v1-TESTONLY';

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Fake Feed</title>
<item><title>Item One: robots learn to summarise things</title></item>
<item><title>Item Two: a gateway routes to the cheapest model</title></item>
</channel></rss>`;

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Async equivalent of `spawnSync` — see this file's header for why `spawnSync` itself is never
 *  used here. */
function runNode(
  command: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

interface FakeRss {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function startFakeRss(): Promise<FakeRss> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(RSS_XML);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake RSS server failed to bind a port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not allocate a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function readLockPid(): number | null {
  try {
    const parsed = JSON.parse(readFileSync(NEXT_DEV_LOCK, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** Kills `next dev`'s persistent worker (see this file's header) and clears its lock — safe to
 *  call even if nothing is running (defensive, for a previous crashed run's leftovers too). */
function stopGateway(child: ChildProcess | null): void {
  const lockPid = readLockPid();
  if (child?.pid) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (lockPid) {
    try {
      process.kill(lockPid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    rmSync(NEXT_DEV_LOCK, { force: true });
  } catch {
    // nothing to remove
  }
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`gateway on port ${port} did not become healthy in time: ${String(lastError)}`);
}

describe('S-09 kit vs. a real local gateway (AC2, AC3, AC4, AC6)', () => {
  let fakeUpstream: FakeUpstream;
  let fakeRss: FakeRss;
  let gatewayPort: number;
  let gatewayChild: ChildProcess | null = null;
  let ledgerDir: string;
  let scaffoldRoot: string;
  const gatewayUrl = () => `http://127.0.0.1:${gatewayPort}`;

  beforeAll(async () => {
    stopGateway(null); // clear any stale lock from a previous crashed run

    fakeUpstream = await startFakeUpstream('ok');
    fakeRss = await startFakeRss();
    ledgerDir = mkdtempSync(join(tmpdir(), 's09-ledger-'));
    scaffoldRoot = mkdtempSync(join(tmpdir(), 's09-scaffold-'));
    gatewayPort = await getFreePort();

    gatewayChild = spawn(NEXT_BIN, ['dev', '--webpack', '-p', String(gatewayPort)], {
      cwd: WEB_APP_DIR,
      env: {
        ...process.env,
        LEDGER: 'sqlite',
        LEDGER_SQLITE_PATH: join(ledgerDir, 'treasurer.db'),
        GATEWAY_KEYS: TEST_KEY,
        ORBIO_GATEWAY_BASE_URL: fakeUpstream.baseUrl,
        ORBIO_KEY: UPSTREAM_KEY,
        REFERENCE_AGENT_SLUG: 'treasurer',
      },
      stdio: 'ignore',
    });

    await waitForHealth(gatewayPort, 60_000);
  }, 90_000);

  afterAll(async () => {
    stopGateway(gatewayChild);
    await fakeUpstream?.close();
    await fakeRss?.close();
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(scaffoldRoot, { recursive: true, force: true });
  }, 30_000);

  it('AC2/AC3: agent.mjs calls the gateway with model:"auto" (metered in tier S/M), and register.mjs run twice yields exactly one agent row', async () => {
    const name = 'e2e-agent';
    const create = await runNode(
      process.execPath,
      [BIN_PATH, name, '--gateway', gatewayUrl(), '--key', TEST_KEY],
      { cwd: scaffoldRoot },
    );
    expect(create.status).toBe(0);
    const agentDir = join(scaffoldRoot, name);
    expect(existsSync(join(agentDir, '.env'))).toBe(true);

    // AC2: `node agent.mjs` (via the README's `npm start`, --env-file=.env) prints a summary.
    const run = await runNode(process.execPath, ['--env-file=.env', 'agent.mjs'], {
      cwd: agentDir,
      env: { ...process.env, FEEDS: fakeRss.baseUrl },
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim().length).toBeGreaterThan(0);

    // The gateway recorded the call against the reference agent, tier S or M (S-01/S-06's
    // synthetic catalog fixture: a plain summary routes to the cheapest, S, tier).
    const stats = (await fetch(`${gatewayUrl()}/api/stats`).then((r) => r.json())) as {
      savings: { byTier: readonly { tier: string; calls: number }[] };
    };
    const sOrMCalls = stats.savings.byTier
      .filter((t) => t.tier === 'S' || t.tier === 'M')
      .reduce((sum, t) => sum + t.calls, 0);
    expect(sOrMCalls).toBeGreaterThanOrEqual(1);

    // AC3: register.mjs run twice → still exactly one `agents` row for this agent.
    const register1 = await runNode(process.execPath, ['--env-file=.env', 'register.mjs'], {
      cwd: agentDir,
    });
    expect(register1.status).toBe(0);
    const register2 = await runNode(process.execPath, ['--env-file=.env', 'register.mjs'], {
      cwd: agentDir,
    });
    expect(register2.status).toBe(0);
    expect(register2.stdout).toContain('already registered');

    const agents = (await fetch(`${gatewayUrl()}/api/agents`).then((r) => r.json())) as {
      agents: readonly { name: string }[];
    };
    const matching = agents.agents.filter((a) => a.name === name);
    expect(matching).toHaveLength(1);
  });

  it('AC4: gateway down → agent.mjs exits 1 with a one-line error, no stack trace, no key', async () => {
    const name = 'e2e-agent-down';
    const create = await runNode(
      process.execPath,
      // Port 1: nothing listens there in this sandbox, so the connection is refused immediately.
      [BIN_PATH, name, '--gateway', 'http://127.0.0.1:1', '--key', TEST_KEY],
      { cwd: scaffoldRoot },
    );
    expect(create.status).toBe(0);
    const agentDir = join(scaffoldRoot, name);

    const run = await runNode(process.execPath, ['--env-file=.env', 'agent.mjs'], {
      cwd: agentDir,
      env: { ...process.env, FEEDS: fakeRss.baseUrl },
    });

    expect(run.status).not.toBe(0);
    const stderrLines = run.stderr.trim().split('\n').filter(Boolean);
    expect(stderrLines).toHaveLength(1);
    expect(run.stderr).not.toContain('at ');
    expect(run.stderr).not.toContain(TEST_KEY);
    expect(run.stdout.trim()).toBe('');
  });

  it('AC6: the README quickstart works end to end (npx create-orbio-agent, npm start, npm run register)', async () => {
    const name = 'e2e-quickstart';
    const create = await runNode(
      process.execPath,
      [BIN_PATH, name, '--gateway', gatewayUrl(), '--key', TEST_KEY],
      { cwd: scaffoldRoot },
    );
    expect(create.status).toBe(0);
    const agentDir = join(scaffoldRoot, name);

    // --key was passed, so .env already has ORBIO_TREASURER_KEY — the README's "cp .env.example
    // .env, then fill it in" step is this case's documented no-op.
    const start = await runNode('npm', ['start'], {
      cwd: agentDir,
      env: { ...process.env, FEEDS: fakeRss.baseUrl },
    });
    expect(start.status).toBe(0);
    expect(start.stdout).toContain('routed to');

    const register = await runNode('npm', ['run', 'register'], { cwd: agentDir });
    expect(register.status).toBe(0);
    expect(register.stdout).toContain('registered');
  });
});

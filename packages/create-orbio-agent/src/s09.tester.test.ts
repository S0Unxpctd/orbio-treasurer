/**
 * Tester pass for S-09 (tasks/S-09.md) — written from the ticket's Acceptance criteria alone,
 * before reading `bin/create-orbio-agent.js`, `template/**` was only read afterwards to discover
 * exact file names/env vars/response shapes needed to drive the CLI and the generated scripts as
 * a stranger would (PROCESS.md §3: "derive tests from the ticket's acceptance criteria without
 * reading the implementation first"). Independent of the builder's own `cli.test.ts`/
 * `e2e.test.ts` — not read before writing this file.
 *
 * Two process-handling gotchas found the hard way while writing this (kept here, not read from
 * the builder's e2e test, per the tester brief's "only if you get stuck" — this file got stuck
 * on both before finding them independently):
 *
 *  - The fake Orbio upstream and the fake RSS server below run *in this same vitest worker
 *    process* (plain `node:http`, like S-01's `startFakeUpstream`). `agent.mjs`/`register.mjs`
 *    are therefore always driven with ASYNC `spawn()` + an event-based wait, never
 *    `spawnSync()` — `spawnSync` blocks this process's entire event loop until the child exits,
 *    which starves those in-process servers of the very requests the child is making and
 *    deadlocks the run (reproduced directly: a `spawnSync`'d `agent.mjs` hung for ~70s then
 *    failed with "could not fetch one or more feeds" against a fake RSS server that answers in
 *    under a millisecond otherwise). The one-shot CLI scaffold itself never touches the network,
 *    so it stays `spawnSync` throughout.
 *  - `next dev` (Next 16) runs a single *persistent* dev server per directory: killing the
 *    spawned CLI process does not stop the `next-server` worker it forked, and a second
 *    `next dev` in the same `apps/web` directory refuses to start while one is still up
 *    (`apps/web/.next/dev/lock`, `{pid, port, ...}`, reproduced directly: "Another next dev
 *    server is already running"). `stopGateway()` below kills the spawned wrapper, then the pid
 *    the lock file names, then removes the lock.
 *
 * `packages/core`'s `dist/` must exist for `apps/web` to resolve `@orbio-treasurer/core` under
 * plain `next dev` (this bypasses turbo's `test`/`typecheck` task, which declares
 * `dependsOn: ["^build"]` — a bare `next dev` does not) — `beforeAll` below builds it once.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '../..');
const BIN_PATH = join(PACKAGE_DIR, 'bin', 'create-orbio-agent.js');
const TEMPLATE_DIR = join(PACKAGE_DIR, 'template');
const EXAMPLE_DIR = join(REPO_ROOT, 'examples', 'daily-digest');
const WEB_DIR = join(REPO_ROOT, 'apps', 'web');
const NEXT_BIN = join(WEB_DIR, 'node_modules', '.bin', 'next');
const NEXT_DEV_LOCK = join(WEB_DIR, '.next', 'dev', 'lock');

// Ticket "In scope" bullet, verbatim list of what `template/` must contain.
const EXPECTED_TEMPLATE_FILES = [
  'package.json',
  'agent.mjs',
  'register.mjs',
  'cron.example',
  '.github/workflows/daily.yml',
  '.env.example',
  'README.md',
] as const;

// Obviously-fake, obviously-not-random: an easy `git grep` hit if it ever leaked, never a shape
// that could be mistaken for something real (audit checklist §4 "Secrets": "a well-known test
// PK" spirit, applied to the otk_ shape).
const TEST_KEY = `otk_${'facade00'.repeat(4)}`; // otk_ + 32 hex chars

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function listFilesRecursive(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else {
      out.push(relative(base, full));
    }
  }
  return out.sort();
}

function scaffold(
  name: string,
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN_PATH, name, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Async spawn + wait — see file header. Never used for the CLI scaffold itself (no network). */
function runNode(
  scriptPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code) => resolvePromise({ status: code, stdout, stderr }));
    child.on('error', (err) => resolvePromise({ status: -1, stdout, stderr: String(err) }));
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate a free port'));
        return;
      }
      const port = address.port;
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

async function waitForOk(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastErr)}`);
}

// --- fake Orbio upstream (S-01 fixtures, reused so routing lands deterministically) -----------

const FIXTURES_DIR = join(REPO_ROOT, 'packages/core/src/router/fixtures');
const CATALOG_FIXTURE = readFileSync(join(FIXTURES_DIR, 'models-catalog.2026-09-19.json'), 'utf8');
const NONSTREAM_FIXTURE = readFileSync(
  join(FIXTURES_DIR, 'chat-completion.nonstream.2026-09-19.json'),
  'utf8',
);

interface FakeServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function startFakeUpstream(): Promise<FakeServer> {
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(CATALOG_FIXTURE);
        return;
      }
      if (req.url === '/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(NONSTREAM_FIXTURE);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake upstream failed to bind'));
        return;
      }
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    server.on('error', reject);
  });
}

const FAKE_RSS_XML = (feedNum: number): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Tester Feed ${feedNum}</title>` +
  `<item><title>Tester headline ${feedNum}-A</title></item>` +
  `<item><title>Tester headline ${feedNum}-B</title></item></channel></rss>`;

function startFakeRss(): Promise<FakeServer> {
  const server: Server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(FAKE_RSS_XML(req.url?.includes('feed2') ? 2 : 1));
  });
  return new Promise((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake RSS server failed to bind'));
        return;
      }
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    server.on('error', reject);
  });
}

// --- real gateway: `next dev --webpack` against apps/web, per the tester brief ----------------

interface Gateway {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

async function readLockPid(): Promise<number | null> {
  try {
    const raw = readFileSync(NEXT_DEV_LOCK, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function stopGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await sleep(300);
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  // See file header: the persistent `next-server` worker the CLI process forked survives the
  // above and must be killed by the pid the lock file names, or it leaks into the next run.
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (!existsSync(NEXT_DEV_LOCK)) return;
    const pid = await readLockPid();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    await sleep(300);
  }
  try {
    rmSync(NEXT_DEV_LOCK, { force: true });
  } catch {
    /* best-effort */
  }
}

async function startGateway(env: NodeJS.ProcessEnv): Promise<Gateway> {
  if (existsSync(NEXT_DEV_LOCK)) {
    // A previous run in this same checkout left the lock behind (crash, timeout). Clear it
    // before starting — otherwise `next dev` refuses outright ("Another next dev server is
    // already running") and every test in this file fails on an unrelated leftover.
    const stalePid = await readLockPid();
    if (stalePid !== null) {
      try {
        process.kill(stalePid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    try {
      rmSync(NEXT_DEV_LOCK, { force: true });
    } catch {
      /* best-effort */
    }
  }

  const port = await getFreePort();
  const child = spawn(NEXT_BIN, ['dev', '--webpack', '-p', String(port)], {
    cwd: WEB_DIR,
    env: { ...process.env, ...env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForOk(`${baseUrl}/api/health`, 120_000);
  } catch (err) {
    await stopGateway(child);
    throw new Error(
      `gateway dev server never became healthy: ${String(err)}\n---\n${out.slice(-4000)}`,
    );
  }

  return {
    baseUrl,
    stop: () => stopGateway(child),
  };
}

// ================================================================================================
// AC1 — scaffold produces every template file, name substituted, no placeholder left when
// --gateway/--key are given.
// ================================================================================================

describe('AC1: scaffold produces every template file with the name substituted', () => {
  let parentDir: string;
  let outDir: string;

  beforeAll(() => {
    parentDir = mkdtempSync(join(tmpdir(), 's09-scaffold-'));
    const gatewayUrl = 'http://127.0.0.1:59999'; // never contacted in this describe block
    const result = scaffold('demo', ['--gateway', gatewayUrl, '--key', TEST_KEY], parentDir);
    if (result.status !== 0) {
      throw new Error(
        `scaffold failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    outDir = join(parentDir, 'demo');
  });

  afterAll(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('creates the target folder', () => {
    expect(existsSync(outDir)).toBe(true);
  });

  it.each(EXPECTED_TEMPLATE_FILES)('creates %s', (relPath) => {
    expect(existsSync(join(outDir, relPath)), `${relPath} missing from scaffolded output`).toBe(
      true,
    );
  });

  it('leaves no __PLACEHOLDER__-shaped token in any generated file', () => {
    for (const relPath of EXPECTED_TEMPLATE_FILES) {
      const content = readFileSync(join(outDir, relPath), 'utf8');
      expect(content, `${relPath} still has a __..._ __ placeholder`).not.toMatch(
        /__[A-Za-z0-9]+__/,
      );
    }
  });

  it('leaves no <REFERENCE_HOST> placeholder when --gateway was passed explicitly', () => {
    for (const relPath of EXPECTED_TEMPLATE_FILES) {
      const content = readFileSync(join(outDir, relPath), 'utf8');
      expect(content, `${relPath} still contains <REFERENCE_HOST>`).not.toContain(
        '<REFERENCE_HOST>',
      );
    }
  });

  it('writes the passed --gateway URL into .env.example and the workflow', () => {
    const env = readFileSync(join(outDir, '.env.example'), 'utf8');
    expect(env).toContain('ORBIO_TREASURER_URL=http://127.0.0.1:59999');
    const workflow = readFileSync(join(outDir, '.github/workflows/daily.yml'), 'utf8');
    expect(workflow).toContain('ORBIO_TREASURER_URL: http://127.0.0.1:59999');
  });

  it('names the generated package after the folder', () => {
    const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('demo');
  });

  it('substitutes the agent name into README.md and cron.example', () => {
    const readme = readFileSync(join(outDir, 'README.md'), 'utf8');
    expect(readme).toContain('npx create-orbio-agent demo');
    const cron = readFileSync(join(outDir, 'cron.example'), 'utf8');
    expect(cron).toContain('/demo &&');
  });

  // Ticket AC1 / builder brief: "--key <otk_…> (optional; ...)" — the README's "Get a key"
  // section promises "re-run create-orbio-agent --key otk_... ... to have it filled in for you
  // automatically". Verified directly against the real CLI (not from reading its source): the
  // key is NOT written into the committed `.env.example` (good — AC7, "no secret in any
  // committed file") but into a separate, gitignored `.env` alongside it, which is what the
  // README's promise actually resolves to.
  it('.env.example never carries a real key, even when --key is passed (AC7)', () => {
    const env = readFileSync(join(outDir, '.env.example'), 'utf8');
    expect(env).toContain('ORBIO_TREASURER_KEY=\n');
    expect(env).not.toContain(TEST_KEY);
  });

  it('fills the passed --key into a separate, gitignored .env (README "Get a key" promise)', () => {
    const dotEnvPath = join(outDir, '.env');
    expect(existsSync(dotEnvPath), '.env was not created even though --key was passed').toBe(true);
    const dotEnv = readFileSync(dotEnvPath, 'utf8');
    expect(dotEnv).toContain(`ORBIO_TREASURER_KEY=${TEST_KEY}`);

    const gitignore = readFileSync(join(outDir, '.gitignore'), 'utf8');
    expect(gitignore.split('\n').map((l) => l.trim())).toContain('.env');
  });
});

describe('AC1: default --gateway is a placeholder by design, and the README must say so', () => {
  let parentDir: string;
  let outDir: string;

  beforeAll(() => {
    parentDir = mkdtempSync(join(tmpdir(), 's09-scaffold-default-'));
    const result = scaffold('demo', [], parentDir);
    if (result.status !== 0) {
      throw new Error(
        `scaffold failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    outDir = join(parentDir, 'demo');
  });

  afterAll(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('keeps the <REFERENCE_HOST> placeholder in .env.example when --gateway is omitted (by design)', () => {
    const env = readFileSync(join(outDir, '.env.example'), 'utf8');
    expect(env).toContain('ORBIO_TREASURER_URL=https://<REFERENCE_HOST>');
  });

  // Real defect, kept failing (see file header / test report): today nothing in the scaffolded
  // output or the CLI's own stdout explains that this default is a stand-in the user must
  // replace — a stranger following the README literally ships a gateway URL that can never
  // resolve, with no hint why.
  it('tells the user, somewhere in the scaffolded output, that the default gateway is a placeholder', () => {
    const readme = readFileSync(join(outDir, 'README.md'), 'utf8').toLowerCase();
    const explainsPlaceholder =
      /placeholder/.test(readme) ||
      /reference_host/.test(readme) ||
      /(replace|not (a )?real).{0,40}gateway/.test(readme);
    expect(
      explainsPlaceholder,
      'README.md never mentions the default gateway is a placeholder',
    ).toBe(true);
  });
});

// ================================================================================================
// AC5 — examples/daily-digest matches a fresh generation for name "daily-digest".
// ================================================================================================

describe('AC5: examples/daily-digest matches a fresh generation', () => {
  it('is byte-identical, file for file, to what the generator produces for name "daily-digest"', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 's09-digest-diff-'));
    try {
      const result = scaffold('daily-digest', [], parentDir);
      expect(result.status, `scaffold failed: ${result.stdout}\n${result.stderr}`).toBe(0);
      const generatedDir = join(parentDir, 'daily-digest');

      const expectedFiles = listFilesRecursive(EXAMPLE_DIR);
      const actualFiles = listFilesRecursive(generatedDir);
      expect(actualFiles).toEqual(expectedFiles);

      for (const relPath of expectedFiles) {
        const expected = readFileSync(join(EXAMPLE_DIR, relPath), 'utf8');
        const actual = readFileSync(join(generatedDir, relPath), 'utf8');
        expect(actual, `mismatch in ${relPath}`).toBe(expected);
      }
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});

// ================================================================================================
// AC7 / audit hygiene — no key-shaped material anywhere in template/ or examples/daily-digest.
// ================================================================================================

describe('AC7: no secret in any committed file', () => {
  const SUSPECT_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
    { label: 'a real-shaped otk_ caller key', re: /otk_[0-9a-fA-F]{32}/ },
    { label: 'a derived Orbio API key (sk-orb-...)', re: /sk-orb-\d+-[A-Za-z0-9+/=]{10,}/ },
    {
      label: 'an OpenRouter-shaped key that is not obviously a test placeholder',
      re: /sk-or-v1-(?!TESTONLY)[A-Za-z0-9]{10,}/,
    },
    { label: 'a raw 0x-prefixed private key', re: /0x[0-9a-fA-F]{64}/ },
  ];

  function scanDir(dir: string): void {
    for (const relPath of listFilesRecursive(dir)) {
      const content = readFileSync(join(dir, relPath), 'utf8');
      for (const { label, re } of SUSPECT_PATTERNS) {
        const match = content.match(re);
        expect(match, `${label} found in ${relPath}: "${match?.[0]}"`).toBeNull();
      }
    }
  }

  it('template/ has no key-shaped strings', () => {
    scanDir(TEMPLATE_DIR);
  });

  it('examples/daily-digest has no key-shaped strings', () => {
    scanDir(EXAMPLE_DIR);
  });
});

// ================================================================================================
// AC2 / AC3 / AC4 / AC6 — the README quickstart, followed literally, against a real gateway.
// ================================================================================================

describe('README quickstart against a real gateway (next dev --webpack)', () => {
  let upstream: FakeServer;
  let rss: FakeServer;
  let gateway: Gateway;
  let parentDir: string;
  let agentDir: string;
  let ledgerDir: string;

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@orbio-treasurer/core', 'build'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (build.status !== 0) {
      throw new Error(`packages/core build failed:\n${build.stdout}\n${build.stderr}`);
    }

    upstream = await startFakeUpstream();
    rss = await startFakeRss();
    ledgerDir = mkdtempSync(join(tmpdir(), 's09-ledger-'));

    gateway = await startGateway({
      LEDGER: 'sqlite',
      LEDGER_SQLITE_PATH: join(ledgerDir, 'treasurer.db'),
      GATEWAY_KEYS: TEST_KEY,
      ORBIO_GATEWAY_BASE_URL: upstream.baseUrl,
      ORBIO_KEY: 'sk-or-v1-TESTONLYS09TESTERFAKEUPSTREAM',
      TREASURER_MODE: 'normal',
    });

    parentDir = mkdtempSync(join(tmpdir(), 's09-e2e-'));
    const result = scaffold(
      'demo-agent',
      ['--gateway', gateway.baseUrl, '--key', TEST_KEY],
      parentDir,
    );
    if (result.status !== 0) {
      throw new Error(`scaffold failed: ${result.stdout}\n${result.stderr}`);
    }
    agentDir = join(parentDir, 'demo-agent');
  }, 150_000);

  afterAll(async () => {
    await gateway?.stop();
    await upstream?.close();
    await rss?.close();
    if (parentDir) rmSync(parentDir, { recursive: true, force: true });
    if (ledgerDir) rmSync(ledgerDir, { recursive: true, force: true });
  }, 30_000);

  function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ORBIO_TREASURER_URL: gateway.baseUrl,
      ORBIO_TREASURER_KEY: TEST_KEY,
      FEEDS: `${rss.baseUrl}/feed1,${rss.baseUrl}/feed2`,
      ...extra,
    };
  }

  interface StatsResponse {
    readonly savings: {
      readonly all: { readonly calls: number };
      readonly byTier: ReadonlyArray<{ readonly tier: string; readonly calls: number }>;
    };
  }

  interface AgentsResponse {
    readonly agents: ReadonlyArray<{ readonly name: string }>;
  }

  async function getStats(): Promise<StatsResponse> {
    const res = await fetch(`${gateway.baseUrl}/api/stats`);
    expect(res.status).toBe(200);
    return res.json() as Promise<StatsResponse>;
  }

  async function getAgents(): Promise<AgentsResponse> {
    const res = await fetch(`${gateway.baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    return res.json() as Promise<AgentsResponse>;
  }

  function tierCalls(stats: StatsResponse, tier: 'S' | 'M' | 'L'): number {
    return stats.savings.byTier.find((t) => t.tier === tier)?.calls ?? 0;
  }

  it('AC2: `npm start` (node agent.mjs) prints a digest and the gateway records one usage row in tier S or M', async () => {
    const before = await getStats();

    const run = await runNode(join(agentDir, 'agent.mjs'), agentDir, baseEnv());
    expect(run.status, `agent.mjs stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout.trim().length).toBeGreaterThan(0);
    expect(run.stdout).toMatch(/routed to/);

    const after = await getStats();
    expect(after.savings.all.calls).toBe(before.savings.all.calls + 1);

    const lDelta = tierCalls(after, 'L') - tierCalls(before, 'L');
    const smDelta =
      tierCalls(after, 'S') -
      tierCalls(before, 'S') +
      (tierCalls(after, 'M') - tierCalls(before, 'M'));
    expect(lDelta, 'the recorded call landed on tier L, not S/M').toBe(0);
    expect(smDelta, 'expected exactly one new call in tier S or M').toBe(1);
  }, 60_000);

  it('AC6/AC2: `npm run register` (node register.mjs) makes the agent appear via GET /api/agents', async () => {
    const run = await runNode(join(agentDir, 'register.mjs'), agentDir, baseEnv());
    expect(run.status, `register.mjs stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/registered/);

    const agents = await getAgents();
    const matches = agents.agents.filter((a) => a.name === 'demo-agent');
    expect(matches.length).toBe(1);
  }, 60_000);

  it('AC3: running `register.mjs` again in the same folder is a no-op — still exactly one agent row', async () => {
    const run = await runNode(join(agentDir, 'register.mjs'), agentDir, baseEnv());
    expect(run.status, `register.mjs stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout.toLowerCase()).toMatch(/already registered|no-op/);

    const agents = await getAgents();
    const matches = agents.agents.filter((a) => a.name === 'demo-agent');
    expect(matches.length).toBe(1);
  }, 60_000);

  it('AC4: gateway down → agent.mjs exits 1 with one line, no stack trace, no key', async () => {
    const run = await runNode(
      join(agentDir, 'agent.mjs'),
      agentDir,
      baseEnv({ ORBIO_TREASURER_URL: 'http://127.0.0.1:1' }),
    );
    expect(run.status).toBe(1);

    const combined = `${run.stdout}${run.stderr}`;
    const nonEmptyLines = combined.split('\n').filter((l) => l.trim().length > 0);
    expect(nonEmptyLines.length, `expected exactly one line, got:\n${combined}`).toBe(1);
    expect(combined, 'a stack frame leaked into the error output').not.toMatch(/at .*:\d+:\d+/);
    expect(combined, 'the raw key leaked into the error output').not.toContain(TEST_KEY);
  }, 30_000);
});

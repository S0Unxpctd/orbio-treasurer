/**
 * Tests for `create-orbio-agent`'s scaffolding that don't need a live gateway (S-09 AC1, AC5,
 * AC7). See `e2e.test.ts` for AC2/AC3/AC4/AC6, which drive a real local gateway.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN_PATH = join(PACKAGE_ROOT, 'bin', 'create-orbio-agent.js');
const TEMPLATE_DIR = join(PACKAGE_ROOT, 'template');
const EXAMPLE_DIR = join(PACKAGE_ROOT, '..', '..', 'examples', 'daily-digest');

// `otk_<32 hex>` shape (router/keys.ts) — clearly a test-only value, never a real key.
const TEST_KEY = `otk_${'a'.repeat(32)}`;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'create-orbio-agent-cli-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8' });
}

/** Every relative file path under `dir`, sorted — used to diff two scaffolded trees. `root`
 *  stays fixed across the recursion so a nested file's path (e.g. `.github/workflows/daily.yml`)
 *  is relative to the tree's top, not to its own immediate parent. */
function listFiles(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else out.push(relative(root, full));
  }
  return out.sort();
}

describe('create-orbio-agent scaffolding (AC1)', () => {
  it('creates every template file under ./<name>, with the name substituted', () => {
    const result = runCli(
      ['demo', '--gateway', 'http://127.0.0.1:9999', '--key', TEST_KEY],
      workDir,
    );
    expect(result.status).toBe(0);

    const targetDir = join(workDir, 'demo');
    expect(existsSync(targetDir)).toBe(true);
    // `--key` was passed, so a real `.env` is also written (see the AC7 describe block below)
    // — every template-sourced file is still present, plus that one extra.
    expect(listFiles(targetDir).filter((f) => f !== '.env')).toEqual(listFiles(TEMPLATE_DIR));

    const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('demo');

    const readme = readFileSync(join(targetDir, 'README.md'), 'utf8');
    expect(readme).toContain('# demo');
    expect(readme).not.toContain('__AGENT_NAME__');

    const workflow = readFileSync(join(targetDir, '.github', 'workflows', 'daily.yml'), 'utf8');
    expect(workflow).toContain('demo daily digest');
    expect(workflow).not.toContain('__AGENT_NAME__');
    expect(workflow).not.toContain('__GATEWAY_URL__');
  });

  it('refuses to scaffold into a directory that already exists', () => {
    mkdirSync(join(workDir, 'taken'));
    const result = runCli(['taken', '--key', TEST_KEY], workDir);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(workDir, 'taken', 'package.json'))).toBe(false);
  });

  it('rejects a name with path-breaking characters', () => {
    const result = runCli(['../evil'], workDir);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(workDir, '..', 'evil'))).toBe(false);
  });

  it('rejects a name containing "__" (would collide with the substitution token)', () => {
    const result = runCli(['a__b'], workDir);
    expect(result.status).not.toBe(0);
  });

  it('prints usage and exits non-zero with no arguments', () => {
    const result = runCli([], workDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Usage:');
  });
});

describe('.env / .env.example never carry a real key in a committed file (AC7)', () => {
  it('writes a real .env (with the resolved gateway + key) only when --key is given', () => {
    const withKey = runCli(
      ['has-key', '--gateway', 'http://127.0.0.1:9999', '--key', TEST_KEY],
      workDir,
    );
    expect(withKey.status).toBe(0);
    const envFile = readFileSync(join(workDir, 'has-key', '.env'), 'utf8');
    expect(envFile).toContain('ORBIO_TREASURER_URL=http://127.0.0.1:9999');
    expect(envFile).toContain(`ORBIO_TREASURER_KEY=${TEST_KEY}`);

    const noKey = runCli(['no-key', '--gateway', 'http://127.0.0.1:9999'], workDir);
    expect(noKey.status).toBe(0);
    expect(existsSync(join(workDir, 'no-key', '.env'))).toBe(false);
  });

  it('never substitutes the real key into .env.example, even when --key is passed', () => {
    runCli(['demo2', '--gateway', 'http://127.0.0.1:9999', '--key', TEST_KEY], workDir);
    const example = readFileSync(join(workDir, 'demo2', '.env.example'), 'utf8');
    expect(example).not.toContain(TEST_KEY);
    expect(example).toMatch(/^ORBIO_TREASURER_KEY=\s*$/m);
  });

  it('the committed template and example ship no secret at all', () => {
    for (const dir of [TEMPLATE_DIR, EXAMPLE_DIR]) {
      expect(existsSync(join(dir, '.env'))).toBe(false);
      for (const file of listFiles(dir)) {
        const text = readFileSync(join(dir, file), 'utf8');
        expect(text).not.toMatch(/^ORBIO_TREASURER_KEY=\S/m);
      }
    }
  });
});

describe('default --gateway placeholder warning (S-10 tasks/S-10.md AC3)', () => {
  it('prints a clear WARNING line to stdout when --gateway is omitted', () => {
    const result = runCli(['no-gateway'], workDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/WARNING/);
    expect(result.stdout).toContain('<REFERENCE_HOST>');
    expect(result.stdout).toContain('--gateway');
  });

  it('prints no such warning when --gateway is passed explicitly', () => {
    const result = runCli(['with-gateway', '--gateway', 'http://127.0.0.1:9999'], workDir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/WARNING/);
  });

  it('the scaffolded README explains the placeholder only when it is actually used', () => {
    runCli(['no-gateway2'], workDir);
    const withoutGateway = readFileSync(
      join(workDir, 'no-gateway2', 'README.md'),
      'utf8',
    ).toLowerCase();
    expect(withoutGateway).toMatch(/placeholder/);

    runCli(['with-gateway2', '--gateway', 'http://127.0.0.1:9999'], workDir);
    const withGateway = readFileSync(join(workDir, 'with-gateway2', 'README.md'), 'utf8');
    // The generic "always pass --gateway" advisory sentence stays either way (it's still true
    // advice); what must NOT appear once a real gateway was actually given is the specific
    // "this scaffold's URL is a placeholder" callout and the literal placeholder value itself.
    expect(withGateway).not.toContain('<REFERENCE_HOST>');
    expect(withGateway).not.toContain('**Placeholder gateway.**');
  });
});

describe('examples/daily-digest matches the generator output (AC5)', () => {
  it('is byte-identical to a fresh `daily-digest` scaffold with no flags', () => {
    const result = runCli(['daily-digest'], workDir);
    expect(result.status).toBe(0);
    const generatedDir = join(workDir, 'daily-digest');

    expect(listFiles(generatedDir)).toEqual(listFiles(EXAMPLE_DIR));
    for (const file of listFiles(generatedDir)) {
      const generated = readFileSync(join(generatedDir, file), 'utf8');
      const committed = readFileSync(join(EXAMPLE_DIR, file), 'utf8');
      expect(generated).toBe(committed);
    }
  });
});

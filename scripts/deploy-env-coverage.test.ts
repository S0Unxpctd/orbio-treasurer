/**
 * `docs/DEPLOY.md` env-var coverage (S-10, tasks/S-10.md AC5): "parse env.ts keys, assert each
 * appears in DEPLOY.md or in an explicit 'kit-only / test-only' list." This test parses
 * `packages/core/src/env.ts`'s schema keys directly from source (no import — the schema object
 * itself isn't exported, only `Env`/`loadEnv`) and checks every one is mentioned, by name, word-
 * bounded, somewhere in `docs/DEPLOY.md` — either in the main table (needed by the hosted app) or
 * in its "Not set for this deploy" section (kit-only/legacy/obsolete, with a reason given there).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ENV_TS_PATH = resolve(REPO_ROOT, 'packages/core/src/env.ts');
const DEPLOY_MD_PATH = resolve(REPO_ROOT, 'docs/DEPLOY.md');

/** Every top-level schema key in `env.ts`'s `baseSchema` — lines indented exactly two spaces,
 *  `UPPER_SNAKE_CASE:` at the start (the file's own consistent style; `LEDGER_VALUES` etc. are
 *  arrays, not object keys, and never match this shape). */
function extractEnvKeys(source: string): string[] {
  const re = /^ {2}([A-Z][A-Z0-9_]*):/gm;
  const keys: string[] = [];
  let match = re.exec(source);
  while (match) {
    keys.push(match[1] as string);
    match = re.exec(source);
  }
  return keys;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('docs/DEPLOY.md — every env.ts variable is accounted for (AC5)', () => {
  const envSource = readFileSync(ENV_TS_PATH, 'utf8');
  const deployMd = readFileSync(DEPLOY_MD_PATH, 'utf8');
  const keys = extractEnvKeys(envSource);

  it("found a non-trivial number of env.ts keys (the extractor isn't silently matching nothing)", () => {
    expect(keys.length).toBeGreaterThan(40);
  });

  it('every env.ts key is mentioned, whole-word, somewhere in docs/DEPLOY.md', () => {
    const missing: string[] = [];
    for (const key of keys) {
      const re = new RegExp(`\\b${escapeRegex(key)}\\b`);
      if (!re.test(deployMd)) missing.push(key);
    }
    expect(
      missing,
      `env.ts variable(s) not mentioned anywhere in DEPLOY.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('DEPLOY.md distinguishes what the hosted app needs from what it does not', () => {
    expect(deployMd).toMatch(/Not set for this deploy/i);
    // Spot-check one representative variable from each side of that line.
    expect(deployMd).toContain('TICK_SECRET');
    expect(deployMd).toContain('ORBIO_MCP_URL');
  });
});

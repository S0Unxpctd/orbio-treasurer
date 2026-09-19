/**
 * S-10 tester pass — automatable checks derived from tasks/S-10.md's acceptance criteria,
 * written independently of scripts/check-readme-links.test.ts (the builder's own test).
 *
 * Covers: README pnpm-command names resolve to real scripts, README markdown links resolve on
 * disk, no secret shape anywhere in the new/modified docs, SUBMISSION.md's word budget, and
 * LOOM-script.md's spoken-word budget for a 3-minute Loom at ~150 wpm.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

describe('README.md — pnpm command names resolve', () => {
  const README = read('README.md');
  const rootPkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const webPkg = JSON.parse(read('apps/web/package.json')) as { scripts?: Record<string, string> };
  const rootScripts = new Set(Object.keys(rootPkg.scripts ?? {}));
  const webScripts = new Set(Object.keys(webPkg.scripts ?? {}));

  it('every `pnpm <script>` invocation in README.md names a real root script (or a filter target)', () => {
    const re = /pnpm\s+(?:--filter\s+\S+\s+)?([a-zA-Z0-9:_-]+)/g;
    const unknown: string[] = [];
    let match = re.exec(README);
    while (match) {
      const name = match[1] as string;
      // "install" / "dev" (inside apps/web) are the two exceptions: `pnpm install` is a built-in
      // pnpm command, not a package.json script, and `pnpm dev --webpack` inside `apps/web` runs
      // that package's own `dev` script.
      if (name !== 'install' && !rootScripts.has(name) && !webScripts.has(name)) {
        unknown.push(name);
      }
      match = re.exec(README);
    }
    expect(unknown).toEqual([]);
  });
});

describe('README.md — markdown links resolve on disk', () => {
  const README = read('README.md');

  it('every relative `](path)` target exists relative to the repo root', () => {
    const re = /\]\(([^)]+)\)/g;
    const missing: string[] = [];
    let match = re.exec(README);
    while (match) {
      const target = (match[1] as string).split('#')[0] as string;
      if (!target || /^https?:\/\//.test(target) || target.startsWith('mailto:')) {
        match = re.exec(README);
        continue;
      }
      if (!existsSync(resolve(REPO_ROOT, target))) missing.push(target);
      match = re.exec(README);
    }
    expect(missing).toEqual([]);
  });
});

describe('Secret grep — new/modified S-10 docs', () => {
  const files = [
    'README.md',
    'STATUS.md',
    'docs/DEPLOY.md',
    'docs/SUBMISSION.md',
    'docs/LOOM-script.md',
    'packages/create-orbio-agent/README.md',
  ];
  // sk-orb-<epoch>-<base64 sig>, a real private key/tx hash shape (0x + 64 hex), a Supabase
  // service-role prefix, and a JWT-shaped string — CLAUDE.md rule 4 / S-10 AC7.
  const SECRET_PATTERNS: RegExp[] = [
    /sk-orb-\d/,
    /\b0x[0-9a-fA-F]{64}\b/,
    /\bsbp_[0-9a-fA-F]+/,
    /\beyJ[A-Za-z0-9_-]{10,}/,
  ];

  for (const file of files) {
    it(`${file} contains no secret-shaped string`, () => {
      const content = read(file);
      const hits = SECRET_PATTERNS.filter((re) => re.test(content));
      expect(hits).toEqual([]);
    });
  }
});

describe('docs/SUBMISSION.md — word budget', () => {
  const content = read('docs/SUBMISSION.md');

  it('the submission body (between the H2 heading and the Links line) is ≤ 300 words', () => {
    const start = content.indexOf('Orbio Treasurer is a gateway');
    const end = content.indexOf('Links:');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = content.slice(start, end);
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThanOrEqual(300);
  });
});

describe('docs/LOOM-script.md — fits a 3-minute Loom', () => {
  const content = read('docs/LOOM-script.md');

  it('total spoken words across every "What to say" cell, at 150 wpm, is ≤ 3:00', () => {
    // Table rows: | time | segment | what to show | what to say |  — the "what to say" cell is
    // the last `|`-delimited cell, always double-quoted.
    const rows = content.split('\n').filter((line) => line.startsWith('|') && line.includes('"'));
    expect(rows.length).toBeGreaterThan(0);
    let totalWords = 0;
    for (const row of rows) {
      const quoted = row.match(/"([^"]*)"/);
      expect(quoted).not.toBeNull();
      totalWords += (quoted?.[1] ?? '').split(/\s+/).filter(Boolean).length;
    }
    const minutesAt150wpm = totalWords / 150;
    expect(minutesAt150wpm).toBeLessThanOrEqual(3);
  });

  it('the segment time boxes in the table sum to ≤ 3:00', () => {
    const re = /\|\s*(\d+):(\d+)–(\d+):(\d+)\s*\|/g;
    let lastEndSeconds = 0;
    let match = re.exec(content);
    let found = false;
    while (match) {
      found = true;
      const endMin = Number(match[3]);
      const endSec = Number(match[4]);
      lastEndSeconds = endMin * 60 + endSec;
      match = re.exec(content);
    }
    expect(found).toBe(true);
    expect(lastEndSeconds).toBeLessThanOrEqual(180);
  });
});

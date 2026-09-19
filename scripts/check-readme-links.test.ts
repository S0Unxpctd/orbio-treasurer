/**
 * README.md link + content checks (S-10, tasks/S-10.md AC1).
 *
 * "No broken relative links: test with a small script that checks every `](path)` exists" —
 * extracts every markdown link's target, skips external/anchor/mailto links, resolves the rest
 * relative to the repo root (README.md's own location), and asserts each one exists on disk.
 * Also asserts the pitch line and the honest-limits (footer) sentence appear verbatim, per the
 * ticket's other AC1 requirement.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const README_PATH = resolve(REPO_ROOT, 'README.md');

const PITCH_LINE =
  "One base_url change. Your agents' crons cost less, because we route smarter and source " +
  'inference below list on Orbio, and you can verify it on-chain.';

// Verbatim `FOOTER_SENTENCE` from apps/web/app/model.ts — the page's own honest-limits sentence.
// Kept as a literal here (not imported) for the same reason scripts/smoke.ts keeps its own copy:
// this script has no dependency on apps/web's build graph.
const FOOTER_SENTENCE =
  'v1: the buy-and-stake leg is funded by seed capital and capped; caller billing is not live. ' +
  'Every on-chain action above links to its transaction.';

/** Every `[text](target)` markdown link's target, in order. Does not attempt to parse
 *  reference-style links (`[text][ref]`) — README.md uses only inline links. */
function extractLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const re = /\]\(([^)]+)\)/g;
  let match = re.exec(markdown);
  while (match) {
    targets.push(match[1] as string);
    match = re.exec(markdown);
  }
  return targets;
}

function isExternalOrNonFileLink(target: string): boolean {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('#')
  );
}

describe('README.md — links resolve (AC1)', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  const targets = extractLinkTargets(readme);

  it("contains at least one relative link to check (the test isn't vacuous)", () => {
    const relative = targets.filter((t) => !isExternalOrNonFileLink(t));
    expect(relative.length).toBeGreaterThan(0);
  });

  it('every relative ](path) link resolves to a file that exists', () => {
    const relative = targets.filter((t) => !isExternalOrNonFileLink(t));
    const missing: string[] = [];
    for (const target of relative) {
      const withoutFragment = target.split('#')[0] as string;
      const resolved = resolve(REPO_ROOT, withoutFragment);
      if (!existsSync(resolved)) missing.push(target);
    }
    expect(missing, `broken relative link(s): ${missing.join(', ')}`).toEqual([]);
  });
});

describe('README.md — required verbatim text (AC1)', () => {
  const readme = readFileSync(README_PATH, 'utf8');

  it('contains the PRD §1 pitch line verbatim', () => {
    expect(readme).toContain(PITCH_LINE);
  });

  it('contains the honest-limits (footer) sentence verbatim', () => {
    expect(readme).toContain(FOOTER_SENTENCE);
  });
});

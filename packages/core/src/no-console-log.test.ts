import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Biome already errors on console.log in packages/core (biome.json noConsole
 * allows only "error"). This test is a belt-and-braces backstop that greps the
 * package's own source for console.log(, independent of the lint config —
 * see CLAUDE.md non-negotiable #4 and ARCHITECTURE.md §8: core logs only
 * through log()/console.error, never console.log.
 */

const SRC_DIR = new URL('.', import.meta.url).pathname;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    files.push(fullPath);
  }
  return files;
}

describe('core never uses console.log', () => {
  it('has no console.log( call in any non-test .ts file under src/', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('console.log(')) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

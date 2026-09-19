import { defineConfig } from 'vitest/config';

/**
 * Root-level vitest config, scoped to `scripts/**` only (S-10, tasks/S-10.md "Tests required").
 * Every package under `packages/*`/`apps/*` has its own vitest config and its own `test` script,
 * run through `pnpm test` (turbo); this config exists only so `npx vitest run` from the repo
 * root picks up the new root-level scripts' tests without also re-running (or conflicting with)
 * every workspace package's own suite.
 */
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/**', 'apps/**', 'examples/**'],
  },
});

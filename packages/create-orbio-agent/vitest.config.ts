import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // e2e.test.ts spins up a real `next dev --webpack` for apps/web (S-09 builder brief) — cold
    // compile plus the persistent dev-server lifecycle need more than vitest's 5s default.
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
});

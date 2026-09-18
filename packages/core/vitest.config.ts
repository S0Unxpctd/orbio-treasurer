import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Sprint 1.0: the MCP client is obsolete since the CREDIT protocol (2026-09-16); its suite is
    // frozen out rather than maintained. See CLAUDE.md banner.
    exclude: ['**/node_modules/**', 'src/mcp/**'],
    environment: 'node',
  },
});

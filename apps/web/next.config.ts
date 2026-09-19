import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Discovered (tasks/S-08.md, AC6): `better-sqlite3` (S-08 is the first ticket that loads
  // SqliteLedgerStore inside apps/web) ships a native `.node` addon loaded through a dynamic,
  // webpack-unfriendly `require`; bundling it rewrites that lookup and the addon 404s at
  // runtime ("Cannot find module '.../build/Release/better_sqlite3.node'"). `serverExternalPackages`
  // is the documented fix: it tells Next to `require()` the package straight from node_modules
  // at runtime instead of bundling it.
  serverExternalPackages: ['better-sqlite3'],
  // Discovered (tasks/S-08.md, AC6): every relative import in this app (`_gateway.ts`,
  // `_data.ts`, `_ledger.ts`, `model.ts`, ...) is written `./foo.js` per the repo's NodeNext/ESM
  // convention (packages/core needs the real `.js` extension at runtime) — tsc and Vitest both
  // resolve that back to `./foo.ts`, but neither of Next 16's bundlers do by default, so every
  // route that imports a sibling module 500s under a real `next dev`/`next build` ("Module not
  // found"), including S-01's already-merged `/v1/models` and `/v1/chat/completions`. This alias
  // (the standard webpack5 fix for TS's `.js`-specifier convention) restores it for webpack;
  // Turbopack (the `next dev` default) needs its own `resolveExtensions`/`resolveAlias` fix —
  // not resolved here, see tasks/S-08.md Discovered. Run `next dev --webpack` until it is.
  webpack(config, { isServer }) {
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts', '.tsx'],
    };
    // `serverExternalPackages` above should already cover this (better-sqlite3 is even in
    // Next's own default externals list) but demonstrably doesn't in this pnpm workspace — see
    // the comment above. Force it directly on webpack's own `externals` as a fallback.
    if (isServer) {
      const existing = config.externals;
      config.externals = [
        ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
        'better-sqlite3',
      ];
    }
    return config;
  },
};

export default nextConfig;

# Audit report — T-001, pass 1 (2026-09-08, fresh auditor session)

Summary: 1 Blocker, 2 Major, 9 Minor, 2 Questions → in-code.

- **Blocker** — `pnpm probe <P-n>` crashes on every invocation: root package.json lacks `"type": "module"`, so tsx transpiles `scripts/probe.ts` as CJS and the top-level `await import()` fails at transform time. Usage and "no probe script" paths never reached. Load-bearing for P-1…P-8.
- **Major** — `pnpm test:policy` (`… test -- src/policy`) ignores the filter; vitest swallows `--` and runs the whole suite.
- **Major** — ARCHITECTURE §1 ("locked", changes via ADR) edited in-ticket Next 15 → 16 with no ADR; ADR-001 still says 15.
- Minor — `tsx` dependency not on ARCH §1 list, no ADR. Node 22 native type-stripping is an alternative.
- Minor — `scripts/` linted but never typechecked (no tsconfig covers it; root has no @types/node).
- Minor — test files excluded from typecheck in package tsconfigs.
- Minor — Biome `noConsole` allows `console.error` in core; `redact()` discipline rests on review. `apps/book-daily` strict, `apps/web` exempt: defensible, undocumented.
- Minor — CI hygiene: no `permissions`, `concurrency`, `timeout-minutes`; actions pinned by tag; `next build` not run in CI.
- Minor — turbo `test` task declares `coverage/**` outputs → "no output files" warning noise.
- Minor — `moduleResolution: Bundler` for tsc-compiled Node ESM packages allows extensionless imports that fail at runtime.
- Minor — scope creep: `/api/health` + placeholder page; `export type Layer` in core.
- Minor — `.npmrc` `strict-peer-dependencies=false` + `auto-install-peers=true` hides peer conflicts.
- Question — core and create-orbio-agent are `private: true`; FR-7.1 implies npm publish in T-025.
- Question — `better-sqlite3` (T-011) has a native build; needs adding to `onlyBuiltDependencies`.

ACs: (1) MET on clean clone; (2) CAN'T TELL (no remote, no CI run); (3) NOT MET (probe runner crashes; test:policy mis-filters).

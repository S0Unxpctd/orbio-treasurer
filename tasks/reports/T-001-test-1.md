# Test report — T-001, pass 1 (2026-09-08, fresh tester session, clean clone at /tmp)

14 checks: 13 PASS, 1 FAIL.

PASS: clean-clone hygiene (no build output tracked, lockfile tracked); ARCH §2 layout present; `pnpm install --frozen-lockfile` exit 0 no prompts; lint exit 0 (1 Biome deprecation info); typecheck 5/5; test (core 1 passed, others passWithNoTests); test:policy exit 0 (but see audit: filter ignored); all 9 CLAUDE.md root scripts present; `pnpm smoke` honest stub exit 0; `pnpm tick` honest stub exit 1 with clear message; CI workflow versions consistent with packageManager/engines and uses --frozen-lockfile; secrets grep clean, no .env tracked; all tsconfigs extend strict base; `apps/web` `next build` succeeds (~20s).

FAIL: `pnpm probe P-1` → esbuild "Top-level await is currently not supported with the cjs output format" (ERR_REQUIRE_ASYNC_MODULE), exit 1, stack trace; same with no argument, usage never printed. Root cause: root package.json lacks `"type": "module"`. Verified fixes: rename to `probe.mts`, or drop top-level await, or add `"type": "module"`.

Tests added: none (CLI behaviour; suggested CI one-liner `pnpm probe P-1; test $? -eq 2`).
Untestable: AC2 (CI green) until first push; `pnpm dev` / `pnpm db:migrate` existence only.
→ in-code.

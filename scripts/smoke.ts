#!/usr/bin/env tsx
/**
 * `pnpm smoke` (S-08 AC6) — Node `fetch` smoke test against `$SMOKE_BASE_URL`
 * (default `http://localhost:3000`), hitting `/`, `/api/stats`, `/api/agents` and asserting
 * 200 + the footer sentence + JSON shape. No Playwright, no browser — this ticket's explicit
 * override of the Playwright smoke test named in CLAUDE.md/ARCHITECTURE.md for `pnpm smoke`.
 *
 * Usage: `SMOKE_BASE_URL=https://... pnpm smoke` (start `next dev`/deploy first — this script
 * only checks an already-running server, it never starts one).
 */

// Kept as a literal, not imported from apps/web/app/model.ts (a Next-app-scoped file), so this
// script has no dependency on that app's build graph — see tasks/S-08.md Evidence for the exact
// diff-check that keeps the two in sync. PRD §1 / tasks/S-08.md "In scope" is the source of truth.
const FOOTER_SENTENCE =
  'v1: the buy-and-stake leg is funded by seed capital and capped; caller billing is not live. ' +
  'Every on-chain action above links to its transaction.';

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';

let failures = 0;

function fail(label: string, detail: string): void {
  failures += 1;
  console.error(`✗ ${label}: ${detail}`);
}

function ok(label: string): void {
  console.log(`✓ ${label}`);
}

function assertField(obj: Record<string, unknown>, path: string, label: string): boolean {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) {
      fail(label, `missing field "${path}"`);
      return false;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return true;
}

async function checkHome(): Promise<void> {
  const label = 'GET /';
  const res = await fetch(`${BASE_URL}/`);
  if (res.status !== 200) {
    fail(label, `expected 200, got ${res.status}`);
    return;
  }
  const html = await res.text();
  if (!html.includes(FOOTER_SENTENCE)) {
    fail(label, 'footer sentence not found verbatim in the HTML');
    return;
  }
  ok(label);
}

async function checkStats(): Promise<void> {
  const label = 'GET /api/stats';
  const res = await fetch(`${BASE_URL}/api/stats`);
  if (res.status !== 200) {
    fail(label, `expected 200, got ${res.status}`);
    return;
  }
  if (!res.headers.get('cache-control')) {
    fail(label, 'missing Cache-Control header');
    return;
  }
  const body = (await res.json()) as Record<string, unknown>;
  const required = [
    'agent',
    'savings',
    'savings.h24',
    'savings.all',
    'savings.byTier',
    'treasury',
    'events',
    'generatedAt',
  ];
  let allPresent = true;
  for (const field of required) {
    allPresent = assertField(body, field, label) && allPresent;
  }
  if (allPresent) ok(label);
}

async function checkAgents(): Promise<void> {
  const label = 'GET /api/agents';
  const res = await fetch(`${BASE_URL}/api/agents`);
  if (res.status !== 200) {
    fail(label, `expected 200, got ${res.status}`);
    return;
  }
  const body = (await res.json()) as Record<string, unknown>;
  if (!Array.isArray(body.agents)) {
    fail(label, '"agents" is not an array');
    return;
  }
  ok(label);

  const authLabel = 'POST /api/agents without a key';
  const authRes = await fetch(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-test-agent' }),
  });
  if (authRes.status !== 401) {
    fail(authLabel, `expected 401, got ${authRes.status}`);
    return;
  }
  ok(authLabel);
}

async function main(): Promise<void> {
  console.log(`pnpm smoke — base url: ${BASE_URL}`);
  await checkHome();
  await checkStats();
  await checkAgents();

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}

await main();

#!/usr/bin/env node
/**
 * Registers this agent with the Orbio Treasurer so it shows up on the public page. Idempotent:
 * after a first successful call, a local marker file (`.orbio-agent.json`, git-ignored) records
 * it, and every later run is a no-op as long as that file exists — this is what keeps this
 * agent's `agents` row to exactly one even if register.mjs runs on every cron tick (S-09 AC3).
 * No dependencies beyond Node built-ins.
 */
import { readFile, writeFile } from 'node:fs/promises';

const TREASURER_URL = process.env.ORBIO_TREASURER_URL;
const TREASURER_KEY = process.env.ORBIO_TREASURER_KEY;
const AGENT_REPO_URL = process.env.AGENT_REPO_URL; // optional, shown on the public page
const MARKER_PATH = new URL('./.orbio-agent.json', import.meta.url);

function fail(message) {
  console.error(`register: ${message}`);
  process.exitCode = 1;
}

async function readMarker() {
  try {
    return JSON.parse(await readFile(MARKER_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  if (!TREASURER_URL || !TREASURER_KEY) {
    fail('ORBIO_TREASURER_URL and ORBIO_TREASURER_KEY must be set (see .env.example)');
    return;
  }

  const existing = await readMarker();
  if (existing) {
    console.log(`already registered as "${existing.slug ?? 'unknown'}" — no-op`);
    return;
  }

  let res;
  try {
    res = await fetch(`${TREASURER_URL.replace(/\/+$/, '')}/api/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TREASURER_KEY}`,
      },
      body: JSON.stringify({
        name: 'daily-digest',
        ...(AGENT_REPO_URL ? { repoUrl: AGENT_REPO_URL } : {}),
      }),
    });
  } catch {
    fail('could not reach the Treasurer gateway');
    return;
  }

  // 200 = created/updated, 409 = already exists server-side — both count as a successful,
  // idempotent outcome from this script's point of view.
  if (res.status !== 200 && res.status !== 409) {
    fail(`Treasurer gateway returned ${res.status}`);
    return;
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // A bare 409 with no body is still a success per the contract above.
  }

  await writeFile(
    MARKER_PATH,
    JSON.stringify({ slug: body?.slug ?? null, registeredAt: new Date().toISOString() }, null, 2),
  );
  console.log(body?.slug ? `registered as "${body.slug}"` : 'registered');
}

await main();

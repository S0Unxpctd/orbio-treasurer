/**
 * `/api/agents` (S-08). `GET` lists public agents (no auth — same transparency as the page).
 * `POST` registers/updates the caller's own agent row, authenticated the same way `/v1/*`
 * already is (S-01's `CallerKeyStore`, env-backed for now — `EnvCallerKeyStore` never assigns a
 * real `agentId` per key yet, so today every successful POST takes the "create one" branch of
 * the ticket's "upserts ... (or creates one)"; the `caller.agentId` branch below is written for
 * when S-02's DB-backed caller keys land, so this route doesn't need to change then).
 *
 * Discovered (tasks/S-08.md): the ticket's POST body is `{name, url?, repoUrl?}`, but the
 * `agents` table (packages/core/src/ledger/schema.ts) has only a `repo_url` column, no generic
 * `url` — matching PRD 1.0 §4 T-9's kit, which posts `{name, url}`. `url` is accepted as an alias
 * for `repoUrl` (an explicit `repoUrl` wins if both are sent) rather than silently dropped.
 */
import { randomBytes } from 'node:crypto';

import { authenticateBearer, redact } from '@orbio-treasurer/core';
import { z } from 'zod';

import { getLedgerStore } from '../../_ledger.js';
import { getEnv, getKeyStore } from '../../v1/_gateway.js';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 2048;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url().max(500).optional(),
  repoUrl: z.string().trim().url().max(500).optional(),
});

function jsonError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

function logError(msg: string, ctx: Record<string, unknown>): void {
  console.error(JSON.stringify(redact({ msg, ...ctx })));
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : 'agent';
}

function randomSuffix(): string {
  return randomBytes(2).toString('hex'); // 4 hex chars, per the ticket
}

function toAgentJson(row: {
  slug: string;
  name: string;
  repoUrl: string | null;
  lastSeenAt: string | null;
}) {
  return { slug: row.slug, name: row.name, repoUrl: row.repoUrl, lastSeenAt: row.lastSeenAt };
}

export async function GET(): Promise<Response> {
  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (err) {
    logError('api/agents GET: env config error', { err });
    return jsonError(500, 'config', 'server misconfigured');
  }

  try {
    const store = getLedgerStore(env);
    const rows = await store.listPublicAgents();
    return Response.json({ agents: rows.map(toAgentJson) }, { status: 200 });
  } catch (err) {
    logError('api/agents GET: ledger read failed', { err });
    return jsonError(500, 'ledger_error', 'could not read the ledger');
  }
}

export async function POST(request: Request): Promise<Response> {
  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (err) {
    logError('api/agents POST: env config error', { err });
    return jsonError(500, 'config', 'server misconfigured');
  }

  const caller = authenticateBearer(request.headers.get('authorization'), getKeyStore(env));
  if (!caller) {
    return jsonError(401, 'auth', 'missing or invalid API key');
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return jsonError(400, 'invalid_request', `body must be at most ${MAX_BODY_BYTES} bytes`);
  }

  let json: unknown;
  try {
    json = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return jsonError(400, 'invalid_request', 'request body must be valid JSON');
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return jsonError(
      400,
      'invalid_request',
      'expected { name: string, url?: string, repoUrl?: string }',
    );
  }
  const { name, url, repoUrl } = parsed.data;
  const link = repoUrl ?? url ?? null;

  const store = getLedgerStore(env);
  const now = new Date().toISOString();

  try {
    if (caller.agentId) {
      const existing = await store.getAgent(caller.agentId);
      if (existing) {
        const updated = await store.updateAgent(existing.id, {
          name,
          ...(link !== null ? { repoUrl: link } : {}),
          lastSeenAt: now,
        });
        return Response.json(toAgentJson(updated), { status: 200 });
      }
    }

    // No agentId on the caller key (S-01 env store, today's only path) — create a new agent,
    // retrying the random slug suffix on the rare collision.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = `${slugify(name)}-${randomSuffix()}`;
      const clash = await store.getAgentBySlug(slug);
      if (clash) continue;
      const created = await store.insertAgent({
        slug,
        name,
        repoUrl: link,
        mode: 'dry_run',
        public: true,
        lastSeenAt: now,
      });
      return Response.json(toAgentJson(created), { status: 200 });
    }
    throw new Error('could not allocate a unique agent slug after 5 attempts');
  } catch (err) {
    logError('api/agents POST: ledger write failed', { err });
    return jsonError(500, 'ledger_error', 'could not save the agent');
  }
}

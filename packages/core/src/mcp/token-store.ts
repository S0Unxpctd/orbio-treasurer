/**
 * McpTokenStore — pluggable persistence for the OAuth token pair `OrbioMcpClient` uses (T-010,
 * PRD FR-2.1, docs/api-notes.md P-1).
 *
 * P-1: the refresh token ROTATES on every refresh — the old one is single-use. The client
 * (client.ts) calls `save()` with the new pair and awaits it BEFORE using the new access token
 * for anything else, so a crash between refresh and save can only ever strand the *previous*
 * (still centrally revocable) pair, never a pair the client used but never persisted.
 *
 * Two implementations ship here:
 *  - `EnvFileTokenStore` — the kit default; reads/writes `ORBIO_MCP_TOKEN` /
 *    `ORBIO_MCP_REFRESH_TOKEN` / `ORBIO_MCP_TOKEN_EXPIRES_AT` / `ORBIO_MCP_CLIENT_ID` in an
 *    env-style file (typically `.env.local`), preserving every other line untouched. Writes are
 *    atomic (temp file + rename) so a crash mid-write can never leave a half-written file.
 *  - `InMemoryTokenStore` — for tests and for any caller that already has the pair in memory.
 *
 * Out of scope (ticket T-010): a Supabase Vault-backed store for the hosted reference agent.
 * `McpTokenStore` is the seam a future ticket hangs a `VaultTokenStore` off; nothing here
 * assumes the env-file shape.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface McpTokenPair {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** UTC ISO-8601 expiry of `accessToken`, when known. */
  readonly expiresAt?: string;
  /** Public OAuth client id from dynamic client registration (P-1: `token_endpoint_auth_methods_supported = none`, no secret). */
  readonly clientId?: string;
}

export interface McpTokenStore {
  /** Returns the currently persisted pair, or null if none exists yet. */
  load(): Promise<McpTokenPair | null>;
  /** Persists `pair`, replacing whatever was stored before. Must complete before the caller
   *  uses `pair.accessToken` for anything (see file header). */
  save(pair: McpTokenPair): Promise<void>;
}

/** In-memory `McpTokenStore` — tests, and any short-lived process that already holds the pair. */
export class InMemoryTokenStore implements McpTokenStore {
  private pair: McpTokenPair | null;

  constructor(initial: McpTokenPair | null = null) {
    this.pair = initial;
  }

  async load(): Promise<McpTokenPair | null> {
    return this.pair;
  }

  async save(pair: McpTokenPair): Promise<void> {
    this.pair = pair;
  }
}

const ENV_KEYS = {
  accessToken: 'ORBIO_MCP_TOKEN',
  refreshToken: 'ORBIO_MCP_REFRESH_TOKEN',
  expiresAt: 'ORBIO_MCP_TOKEN_EXPIRES_AT',
  clientId: 'ORBIO_MCP_CLIENT_ID',
} as const;

const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const m = ENV_LINE_RE.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) map.set(m[1], m[2]);
  }
  return map;
}

/** `McpTokenStore` backed by an env-style file (the kit's `.env.local`). Read/write are scoped
 *  to the four keys in `ENV_KEYS`; every other line in the file is preserved byte-for-byte. */
export class EnvFileTokenStore implements McpTokenStore {
  constructor(private readonly path: string) {}

  async load(): Promise<McpTokenPair | null> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch {
      return null;
    }
    const map = parseEnvFile(content);
    const accessToken = map.get(ENV_KEYS.accessToken);
    if (accessToken === undefined || accessToken.length === 0) return null;
    const refreshToken = map.get(ENV_KEYS.refreshToken);
    const expiresAt = map.get(ENV_KEYS.expiresAt);
    const clientId = map.get(ENV_KEYS.clientId);
    return {
      accessToken,
      ...(refreshToken !== undefined && refreshToken.length > 0 ? { refreshToken } : {}),
      ...(expiresAt !== undefined && expiresAt.length > 0 ? { expiresAt } : {}),
      ...(clientId !== undefined && clientId.length > 0 ? { clientId } : {}),
    };
  }

  /**
   * Upserts the four token keys in place and leaves every other line untouched. Atomic: writes
   * a temp file in the same directory, then renames it over `this.path` — a crash mid-write
   * leaves the previous file intact, never a half-written one (see file header).
   */
  async save(pair: McpTokenPair): Promise<void> {
    let existing: string;
    try {
      existing = await readFile(this.path, 'utf8');
    } catch {
      existing = '';
    }
    const updates = new Map<string, string>([[ENV_KEYS.accessToken, pair.accessToken]]);
    if (pair.refreshToken !== undefined) updates.set(ENV_KEYS.refreshToken, pair.refreshToken);
    if (pair.expiresAt !== undefined) updates.set(ENV_KEYS.expiresAt, pair.expiresAt);
    if (pair.clientId !== undefined) updates.set(ENV_KEYS.clientId, pair.clientId);

    const lines = existing.length > 0 ? existing.split('\n') : [];
    const pending = new Map(updates);
    const out: string[] = [];
    for (const line of lines) {
      const m = ENV_LINE_RE.exec(line);
      const key = m?.[1];
      if (key !== undefined && pending.has(key)) {
        out.push(`${key}=${pending.get(key)}`);
        pending.delete(key);
      } else {
        out.push(line);
      }
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    for (const [key, value] of pending) out.push(`${key}=${value}`);
    out.push('');

    await mkdir(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmpPath, out.join('\n'), { mode: 0o600 });
    await rename(tmpPath, this.path);
    try {
      await chmod(this.path, 0o600);
    } catch {
      // best effort — the file already exists with whatever perms it had
    }
  }
}

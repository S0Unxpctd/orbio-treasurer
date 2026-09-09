/**
 * OrbioMcpClient — typed client for the Orbio MCP's four tools over Streamable HTTP (T-010,
 * PRD FR-2.0..FR-2.3, ARCHITECTURE.md §4a/§6, docs/api-notes.md P-1).
 *
 * Reuses the OAuth/token approach probe P-1 verified (`scripts/probes/p1-mcp-auth.ts`:
 * discovery, dynamic client registration already done once by that probe, manual refresh —
 * deliberately NOT the SDK's built-in interactive 401 handler, which would fall through to
 * starting a browser authorization flow and block an unattended tick on stdin) but lives here as
 * product code: no CLI flags, no stdin, no `.env.local` assumption baked in (that's
 * `EnvFileTokenStore`, injected).
 *
 * Token lifecycle (P-1 defaults, ARCHITECTURE §4a):
 *  - proactive refresh when `expiresAt - now < 5 min`;
 *  - exactly one refresh attempt on a 401, at connect or at any tool call;
 *  - the refresh token ROTATES on every refresh — the new pair is persisted via the injected
 *    `McpTokenStore` and awaited BEFORE the new access token is used for anything (token-store.ts);
 *  - refresh failure -> `McpUnavailableError` (balance-chain.ts catches this and falls to
 *    `estimate`; it never catches `AdapterShapeError` — a malformed response fails the tick
 *    loudly, per CLAUDE.md rule 6, it is not "unavailability").
 *  - `MCP_UNAVAILABLE` is logged once per *entry* into the unreachable state (mirrors
 *    `policy/rules/always.ts`'s `computeMcpUnavailable` edge-detection, at the client-instance
 *    level rather than the ledger-tick level — this ticket owns the client, not the ledger).
 *
 * Transport and OAuth refresh are both injected seams (`McpTransportFactory`,
 * `OAuthRefresher`) so tests exercise 401 -> refresh -> retry and rotation-exactly-once without
 * ever touching the network. Production wiring (`defaultTransportFactory`,
 * `defaultOAuthRefresher`) is the only place `@modelcontextprotocol/sdk`'s HTTP transport and
 * `refreshAuthorization()` are used directly.
 *
 * Time is an input: every expiry check reads `Clock` (default `() => new Date()`), never
 * `Date.now()` directly, so tests control "5 minutes from expiry" deterministically.
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { z } from 'zod';

import { log } from '../log.js';
import { redact } from '../redact.js';
import {
  AdapterShapeError,
  balanceStructuredContentSchema,
  createKeyStructuredContentSchema,
  type KeyStatusStructuredContent,
  keyStatusStructuredContentSchema,
  type McpToolName,
  parseStructuredContent,
  recordUnrecognizedSample,
  revokeKeyStructuredContentSchema,
} from './schemas.js';
import type { McpTokenPair, McpTokenStore } from './token-store.js';

export type Clock = () => Date;

const PROACTIVE_REFRESH_MARGIN_MS = 5 * 60_000;
const CLIENT_NAME = 'orbio-treasurer-core';
const CLIENT_VERSION = '0.1.0';

// --- transport seam -----------------------------------------------------------------------------

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface McpToolCallResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Thrown by an `McpTransport` on an HTTP-level failure. `status` is `undefined` for a
 *  non-HTTP transport error (network failure, timeout, ...). */
export class McpHttpError extends Error {
  readonly status: number | undefined;

  constructor(status: number | undefined, message: string) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
  }
}

/** One live connection using a fixed access token. `client.ts` rebuilds a new transport (via
 *  `McpTransportFactory`) whenever the token changes (first use, after refresh). */
export interface McpTransport {
  callTool(name: McpToolName, args: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export type McpTransportFactory = (accessToken: string, mcpUrl: string) => McpTransport;

function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof StreamableHTTPError) return err.code;
  const message = err instanceof Error ? err.message : String(err);
  const m = /HTTP (\d{3})/.exec(message);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

/** Real transport over `@modelcontextprotocol/sdk`'s Streamable HTTP client. Connects lazily on
 *  first `callTool()` and reuses the connection until `close()`. */
export function defaultTransportFactory(accessToken: string, mcpUrl: string): McpTransport {
  let client: Client | null = null;

  async function ensureConnected(): Promise<Client> {
    if (client !== null) return client;
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const c = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    // See scripts/probes/p1-mcp-auth.ts's `connect()` for the identical cast + rationale:
    // StreamableHTTPClientTransport implements Transport at runtime; the mismatch here is a
    // typing artifact of `exactOptionalPropertyTypes`, not a real one.
    await c.connect(transport as unknown as Transport);
    client = c;
    return c;
  }

  return {
    async callTool(name, args) {
      const c = await ensureConnected();
      try {
        const result = await c.callTool({ name, arguments: args });
        return result as McpToolCallResult;
      } catch (err) {
        throw new McpHttpError(httpStatusOf(err), err instanceof Error ? err.message : String(err));
      }
    },
    async close() {
      if (client !== null) {
        const toClose = client;
        client = null;
        try {
          await toClose.close();
        } catch {
          // ignore — best-effort teardown
        }
      }
    },
  };
}

// --- OAuth refresh seam --------------------------------------------------------------------------

export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

export interface OAuthRefresher {
  refresh(pair: McpTokenPair, clock: Clock): Promise<OAuthRefreshResult>;
}

interface DiscoveryCache {
  authServerUrl: string;
  metadata: AuthorizationServerMetadata | undefined;
}

/** Real refresher: RFC 9728/8414 discovery (cached per process — P-1's endpoints are static),
 *  then `grant_type=refresh_token` via the SDK's `refreshAuthorization()`, exactly as
 *  `scripts/probes/p1-mcp-auth.ts` verified works headless. */
export function defaultOAuthRefresher(mcpUrl: string): OAuthRefresher {
  let cached: DiscoveryCache | null = null;

  async function discoverOnce(): Promise<DiscoveryCache> {
    if (cached !== null) return cached;
    let authServerUrl: string;
    try {
      const resourceMetadata = await discoverOAuthProtectedResourceMetadata(mcpUrl);
      authServerUrl =
        resourceMetadata.authorization_servers?.[0] ?? new URL('/', mcpUrl).toString();
    } catch {
      authServerUrl = new URL('/', mcpUrl).toString();
    }
    let metadata: AuthorizationServerMetadata | undefined;
    try {
      metadata = await discoverAuthorizationServerMetadata(authServerUrl);
    } catch {
      metadata = undefined;
    }
    cached = { authServerUrl, metadata };
    return cached;
  }

  return {
    async refresh(pair, clock) {
      if (pair.refreshToken === undefined || pair.clientId === undefined) {
        throw new Error('no refresh_token/client_id available to refresh with');
      }
      const { authServerUrl, metadata } = await discoverOnce();
      const clientInfo: OAuthClientInformationFull = {
        client_id: pair.clientId,
        redirect_uris: [],
      };
      const tokens = await refreshAuthorization(authServerUrl, {
        clientInformation: clientInfo,
        refreshToken: pair.refreshToken,
        ...(metadata !== undefined ? { metadata } : {}),
      });
      const expiresAt =
        tokens.expires_in !== undefined
          ? new Date(clock().getTime() + tokens.expires_in * 1000).toISOString()
          : undefined;
      return {
        accessToken: tokens.access_token,
        // P-1: refresh_token rotates; fall back to the pair we just used only if the server
        // (unexpectedly) omitted a new one.
        refreshToken: tokens.refresh_token ?? pair.refreshToken,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    },
  };
}

// --- key rotation ---------------------------------------------------------------------------------

export interface KeyRotateResult {
  readonly type: 'KEY_ROTATE';
  readonly keyPrefix: string;
  readonly keyLast4: string;
  readonly rotatedAt: string;
}

// The one thing the create_key tool description guarantees about its response ("The secret is
// in this response and nowhere else"): a fresh `sk-orbio-...` token in the human-readable text
// block. structuredContent's shape is unconfirmed (see schemas.ts) so this is the primary path,
// not a fallback.
const KEY_SECRET_PATTERN = /sk-orbio-[A-Za-z0-9_-]{6,}/;
// CLAUDE.md rule 4: store only a prefix + last4, never the secret. 16 chars keeps a few
// identifying characters beyond the "sk-orbio-" literal every key shares.
const KEY_PREFIX_LEN = 16;

function extractKeySecret(result: McpToolCallResult): string | null {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured !== undefined) {
    for (const field of ['key', 'secret', 'apiKey', 'value'] as const) {
      const candidate = structured[field];
      if (typeof candidate === 'string' && KEY_SECRET_PATTERN.test(candidate)) return candidate;
    }
  }
  for (const block of result.content) {
    if (typeof block.text === 'string') {
      const match = KEY_SECRET_PATTERN.exec(block.text);
      if (match) return match[0];
    }
  }
  return null;
}

// --- MCP unavailability ---------------------------------------------------------------------------

/** Thrown when the MCP could not be reached after every retry this client attempts (expired
 *  token + failed refresh, network error, non-auth HTTP failure). `balance-chain.ts` catches
 *  exactly this type and falls back to `estimate` (FR-2.0). Never thrown for a malformed
 *  response — see `AdapterShapeError`, which must propagate and fail the tick loudly. */
export class McpUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'McpUnavailableError';
  }
}

// --- OrbioMcpClient -------------------------------------------------------------------------------

export interface OrbioMcpClientConfig {
  readonly mcpUrl: string;
  readonly tokenStore: McpTokenStore;
  readonly clock?: Clock;
  readonly transportFactory?: McpTransportFactory;
  readonly oauthRefresher?: OAuthRefresher;
  /** Called (best-effort) whenever a tool response fails shape validation. Defaults to
   *  `recordUnrecognizedSample()` against the real docs/api-notes.md; tests must override this
   *  rather than let it touch the repo's docs file. */
  readonly onUnrecognizedSample?: (err: AdapterShapeError) => Promise<void> | void;
}

export class OrbioMcpClient {
  private readonly mcpUrl: string;
  private readonly tokenStore: McpTokenStore;
  private readonly clock: Clock;
  private readonly transportFactory: McpTransportFactory;
  private readonly oauthRefresher: OAuthRefresher;
  private readonly onUnrecognizedSample: (err: AdapterShapeError) => Promise<void> | void;

  private transport: McpTransport | null = null;
  private tokens: McpTokenPair | null = null;
  /** "once per state entry" for MCP_UNAVAILABLE — true while the client believes the MCP is
   *  reachable; flips (and logs) on the transition to unreachable, resets silently on recovery. */
  private mcpReachable = true;
  /** idempotencyKey -> in-flight/completed rotation, so a retry with the same key can never
   *  cause a second `orbio_create_key` call (audit focus: "Retries creating two keys"). */
  private readonly rotations = new Map<string, Promise<KeyRotateResult>>();
  /**
   * Single-flight guard for token refresh (audit-1 Major finding). `ensureFreshToken()`'s
   * proactive path and `callTool()`'s 401 path both call `tryRefresh()`; every concurrent
   * caller — on the same tick, e.g. `getBalance()` and `getKeyStatus()` racing via
   * `Promise.all` — must await the SAME refresh attempt instead of each issuing its own,
   * since the real refresh_token is single-use (P-1): two independent calls would burn it
   * twice, and the loser would either hard-fail against the server or race `tokenStore.save()`.
   * Set and read synchronously (no `await` between the null-check and the assignment below),
   * so two callers invoked back-to-back in the same microtask (as `Promise.all` does) can never
   * both observe `null` — see `tryRefresh()`. Once the shared promise resolves, EVERY caller
   * reads the fresh pair straight from `this.tokens` (already updated by then) rather than
   * re-reading the token store — a plain field read achieves the same "use the fresh pair, not
   * a second refresh" outcome the ticket asks for, with no extra I/O.
   */
  private refreshPromise: Promise<boolean> | null = null;
  /** Set when a refresh's server call succeeded but persisting the new pair failed — see
   *  `doRefresh()`'s save()-failure branch and `ensureFreshToken()`. */
  private refreshTokenConsumedLocally = false;
  /** "log once" companion to `refreshTokenConsumedLocally`. */
  private loggedRefreshSaveFailure = false;

  constructor(config: OrbioMcpClientConfig) {
    this.mcpUrl = config.mcpUrl;
    this.tokenStore = config.tokenStore;
    this.clock = config.clock ?? (() => new Date());
    this.transportFactory = config.transportFactory ?? defaultTransportFactory;
    this.oauthRefresher = config.oauthRefresher ?? defaultOAuthRefresher(this.mcpUrl);
    this.onUnrecognizedSample =
      config.onUnrecognizedSample ??
      ((err) =>
        recordUnrecognizedSample(err).catch((appendErr: unknown) => {
          log('warn', 'mcp-unrecognized-sample-append-failed', {
            tool: err.tool,
            error: redact(String(appendErr)),
          });
        }));
  }

  /** `orbio_get_balance` -> the "spendable now" figure (`structuredContent.balance.microUsd`,
   *  never the `usd` float). Throws `McpUnavailableError` if unreachable, `AdapterShapeError`
   *  if the response is malformed. */
  async getBalance(): Promise<{ valueMicroUsd: string }> {
    const result = await this.callTool('orbio_get_balance', {});
    const parsed = this.validate(
      'orbio_get_balance',
      balanceStructuredContentSchema,
      result.structuredContent,
    );
    return { valueMicroUsd: parsed.balance.microUsd };
  }

  /** `orbio_get_key_status`. Throws `McpUnavailableError` if unreachable, `AdapterShapeError`
   *  if the response is malformed. */
  async getKeyStatus(): Promise<KeyStatusStructuredContent> {
    const result = await this.callTool('orbio_get_key_status', {});
    return this.validate(
      'orbio_get_key_status',
      keyStatusStructuredContentSchema,
      result.structuredContent,
    );
  }

  /**
   * `orbio_revoke_key` then `orbio_create_key` (PRD FR-2.2/§10 `KEY_ROTATE`). `idempotencyKey`
   * must be stable across retries of the *same* rotation attempt (e.g. a decision/tick id) — a
   * second call with the same key, whether concurrent or a later retry after success or
   * failure, joins the original attempt's promise rather than re-running revoke+create, so
   * `orbio_create_key` is called at most once per key.
   *
   * Never call this against the real MCP outside a human-approved live check (tasks/T-010.md
   * "LIVE CALL RULES") — it would rotate a real production key.
   */
  async rotateKey(idempotencyKey: string): Promise<KeyRotateResult> {
    const existing = this.rotations.get(idempotencyKey);
    if (existing !== undefined) return existing;

    const attempt = this.doRotate();
    this.rotations.set(idempotencyKey, attempt);
    // Only evict on failure — a caller retrying a rotation that actually already SUCCEEDED
    // (e.g. it timed out waiting for the response) must still get the cached success, never a
    // second orbio_create_key call.
    attempt.catch(() => {
      this.rotations.delete(idempotencyKey);
    });
    return attempt;
  }

  private async doRotate(): Promise<KeyRotateResult> {
    const revokeResult = await this.callTool('orbio_revoke_key', {});
    this.validate(
      'orbio_revoke_key',
      revokeKeyStructuredContentSchema,
      revokeResult.structuredContent,
    );

    const createResult = await this.callTool('orbio_create_key', {});
    this.validate(
      'orbio_create_key',
      createKeyStructuredContentSchema,
      createResult.structuredContent,
    );

    const secret = extractKeySecret(createResult);
    if (secret === null) {
      throw new AdapterShapeError(
        'orbio_create_key',
        'no key secret found in structuredContent or content[0].text',
        redact(createResult),
      );
    }
    return {
      type: 'KEY_ROTATE',
      keyPrefix: secret.slice(0, KEY_PREFIX_LEN),
      keyLast4: secret.slice(-4),
      rotatedAt: this.clock().toISOString(),
    };
  }

  /** Releases the underlying transport connection, if any. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.transport !== null) {
      const t = this.transport;
      this.transport = null;
      await t.close();
    }
  }

  // --- internals ------------------------------------------------------------------------------

  private validate<T>(tool: McpToolName, schema: z.ZodType<T>, value: unknown): T {
    try {
      return parseStructuredContent(tool, schema, value);
    } catch (err) {
      if (err instanceof AdapterShapeError) {
        void this.onUnrecognizedSample(err);
      }
      throw err;
    }
  }

  private async callTool(
    name: McpToolName,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    await this.ensureFreshToken();
    const transport = this.ensureTransport();
    try {
      const result = await transport.callTool(name, args);
      this.markReachable();
      return result;
    } catch (err) {
      if (err instanceof McpHttpError && err.status === 401) {
        const refreshed = await this.tryRefresh();
        if (!refreshed) {
          this.markUnreachable(name, err);
          throw new McpUnavailableError(`${name}: 401 and refresh failed`, err);
        }
        const retryTransport = this.ensureTransport();
        try {
          const result = await retryTransport.callTool(name, args);
          this.markReachable();
          return result;
        } catch (err2) {
          this.markUnreachable(name, err2);
          throw new McpUnavailableError(`${name}: failed after refresh + retry`, err2);
        }
      }
      this.markUnreachable(name, err);
      throw new McpUnavailableError(`${name}: transport failure`, err);
    }
  }

  private ensureTransport(): McpTransport {
    if (this.transport === null) {
      const accessToken = this.tokens?.accessToken;
      if (accessToken === undefined) {
        throw new McpUnavailableError('no MCP access token available');
      }
      this.transport = this.transportFactory(accessToken, this.mcpUrl);
    }
    return this.transport;
  }

  private async ensureFreshToken(): Promise<void> {
    if (this.tokens === null) {
      this.tokens = await this.tokenStore.load();
      if (this.tokens === null) {
        this.markUnreachable('load-token', new Error('token store has no token'));
        throw new McpUnavailableError('no MCP token available in the token store');
      }
    }
    // `!this.refreshTokenConsumedLocally` gates the ATTEMPT: once a previous call's refresh
    // succeeded server-side but failed to persist locally, the refresh token is already burnt
    // (P-1: single-use) — attempting it again proactively here is doomed and would hammer the
    // token endpoint every single call until real expiry. Skip straight to using the still-valid
    // old access token instead; a 401 (if the server ever rejects it before its stated expiry)
    // still gets the normal one-refresh-attempt-on-401 treatment in callTool() below — that
    // attempt is a real server round-trip ("the server returned an error"), not a retry this
    // skips.
    if (this.isNearExpiry() && !this.refreshTokenConsumedLocally) {
      const ok = await this.tryRefresh();
      // Don't throw for the fail-closed save() case (audit-1): `doRefresh()` already set
      // `refreshTokenConsumedLocally` for it, and the old access token — untouched, since
      // `this.tokens` was deliberately never reassigned — is still valid, so just fall through
      // and use it. Only a GENUINE failure (server rejected the refresh, network error, ...)
      // throws here: there is then no way to renew a token that actually is near/at expiry.
      if (!ok && !this.refreshTokenConsumedLocally) {
        this.markUnreachable('proactive-refresh', new Error('proactive refresh failed'));
        throw new McpUnavailableError('token near expiry and proactive refresh failed');
      }
    }
  }

  private isNearExpiry(): boolean {
    const expiresAt = this.tokens?.expiresAt;
    if (expiresAt === undefined) return false;
    const msLeft = new Date(expiresAt).getTime() - this.clock().getTime();
    return msLeft < PROACTIVE_REFRESH_MARGIN_MS;
  }

  /**
   * Single-flighted entry point: `ensureFreshToken()`'s proactive path and `callTool()`'s 401
   * path both call this. If a refresh is already in flight, every caller awaits that SAME
   * promise instead of starting a second one (audit-1 Major fix) — see `refreshPromise`'s
   * field comment for why the check-then-assign below is safe against `Promise.all`-style
   * concurrent callers despite not being behind a lock.
   */
  private tryRefresh(): Promise<boolean> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    const attempt = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    this.refreshPromise = attempt;
    return attempt;
  }

  /** One refresh attempt's actual work — only ever called by `tryRefresh()`, at most once at a
   *  time (never call this directly from two places, or the single-flight guard above is
   *  bypassed). On success, persists the (possibly rotated) pair via the token store and awaits
   *  that write BEFORE the new access token is used for anything (see file header and
   *  token-store.ts), then drops the current transport so the next call reconnects with it. */
  private async doRefresh(): Promise<boolean> {
    if (this.tokens === null) return false;
    try {
      const result = await this.oauthRefresher.refresh(this.tokens, this.clock);
      const newPair: McpTokenPair = {
        accessToken: result.accessToken,
        ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
        ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
        ...(this.tokens.clientId !== undefined ? { clientId: this.tokens.clientId } : {}),
      };
      try {
        await this.tokenStore.save(newPair);
      } catch (saveErr) {
        // FAIL CLOSED (audit-1): the server call above already succeeded and rotated the
        // refresh token server-side, but we could not persist the new pair locally. Do NOT
        // adopt the in-memory-only pair — a value nothing durable can recover after a process
        // restart is worse than staying on the old one. `this.tokens` is deliberately left
        // untouched: the old access token is still valid until it actually expires, so calls
        // keep working; `refreshTokenConsumedLocally` stops `ensureFreshToken()` from
        // proactively retrying a refresh that is now guaranteed to fail (the refresh token was
        // already burnt) — only a genuine 401 gets to attempt it again, via the normal 401 path,
        // and that attempt is allowed to fail with a real server error. Logged once.
        if (!this.loggedRefreshSaveFailure) {
          log('warn', 'mcp-refresh-store-save-failed', {
            error: redact(saveErr instanceof Error ? saveErr.message : String(saveErr)),
          });
          this.loggedRefreshSaveFailure = true;
        }
        this.refreshTokenConsumedLocally = true;
        return false;
      }
      this.tokens = newPair;
      this.refreshTokenConsumedLocally = false;
      this.loggedRefreshSaveFailure = false;
      if (this.transport !== null) {
        const old = this.transport;
        this.transport = null;
        await old.close();
      }
      return true;
    } catch (err) {
      log('warn', 'mcp-refresh-failed', {
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      return false;
    }
  }

  private markReachable(): void {
    this.mcpReachable = true;
  }

  private markUnreachable(context: string, err: unknown): void {
    if (this.mcpReachable) {
      log('warn', 'MCP_UNAVAILABLE', {
        context,
        error: redact(err instanceof Error ? err.message : String(err)),
      });
    }
    this.mcpReachable = false;
  }
}

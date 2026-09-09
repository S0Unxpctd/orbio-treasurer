#!/usr/bin/env tsx
import { randomBytes } from 'node:crypto';
/**
 * P-1 · MCP headless auth (PRD §13a, tasks/P-001.md)
 *
 * Question: can a server process call `orbio_get_balance` for > 6h with a token
 * obtained once? Is there a refresh token?
 *
 * This probe is READ-ONLY: it never writes anything except OAuth material into
 * `.env.local`, never calls a mutating MCP tool (create_key/revoke_key), and never
 * prints a token, refresh token, client secret or authorization code.
 *
 * Usage: `pnpm probe P-1 [--reauth] [--interval-min N] [--hours N] [--once] [--help]`
 * See scripts/probes/README.md for the full headless run instructions.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  auth,
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
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { redact } from '../../packages/core/src/redact.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const ENV_PATH = resolve(REPO_ROOT, '.env.local');

const DEFAULT_MCP_URL = 'https://www.orbio.so/api/mcp';
const REDIRECT_URI = 'http://localhost:3333/callback';
const TOOL_NAME = 'orbio_get_balance';
const CLIENT_NAME = 'orbio-treasurer-probe-p1';

// ---------------------------------------------------------------------------
// Logging — every JSON line goes through redact() so a secret can never slip out.
// ---------------------------------------------------------------------------

function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(redact({ ts: new Date().toISOString(), ...fields })));
}

function logErrLine(fields: Record<string, unknown>): void {
  console.error(JSON.stringify(redact({ ts: new Date().toISOString(), ...fields })));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface Flags {
  reauth: boolean;
  once: boolean;
  help: boolean;
  intervalMin: number;
  hours: number;
}

function numFlag(argv: readonly string[], name: string, fallback: number): number {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const raw = argv[i + 1];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFlags(argv: readonly string[]): Flags {
  return {
    reauth: argv.includes('--reauth'),
    once: argv.includes('--once'),
    help: argv.includes('--help') || argv.includes('-h'),
    intervalMin: numFlag(argv, '--interval-min', 10),
    hours: numFlag(argv, '--hours', 6),
  };
}

const USAGE = `pnpm probe P-1 [flags]

Calls ${TOOL_NAME} on the Orbio MCP (${DEFAULT_MCP_URL}) every --interval-min
minutes for up to --hours hours, to answer PRD §13a P-1 (token lifetime / refresh
behaviour). Headless OAuth: on first run (or with --reauth) this prints an
authorization URL and waits on stdin for the full callback URL pasted back.

Flags:
  --reauth            force a fresh OAuth flow even if .env.local has a token
  --once              make exactly one get_balance call, then stop
  --interval-min N    minutes between calls (default 10)
  --hours N           stop after this many hours (default 6)
  --help              print this message and exit

Never prints a token. OAuth material is written to .env.local under
ORBIO_MCP_TOKEN / ORBIO_MCP_REFRESH_TOKEN / ORBIO_MCP_TOKEN_EXPIRES_AT /
ORBIO_MCP_CLIENT_ID / ORBIO_MCP_CLIENT_SECRET.
`;

// ---------------------------------------------------------------------------
// .env.local — read the whole file, and upsert only the keys we own.
// ---------------------------------------------------------------------------

function readEnvMap(): Map<string, string> {
  const map = new Map<string, string>();
  let content: string;
  try {
    content = readFileSync(ENV_PATH, 'utf8');
  } catch {
    return map;
  }
  for (const line of content.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) map.set(m[1], m[2]);
  }
  return map;
}

/** Upserts only the given keys in .env.local; keys mapped to `undefined` are left untouched. */
function writeEnvKeys(updates: Record<string, string | undefined>): void {
  const toWrite = Object.entries(updates).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (toWrite.length === 0) return;

  let content: string;
  try {
    content = readFileSync(ENV_PATH, 'utf8');
  } catch {
    content = '';
  }
  const lines = content.length > 0 ? content.split('\n') : [];
  const pending = new Map(toWrite);
  const out: string[] = [];
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
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
  writeFileSync(ENV_PATH, out.join('\n'), { mode: 0o600 });
  try {
    chmodSync(ENV_PATH, 0o600);
  } catch {
    // best effort — the file already exists with whatever perms it had
  }
}

// ---------------------------------------------------------------------------
// Discovery: try RFC 9728 (protected resource) then RFC 8414 / OIDC (authorization
// server), independently, so we can report which one actually worked.
// ---------------------------------------------------------------------------

interface DiscoveryResult {
  resourceMetadata?: OAuthProtectedResourceMetadata;
  rfc9728Ok: boolean;
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  rfc8414OrOidcOk: boolean;
}

async function runDiscovery(mcpUrl: string): Promise<DiscoveryResult> {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  let rfc9728Ok = false;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(mcpUrl);
    rfc9728Ok = true;
  } catch (err) {
    logLine({
      event: 'discovery_step',
      step: 'rfc9728_protected_resource',
      ok: false,
      error: errMessage(err),
    });
  }

  const authorizationServerUrl =
    resourceMetadata?.authorization_servers?.[0] ?? new URL('/', mcpUrl).toString();

  let metadata: AuthorizationServerMetadata | undefined;
  let rfc8414OrOidcOk = false;
  try {
    metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl);
    rfc8414OrOidcOk = metadata !== undefined;
  } catch (err) {
    logLine({
      event: 'discovery_step',
      step: 'rfc8414_or_oidc_metadata',
      ok: false,
      error: errMessage(err),
    });
  }

  logLine({
    event: 'discovery',
    rfc9728_protected_resource_metadata: rfc9728Ok,
    authorization_server_url: authorizationServerUrl,
    rfc8414_or_oidc_authorization_server_metadata: rfc8414OrOidcOk,
    registration_endpoint_present: metadata?.registration_endpoint !== undefined,
    which_worked:
      rfc9728Ok && rfc8414OrOidcOk
        ? 'both'
        : rfc9728Ok
          ? 'rfc9728_only'
          : rfc8414OrOidcOk
            ? 'rfc8414_or_oidc_only'
            : 'neither (falling back to MCP origin as authorization server, /register guess for DCR)',
  });

  return {
    rfc9728Ok,
    authorizationServerUrl,
    rfc8414OrOidcOk,
    ...(resourceMetadata !== undefined ? { resourceMetadata } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// OAuthClientProvider backed by .env.local (PKCE S256, dynamic registration).
// ---------------------------------------------------------------------------

class EnvFileOAuthProvider implements OAuthClientProvider {
  currentTokens: OAuthTokens | undefined;
  currentClientInfo: OAuthClientInformationFull | undefined;
  expectedState: string | undefined;
  private codeVerifierValue: string | undefined;

  constructor(env: Map<string, string>) {
    const clientId = env.get('ORBIO_MCP_CLIENT_ID');
    if (clientId !== undefined) {
      const clientSecret = env.get('ORBIO_MCP_CLIENT_SECRET');
      this.currentClientInfo = {
        client_id: clientId,
        redirect_uris: [REDIRECT_URI],
        ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
      };
    }
    const accessToken = env.get('ORBIO_MCP_TOKEN');
    if (accessToken !== undefined) {
      const refreshToken = env.get('ORBIO_MCP_REFRESH_TOKEN');
      this.currentTokens = {
        access_token: accessToken,
        token_type: 'Bearer',
        ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
      };
    }
  }

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: CLIENT_NAME,
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString('hex');
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.currentClientInfo;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.currentClientInfo = info;
    writeEnvKeys({
      ORBIO_MCP_CLIENT_ID: info.client_id,
      ORBIO_MCP_CLIENT_SECRET: info.client_secret,
    });
    logLine({ event: 'dcr', ok: true, client_secret_issued: info.client_secret !== undefined });
  }

  tokens(): OAuthTokens | undefined {
    return this.currentTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.currentTokens = tokens;
    const expiresAt =
      tokens.expires_in !== undefined
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined;
    writeEnvKeys({
      ORBIO_MCP_TOKEN: tokens.access_token,
      ORBIO_MCP_REFRESH_TOKEN: tokens.refresh_token,
      ORBIO_MCP_TOKEN_EXPIRES_AT: expiresAt,
    });
    logLine({
      event: 'tokens_saved',
      ok: true,
      has_refresh_token: tokens.refresh_token !== undefined,
      expires_at: expiresAt ?? null,
    });
  }

  redirectToAuthorization(url: URL): void {
    console.log('\n=== P-1: authorize the probe ===');
    console.log(
      'Open this URL on ANY machine (browser), sign in and approve. The localhost\n' +
        'redirect will fail to load in the browser — that is expected for a headless\n' +
        'server probe. Copy the FULL URL from the browser address bar after it fails\n' +
        '(it carries ?code=...&state=...) and paste it back here.\n',
    );
    console.log(url.toString());
    console.log('');
  }

  saveCodeVerifier(verifier: string): void {
    this.codeVerifierValue = verifier;
  }

  codeVerifier(): string {
    return this.codeVerifierValue ?? '';
  }
}

// ---------------------------------------------------------------------------
// Headless authorization: print URL, block on stdin for the pasted redirect URL.
// Resolves to null on EOF with nothing typed (used both by a real human declining
// and by a non-interactive dry verification run).
// ---------------------------------------------------------------------------

async function readRedirectUrlFromStdin(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | null>((resolveLine) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolveLine(value);
      };
      rl.question('Paste the full callback URL here: ').then((line) => finish(line.trim() || null));
      rl.once('close', () => finish(null));
    });
  } finally {
    rl.close();
  }
}

async function ensureAuthorized(
  mcpUrl: string,
  provider: EnvFileOAuthProvider,
  reauth: boolean,
): Promise<boolean> {
  if (provider.currentTokens?.access_token !== undefined && !reauth) {
    logLine({ event: 'auth', mode: 'reuse', ok: true });
    return true;
  }

  let firstResult: 'AUTHORIZED' | 'REDIRECT';
  try {
    firstResult = await auth(provider, { serverUrl: mcpUrl });
  } catch (err) {
    logErrLine({ event: 'auth_error', stage: 'discovery_or_registration', error: errMessage(err) });
    console.error(
      '\nDynamic client registration (RFC 7591) or discovery failed against the real MCP server.\n' +
        'See the auth_error line above for the exact error. Stopping — nothing else was attempted.',
    );
    return false;
  }

  if (firstResult === 'AUTHORIZED') {
    // Non-interactive grant (should not happen for this server, but handle it).
    logLine({ event: 'auth', mode: 'headless', ok: true, note: 'authorized without redirect' });
    return true;
  }

  const redirectInput = await readRedirectUrlFromStdin();
  if (redirectInput === null) {
    logLine({ event: 'auth', mode: 'headless', ok: false, reason: 'no_redirect_url_on_stdin' });
    console.error(
      '\nNo redirect URL received on stdin — stopping before any token exchange.\n' +
        'Re-run in an interactive terminal (or pipe the pasted URL in) to complete the\n' +
        'headless OAuth flow: pnpm probe P-1',
    );
    return false;
  }

  let code: string;
  let state: string | null;
  try {
    const parsed = new URL(redirectInput);
    const c = parsed.searchParams.get('code');
    if (c === null || c.length === 0) throw new Error('redirect URL has no ?code=');
    code = c;
    state = parsed.searchParams.get('state');
  } catch (err) {
    logErrLine({ event: 'auth_error', stage: 'parse_redirect_url', error: errMessage(err) });
    return false;
  }

  if (state !== provider.expectedState) {
    logErrLine({ event: 'auth_error', stage: 'state_mismatch' });
    console.error('\nstate parameter did not match what we sent — possible CSRF, stopping.');
    return false;
  }

  try {
    const second = await auth(provider, { serverUrl: mcpUrl, authorizationCode: code });
    if (second !== 'AUTHORIZED') {
      logErrLine({
        event: 'auth_error',
        stage: 'token_exchange',
        error: `unexpected result ${second}`,
      });
      return false;
    }
  } catch (err) {
    logErrLine({ event: 'auth_error', stage: 'token_exchange', error: errMessage(err) });
    return false;
  }

  logLine({ event: 'auth', mode: 'headless', ok: true });
  return true;
}

// ---------------------------------------------------------------------------
// Connect / call / refresh-on-401 — deliberately manual (no authProvider on the
// transport): the SDK's built-in 401 handling falls through to starting a brand
// new interactive authorization flow on refresh failure, which would block this
// unattended loop on stdin. We do exactly what the ticket asks instead: one
// refresh attempt, then continue or stop.
// ---------------------------------------------------------------------------

async function connect(mcpUrl: string, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: CLIENT_NAME, version: '0.0.1' }, { capabilities: {} });
  // The SDK's own `sessionId?: string` getter surfaces as `string | undefined` under our
  // exactOptionalPropertyTypes, which TS then treats as incompatible with the very same
  // optional-property declaration on `Transport` — a typing artifact, not a real mismatch
  // (StreamableHTTPClientTransport does implement Transport at runtime).
  await client.connect(transport as unknown as Transport);
  return client;
}

function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof StreamableHTTPError) return err.code;
  const m = /HTTP (\d{3})/.exec(errMessage(err));
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

interface AuthContext {
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata | undefined;
}

async function tryRefreshOnce(
  provider: EnvFileOAuthProvider,
  ctx: AuthContext,
): Promise<{ ok: boolean; error?: string }> {
  const refreshToken = provider.currentTokens?.refresh_token;
  if (refreshToken === undefined) return { ok: false, error: 'no refresh_token available' };
  const clientInfo = provider.currentClientInfo;
  if (clientInfo === undefined)
    return { ok: false, error: 'no client information available for refresh' };
  try {
    const newTokens = await refreshAuthorization(ctx.authorizationServerUrl, {
      clientInformation: clientInfo,
      refreshToken,
      ...(ctx.metadata !== undefined ? { metadata: ctx.metadata } : {}),
    });
    provider.saveTokens(newTokens);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Summary — printed on SIGINT or when the run window ends. Formatted to paste
// straight into docs/api-notes.md under "Probe results".
// ---------------------------------------------------------------------------

interface Stats {
  startedAtMs: number;
  tokenObtainedAtMs: number;
  intervalMin: number;
  hasRefreshTokenAtAuth: boolean;
  calls: number;
  failures: number;
  firstFailureAt: string | null;
  refreshAttempts: number;
  refreshSuccesses: number;
}

function buildSummaryParagraph(stats: Stats): string {
  const durationMin = ((Date.now() - stats.startedAtMs) / 60_000).toFixed(1);
  const tokenLifetime = stats.firstFailureAt
    ? `~${((new Date(stats.firstFailureAt).getTime() - stats.tokenObtainedAtMs) / 60_000).toFixed(
        1,
      )} min before the first auth failure`
    : `not observed to expire during this ${durationMin}-min run`;
  const refreshLine =
    stats.refreshAttempts === 0
      ? 'no refresh was attempted (no 401 seen)'
      : `refresh attempted ${stats.refreshAttempts} time(s), succeeded ${stats.refreshSuccesses} time(s)`;
  const date = new Date().toISOString().slice(0, 10);
  return (
    `P-1 (${date}): ran ${TOOL_NAME} every ${stats.intervalMin} min for ${durationMin} min ` +
    `(${stats.calls} ok call(s), ${stats.failures} failure(s), first failure at ` +
    `${stats.firstFailureAt ?? 'n/a'}). Observed token lifetime: ${tokenLifetime}. A refresh ` +
    `token ${stats.hasRefreshTokenAtAuth ? 'was issued' : 'was NOT issued'} at auth time; ` +
    `${refreshLine}. Evidence: scripts/probes/p1-mcp-auth.ts output (redacted), run via ` +
    `\`pnpm probe P-1\`.`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const mcpUrl = process.env.ORBIO_MCP_URL ?? DEFAULT_MCP_URL;
  const env = readEnvMap();
  const provider = new EnvFileOAuthProvider(env);

  const discovery = await runDiscovery(mcpUrl);

  const hasRefreshTokenAtAuth = provider.currentTokens?.refresh_token !== undefined;
  const authorized = await ensureAuthorized(mcpUrl, provider, flags.reauth);
  if (!authorized) {
    process.exitCode = 1;
    return;
  }

  const accessToken = provider.currentTokens?.access_token;
  if (accessToken === undefined) {
    logErrLine({ event: 'fatal', error: 'authorized but no access token present in memory' });
    process.exitCode = 1;
    return;
  }

  const authCtx: AuthContext = {
    authorizationServerUrl: discovery.authorizationServerUrl,
    metadata: discovery.metadata,
  };

  const stats: Stats = {
    startedAtMs: Date.now(),
    tokenObtainedAtMs: Date.now(),
    intervalMin: flags.intervalMin,
    hasRefreshTokenAtAuth:
      provider.currentTokens?.refresh_token !== undefined || hasRefreshTokenAtAuth,
    calls: 0,
    failures: 0,
    firstFailureAt: null,
    refreshAttempts: 0,
    refreshSuccesses: 0,
  };

  let stopped = false;
  const stopAndSummarize = () => {
    if (stopped) return;
    stopped = true;
    console.log(`\n${buildSummaryParagraph(stats)}\n`);
  };
  process.on('SIGINT', () => {
    stopAndSummarize();
    process.exit(0);
  });

  let client: Client;
  try {
    client = await connect(mcpUrl, accessToken);
  } catch (err) {
    logErrLine({ event: 'connect_error', error: errMessage(err) });
    process.exitCode = 1;
    return;
  }

  try {
    const toolsResult = await client.listTools();
    logLine({ event: 'list_tools', ok: true, tools: toolsResult.tools.map((t) => t.name) });
  } catch (err) {
    logLine({ event: 'list_tools', ok: false, error: errMessage(err) });
  }

  const deadlineMs = Date.now() + flags.hours * 3_600_000;
  const intervalMs = flags.intervalMin * 60_000;

  while (!stopped) {
    const callStart = Date.now();
    try {
      await client.callTool({ name: TOOL_NAME, arguments: {} });
      stats.calls++;
      logLine({
        event: 'get_balance',
        ok: true,
        elapsed_ms: Date.now() - callStart,
        refresh_needed: false,
      });
    } catch (err) {
      const status = httpStatusOf(err);
      if (status === 401) {
        stats.refreshAttempts++;
        const refreshResult = await tryRefreshOnce(provider, authCtx);
        if (refreshResult.ok) {
          stats.refreshSuccesses++;
          const newToken = provider.currentTokens?.access_token;
          try {
            await client.close();
          } catch {
            // ignore
          }
          try {
            client = await connect(mcpUrl, newToken ?? accessToken);
            await client.callTool({ name: TOOL_NAME, arguments: {} });
            stats.calls++;
            logLine({
              event: 'get_balance',
              ok: true,
              elapsed_ms: Date.now() - callStart,
              refresh_needed: true,
              refresh_ok: true,
            });
          } catch (err2) {
            stats.failures++;
            stats.firstFailureAt ??= new Date().toISOString();
            logLine({
              event: 'get_balance',
              ok: false,
              http_status: httpStatusOf(err2) ?? null,
              error: errMessage(err2),
              elapsed_ms: Date.now() - callStart,
              refresh_needed: true,
              refresh_ok: true,
            });
            stopAndSummarize();
            break;
          }
        } else {
          stats.failures++;
          stats.firstFailureAt ??= new Date().toISOString();
          logLine({
            event: 'get_balance',
            ok: false,
            http_status: 401,
            error: refreshResult.error ?? 'refresh failed',
            elapsed_ms: Date.now() - callStart,
            refresh_needed: true,
            refresh_ok: false,
          });
          stopAndSummarize();
          break;
        }
      } else {
        stats.failures++;
        stats.firstFailureAt ??= new Date().toISOString();
        logLine({
          event: 'get_balance',
          ok: false,
          http_status: status ?? null,
          error: errMessage(err),
          elapsed_ms: Date.now() - callStart,
          refresh_needed: false,
        });
      }
    }

    if (flags.once) break;
    if (Date.now() + intervalMs > deadlineMs) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  try {
    await client.close();
  } catch {
    // ignore
  }
  stopAndSummarize();
}

main().catch((err: unknown) => {
  logErrLine({ event: 'fatal', error: errMessage(err) });
  process.exitCode = 1;
});

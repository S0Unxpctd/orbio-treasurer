/**
 * Live MCP check for T-010 AC1 ("2/4 live, 2/4 fixture" — see tasks/T-010.md Evidence).
 *
 * SKIPPED BY DEFAULT. Opt in with `ORBIO_MCP_LIVE_TEST=1 pnpm --filter @orbio-treasurer/core
 * exec vitest run src/mcp/mcp-client.live.test.ts` — never run as part of the default
 * `pnpm test` (Builder/Auditor/Tester all run that; this ticket's live-call budget is 5 total
 * against orbio_get_balance/orbio_get_key_status, and only THOSE two — never
 * orbio_create_key/orbio_revoke_key/orbio_delete_key here, that would rotate So's production
 * key). Uses the real `.env.local` via `EnvFileTokenStore`, unmodified so it can be re-run.
 *
 * This test makes at most 2 live calls: getKeyStatus() on one client instance, then getBalance()
 * on a SECOND, freshly-constructed client instance reading the store from disk again — proving
 * the token-store round-trip (whatever `.env.local` held at the start of the run) actually
 * works end to end, which is what the ticket's "verify by a second call" asks for.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { EnvFileTokenStore, OrbioMcpClient } from './index.js';

const LIVE = process.env.ORBIO_MCP_LIVE_TEST === '1';
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const ENV_LOCAL_PATH = resolve(REPO_ROOT, '.env.local');
const MCP_URL = process.env.ORBIO_MCP_URL ?? 'https://www.orbio.so/api/mcp';

describe.skipIf(!LIVE)('OrbioMcpClient — live MCP (opt-in, ORBIO_MCP_LIVE_TEST=1)', () => {
  it('getKeyStatus() then, on a fresh client instance, getBalance() — read-only, 2 calls total', async () => {
    const clientA = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new EnvFileTokenStore(ENV_LOCAL_PATH),
    });
    const keyStatus = await clientA.getKeyStatus();
    expect(typeof keyStatus.hasKey).toBe('boolean');
    await clientA.close();

    // Fresh instance, fresh read from .env.local — proves the store (and, if a proactive/401
    // refresh happened above, the rotated pair it would have persisted) round-trips correctly.
    const clientB = new OrbioMcpClient({
      mcpUrl: MCP_URL,
      tokenStore: new EnvFileTokenStore(ENV_LOCAL_PATH),
    });
    const balance = await clientB.getBalance();
    expect(/^-?\d+$/.test(balance.valueMicroUsd)).toBe(true);
    await clientB.close();
  });
});

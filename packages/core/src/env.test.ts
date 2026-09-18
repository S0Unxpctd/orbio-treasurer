import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

describe('loadEnv — defaults', () => {
  it('applies every documented default on a bare environment', () => {
    const env = loadEnv({});
    expect(env.LEDGER).toBe('sqlite');
    expect(env.LEDGER_SQLITE_PATH).toBe('./treasurer.db');
    expect(env.BOOK_CLIENT).toBe('readonly');
    expect(env.STAKE_CLIENT).toBe('none');
    expect(env.TREASURER_LIVE).toBe(false);
    expect(env.RH_CHAIN_ID).toBe(4663);
    expect(env.ORBIO_MCP_URL).toBe('https://www.orbio.so/api/mcp');
  });

  it('boots with LEDGER=sqlite and no SUPABASE_* var (CLAUDE.md #5c, FR-1.0 AC)', () => {
    expect(() => loadEnv({ LEDGER: 'sqlite' })).not.toThrow();
  });

  it('parses TREASURER_LIVE=true', () => {
    expect(loadEnv({ TREASURER_LIVE: 'true' }).TREASURER_LIVE).toBe(true);
  });

  it('parses TREASURER_LIVE=false explicitly', () => {
    expect(loadEnv({ TREASURER_LIVE: 'false' }).TREASURER_LIVE).toBe(false);
  });

  it('coerces RH_CHAIN_ID to a number', () => {
    expect(loadEnv({ RH_CHAIN_ID: '11155111' }).RH_CHAIN_ID).toBe(11155111);
  });

  // S-01
  it('defaults TREASURER_MODE to normal and leaves GATEWAY_KEYS/ROUTER_ALLOW unset', () => {
    const env = loadEnv({});
    expect(env.TREASURER_MODE).toBe('normal');
    expect(env.GATEWAY_KEYS).toBeUndefined();
    expect(env.ROUTER_ALLOW).toBeUndefined();
  });

  it('parses GATEWAY_KEYS, ROUTER_ALLOW and an explicit TREASURER_MODE', () => {
    const env = loadEnv({
      GATEWAY_KEYS: 'otk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,otk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ROUTER_ALLOW: 'model-a,model-b',
      TREASURER_MODE: 'eco',
    });
    expect(env.GATEWAY_KEYS).toContain('otk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(env.ROUTER_ALLOW).toBe('model-a,model-b');
    expect(env.TREASURER_MODE).toBe('eco');
  });

  it('rejects an invalid TREASURER_MODE by name only', () => {
    let error: unknown;
    try {
      loadEnv({ TREASURER_MODE: 'yolo' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(['TREASURER_MODE']);
  });
});

describe('loadEnv — missing required vars are named, never valued', () => {
  it('LEDGER=postgres with none of SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/DATABASE_URL set', () => {
    let error: unknown;
    try {
      loadEnv({ LEDGER: 'postgres' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const err = error as EnvValidationError;
    expect(err.missing).toEqual(
      expect.arrayContaining(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']),
    );
    // The message names variables, never a value — assert no leaked-looking secret substring.
    expect(err.message).not.toMatch(/sk-|postgres:\/\//);
  });

  it('LEDGER=postgres is satisfied by DATABASE_URL alone', () => {
    expect(() =>
      loadEnv({ LEDGER: 'postgres', DATABASE_URL: 'postgres://user:pass@host/db' }),
    ).not.toThrow();
  });

  it('LEDGER=postgres is satisfied by SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(() =>
      loadEnv({
        LEDGER: 'postgres',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'secret-key',
      }),
    ).not.toThrow();
  });

  it('LEDGER=postgres with only SUPABASE_URL names the missing pieces', () => {
    let error: unknown;
    try {
      loadEnv({ LEDGER: 'postgres', SUPABASE_URL: 'https://project.supabase.co' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const err = error as EnvValidationError;
    expect(err.missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']);
  });

  it('BOOK_CLIENT=orbio requires ORBIO_BUY_URL and ORBIO_BUY_TOKEN, named exactly', () => {
    let error: unknown;
    try {
      loadEnv({ BOOK_CLIENT: 'orbio' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(['ORBIO_BUY_URL', 'ORBIO_BUY_TOKEN']);
  });

  it('STAKE_CLIENT=uniswap requires the full L2a chain var set, named exactly', () => {
    let error: unknown;
    try {
      loadEnv({ STAKE_CLIENT: 'uniswap' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual([
      'RH_RPC_URL',
      'UNISWAP_ROUTER',
      'UNISWAP_QUOTER',
      'ORBIO_TOKEN',
      'STABLE_TOKEN',
      'AGENT_WALLET_PK',
    ]);
  });

  it('an invalid enum value is reported by variable name only', () => {
    let error: unknown;
    try {
      loadEnv({ LEDGER: 'mysql' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(['LEDGER']);
  });
});

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

// S-03: treasury read + wallet-signed key (tasks/S-03.md, docs/PRD-1.0-sprint.md §3/§4 T-3)
describe('loadEnv — S-03 chain vars', () => {
  it('defaults RH_RPC_URLS to the publicnode -> ordofi order and leaves the 7 address vars unset', () => {
    const env = loadEnv({});
    expect(env.RH_RPC_URLS).toBe('https://robinhood-rpc.publicnode.com,https://rpc.ordofi.network');
    expect(env.CREDIT_ADDRESS).toBeUndefined();
    expect(env.STAKING_ADDRESS).toBeUndefined();
    expect(env.EXCHANGE_ADDRESS).toBeUndefined();
    expect(env.ORBIO_ADDRESS).toBeUndefined();
    expect(env.USDG_ADDRESS).toBeUndefined();
    expect(env.NVDA_ADDRESS).toBeUndefined();
    expect(env.PAYOUT_ADDRESS).toBeUndefined();
    expect(env.TREASURER_PRIVATE_KEY).toBeUndefined();
    expect(env.STAKER_ADDRESS).toBeUndefined();
    expect(env.STAKER_PRIVATE_KEY).toBeUndefined();
  });

  it('boots fine with none of the S-03 vars set (chain features are opt-in)', () => {
    expect(() => loadEnv({})).not.toThrow();
  });

  it('parses an explicit RH_RPC_URLS override', () => {
    const env = loadEnv({ RH_RPC_URLS: 'https://a.example/rpc,https://b.example/rpc' });
    expect(env.RH_RPC_URLS).toBe('https://a.example/rpc,https://b.example/rpc');
  });

  it('accepts a well-formed TREASURER_PRIVATE_KEY / STAKER_PRIVATE_KEY (0x + 64 hex)', () => {
    const pk = `0x${'ab'.repeat(32)}`;
    const env = loadEnv({ TREASURER_PRIVATE_KEY: pk, STAKER_PRIVATE_KEY: pk });
    expect(env.TREASURER_PRIVATE_KEY).toBe(pk);
    expect(env.STAKER_PRIVATE_KEY).toBe(pk);
  });

  it('rejects a malformed TREASURER_PRIVATE_KEY by name only, never the value', () => {
    let error: unknown;
    try {
      loadEnv({ TREASURER_PRIVATE_KEY: 'not-a-key' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(['TREASURER_PRIVATE_KEY']);
    expect((error as EnvValidationError).message).not.toContain('not-a-key');
  });

  it('rejects a malformed STAKER_ADDRESS (must be 0x + 40 hex, not 64)', () => {
    let error: unknown;
    try {
      loadEnv({ STAKER_ADDRESS: `0x${'ab'.repeat(32)}` });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(['STAKER_ADDRESS']);
  });

  it('accepts a well-formed STAKER_ADDRESS', () => {
    const addr = `0x${'ab'.repeat(20)}`;
    expect(loadEnv({ STAKER_ADDRESS: addr }).STAKER_ADDRESS).toBe(addr);
  });

  it('the 7 chain address vars pass through as opaque strings (checksum validated in chain/contracts.ts, not here)', () => {
    const env = loadEnv({
      CREDIT_ADDRESS: '0xe33322da1380e61e5ae5dfb21e7f62924c73004c',
      STAKING_ADDRESS: '0xe0710011278bfb63e57c5f227e5980984b1eddca',
      EXCHANGE_ADDRESS: '0x6951ffd32630b05e06f50062aea801625a58ebc0',
      ORBIO_ADDRESS: '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3',
      USDG_ADDRESS: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      NVDA_ADDRESS: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
      PAYOUT_ADDRESS: '0x4cbbbf652b11ed1294df0ac49d8322394310cfc5',
    });
    expect(env.CREDIT_ADDRESS).toBe('0xe33322da1380e61e5ae5dfb21e7f62924c73004c');
    expect(env.USDG_ADDRESS).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  });
});

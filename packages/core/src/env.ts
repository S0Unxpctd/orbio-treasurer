/**
 * Environment loading and validation (T-002, ARCHITECTURE.md §6).
 *
 * Every variable is read through `loadEnv()`. Required-ness is conditional on the selected
 * ledger/book/stake client, per ARCH §6's per-group comments (`# L2a only`, `# hosted only`, …)
 * and this ticket's guidance. `loadEnv()` never includes a variable's *value* in an error —
 * only its name — so a thrown error is always safe to log or print (CLAUDE.md #4).
 *
 * Discovered (see tasks/T-002.md): ARCH §6 does not list `DATABASE_URL`, but the ticket's
 * concrete guidance says Postgres may be configured via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
 * *or* a `DATABASE_URL`; `DATABASE_URL` is added here as that alternative.
 */
import { z } from 'zod';

const LEDGER_VALUES = ['sqlite', 'postgres'] as const;
const BOOK_CLIENT_VALUES = ['readonly', 'orbio'] as const;
const STAKE_CLIENT_VALUES = ['none', 'uniswap'] as const;

export type Ledger = (typeof LEDGER_VALUES)[number];
export type BookClientKind = (typeof BOOK_CLIENT_VALUES)[number];
export type StakeClientKind = (typeof STAKE_CLIENT_VALUES)[number];

const optionalString = z.string().min(1).optional();

const baseSchema = z.object({
  // --- core (every agent) ---
  LEDGER: z.enum(LEDGER_VALUES).default('sqlite'),
  LEDGER_SQLITE_PATH: z.string().min(1).default('./treasurer.db'),
  ORBIO_MCP_URL: z.string().min(1).default('https://www.orbio.so/api/mcp'),
  ORBIO_MCP_TOKEN: optionalString,
  ORBIO_GATEWAY_BASE_URL: optionalString,
  ORBIO_KEY: optionalString,

  BOOK_CLIENT: z.enum(BOOK_CLIENT_VALUES).default('readonly'),
  ORBIO_BOOK_READ_URL: optionalString,
  ORBIO_BUY_URL: optionalString,
  ORBIO_BUY_TOKEN: optionalString,

  STAKE_CLIENT: z.enum(STAKE_CLIENT_VALUES).default('none'),
  RH_RPC_URL: optionalString,
  RH_CHAIN_ID: z.coerce.number().int().positive().default(4663),
  UNISWAP_ROUTER: optionalString,
  UNISWAP_QUOTER: optionalString,
  ORBIO_TOKEN: optionalString,
  STABLE_TOKEN: optionalString,
  AGENT_WALLET_PK: optionalString,

  TREASURER_LIVE: z.stringbool().default(false),

  LANDING_URL: optionalString,
  LANDING_AGENT_TOKEN: optionalString,

  // --- hosted only (Supabase-backed ledger; DATABASE_URL is an accepted alternative) ---
  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  DATABASE_URL: optionalString,
  CRON_SECRET: optionalString,
  NEXT_PUBLIC_SITE_URL: optionalString,

  // --- book-daily ---
  X_API_KEY: optionalString,
  X_API_SECRET: optionalString,
  X_ACCESS_TOKEN: optionalString,
  X_ACCESS_SECRET: optionalString,
});

export type Env = z.infer<typeof baseSchema>;

/** Thrown by `loadEnv()`. Carries only variable *names* — never values. */
export class EnvValidationError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Missing or invalid required environment variable(s): ${missing.join(', ')}`);
    this.name = 'EnvValidationError';
    this.missing = missing;
  }
}

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

const STAKE_UNISWAP_VARS = [
  'RH_RPC_URL',
  'UNISWAP_ROUTER',
  'UNISWAP_QUOTER',
  'ORBIO_TOKEN',
  'STABLE_TOKEN',
  'AGENT_WALLET_PK',
] as const;

/**
 * Parses and validates `source` (defaults to `process.env`) into an `Env`.
 * Throws `EnvValidationError` naming every missing/invalid variable — by name only — when:
 *   - a supplied value doesn't match its expected shape/enum, or
 *   - LEDGER=postgres and neither (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) nor DATABASE_URL is set, or
 *   - BOOK_CLIENT=orbio and ORBIO_BUY_URL/ORBIO_BUY_TOKEN are missing, or
 *   - STAKE_CLIENT=uniswap and any of the L2a chain vars are missing.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = baseSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new EnvValidationError(names);
  }
  const env = parsed.data;
  const missing: string[] = [];

  if (env.LEDGER === 'postgres') {
    const hasDatabaseUrl = isSet(source.DATABASE_URL);
    if (!hasDatabaseUrl) {
      if (!isSet(source.SUPABASE_URL)) missing.push('SUPABASE_URL');
      if (!isSet(source.SUPABASE_SERVICE_ROLE_KEY)) missing.push('SUPABASE_SERVICE_ROLE_KEY');
      // Only ask for DATABASE_URL as a named alternative once the pair above is incomplete.
      if (!isSet(source.SUPABASE_URL) || !isSet(source.SUPABASE_SERVICE_ROLE_KEY)) {
        missing.push('DATABASE_URL');
      }
    }
  }

  if (env.BOOK_CLIENT === 'orbio') {
    if (!isSet(source.ORBIO_BUY_URL)) missing.push('ORBIO_BUY_URL');
    if (!isSet(source.ORBIO_BUY_TOKEN)) missing.push('ORBIO_BUY_TOKEN');
  }

  if (env.STAKE_CLIENT === 'uniswap') {
    for (const name of STAKE_UNISWAP_VARS) {
      if (!isSet(source[name])) missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new EnvValidationError(missing);
  }

  return env;
}

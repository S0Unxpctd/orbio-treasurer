/**
 * @orbio-treasurer/core — public entry point.
 * Modules land here ticket by ticket (see tasks/). T-001 ships the package shell only.
 */
export const CORE_VERSION = '0.0.1';

/** Layers the Treasurer can run at; see PRD §7. */
export type Layer = 'L0' | 'L1' | 'L2a' | 'L2b';

export type { BookClientKind, Env, Ledger, StakeClientKind } from './env.js';
export { EnvValidationError, loadEnv } from './env.js';
// T-002: ledger schema source and env loading. LedgerStore implementations land in T-011.
export type {
  ColumnDef,
  ColumnType,
  IndexDef,
  RlsPolicy,
  TableDef,
  WritePolicy,
} from './ledger/schema.js';
export { LEDGER_SCHEMA } from './ledger/schema.js';

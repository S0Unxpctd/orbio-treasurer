/**
 * @orbio-treasurer/core — public entry point.
 * Modules land here ticket by ticket (see tasks/). T-001 ships the package shell only.
 */
export const CORE_VERSION = '0.0.1';

/** Layers the Treasurer can run at; see PRD §7. */
export type Layer = 'L0' | 'L1' | 'L2a' | 'L2b';

// T-002: ledger schema source and env loading. T-011: exact decimal-string arithmetic
// (ADR-002), pure snapshot metrics math (FR-1.3, FR-3.3), and the LedgerStore interface with
// its SQLite (kit default) and Postgres (hosted reference/landing) implementations.
export type { BookClientKind, Env, Ledger, StakeClientKind } from './env.js';
export { EnvValidationError, loadEnv } from './env.js';
export type { ScaledDecimal } from './ledger/decimal.js';
export {
  divideDecimal,
  formatDecimal,
  maxDecimal,
  normalizeMoney,
  normalizeTokenAmount,
  parseDecimal,
  subDecimal,
} from './ledger/decimal.js';
export type { SnapshotMetrics, SnapshotMetricsInput } from './ledger/metrics.js';
export {
  computeSnapshotMetrics,
  DEFAULT_EPSILON_USD_PER_DAY,
  LOW_CONFIDENCE_THRESHOLD_HOURS,
} from './ledger/metrics.js';
export { openPostgresLedger, PostgresLedgerStore } from './ledger/postgres/store.js';
export type {
  ColumnDef,
  ColumnType,
  IndexDef,
  RlsPolicy,
  TableDef,
  WritePolicy,
} from './ledger/schema.js';
export { LEDGER_SCHEMA } from './ledger/schema.js';
export { openSqliteLedger, SqliteLedgerStore } from './ledger/sqlite/store.js';
export type {
  AgentMode,
  AgentMutablePatch,
  AgentRow,
  BalanceSource,
  BookSnapshotRow,
  BookSnapshotSource,
  DecisionRow,
  Id,
  IsoTimestamp,
  KeyMetaRow,
  LedgerStore,
  Money,
  NewAgent,
  NewBookSnapshot,
  NewDecision,
  NewKeyMeta,
  NewOrder,
  NewTreasurySnapshot,
  NewUsageEvent,
  OrderFillPatch,
  OrderRow,
  OrderSide,
  TokenAmount,
  TreasurySnapshotRow,
  UsageEventRow,
} from './ledger/types.js';
export { NotFoundError } from './ledger/types.js';
// T-010: OrbioMcpClient, token refresh/rotation, balance chain mcp -> estimate.
export type {
  BalanceSourceResult,
  BalanceStructuredContent,
  Clock,
  EstimateInput,
  KeyRotateResult,
  KeyStatusStructuredContent,
  McpBalanceReader,
  McpContentBlock,
  McpTokenPair,
  McpTokenStore,
  McpToolCallResult,
  McpToolName,
  McpTransport,
  McpTransportFactory,
  OAuthRefresher,
  OAuthRefreshResult,
  OrbioMcpClientConfig,
  RecordUnrecognizedSampleOptions,
} from './mcp/index.js';
export {
  AdapterShapeError,
  balanceStructuredContentSchema,
  createKeyStructuredContentSchema,
  defaultOAuthRefresher,
  defaultTransportFactory,
  EnvFileTokenStore,
  estimateBalanceMicroUsd,
  getBalanceViaChain,
  InMemoryTokenStore,
  keyStatusStructuredContentSchema,
  MCP_TOOL_NAMES,
  McpHttpError,
  McpUnavailableError,
  OrbioMcpClient,
  parseStructuredContent,
  recordUnrecognizedSample,
  revokeKeyStructuredContentSchema,
} from './mcp/index.js';

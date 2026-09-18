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
  addDecimal,
  divideDecimal,
  formatDecimal,
  maxDecimal,
  normalizeMoney,
  normalizeTokenAmount,
  parseDecimal,
  subDecimal,
} from './ledger/decimal.js';
export type {
  MeteredTier,
  MetricsWindow,
  SavingsResult,
  SnapshotMetrics,
  SnapshotMetricsInput,
  TierSavings,
} from './ledger/metrics.js';
export {
  burnDaily,
  computeSnapshotMetrics,
  DEFAULT_EPSILON_USD_PER_DAY,
  LOW_CONFIDENCE_THRESHOLD_HOURS,
  savings,
} from './ledger/metrics.js';
export { openPostgresLedger, PostgresLedgerStore } from './ledger/postgres/store.js';
export { LedgerCallRecorder } from './ledger/recorder.js';
// Merge note (S-01 ∥ S-02): the router's CallRecord (router/recorder.ts) and the ledger's
// (ledger/recorder-types.ts) were written in parallel with different shapes; S-06 adds the adapter.
// The ledger pair is exported under a distinct name until then.
export type {
  CallRecord as LedgerCallRecord,
  CallRecorder as LedgerCallRecorderContract,
} from './ledger/recorder-types.js';
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
  CallerKeyRow,
  ChainSnapshotRow,
  DecisionRow,
  Id,
  IsoTimestamp,
  KeyMetaRow,
  LedgerStore,
  Money,
  NewAgent,
  NewBookSnapshot,
  NewCallerKey,
  NewChainSnapshot,
  NewDecision,
  NewKeyMeta,
  NewOrder,
  NewTreasuryEvent,
  NewTreasurySnapshot,
  NewUsageEvent,
  OrderFillPatch,
  OrderRow,
  OrderSide,
  TokenAmount,
  TreasuryEventKind,
  TreasuryEventRow,
  TreasuryEventToken,
  TreasurySnapshotRow,
  UsageEventRow,
} from './ledger/types.js';
export { CallerKeyAlreadyRevokedError, InvalidTxHashError, NotFoundError } from './ledger/types.js';
// S-01: redact()/log() weren't yet exported from this barrel — every consumer outside `core` (the
// gateway route handlers) needs both to satisfy CLAUDE.md #4 ("Use redact() ... in every log
// line"), so this ticket adds the export rather than duplicating either in apps/web.
export type { Logger, LogLevel } from './log.js';
export { createLogger, log } from './log.js';
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
export type { RedactOptions } from './redact.js';
export { DEFAULT_ALLOW_TX_HASH_KEYS, redact } from './redact.js';
export { computeBaselineCostUsd, selectBaselineModel } from './router/baseline.js';
export type { FetchedCatalog, ModelsResponse } from './router/catalog.js';
export {
  buildAutoModelEntries,
  createCachedCatalogFetcher,
  fetchModelCatalog,
} from './router/catalog.js';
export type { RouterAdapterShapeSource } from './router/errors.js';
export { AdapterShapeError as RouterAdapterShapeError } from './router/errors.js';
export type { CallerKeyLookup, CallerKeyStore } from './router/keys.js';
export { authenticateBearer, EnvCallerKeyStore, hashKey, isValidKeyShape } from './router/keys.js';
// S-01: gateway + router (docs/PRD-1.0-sprint.md §4 T-1). `route()` is pure; keys/recorder/
// catalog/upstream do I/O. `AdapterShapeError` is aliased on export — the (frozen/obsolete, see
// CLAUDE.md banner) mcp module already exports a class of that name above, and router/errors.ts
// is deliberately its own, independent class rather than a shared dependency on mcp/schemas.ts.
export type { CallRecord, CallRecorder, CallStatus } from './router/recorder.js';
export {
  InMemoryCallRecorder,
  JsonlStdoutCallRecorder,
  recordFireAndForget,
} from './router/recorder.js';
export { cheapestInTier, classifyTier, priceTier, route } from './router/route.js';
export type {
  Mode,
  ModelCatalogEntry,
  RouteInput,
  RouteMessage,
  RouteOpts,
  RouteResult,
  Tier,
} from './router/types.js';
export { MODES, RouterError, TIERS } from './router/types.js';
export type {
  ForwardChatCompletionParams,
  ForwardChatCompletionResult,
  UsageResult,
} from './router/upstream.js';
export { forwardChatCompletion, getUpstreamKey } from './router/upstream.js';

/**
 * @orbio-treasurer/core/mcp — public surface of the MCP module (T-010).
 * See client.ts, schemas.ts, token-store.ts, balance-chain.ts for the implementation notes.
 */
export type { BalanceSourceResult, EstimateInput, McpBalanceReader } from './balance-chain.js';
export { estimateBalanceMicroUsd, getBalanceViaChain } from './balance-chain.js';
export type {
  Clock,
  KeyRotateResult,
  McpContentBlock,
  McpToolCallResult,
  McpTransport,
  McpTransportFactory,
  OAuthRefresher,
  OAuthRefreshResult,
  OrbioMcpClientConfig,
} from './client.js';
export {
  defaultOAuthRefresher,
  defaultTransportFactory,
  McpHttpError,
  McpUnavailableError,
  OrbioMcpClient,
} from './client.js';
export type {
  BalanceStructuredContent,
  KeyStatusStructuredContent,
  McpToolName,
  RecordUnrecognizedSampleOptions,
} from './schemas.js';
export {
  AdapterShapeError,
  balanceStructuredContentSchema,
  createKeyStructuredContentSchema,
  keyStatusStructuredContentSchema,
  MCP_TOOL_NAMES,
  parseStructuredContent,
  recordUnrecognizedSample,
  revokeKeyStructuredContentSchema,
} from './schemas.js';
export type { McpTokenPair, McpTokenStore } from './token-store.js';
export { EnvFileTokenStore, InMemoryTokenStore } from './token-store.js';

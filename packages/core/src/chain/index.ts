/** chain/ — S-03 barrel. See tasks/S-03.md and docs/PRD-1.0-sprint.md §3. */

export type { RpcTracker } from './chain.js';
export {
  createRobinhoodClient,
  createRpcTracker,
  DEFAULT_RH_RPC_URLS,
  MULTICALL3_ADDRESS,
  parseRhRpcUrls,
  ROBINHOOD_CHAIN_ID,
  robinhoodChain,
} from './chain.js';
export type { ChainAddresses } from './contracts.js';
export {
  ChainEnvValidationError,
  creditAbi,
  erc20Abi,
  exchangeAbi,
  loadChainAddresses,
  stakingAbi,
} from './contracts.js';
export type { ChainAdapterShapeSource } from './errors.js';
export { AdapterShapeError, GatewayKeyHttpError } from './errors.js';
export type { ApiBalance } from './key.js';
export {
  deriveOrbioKey,
  orbioKeyDerivationMessage,
  parseOrbioBalanceHeader,
  readApiBalance,
} from './key.js';
export type { ChainSnapshot, QuoteResult, ReadTreasuryOptions } from './read.js';
export {
  QUOTE_PROBE_MAX_FILLS,
  QUOTE_PROBE_USDG_IN,
  readTreasury,
} from './read.js';
export type { SnapshotTreasuryParams, SnapshotTreasuryResult } from './snapshot.js';
export { snapshotTreasury } from './snapshot.js';

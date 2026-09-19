/** chain/ — S-03/S-04/S-05 barrel. See tasks/S-03.md, tasks/S-04.md, tasks/S-05.md and
 *  docs/PRD-1.0-sprint.md §3-6. */

export type {
  BuyCaps,
  BuyCreditDeps,
  BuyCreditResult,
  BuyExecClient,
  BuyExecuteDeps,
  BuyExecutionResult,
  BuyHistoryInput,
  BuyPlan,
  BuyQuoteInput,
  BuyRefusal,
  BuyRefusalReason,
  BuyWalletBalances,
  PlanBuyInput,
  ResolveBuyCapsOptions,
} from './buy.js';
export {
  addressToBeneficiary,
  buyCredit,
  DEFAULT_MAX_FEE_GWEI,
  DEFAULT_MIN_GAS_ETH,
  executeBuy,
  planBuy,
  resolveBuyCaps,
  resolveMaxFeeGweiCap,
} from './buy.js';
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
export type {
  ClaimAndActivateDeps,
  ClaimAndActivateResult,
  ClaimCaps,
  ClaimExecClient,
  ClaimExecuteDeps,
  ClaimExecutionResult,
  ClaimHistoryInput,
  ClaimLegResult,
  ClaimPlan,
  ClaimReadClient,
  ClaimRefusal,
  ClaimRefusalReason,
  ClaimStep,
  ClaimStepResult,
  DiscoverLatestPeriodIdOptions,
  DiscoverPeriodsToSettleOptions,
  ExecuteActivateFromHotDeps,
  HotActivatePlan,
  ManualAlertPlan,
  ManualAlertStep,
  NoOpClaimPlan,
  PlanClaimInput,
  ResolveClaimCapsOptions,
  SettleClaimActivatePlan,
} from './claim.js';
export {
  ClaimExecutionError,
  claimAndActivate,
  DEFAULT_MAX_FEE_GWEI as CLAIM_DEFAULT_MAX_FEE_GWEI,
  DEFAULT_MIN_GAS_ETH as CLAIM_DEFAULT_MIN_GAS_ETH,
  DEFAULT_STAKER_MIN_GAS_ETH,
  DISCOVERY_MAX_PERIODS_BACK,
  discoverLatestPeriodId,
  discoverPeriodsToSettle,
  executeActivateFromHot,
  executeClaim,
  planClaim,
  resolveClaimCaps,
  resolveMaxFeeGweiCap as resolveClaimMaxFeeGweiCap,
} from './claim.js';
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
export {
  addressToBytes32,
  capRemaining,
  decodeEventFromContract,
  requireSuccessReceipt,
  sumAtomsForUtcDay,
  utcDateKey,
} from './tx.js';

import type { Address, Hex } from "viem";

import type { LineKind, LineParams, MarketParams, PegSourceKind } from "./deployments/types.js";
import type { PegHealth } from "./math.js";

/** Unsigned transaction: send as-is from the user's wallet. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

export type LoanState = "None" | "Active" | "Auction" | "Closed" | "Liquidated";
export type EscrowType = "NORMAL" | "LOCKED" | "MANAGED";

export interface EpochInfo {
  /** Block the view was read at. */
  blockNumber: bigint;
  /** Timestamp of that block. */
  now: bigint;
  epochLength: bigint;
  /** Start (and id) of the current epoch. */
  currentEpoch: bigint;
  /** Start of the next epoch. */
  nextFlip: bigint;
  secondsToFlip: bigint;
  /** The epoch before the current one: its tally is final. */
  lastClosedEpoch: bigint;
  /** Tally epoch whose votes drive the current allocation. */
  activeTallyEpoch: bigint;
  /** Epoch of the last rebalance (0 before the first). */
  lastRebalanceEpoch: bigint;
  /** No rebalance has run in the current epoch yet. */
  rebalanceDue: boolean;
  /** Seasoning length in epochs (SuretyPool.SEASON). */
  season: bigint;
}

export interface VaultStats {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  asset: Address;
  totalAssets: bigint;
  totalSupply: bigint;
  /** Assets per 1e18 shares (srMUSD -> MUSD). */
  sharePrice: bigint;
  /**
   * MUSD not lent out: what the vault holds itself plus what its savings adapter parks in sMUSD (v2). Withdrawals
   * and covers draw on both.
   */
  idle: bigint;
  /** MUSD held by the vault contract itself. */
  idleInVault: bigint;
  /** MUSD parked in sMUSD through the savings adapter (`realAssets`); 0 without one, null when unreadable. */
  parked: bigint | null;
  /** Share of total assets the allocator keeps idle, bps. */
  idleBufferBps: bigint;
  /** Performance fee on interest, WAD (the voters' fee). */
  performanceFee: bigint;
  performanceFeeRecipient: Address;
  /** Management fee, WAD per second. */
  managementFee: bigint;
  /** Max share-price growth rate, WAD per second. */
  maxRate: bigint;
  /**
   * Whether the vault's DepositGate holds new shares back (SuretyPool.depositsPaused): a loss is pending or uncovered,
   * or a cover's MUSD is still being re-recognised. Deposits, share transfers and pool claims wait; withdrawals never
   * do. null when unknown (a deployment without the gate).
   */
  depositsPaused: boolean | null;
  /** Estimated depositor APY: asset-weighted line supply APYs, net of fees. */
  supplyApy: number;
}

export interface BoardLine {
  id: number;
  name: string;
  kind: LineKind;
  active: boolean;
  adapter: Address;
  /** Morpho lines only. */
  marketId?: Hex;
  marketParams?: MarketParams;
  votes: {
    current: bigint;
    /** Share of the current epoch's total votes, 0..1. */
    currentShare: number;
    lastClosed: bigint;
    lastClosedShare: number;
  };
  /** Assets the vault holds in the line now (VoteAllocator.lineAssets). */
  allocation: bigint | null;
  /** Target of the next rebalance (VoteAllocator.targets). */
  target: bigint | null;
  /** Borrowed / supplied, WAD. */
  utilizationWad: bigint | null;
  /** Estimated APY the line pays its suppliers (the vault), before vault fees. */
  supplyApy: number | null;
  /** Borrower APY at current utilisation. */
  borrowApy: number | null;
  /** Borrow rate source: the IRM's live view, or derived from the stored rate at target. */
  borrowRateSource: "irm" | "derived" | "line" | null;
  /** Sponsor incentives posted for this line in the current epoch. */
  incentives: { shares: bigint; assets: bigint };
  /** MUSD the line's unmatured cohorts plus the reserve can pay toward its losses now. */
  coverCapacity: bigint | null;
  /** Recorded loss not covered yet (borne by lenders until covered). */
  uncoveredLoss: bigint | null;
  lossRecorded: bigint | null;
  lossCovered: bigint | null;
  /** veBTC line only: whether new borrowing is paused. */
  paused?: boolean;
  /** Whether the line's oracle quotes right now (stale or bad prices fail closed). */
  oracleLive: boolean | null;
}

export interface Board {
  epoch: EpochInfo;
  vault: VaultStats;
  lines: BoardLine[];
  totals: { currentVotes: bigint; lastClosedVotes: bigint };
}

export interface Ballot {
  tokenId: bigint;
  lineIds: number[];
  weightsBps: number[];
  /** Epoch the ballot was last cast or poked into (0 if never). */
  epochCast: bigint;
  currentEpoch: bigint;
  castThisEpoch: boolean;
  /** A stored ballot from an earlier epoch that `poke` would recast. */
  pokeable: boolean;
  /** Voting power at the current epoch start (what a vote or poke would count). */
  powerAtEpochStart: bigint;
  /** Power tallied per line in the current epoch. */
  votesThisEpoch: { lineId: number; votes: bigint }[];
}

export interface VeBTCLock {
  amount: bigint;
  /** Unlock time; 0 for permanent locks. */
  end: bigint;
  isPermanent: boolean;
  boost: bigint;
}

export interface VeBTCPosition {
  tokenId: bigint;
  /** Wallet that owns the NFT, or the borrower when it sits in a Surety loan escrow. */
  owner: Address;
  /** Held by a Surety loan escrow. */
  escrowed: boolean;
  loanId: bigint | null;
  lock: VeBTCLock;
  escrowType: EscrowType;
  /** Vesting lock with a grant manager (cannot be borrowed against). */
  grantLock: boolean;
  powerAtEpochStart: bigint;
  /** Has an active vote on Mezo's PoolsVoter. */
  votedOnMezo: boolean;
  /** Epoch of the NFT's Surety ballot (0 if none). */
  ballotEpoch: bigint;
  /** What the veBTC line would lend against it now (null if the oracle is down, 0 if ineligible). */
  maxBorrow: bigint | null;
}

export type CohortStatus = "claimable" | "claimed" | "maturing" | "at-risk" | "empty";

export interface CohortPosition {
  lineId: number;
  /** Tally epoch of the cohort. */
  epoch: bigint;
  /** Power the NFT voted for the line in that epoch. */
  votes: bigint;
  lineVotes: bigint;
  /** When the cohort can be claimed and stops being slashable. */
  maturity: bigint;
  /**
   * claimable: matured, unclaimed. claimed: paid. maturing: seasoning, first loss for its line.
   * at-risk: seasoning while its line has an uncovered loss (a cover would slash it). empty: matured with nothing.
   */
  status: CohortStatus;
  /** The NFT's pro-rata share of the cohort (exact once matured). */
  shares: bigint;
  assets: bigint;
}

export interface Cohorts {
  tokenId: bigint;
  currentEpoch: bigint;
  season: bigint;
  cohorts: CohortPosition[];
  totals: { claimableAssets: bigint; maturingAssets: bigint; atRiskAssets: bigint };
}

export interface LoanView {
  loanId: bigint;
  borrower: Address;
  escrow: Address;
  tokenId: bigint;
  state: LoanState;
  debt: bigint;
  lock: VeBTCLock;
  /** Live collateral value in MUSD (null if the oracle is down). */
  collateralValue: bigint | null;
  ltvBps: bigint | null;
  maxLtvBps: bigint;
  liqLtvBps: bigint;
  /** Lock end for timed locks; null for permanent locks. */
  maturity: bigint | null;
  expired: boolean;
  /** Whether `startAuction` would pass now (null if it depends on an unavailable price). */
  liquidatable: boolean | null;
  liquidationReason: "ltv" | "expiry" | null;
  /** BTC/USD price (WAD) at which the loan reaches the liquidation LTV. */
  liquidationPriceWad: bigint | null;
  auctionStart: bigint | null;
  auctionEndsAt: bigint | null;
  /** Current Dutch auction price (Auction state only). */
  auctionPrice: bigint | null;
  /** Whether anyone may harvest the NFT's rewards into repayment (v2; false on v1 lines). */
  autoRepay: boolean;
  /** Address that started the auction, paid the keeper share of the liquidation fee (v2; null otherwise). */
  keeper: Address | null;
}

export type BorrowIneligibility =
  | "not-normal"
  | "grant-lock"
  | "no-lock"
  | "term-too-short"
  | "escrowed"
  | "oracle-unavailable"
  | "no-liquidity"
  | "line-paused"
  | "above-max"
  | "peg-unhealthy";

export interface BorrowQuote {
  tokenId: bigint;
  owner: Address;
  eligible: boolean;
  reasons: BorrowIneligibility[];
  lock: VeBTCLock;
  priceWad: bigint | null;
  collateralValue: bigint | null;
  maxLtvBps: bigint;
  liqLtvBps: bigint;
  /** What `open` would lend now (contract maxBorrow), capped by line cash. */
  maxBorrow: bigint;
  /** Amount quoted (requested amount, or maxBorrow). */
  amount: bigint;
  ltvBps: bigint | null;
  liquidationPriceWad: bigint | null;
  /** Lock end for timed locks; null for permanent locks. */
  maturity: bigint | null;
  minTerm: bigint;
  lineCash: bigint;
  borrowAprNow: number;
  borrowAprAfter: number;
  borrowApyAfter: number;
  /** Origination fee on `amount` (0 on v1 lines). */
  originationFee: bigint;
  /** What the borrower receives for `amount`; the debt is the full amount. */
  receives: bigint;
}

export interface AuctionView extends LoanView {
  /** Price floor the auction decays to. */
  floorPrice: bigint | null;
}

/* v2: MUSD peg */

export interface PegSourceReading {
  index: number;
  address: Address;
  /** From the deployment file; null when the file does not list it. */
  kind: PegSourceKind | null;
  pool: Address | null;
  ok: boolean;
  /** MUSD/USD, WAD; null when the source has no usable reading. */
  musdUsdWad: bigint | null;
}

export interface PegView extends PegHealth {
  address: Address;
  minSources: number;
  maxSpreadBps: number;
  bandBps: number;
  sources: PegSourceReading[];
  /** `pegHealthy()` as the contract answers it (the line refuses new loans while false). */
  healthyOnChain: boolean;
  /** `VoteAllocator.pegGateOpen()`: whether a rebalance would fund lines now. */
  allocatorGateOpen: boolean | null;
  /** BTC/USD under the line's price (stressed on a stress deployment); null when it reverts. */
  btcUsdWad: bigint | null;
  /** BTC in MUSD as the line and the Morpho oracle value it; null when it reverts. */
  btcMusdWad: bigint | null;
  /** Testnet: the StressedPegSource override, if one applies now. */
  stress: { active: boolean; musdUsdWad: bigint; endsAt: bigint } | null;
}

/* v2: fees */

export interface FeeSchedule {
  /** The veBTC line's parameters, fee fields included. */
  line: LineParams;
  treasury: Address | null;
  /** VaultV2 performance fee (the voters' fee), WAD. */
  performanceFee: bigint;
  performanceFeeRecipient: Address;
  /** VaultV2 management fee, WAD of total assets per second. */
  managementFee: bigint;
  /** The management fee as a yearly rate, WAD. */
  managementFeeAprWad: bigint;
  managementFeeRecipient: Address;
  /** ShareMarket fee on each fill; null without a ShareMarket. */
  shareMarketFeeBps: number | null;
}

/* v2: savings (idle MUSD in sMUSD) */

export interface SavingsView {
  adapter: Address;
  smusd: Address;
  /** Whether idle MUSD is parked (savings is the vault's liquidity adapter). */
  parking: boolean | null;
  liquidityAdapter: Address | null;
  /** MUSD held by the vault contract. */
  vaultIdle: bigint;
  /** Savings adapter `realAssets`: sMUSD held, MUSD held and yield claimable. */
  parked: bigint;
  /** vaultIdle + parked: what is not lent out. */
  idle: bigint;
  /** Yield a `harvest()` would claim and re-deposit now. */
  claimableYield: bigint | null;
  /** Cumulative yield sMUSD has paid the adapter. */
  yieldClaimed: bigint | null;
}

/* v2: ShareMarket */

export interface ShareListing {
  id: bigint;
  seller: Address;
  discountBps: number;
  /** srMUSD still for sale. */
  shares: bigint;
  /** What those shares are worth at the live share price, MUSD. */
  value: bigint;
  /** What a buyer pays for all of them now. */
  price: bigint;
  /** Treasury fee inside `price`. */
  fee: bigint;
}

export interface ShareMarketView {
  address: Address;
  feeBps: number;
  /** Whether listing and filling are open (the vault's gate takes new shares). */
  isOpen: boolean;
  openCount: bigint;
  /** Vault share price, MUSD per 1e18 srMUSD. */
  sharePrice: bigint;
  /** Open listings from `start`, at most `count` (positions are unordered). */
  listings: ShareListing[];
  /** The deepest discount on offer. */
  best: { id: bigint; discountBps: number; shares: bigint; pricePerShare: bigint } | null;
}

export interface ShareFillQuote {
  id: bigint;
  /** Shares the fill would buy. */
  filled: bigint;
  /** MUSD the buyer pays. */
  assets: bigint;
  fee: bigint;
  sellerReceives: bigint;
}

/* v2: testnet Sponsor */

export interface StarterKitEntry {
  user: Address;
  tokenId: bigint;
  btcGas: bigint;
  lockAmount: bigint;
  musd: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
}

export interface SponsorLedger {
  address: Address;
  kitsIssued: bigint;
  /** Full kits the Sponsor's balances still pay for; null when unreadable. */
  kitsLeft: bigint | null;
  dailyLimit: bigint;
  kit: { btcGas: bigint; lockAmount: bigint; musd: bigint; lockDuration: bigint };
  /** Every StarterKit event: the public ledger of the wallets that tried the product. */
  entries: StarterKitEntry[];
}

/* v2: harvesting a loan's rewards */

export interface HarvestPlan {
  loanId: bigint;
  tokenId: bigint;
  autoRepay: boolean;
  /** Pools the escrowed NFT votes on, on Mezo's PoolsVoter. */
  pools: Address[];
  /** Reward contracts with something earned, and the tokens to claim from each: `harvest`'s arguments. */
  rewards: Address[];
  tokens: Address[][];
  earned: { reward: Address; token: Address; amount: bigint }[];
  /** veBTC rebase the distributor would pay now. */
  claimableRebase: bigint;
  /** Whether a harvest would claim anything. */
  worthHarvesting: boolean;
}

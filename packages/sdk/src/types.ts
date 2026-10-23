import type { Address, Hex } from "viem";

import type { LineKind, MarketParams } from "./deployments/types.js";

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
  /** MUSD held by the vault itself, not allocated to any line. */
  idle: bigint;
  /** Share of total assets the allocator keeps idle, bps. */
  idleBufferBps: bigint;
  /** Performance fee on interest, WAD (the voters' fee). */
  performanceFee: bigint;
  performanceFeeRecipient: Address;
  /** Management fee, WAD per second. */
  managementFee: bigint;
  /** Max share-price growth rate, WAD per second. */
  maxRate: bigint;
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
  | "above-max";

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
}

export interface AuctionView extends LoanView {
  /** Price floor the auction decays to. */
  floorPrice: bigint | null;
}

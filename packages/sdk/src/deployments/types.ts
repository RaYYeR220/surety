import type { Address, Hex } from "viem";

export type LineKind = "Morpho" | "VeBTC";

/** Morpho Blue market parameters (`MarketParams`). */
export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface DeploymentLine {
  id: number;
  kind: LineKind;
  name: string;
  adapter: Address;
  marketId?: Hex;
  marketParams?: MarketParams;
}

export interface SuretyContracts {
  /** Surety VaultV2 (ERC-4626, shares = srMUSD). */
  vault: Address;
  morphoAdapter: Address;
  morpho: Address;
  /** AdaptiveCurveIrm of the Morpho markets. */
  irm: Address;
  creditVoter: Address;
  voteAllocator: Address;
  suretyPool: Address;
  veBTCLine: Address;
  loanEscrowImpl: Address;
  /** LinearKinkIrm of the veBTC line. */
  irmLine: Address;
  /**
   * Price source the lines value collateral with: BTC in MUSD. v2: BtcMusdPriceSource (BTC/USD over the MUSD peg);
   * v1: the BTC/USD source itself (stressed on testnet), MUSD taken as $1.
   */
  priceSource: Address;
  skipSource: Address;
  morphoOracle: Address;
  /** The vault's receive-shares gate (holds new shares back while a loss is pending or a cover is re-recognised).
   * Absent in deployments made before it existed. */
  depositGate?: Address;
  /** v2: BtcMusdPriceSource, the same address as `priceSource`. */
  btcMusdSource?: Address;
  /** v2: the BTC/USD source BtcMusdPriceSource divides (StressedPriceSource on a stress deployment, else Skip). */
  btcUsdSource?: Address;
  /** v2: MusdPeg, the MUSD/USD median whose health gates new borrowing and new allocations. */
  musdPeg?: Address;
  /** v2 testnet: the StressedPegSource anyone can push off the peg for up to two hours. */
  stressedPegSource?: Address;
  /** v2: SavingsAdapter, the vault's liquidity adapter (idle MUSD parked in sMUSD). */
  savingsAdapter?: Address;
  /** v2: ShareMarket, where lenders sell srMUSD at a discount. */
  shareMarket?: Address;
  /** v2 testnet: the starter-kit Sponsor. */
  sponsor?: Address;
  /** v2: recipient of origination, liquidation, management and ShareMarket fees. */
  treasury?: Address;
}

export interface ExternalContracts {
  musd: Address;
  btc: Address;
  veBTC: Address;
  poolsVoter: Address;
  rewardsDistributor: Address;
  skipAggregator: Address;
  /** v2: Mezo's MUSD Savings Rate vault (sMUSD). */
  smusd?: Address;
}

export interface ProofTx {
  label: string;
  hash: Hex;
}

/** The veBTC credit line's parameters (VeBTCCreditLine.Params). */
export interface LineParams {
  maxLtvTimedBps: number;
  maxLtvPermanentBps: number;
  liqLtvBps: number;
  liqFeeBps: number;
  floorBps: number;
  /** Seconds over which the auction price decays to the floor. */
  auctionDuration: number;
  /** Lock time a timed lock must have left to borrow, seconds. */
  minTerm: number;
  /** Share of every amount borrowed paid to the treasury (v2; 0 for v1 lines). */
  originationFeeBps: number;
  /** Share of the liquidation fee kept on a bid that leaves the line (v2; 0 for v1 lines). */
  protocolShareBps: number;
  /** Share of that protocol part paid to the address that started the auction (v2; 0 for v1 lines). */
  keeperShareBps: number;
}

export type PegSourceKind = "ClTwap" | "StableTwap" | "BtcCross" | "Stressed";

/** One MUSD/USD source of MusdPeg, in the peg's order. */
export interface PegSourceInfo {
  kind: PegSourceKind;
  address: Address;
  /** The pool it reads (ClTwap, StableTwap, BtcCross). */
  pool?: Address;
  /** TWAP window in seconds (ClTwap, BtcCross). */
  window?: number;
  /** Least harmonic-mean in-range liquidity over the window for a usable reading (ClTwap, BtcCross). */
  minLiquidity?: bigint;
  /** Observation periods quoted (StableTwap). */
  granularity?: number;
  /** Oldest accepted age of the pool's latest observation, seconds (StableTwap). */
  maxAge?: number;
  /** BTC/USD source (BtcCross). */
  btcUsd?: Address;
  /** Source read when no override applies; zero for a fixed $1 (Stressed). */
  base?: Address;
}

export interface PegParams {
  minSources: number;
  maxSpreadBps: number;
  bandBps: number;
  /** BtcMusdPriceSource's cap on the MUSD premium it divides BTC/USD by. */
  maxPremiumBps: number;
}

export interface DeploymentFees {
  /** VaultV2 performance fee, WAD (the voters' fee, paid to the SuretyPool). */
  performanceFee: bigint;
  performanceFeeRecipient: Address;
  /** VaultV2 management fee, WAD of total assets per second. */
  managementFee: bigint;
  managementFeeRecipient: Address;
  /** VaultV2 penalty on a permissionless forceDeallocate, WAD. */
  forceDeallocatePenalty: bigint;
  shareMarketFeeBps: number;
}

export interface DeploymentCaps {
  /** Absolute cap on each Morpho id (adapter, BTC, market), MUSD wei. */
  morpho: bigint;
  /** Absolute cap on each veBTC line id (adapter, veBTC), MUSD wei. */
  line: bigint;
  /** Absolute cap on the savings adapter, MUSD wei. */
  savings: bigint;
}

/** The testnet Sponsor's starter kit as deployed. */
export interface SponsorKit {
  relayer: Address;
  btcGas: bigint;
  lockAmount: bigint;
  musd: bigint;
  /** Lock duration asked of veBTC, seconds. */
  lockDuration: number;
  dailyLimit: number;
  fundedBtc: bigint;
  fundedMusd: bigint;
}

/** Shape of `contracts/deployments/<chainId>.json` (version 2) and `contracts/deployments/v1/<chainId>.json`. */
export interface SuretyDeployment {
  /** Schema version: 1 for the v1 deployments (no `version` key), 2 for v2. */
  version: 1 | 2;
  chainId: number;
  /** Epoch length in seconds (3600 on the testnet stress deployment, 604800 on mainnet). */
  epochLength: number;
  /** Block the system was deployed at; log scans start here. */
  deployedAt: bigint;
  contracts: SuretyContracts;
  external: ExternalContracts;
  lines: DeploymentLine[];
  proof: { txs: ProofTx[] };
  /** v2: whether BTC/USD goes through StressedPriceSource. */
  stress?: boolean;
  /** v2: the vault and Morpho adapter timelock, seconds. */
  timelock?: number;
  /** v2: the BTC/MUSD Morpho market id (also `lines[0].marketId`). */
  morphoMarketId?: Hex;
  lineParams?: LineParams;
  peg?: PegParams;
  pegSources?: PegSourceInfo[];
  fees?: DeploymentFees;
  caps?: DeploymentCaps;
  sponsorKit?: SponsorKit;
}

/** A v2 deployment: the peg, savings, ShareMarket and fee keys are all present. */
export interface SuretyDeploymentV2 extends SuretyDeployment {
  version: 2;
  contracts: SuretyContracts &
    Required<
      Pick<
        SuretyContracts,
        "depositGate" | "btcMusdSource" | "btcUsdSource" | "musdPeg" | "savingsAdapter" | "shareMarket" | "treasury"
      >
    >;
  external: ExternalContracts & { smusd: Address };
  stress: boolean;
  timelock: number;
  morphoMarketId: Hex;
  lineParams: LineParams;
  peg: PegParams;
  pegSources: PegSourceInfo[];
  fees: DeploymentFees;
  caps: DeploymentCaps;
}

export function isV2Deployment(d: SuretyDeployment): d is SuretyDeploymentV2 {
  return d.version === 2;
}

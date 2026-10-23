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
  /** Price source the lines value collateral with (stressed on testnet). */
  priceSource: Address;
  skipSource: Address;
  morphoOracle: Address;
}

export interface ExternalContracts {
  musd: Address;
  btc: Address;
  veBTC: Address;
  poolsVoter: Address;
  rewardsDistributor: Address;
  skipAggregator: Address;
}

export interface ProofTx {
  label: string;
  hash: Hex;
}

/** Shape of `contracts/deployments/<chainId>.json`. */
export interface SuretyDeployment {
  chainId: number;
  /** Epoch length in seconds (3600 on the testnet stress deployment, 604800 on mainnet). */
  epochLength: number;
  /** Block the system was deployed at; log scans start here. */
  deployedAt: bigint;
  contracts: SuretyContracts;
  external: ExternalContracts;
  lines: DeploymentLine[];
  proof: { txs: ProofTx[] };
}

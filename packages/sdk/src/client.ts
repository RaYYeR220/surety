import type { Address, PublicClient } from "viem";

import * as b from "./builders.js";
import type { IntLike } from "./builders.js";
import { MULTICALL3_ADDRESS, isMezoChainId } from "./chains.js";
import { getDeployment } from "./deployments/index.js";
import type { MarketParams, SuretyDeployment } from "./deployments/types.js";
import { Reader } from "./read.js";
import * as reads from "./reads.js";
import type {
  AuctionView,
  Ballot,
  Board,
  BorrowQuote,
  Cohorts,
  EpochInfo,
  LoanState,
  LoanView,
  TxRequest,
  VaultStats,
  VeBTCPosition,
} from "./types.js";

export interface SuretyClientOptions {
  chainId: number;
  publicClient: PublicClient;
  /** Deployment to use instead of the one bundled for `chainId`. */
  deployment?: SuretyDeployment;
  /**
   * Multicall3 address for batched reads. Defaults to the chain's configured multicall3, or the canonical
   * address on Mezo chains. `false` sends individual `eth_call`s instead.
   */
  multicall?: Address | false;
  /** Blocks per `eth_getLogs` window (default 10 000). */
  logChunkSize?: bigint;
}

export interface SuretyClient {
  readonly chainId: number;
  readonly deployment: SuretyDeployment;
  readonly publicClient: PublicClient;
  readonly reader: Reader;

  /* Reads */
  getEpoch(): Promise<EpochInfo>;
  getBoard(): Promise<Board>;
  getVault(): Promise<VaultStats>;
  getBallot(tokenId: IntLike): Promise<Ballot>;
  getVeBTCPositions(owner: Address, options?: { includeEscrowed?: boolean }): Promise<VeBTCPosition[]>;
  getCohorts(tokenId: IntLike, options?: { epochs?: number }): Promise<Cohorts>;
  getLoans(borrower: Address): Promise<LoanView[]>;
  getLoan(loanId: IntLike): Promise<LoanView | null>;
  listLoans(options?: { states?: LoanState[] }): Promise<AuctionView[]>;
  quoteVeBTCBorrow(tokenId: IntLike, amount?: IntLike): Promise<BorrowQuote>;
  getAuctions(): Promise<AuctionView[]>;

  /* Unsigned transaction builders */
  buildVote(args: { tokenId: IntLike; lineIds: IntLike[]; weightsBps: IntLike[] }): TxRequest;
  buildPoke(args: { tokenId: IntLike }): TxRequest;
  buildDeposit(args: { assets: IntLike; receiver: Address }): TxRequest;
  buildWithdraw(args: { assets: IntLike; receiver: Address; owner: Address }): TxRequest;
  buildRedeem(args: { shares: IntLike; receiver: Address; owner: Address }): TxRequest;
  buildApprove(args: { token: Address; spender: Address; amount: IntLike }): TxRequest;
  buildApproveVeBTC(args: { spender: Address; tokenId: IntLike }): TxRequest;
  buildOpenLoan(args: { tokenId: IntLike; amount: IntLike }): TxRequest[];
  buildBorrowMore(args: { loanId: IntLike; amount: IntLike }): TxRequest;
  buildRepay(args: { loanId: IntLike; amount: IntLike }): TxRequest;
  buildExtend(args: { loanId: IntLike; duration: IntLike }): TxRequest;
  buildAddCollateral(args: { loanId: IntLike; btcAmount: IntLike }): TxRequest;
  buildPostIncentive(args: { lineId: IntLike; assets: IntLike }): TxRequest;
  buildRefundIncentive(args: { lineId: IntLike; epoch: IntLike }): TxRequest;
  buildStartAuction(args: { loanId: IntLike }): TxRequest;
  buildBid(args: { loanId: IntLike; maxPrice: IntLike }): TxRequest;
  buildRebalance(): TxRequest;
  buildCheckpoint(args: { lineId: IntLike }): TxRequest;
  buildCover(args: { lineId: IntLike }): TxRequest;
  buildClaim(args: { tokenId: IntLike; lineId: IntLike; epoch: IntLike }): TxRequest;
  morphoMarketParams(lineId: IntLike): MarketParams;
  buildSupplyCollateral(args: { marketParams: MarketParams; assets: IntLike; onBehalf: Address }): TxRequest;
  buildBorrow(args: { marketParams: MarketParams; assets: IntLike; onBehalf: Address; receiver: Address }): TxRequest;
  buildRepayMorpho(args: {
    marketParams: MarketParams;
    assets?: IntLike;
    shares?: IntLike;
    onBehalf: Address;
  }): TxRequest;
  buildWithdrawCollateral(args: {
    marketParams: MarketParams;
    assets: IntLike;
    onBehalf: Address;
    receiver: Address;
  }): TxRequest;
  buildLiquidateMorpho(args: {
    marketParams: MarketParams;
    borrower: Address;
    seizedAssets?: IntLike;
    repaidShares?: IntLike;
  }): TxRequest;
}

function resolveMulticall(options: SuretyClientOptions): Address | undefined {
  if (options.multicall === false) return undefined;
  if (options.multicall) return options.multicall;
  const configured = options.publicClient.chain?.contracts?.multicall3?.address;
  if (configured) return configured;
  return isMezoChainId(options.chainId) ? MULTICALL3_ADDRESS : undefined;
}

/**
 * A Surety client for one chain: typed reads over `publicClient` and unsigned transaction builders.
 * Throws if no deployment is bundled for `chainId` and none is passed.
 */
export function createSuretyClient(options: SuretyClientOptions): SuretyClient {
  const deployment = options.deployment ?? getDeployment(options.chainId);
  if (!deployment) {
    throw new Error(`no Surety deployment for chain ${options.chainId}; pass one with options.deployment`);
  }
  if (deployment.chainId !== options.chainId) {
    throw new Error(`deployment is for chain ${deployment.chainId}, client is for chain ${options.chainId}`);
  }
  const reader = new Reader(options.publicClient, { multicallAddress: resolveMulticall(options) });
  const ctx: reads.SuretyContext = {
    chainId: options.chainId,
    client: options.publicClient,
    reader,
    deployment,
    logChunkSize: options.logChunkSize ?? 10_000n,
  };
  const d = deployment;

  return {
    chainId: options.chainId,
    deployment,
    publicClient: options.publicClient,
    reader,

    getEpoch: () => reads.getEpoch(ctx),
    getBoard: () => reads.getBoard(ctx),
    getVault: async () => (await reads.getBoard(ctx)).vault,
    getBallot: (tokenId) => reads.getBallot(ctx, b.toBigInt(tokenId, "tokenId")),
    getVeBTCPositions: (owner, opts) => reads.getVeBTCPositions(ctx, owner, opts),
    getCohorts: (tokenId, opts) => reads.getCohorts(ctx, b.toBigInt(tokenId, "tokenId"), opts),
    getLoans: (borrower) => reads.getLoans(ctx, borrower),
    getLoan: (loanId) => reads.getLoan(ctx, b.toBigInt(loanId, "loanId")),
    listLoans: (opts) => reads.listLoans(ctx, opts),
    quoteVeBTCBorrow: (tokenId, amount) =>
      reads.quoteVeBTCBorrow(
        ctx,
        b.toBigInt(tokenId, "tokenId"),
        amount === undefined ? undefined : b.toBigInt(amount, "amount"),
      ),
    getAuctions: () => reads.getAuctions(ctx),

    buildVote: (args) => b.buildVote(d, args),
    buildPoke: (args) => b.buildPoke(d, args),
    buildDeposit: (args) => b.buildDeposit(d, args),
    buildWithdraw: (args) => b.buildWithdraw(d, args),
    buildRedeem: (args) => b.buildRedeem(d, args),
    buildApprove: (args) => b.buildApprove(args),
    buildApproveVeBTC: (args) => b.buildApproveVeBTC(d, args),
    buildOpenLoan: (args) => b.buildOpenLoan(d, args),
    buildBorrowMore: (args) => b.buildBorrowMore(d, args),
    buildRepay: (args) => b.buildRepay(d, args),
    buildExtend: (args) => b.buildExtend(d, args),
    buildAddCollateral: (args) => b.buildAddCollateral(d, args),
    buildPostIncentive: (args) => b.buildPostIncentive(d, args),
    buildRefundIncentive: (args) => b.buildRefundIncentive(d, args),
    buildStartAuction: (args) => b.buildStartAuction(d, args),
    buildBid: (args) => b.buildBid(d, args),
    buildRebalance: () => b.buildRebalance(d),
    buildCheckpoint: (args) => b.buildCheckpoint(d, args),
    buildCover: (args) => b.buildCover(d, args),
    buildClaim: (args) => b.buildClaim(d, args),
    morphoMarketParams: (lineId) => b.morphoMarketParams(d, lineId),
    buildSupplyCollateral: (args) => b.buildSupplyCollateral(d, args),
    buildBorrow: (args) => b.buildBorrow(d, args),
    buildRepayMorpho: (args) => b.buildRepayMorpho(d, args),
    buildWithdrawCollateral: (args) => b.buildWithdrawCollateral(d, args),
    buildLiquidateMorpho: (args) => b.buildLiquidateMorpho(d, args),
  };
}

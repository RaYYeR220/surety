import { encodeFunctionData, type Address, type Hex } from "viem";

import {
  creditVoterAbi,
  erc20Abi,
  morphoAbi,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCAbi,
  veBTCCreditLineAbi,
  voteAllocatorAbi,
} from "./abis/index.js";
import type { MarketParams, SuretyDeployment } from "./deployments/types.js";
import type { TxRequest } from "./types.js";

/** Integer input: bigint, a safe integer number, or a decimal / hex string. */
export type IntLike = bigint | number | string;

export function toBigInt(value: IntLike, name = "value"): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer, got ${value}`);
    return BigInt(value);
  }
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(value.trim())) throw new Error(`${name} must be an integer, got "${value}"`);
  return BigInt(value.trim());
}

function uint(value: IntLike, name: string): bigint {
  const v = toBigInt(value, name);
  if (v < 0n) throw new Error(`${name} must not be negative`);
  return v;
}

function tx(to: Address, data: Hex): TxRequest {
  return { to, data, value: 0n };
}

const EMPTY: Hex = "0x";

/* Generic */

/** ERC-20 approve (MUSD to the vault, pool or line; srMUSD; BTC for addCollateral). */
export function buildApprove(args: { token: Address; spender: Address; amount: IntLike }): TxRequest {
  return tx(
    args.token,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [args.spender, uint(args.amount, "amount")] }),
  );
}

/** veBTC (ERC-721) approve of one NFT. */
export function buildApproveVeBTC(d: SuretyDeployment, args: { spender: Address; tokenId: IntLike }): TxRequest {
  return tx(
    d.external.veBTC,
    encodeFunctionData({ abi: veBTCAbi, functionName: "approve", args: [args.spender, uint(args.tokenId, "tokenId")] }),
  );
}

/* CreditVoter */

/** Votes `tokenId` across lines; weights in bps must sum to 10 000. */
export function buildVote(
  d: SuretyDeployment,
  args: { tokenId: IntLike; lineIds: IntLike[]; weightsBps: IntLike[] },
): TxRequest {
  if (args.lineIds.length !== args.weightsBps.length) throw new Error("lineIds and weightsBps differ in length");
  if (args.lineIds.length === 0 || args.lineIds.length > 10) throw new Error("a ballot has 1 to 10 lines");
  const weights = args.weightsBps.map((w) => uint(w, "weightsBps"));
  if (weights.reduce((a, b) => a + b, 0n) !== 10_000n) throw new Error("weightsBps must sum to 10000");
  return tx(
    d.contracts.creditVoter,
    encodeFunctionData({
      abi: creditVoterAbi,
      functionName: "vote",
      args: [uint(args.tokenId, "tokenId"), args.lineIds.map((l) => uint(l, "lineIds")), weights],
    }),
  );
}

/** Recasts a stored ballot into the current epoch. Permissionless. */
export function buildPoke(d: SuretyDeployment, args: { tokenId: IntLike }): TxRequest {
  return tx(
    d.contracts.creditVoter,
    encodeFunctionData({ abi: creditVoterAbi, functionName: "poke", args: [uint(args.tokenId, "tokenId")] }),
  );
}

/* Vault (ERC-4626) */

/** Deposits MUSD into the vault for srMUSD. Needs a MUSD approve to the vault. */
export function buildDeposit(d: SuretyDeployment, args: { assets: IntLike; receiver: Address }): TxRequest {
  return tx(
    d.contracts.vault,
    encodeFunctionData({ abi: vaultV2Abi, functionName: "deposit", args: [uint(args.assets, "assets"), args.receiver] }),
  );
}

/** Withdraws `assets` MUSD from the vault, burning `owner`'s srMUSD. */
export function buildWithdraw(
  d: SuretyDeployment,
  args: { assets: IntLike; receiver: Address; owner: Address },
): TxRequest {
  return tx(
    d.contracts.vault,
    encodeFunctionData({
      abi: vaultV2Abi,
      functionName: "withdraw",
      args: [uint(args.assets, "assets"), args.receiver, args.owner],
    }),
  );
}

/** Redeems `shares` srMUSD for MUSD (use to exit fully). */
export function buildRedeem(d: SuretyDeployment, args: { shares: IntLike; receiver: Address; owner: Address }): TxRequest {
  return tx(
    d.contracts.vault,
    encodeFunctionData({
      abi: vaultV2Abi,
      functionName: "redeem",
      args: [uint(args.shares, "shares"), args.receiver, args.owner],
    }),
  );
}

/* veBTC credit line */

/**
 * Opens a loan against `tokenId`: the veBTC approve of the NFT to the line, then `open`. Send in order.
 */
export function buildOpenLoan(d: SuretyDeployment, args: { tokenId: IntLike; amount: IntLike }): TxRequest[] {
  const tokenId = uint(args.tokenId, "tokenId");
  return [
    buildApproveVeBTC(d, { spender: d.contracts.veBTCLine, tokenId }),
    tx(
      d.contracts.veBTCLine,
      encodeFunctionData({
        abi: veBTCCreditLineAbi,
        functionName: "open",
        args: [tokenId, uint(args.amount, "amount")],
      }),
    ),
  ];
}

export function buildBorrowMore(d: SuretyDeployment, args: { loanId: IntLike; amount: IntLike }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({
      abi: veBTCCreditLineAbi,
      functionName: "borrowMore",
      args: [uint(args.loanId, "loanId"), uint(args.amount, "amount")],
    }),
  );
}

/** Repays up to `amount`; anyone may repay. Needs a MUSD approve to the line. */
export function buildRepay(d: SuretyDeployment, args: { loanId: IntLike; amount: IntLike }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({
      abi: veBTCCreditLineAbi,
      functionName: "repay",
      args: [uint(args.loanId, "loanId"), uint(args.amount, "amount")],
    }),
  );
}

/** Extends the escrowed lock to now + `duration` seconds (rounded down to weeks by veBTC). */
export function buildExtend(d: SuretyDeployment, args: { loanId: IntLike; duration: IntLike }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({
      abi: veBTCCreditLineAbi,
      functionName: "extend",
      args: [uint(args.loanId, "loanId"), uint(args.duration, "duration")],
    }),
  );
}

/** Adds BTC to the escrowed lock. Needs a BTC approve to the line. */
export function buildAddCollateral(d: SuretyDeployment, args: { loanId: IntLike; btcAmount: IntLike }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({
      abi: veBTCCreditLineAbi,
      functionName: "addCollateral",
      args: [uint(args.loanId, "loanId"), uint(args.btcAmount, "btcAmount")],
    }),
  );
}

/** Starts the Dutch auction of a loan past its liquidation LTV or lock end. Permissionless. */
export function buildStartAuction(d: SuretyDeployment, args: { loanId: IntLike }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({ abi: veBTCCreditLineAbi, functionName: "startAuction", args: [uint(args.loanId, "loanId")] }),
  );
}

/** Buys an auctioned NFT at the live price if it is at most `maxPrice`. Needs a MUSD approve to the line. */
export function buildBid(d: SuretyDeployment, args: { loanId: IntLike; maxPrice: IntLike }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({
      abi: veBTCCreditLineAbi,
      functionName: "bid",
      args: [uint(args.loanId, "loanId"), uint(args.maxPrice, "maxPrice")],
    }),
  );
}

/* VoteAllocator / SuretyPool */

/** Moves vault capital toward the vote-weighted targets. Permissionless. */
export function buildRebalance(d: SuretyDeployment): TxRequest {
  return tx(d.contracts.voteAllocator, encodeFunctionData({ abi: voteAllocatorAbi, functionName: "rebalance" }));
}

/** Posts a MUSD incentive for the current epoch's voters of `lineId`. Needs a MUSD approve to the pool. */
export function buildPostIncentive(d: SuretyDeployment, args: { lineId: IntLike; assets: IntLike }): TxRequest {
  return tx(
    d.contracts.suretyPool,
    encodeFunctionData({
      abi: suretyPoolAbi,
      functionName: "postIncentive",
      args: [uint(args.lineId, "lineId"), uint(args.assets, "assets")],
    }),
  );
}

/** Returns a sponsor's incentive for a line that drew no votes in `epoch`. */
export function buildRefundIncentive(d: SuretyDeployment, args: { lineId: IntLike; epoch: IntLike }): TxRequest {
  return tx(
    d.contracts.suretyPool,
    encodeFunctionData({
      abi: suretyPoolAbi,
      functionName: "refundIncentive",
      args: [uint(args.lineId, "lineId"), uint(args.epoch, "epoch")],
    }),
  );
}

/** Records any new loss of `lineId`. Permissionless. */
export function buildCheckpoint(d: SuretyDeployment, args: { lineId: IntLike }): TxRequest {
  return tx(
    d.contracts.suretyPool,
    encodeFunctionData({ abi: suretyPoolAbi, functionName: "checkpoint", args: [uint(args.lineId, "lineId")] }),
  );
}

/** Checkpoints `lineId` and covers its uncovered loss from cohorts, then reserve. Permissionless. */
export function buildCover(d: SuretyDeployment, args: { lineId: IntLike }): TxRequest {
  return tx(
    d.contracts.suretyPool,
    encodeFunctionData({ abi: suretyPoolAbi, functionName: "cover", args: [uint(args.lineId, "lineId")] }),
  );
}

/** Claims an NFT's share of a matured cohort. Permissionless; pays the NFT owner (or escrowed borrower). */
export function buildClaim(d: SuretyDeployment, args: { tokenId: IntLike; lineId: IntLike; epoch: IntLike }): TxRequest {
  return tx(
    d.contracts.suretyPool,
    encodeFunctionData({
      abi: suretyPoolAbi,
      functionName: "claim",
      args: [uint(args.tokenId, "tokenId"), uint(args.lineId, "lineId"), uint(args.epoch, "epoch")],
    }),
  );
}

/* Morpho Blue (BTC lines) */

/** Market params of a Morpho line from the deployment file. */
export function morphoMarketParams(d: SuretyDeployment, lineId: IntLike): MarketParams {
  const id = Number(uint(lineId, "lineId"));
  const line = d.lines.find((l) => l.id === id);
  if (!line || line.kind !== "Morpho" || !line.marketParams) throw new Error(`line ${id} is not a Morpho line`);
  return line.marketParams;
}

/** Supplies collateral to a Morpho market. Needs a collateral-token approve to Morpho. */
export function buildSupplyCollateral(
  d: SuretyDeployment,
  args: { marketParams: MarketParams; assets: IntLike; onBehalf: Address },
): TxRequest {
  return tx(
    d.contracts.morpho,
    encodeFunctionData({
      abi: morphoAbi,
      functionName: "supplyCollateral",
      args: [args.marketParams, uint(args.assets, "assets"), args.onBehalf, EMPTY],
    }),
  );
}

/** Borrows `assets` MUSD from a Morpho market; the caller must be `onBehalf` or authorised by it. */
export function buildBorrow(
  d: SuretyDeployment,
  args: { marketParams: MarketParams; assets: IntLike; onBehalf: Address; receiver: Address },
): TxRequest {
  return tx(
    d.contracts.morpho,
    encodeFunctionData({
      abi: morphoAbi,
      functionName: "borrow",
      args: [args.marketParams, uint(args.assets, "assets"), 0n, args.onBehalf, args.receiver],
    }),
  );
}

/**
 * Repays a Morpho borrow by `assets` or by `shares` (exactly one non-zero; repay by shares to clear a position
 * without dust). Needs a MUSD approve to Morpho.
 */
export function buildRepayMorpho(
  d: SuretyDeployment,
  args: { marketParams: MarketParams; assets?: IntLike; shares?: IntLike; onBehalf: Address },
): TxRequest {
  const assets = args.assets === undefined ? 0n : uint(args.assets, "assets");
  const shares = args.shares === undefined ? 0n : uint(args.shares, "shares");
  if ((assets === 0n) === (shares === 0n)) throw new Error("set exactly one of assets or shares");
  return tx(
    d.contracts.morpho,
    encodeFunctionData({
      abi: morphoAbi,
      functionName: "repay",
      args: [args.marketParams, assets, shares, args.onBehalf, EMPTY],
    }),
  );
}

/** Withdraws collateral from a Morpho position. */
export function buildWithdrawCollateral(
  d: SuretyDeployment,
  args: { marketParams: MarketParams; assets: IntLike; onBehalf: Address; receiver: Address },
): TxRequest {
  return tx(
    d.contracts.morpho,
    encodeFunctionData({
      abi: morphoAbi,
      functionName: "withdrawCollateral",
      args: [args.marketParams, uint(args.assets, "assets"), args.onBehalf, args.receiver],
    }),
  );
}

/** Liquidates an unhealthy Morpho position by seized collateral or repaid shares (exactly one non-zero). */
export function buildLiquidateMorpho(
  d: SuretyDeployment,
  args: { marketParams: MarketParams; borrower: Address; seizedAssets?: IntLike; repaidShares?: IntLike },
): TxRequest {
  const seized = args.seizedAssets === undefined ? 0n : uint(args.seizedAssets, "seizedAssets");
  const repaid = args.repaidShares === undefined ? 0n : uint(args.repaidShares, "repaidShares");
  if ((seized === 0n) === (repaid === 0n)) throw new Error("set exactly one of seizedAssets or repaidShares");
  return tx(
    d.contracts.morpho,
    encodeFunctionData({
      abi: morphoAbi,
      functionName: "liquidate",
      args: [args.marketParams, args.borrower, seized, repaid, EMPTY],
    }),
  );
}

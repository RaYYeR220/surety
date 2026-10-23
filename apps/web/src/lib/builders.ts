// Unsigned transactions the SDK has no builder for yet: escrow actions on a veBTC loan and the testnet
// price shock. Same shape as the SDK builders ({ to, data, value }), encoded with the SDK's ABIs.
import { stressedPriceSourceAbi, veBTCCreditLineAbi, type SuretyDeployment, type TxRequest } from "@surety/sdk";
import { encodeFunctionData, type Address } from "viem";

const tx = (to: Address, data: `0x${string}`): TxRequest => ({ to, data, value: 0n });

/** Votes an escrowed veBTC on Mezo's PoolsVoter (borrower only). Weights are relative. */
export function buildEscrowVote(
  d: SuretyDeployment,
  args: { loanId: bigint; pools: Address[]; weights: bigint[] },
): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({
      abi: veBTCCreditLineAbi,
      functionName: "escrowVote",
      args: [args.loanId, args.pools, args.weights],
    }),
  );
}

/** Clears the escrowed veBTC's PoolsVoter votes (borrower only). */
export function buildEscrowReset(d: SuretyDeployment, args: { loanId: bigint }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({ abi: veBTCCreditLineAbi, functionName: "escrowReset", args: [args.loanId] }),
  );
}

/** Claims the escrowed veBTC's rebase (compounded into the lock while it is live). */
export function buildEscrowClaimRebase(d: SuretyDeployment, args: { loanId: bigint }): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({ abi: veBTCCreditLineAbi, functionName: "escrowClaimRebase", args: [args.loanId] }),
  );
}

/** Claims PoolsVoter fees and bribes for the escrowed veBTC; they are forwarded to the borrower. */
export function buildEscrowClaim(
  d: SuretyDeployment,
  args: { loanId: bigint; rewards: Address[]; tokens: Address[][] },
): TxRequest {
  return tx(
    d.contracts.veBTCLine,
    encodeFunctionData({
      abi: veBTCCreditLineAbi,
      functionName: "escrowClaim",
      args: [args.loanId, args.rewards, args.tokens],
    }),
  );
}

/** Testnet only: discounts the BTC price the lines use by `bps` for `duration` seconds. Permissionless. */
export function buildShock(d: SuretyDeployment, args: { bps: number; duration: number }): TxRequest {
  return tx(
    d.contracts.priceSource,
    encodeFunctionData({ abi: stressedPriceSourceAbi, functionName: "shock", args: [args.bps, args.duration] }),
  );
}

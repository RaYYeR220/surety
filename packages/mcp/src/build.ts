import { buildApprove, type SuretyClient, type TxRequest } from "@surety/sdk";
import { getAddress, parseUnits, type Address } from "viem";
import { z } from "zod";

const integer = z
  .union([z.string().regex(/^\d+$/, "a non-negative integer"), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, "a decimal amount in token units, e.g. \"1500.5\"")
  .transform((v) => parseUnits(v, 18));
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed address")
  .transform((v) => getAddress(v));
const lineId = z.number().int().nonnegative();
const includeApproval = z.boolean().default(true);

const TOKENS = ["musd", "btc", "srmusd"] as const;
const SPENDERS = ["vault", "suretyPool", "veBTCLine", "morpho"] as const;

/** Parameter schema of each `surety_build_tx` action. Amounts are decimal token units (18 decimals). */
export const actionSchemas = {
  vote: z.object({
    tokenId: integer,
    lineIds: z.array(lineId).min(1).max(10),
    weightsBps: z.array(z.number().int().positive().max(10_000)).min(1).max(10),
  }),
  poke: z.object({ tokenId: integer }),
  deposit: z.object({ assets: amount, receiver: address, includeApproval }),
  withdraw: z.object({ assets: amount, receiver: address, owner: address }),
  redeem: z.object({ shares: amount, receiver: address, owner: address }),
  approve: z.object({
    token: z.union([z.enum(TOKENS), address]),
    spender: z.union([z.enum(SPENDERS), address]),
    amount,
  }),
  open_loan: z.object({ tokenId: integer, amount }),
  borrow_more: z.object({ loanId: integer, amount }),
  repay: z.object({ loanId: integer, amount, includeApproval }),
  extend: z.object({ loanId: integer, durationSeconds: integer }),
  add_collateral: z.object({ loanId: integer, btcAmount: amount, includeApproval }),
  post_incentive: z.object({ lineId, assets: amount, includeApproval }),
  start_auction: z.object({ loanId: integer }),
  bid: z.object({ loanId: integer, maxPrice: amount, includeApproval }),
  rebalance: z.object({}),
  checkpoint: z.object({ lineId }),
  cover: z.object({ lineId }),
  claim: z.object({ tokenId: integer, lineId, epoch: integer }),
  supply_collateral: z.object({ lineId, assets: amount, onBehalf: address, includeApproval }),
  borrow_morpho: z.object({ lineId, assets: amount, onBehalf: address, receiver: address }),
  repay_morpho: z
    .object({
      lineId,
      assets: amount.optional(),
      shares: integer.optional(),
      onBehalf: address,
      includeApproval,
    })
    .refine((v) => (v.assets === undefined) !== (v.shares === undefined), "set exactly one of assets or shares"),
} as const;

export type BuildAction = keyof typeof actionSchemas;
export const BUILD_ACTIONS = Object.keys(actionSchemas) as [BuildAction, ...BuildAction[]];

export interface BuiltTx {
  chainId: number;
  action: BuildAction;
  /** Send in order from the user's wallet. */
  transactions: { to: Address; data: `0x${string}`; value: string; description: string }[];
}

/** One-line usage of every action, for the tool description. */
export const ACTION_HELP = [
  "vote {tokenId, lineIds[], weightsBps[] (sum 10000)}",
  "poke {tokenId}",
  "deposit {assets, receiver}",
  "withdraw {assets, receiver, owner}",
  "redeem {shares, receiver, owner}",
  "approve {token: musd|btc|srmusd|0x.., spender: vault|suretyPool|veBTCLine|morpho|0x.., amount}",
  "open_loan {tokenId, amount}",
  "borrow_more {loanId, amount}",
  "repay {loanId, amount}",
  "extend {loanId, durationSeconds}",
  "add_collateral {loanId, btcAmount}",
  "post_incentive {lineId, assets}",
  "start_auction {loanId}",
  "bid {loanId, maxPrice}",
  "rebalance {}",
  "checkpoint {lineId}",
  "cover {lineId}",
  "claim {tokenId, lineId, epoch}",
  "supply_collateral {lineId, assets, onBehalf}",
  "borrow_morpho {lineId, assets, onBehalf, receiver}",
  "repay_morpho {lineId, assets | shares, onBehalf}",
].join("; ");

/** Validates `params` for `action` and returns the unsigned transactions. Throws a readable error otherwise. */
export function buildTx(client: SuretyClient, action: BuildAction, params: unknown): BuiltTx {
  const schema = actionSchemas[action];
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ");
    throw new Error(`invalid params for ${action}: ${issues}`);
  }
  const d = client.deployment;
  const c = d.contracts;
  const out: { tx: TxRequest; description: string }[] = [];
  const approve = (token: Address, spender: Address, value: bigint, what: string) =>
    out.push({ tx: buildApprove({ token, spender, amount: value }), description: `approve ${what}` });
  const tokenAddress = (t: string): Address =>
    t === "musd" ? d.external.musd : t === "btc" ? d.external.btc : t === "srmusd" ? c.vault : (t as Address);
  const spenderAddress = (s: string): Address =>
    s === "vault" || s === "suretyPool" || s === "veBTCLine" || s === "morpho" ? c[s] : (s as Address);

  // Each branch narrows `p` to its action's parsed params.
  const p = parsed.data as Record<string, unknown>;
  switch (action) {
    case "vote": {
      const v = p as z.output<typeof actionSchemas.vote>;
      out.push({ tx: client.buildVote(v), description: `vote veBTC #${v.tokenId}` });
      break;
    }
    case "poke": {
      const v = p as z.output<typeof actionSchemas.poke>;
      out.push({ tx: client.buildPoke(v), description: `poke veBTC #${v.tokenId}` });
      break;
    }
    case "deposit": {
      const v = p as z.output<typeof actionSchemas.deposit>;
      if (v.includeApproval) approve(d.external.musd, c.vault, v.assets, "MUSD to the vault");
      out.push({ tx: client.buildDeposit(v), description: "deposit MUSD into the vault" });
      break;
    }
    case "withdraw": {
      const v = p as z.output<typeof actionSchemas.withdraw>;
      out.push({ tx: client.buildWithdraw(v), description: "withdraw MUSD from the vault" });
      break;
    }
    case "redeem": {
      const v = p as z.output<typeof actionSchemas.redeem>;
      out.push({ tx: client.buildRedeem(v), description: "redeem srMUSD for MUSD" });
      break;
    }
    case "approve": {
      const v = p as z.output<typeof actionSchemas.approve>;
      approve(tokenAddress(v.token), spenderAddress(v.spender), v.amount, `${v.token} to ${v.spender}`);
      break;
    }
    case "open_loan": {
      const v = p as z.output<typeof actionSchemas.open_loan>;
      const [approveNft, open] = client.buildOpenLoan(v);
      out.push({ tx: approveNft!, description: `approve veBTC #${v.tokenId} to the veBTC line` });
      out.push({ tx: open!, description: `open a loan against veBTC #${v.tokenId}` });
      break;
    }
    case "borrow_more": {
      const v = p as z.output<typeof actionSchemas.borrow_more>;
      out.push({ tx: client.buildBorrowMore(v), description: `borrow more on loan #${v.loanId}` });
      break;
    }
    case "repay": {
      const v = p as z.output<typeof actionSchemas.repay>;
      if (v.includeApproval) approve(d.external.musd, c.veBTCLine, v.amount, "MUSD to the veBTC line");
      out.push({ tx: client.buildRepay(v), description: `repay loan #${v.loanId}` });
      break;
    }
    case "extend": {
      const v = p as z.output<typeof actionSchemas.extend>;
      out.push({
        tx: client.buildExtend({ loanId: v.loanId, duration: v.durationSeconds }),
        description: `extend the lock of loan #${v.loanId}`,
      });
      break;
    }
    case "add_collateral": {
      const v = p as z.output<typeof actionSchemas.add_collateral>;
      if (v.includeApproval) approve(d.external.btc, c.veBTCLine, v.btcAmount, "BTC to the veBTC line");
      out.push({ tx: client.buildAddCollateral(v), description: `add BTC to loan #${v.loanId}` });
      break;
    }
    case "post_incentive": {
      const v = p as z.output<typeof actionSchemas.post_incentive>;
      if (v.includeApproval) approve(d.external.musd, c.suretyPool, v.assets, "MUSD to the Surety pool");
      out.push({ tx: client.buildPostIncentive(v), description: `post an incentive on line ${v.lineId}` });
      break;
    }
    case "start_auction": {
      const v = p as z.output<typeof actionSchemas.start_auction>;
      out.push({ tx: client.buildStartAuction(v), description: `start the auction of loan #${v.loanId}` });
      break;
    }
    case "bid": {
      const v = p as z.output<typeof actionSchemas.bid>;
      if (v.includeApproval) approve(d.external.musd, c.veBTCLine, v.maxPrice, "MUSD to the veBTC line");
      out.push({ tx: client.buildBid(v), description: `bid on loan #${v.loanId}` });
      break;
    }
    case "rebalance":
      out.push({ tx: client.buildRebalance(), description: "rebalance the vault by votes" });
      break;
    case "checkpoint": {
      const v = p as z.output<typeof actionSchemas.checkpoint>;
      out.push({ tx: client.buildCheckpoint(v), description: `record losses of line ${v.lineId}` });
      break;
    }
    case "cover": {
      const v = p as z.output<typeof actionSchemas.cover>;
      out.push({ tx: client.buildCover(v), description: `cover losses of line ${v.lineId}` });
      break;
    }
    case "claim": {
      const v = p as z.output<typeof actionSchemas.claim>;
      out.push({
        tx: client.buildClaim(v),
        description: `claim cohort (line ${v.lineId}, epoch ${v.epoch}) for veBTC #${v.tokenId}`,
      });
      break;
    }
    case "supply_collateral": {
      const v = p as z.output<typeof actionSchemas.supply_collateral>;
      const marketParams = client.morphoMarketParams(v.lineId);
      if (v.includeApproval) approve(marketParams.collateralToken, c.morpho, v.assets, "collateral to Morpho");
      out.push({
        tx: client.buildSupplyCollateral({ marketParams, assets: v.assets, onBehalf: v.onBehalf }),
        description: `supply collateral to line ${v.lineId}`,
      });
      break;
    }
    case "borrow_morpho": {
      const v = p as z.output<typeof actionSchemas.borrow_morpho>;
      out.push({
        tx: client.buildBorrow({
          marketParams: client.morphoMarketParams(v.lineId),
          assets: v.assets,
          onBehalf: v.onBehalf,
          receiver: v.receiver,
        }),
        description: `borrow MUSD from line ${v.lineId}`,
      });
      break;
    }
    case "repay_morpho": {
      const v = p as z.output<typeof actionSchemas.repay_morpho>;
      const marketParams = client.morphoMarketParams(v.lineId);
      if (v.includeApproval && v.assets !== undefined) {
        approve(marketParams.loanToken, c.morpho, v.assets, "MUSD to Morpho");
      }
      out.push({
        tx: client.buildRepayMorpho({
          marketParams,
          onBehalf: v.onBehalf,
          ...(v.assets === undefined ? {} : { assets: v.assets }),
          ...(v.shares === undefined ? {} : { shares: v.shares }),
        }),
        description: `repay MUSD on line ${v.lineId}${v.shares !== undefined ? " (approve enough MUSD to Morpho first)" : ""}`,
      });
      break;
    }
  }

  return {
    chainId: client.chainId,
    action,
    transactions: out.map(({ tx, description }) => ({
      to: tx.to,
      data: tx.data,
      value: tx.value.toString(),
      description,
    })),
  };
}

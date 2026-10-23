// Turns wallet, RPC and contract errors into one plain sentence that says what happened and what to do.
import {
  creditVoterAbi,
  erc20Abi,
  loanEscrowAbi,
  morphoAbi,
  stressedPriceSourceAbi,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCAbi,
  veBTCCreditLineAbi,
  voteAllocatorAbi,
} from "@surety/sdk";
import { decodeErrorResult, type Abi, type Hex } from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;

const errorAbi: Abi = (() => {
  const seen = new Set<string>();
  const out: AbiError[] = [];
  const all = [
    creditVoterAbi,
    suretyPoolAbi,
    veBTCCreditLineAbi,
    voteAllocatorAbi,
    vaultV2Abi,
    morphoAbi,
    stressedPriceSourceAbi,
    loanEscrowAbi,
    erc20Abi,
    veBTCAbi,
  ] as readonly Abi[];
  for (const abi of all) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
})();

/** What each named revert means for the person who pressed the button. */
const MESSAGES: Record<string, string> = {
  // Price feed and line state
  StalePrice: "The BTC price feed is stale, so Surety refuses this until it updates. Repaying always works.",
  BadPrice: "The BTC price feed returned an invalid price, so Surety refuses this for now. Try again shortly.",
  LinePaused: "This credit line is paused for new borrowing. Repaying still works.",
  InactiveLine: "This credit line is not active, so it cannot take votes or incentives right now.",
  // Borrowing
  AboveMaxLtv: "That amount is above what this veBTC can borrow at its maximum loan-to-value. Lower the amount.",
  InsufficientCash: "The line does not have that much MUSD available right now. Try a smaller amount or wait for the next rebalance.",
  TermTooShort: "This lock ends too soon to borrow against. Extend the lock first.",
  NotNormalNFT: "Only regular veBTC locks can be borrowed against (not managed or locked-escrow NFTs).",
  GrantLock: "This veBTC is a vesting grant lock, which cannot be used as collateral.",
  NoLock: "This veBTC has no BTC locked.",
  NotTokenOwner: "Your wallet does not own this veBTC.",
  NotBorrower: "Only the borrower of this loan can do that.",
  LoanNotActive: "This loan is not active: it is closed, or in auction, where the escrow cannot vote or reset on Mezo.",
  LoanClosed: "This loan is already closed.",
  InsufficientBalance: "Your wallet does not hold enough for this.",
  // Auctions
  NotLiquidatable: "This loan is healthy, so it cannot be auctioned.",
  NoAuction: "There is no auction running for this loan.",
  PriceAboveMax: "The auction price is above the max price you set. Raise your max or wait for the price to fall.",
  // Votes
  NoPower: "This veBTC had no voting power at the start of this epoch. New or changed locks count from the next epoch.",
  BadWeights: "Your allocation has to add up to exactly 100%.",
  DuplicateLine: "A line appears twice in your ballot.",
  TooManyLines: "A ballot can include at most 10 lines.",
  UnknownLine: "That credit line does not exist.",
  EscrowOwnedNFT: "This veBTC sits in a Surety loan escrow, so it cannot vote on Surety lines (no voting credit to yourself).",
  NotApprovedOrOwner: "Your wallet is not the owner of this veBTC and is not approved for it.",
  NothingToPoke: "This veBTC has no stored ballot to recast.",
  SnapshotNotFinal: "Voting power for this epoch is not final yet. Try again in a few seconds.",
  // Pool
  NotMatured: "This cohort is still seasoning. It can be claimed once it matures.",
  AlreadyClaimed: "This cohort was already claimed.",
  NothingToClaim: "There is nothing to claim for this cohort.",
  EpochNotEnded: "That epoch has not ended yet. Refunds open once it is over.",
  LineHasVotes: "The line drew votes in that epoch, so the incentive went to its voters and cannot be refunded.",
  NothingToRefund: "You have no incentive to refund for that line and epoch.",
  ZeroAmount: "Enter an amount above zero.",
  // Vault
  AbsoluteCapExceeded: "The vault's cap for this line is reached, so it cannot take more right now.",
  RelativeCapExceeded: "The vault's share cap for this line is reached, so it cannot take more right now.",
  CannotReceiveShares:
    "Deposits are paused while voters' cover is being re-recognised, so new srMUSD (deposits, claims, refunds, transfers) waits. Withdrawals stay open.",
  // Stress oracle
  HaircutTooHigh: "The price shock can be at most 90%.",
  ShockTooLong: "A price shock can last at most 2 hours.",
  // Tokens
  ERC20InsufficientAllowance: "The approval is too small for this amount. Approve again and retry.",
  ERC20InsufficientBalance: "Your wallet does not hold enough for this amount.",
  SafeERC20FailedOperation: "A token transfer failed. Check your balance and approval.",
  TransferFromReverted: "A token transfer failed. Check your balance and approval.",
};

/** Morpho Blue reverts with strings. */
const STRING_MESSAGES: [RegExp, string][] = [
  [/insufficient collateral/i, "This would put the position over the market's liquidation limit. Borrow less or add collateral."],
  [/insufficient liquidity/i, "The market does not have that much MUSD available right now."],
  [/healthy position/i, "This position is healthy and cannot be liquidated."],
  [/transfer(From)? reverted|transfer(From)? returned false/i, "A token transfer failed. Check your balance and approval."],
  [/inconsistent input/i, "Enter either an amount or repay everything, not both."],
];

export interface ExplainedError {
  title: string;
  detail?: string;
  /** Revert name when known. */
  name?: string;
  rejected?: boolean;
}

function chain(e: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && typeof cur === "object" && i < 12; i++) {
    out.push(cur as Record<string, unknown>);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function revertData(links: Record<string, unknown>[]): Hex | null {
  for (const l of links) {
    const d = l.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") {
      const inner = (d as { data: string }).data;
      if (/^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex;
    }
  }
  return null;
}

export function explainError(e: unknown): ExplainedError {
  const links = chain(e);
  if (links.some((l) => l.name === "UserRejectedRequestError" || l.code === 4001)) {
    return { title: "You declined in your wallet. Nothing was sent.", rejected: true };
  }
  for (const l of links) {
    const name = l.errorName ?? (l.data as { errorName?: unknown } | undefined)?.errorName;
    if (typeof name === "string" && MESSAGES[name]) return { title: MESSAGES[name]!, name };
  }
  const data = revertData(links);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: errorAbi, data });
      if (decoded.errorName === "Error") {
        const reason = String(decoded.args?.[0] ?? "");
        const hit = STRING_MESSAGES.find(([re]) => re.test(reason));
        return { title: hit ? hit[1] : `The contract refused: ${reason}`, name: reason };
      }
      return {
        title: MESSAGES[decoded.errorName] ?? `The contract refused this (${decoded.errorName}).`,
        name: decoded.errorName,
      };
    } catch {
      /* unknown selector */
    }
  }
  const message = links
    .map((l) => (typeof l.shortMessage === "string" ? l.shortMessage : typeof l.message === "string" ? l.message : ""))
    .find(Boolean);
  if (message) {
    const hit = STRING_MESSAGES.find(([re]) => re.test(message));
    if (hit) return { title: hit[1] };
    if (/insufficient funds/i.test(message)) {
      return { title: "Your wallet does not have enough BTC to pay the network fee." };
    }
    if (/HTTP request failed|fetch failed|timeout|took too long/i.test(message)) {
      return { title: "The Mezo RPC did not answer. Check your connection and try again.", detail: message };
    }
    if (/chain mismatch|does not match the target chain/i.test(message)) {
      return { title: "Your wallet is on another network. Switch it to the network shown at the top and retry." };
    }
    return { title: "Something went wrong.", detail: message.split("\n")[0] };
  }
  return { title: "Something went wrong.", detail: String(e) };
}

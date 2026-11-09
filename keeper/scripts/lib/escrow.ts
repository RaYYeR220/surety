/**
 * Reads shared by the escrow scripts: the sender's veBTC credit-line loans and the Mezo PoolsVoter gauge an escrow
 * votes on (its fee and bribe reward contracts and their reward tokens).
 */
import { isRevert, veBTCCreditLineAbiFor } from "@surety/sdk";
import { zeroAddress, type Address } from "viem";

import { poolAbi, poolsVoterAbi, symbolAbi, votingRewardAbi } from "./mezo.js";
import { proofTxs, rd, type Ctx } from "./testnet.js";

export interface LoanRecord {
  borrower: Address;
  escrow: Address;
  tokenId: bigint;
  normDebt: bigint;
  state: number;
  auctionStart: bigint;
}

export const LOAN_STATES = ["None", "Active", "Auction", "Closed", "Liquidated"] as const;
export const LOAN_ACTIVE = 1;
export const LOAN_AUCTION = 2;

/** Latest loan the sender holds on `tokenId` (any state), or null. */
export async function latestLoanOn(c: Ctx, tokenId: bigint): Promise<{ loanId: bigint; loan: LoanRecord } | null> {
  const line = c.d.contracts.veBTCLine;
  const count = await rd<bigint>(c, line, veBTCCreditLineAbiFor(c.d), "loanCount");
  for (let id = count; id >= 1n; id--) {
    const loan = await rd<LoanRecord>(c, line, veBTCCreditLineAbiFor(c.d), "loan", [id]);
    if (loan.tokenId === tokenId && loan.borrower.toLowerCase() === c.me.toLowerCase()) return { loanId: id, loan };
  }
  return null;
}

/** The proof-file label of the lock the escrow scripts create, and the NFT id it names. */
export const lockLabel = (tokenId: bigint, amountText: string, days: bigint) =>
  `veBTC lock #${tokenId} created (${amountText} BTC, ${days} days)`;
const LOCK_LABEL = /^veBTC lock #(\d+) created/;

/** NFT of the most recent lock recorded by the escrow scripts, or null. */
export function recordedLockId(c: Ctx): bigint | null {
  const hit = proofTxs(c)
    .map((t) => LOCK_LABEL.exec(t.label))
    .filter((m): m is RegExpExecArray => m !== null)
    .at(-1);
  return hit ? BigInt(hit[1]!) : null;
}

const symbols = new Map<string, string>();

export async function symbolOf(c: Ctx, token: Address): Promise<string> {
  const key = token.toLowerCase();
  if (!symbols.has(key)) {
    const s = await rd<string>(c, token, symbolAbi, "symbol").catch(() => `${token.slice(0, 8)}…`);
    symbols.set(key, s);
  }
  return symbols.get(key)!;
}

export async function rewardTokens(c: Ctx, reward: Address): Promise<Address[]> {
  const n = await rd<bigint>(c, reward, votingRewardAbi, "rewardsListLength");
  const out: Address[] = [];
  for (let i = 0n; i < n; i++) out.push(await rd<Address>(c, reward, votingRewardAbi, "rewards", [i]));
  return out;
}

export interface GaugeInfo {
  pool: Address;
  gauge: Address;
  alive: boolean;
  fees: Address;
  bribe: Address;
  /** The pool's two tokens; null for a vault or other non-pool gauge. */
  tokens: readonly [Address, Address] | null;
  /** e.g. "MUSD/mUSDC". */
  pair: string;
  /** e.g. "MUSD/mUSDC stable pool". */
  name: string;
  feeTokens: Address[];
  bribeTokens: Address[];
}

/** Gauge, reward contracts and reward tokens of a PoolsVoter pool. */
export async function gaugeOf(c: Ctx, voter: Address, pool: Address): Promise<GaugeInfo> {
  const gauge = await rd<Address>(c, voter, poolsVoterAbi, "gauges", [pool]);
  if (gauge === zeroAddress) throw new Error(`pool ${pool} has no gauge on PoolsVoter ${voter}`);
  const [alive, fees, bribe] = await Promise.all([
    rd<boolean>(c, voter, poolsVoterAbi, "isAlive", [gauge]),
    rd<Address>(c, voter, poolsVoterAbi, "gaugeToFees", [gauge]),
    rd<Address>(c, voter, poolsVoterAbi, "gaugeToBribe", [gauge]),
  ]);
  let tokens: readonly [Address, Address] | null = null;
  let stable: boolean | null = null;
  try {
    tokens = [await rd<Address>(c, pool, poolAbi, "token0"), await rd<Address>(c, pool, poolAbi, "token1")];
    stable = await rd<boolean>(c, pool, poolAbi, "stable").catch(() => null);
  } catch {
    tokens = null;
  }
  const pair = tokens
    ? `${await symbolOf(c, tokens[0])}/${await symbolOf(c, tokens[1])}`
    : await symbolOf(c, pool);
  const kind = tokens === null ? "vault" : stable === null ? "concentrated pool" : stable ? "stable pool" : "volatile pool";
  const [feeTokens, bribeTokens] = await Promise.all([rewardTokens(c, fees), rewardTokens(c, bribe)]);
  return { pool, gauge, alive, fees, bribe, tokens, pair, name: `${pair} ${kind}`, feeTokens, bribeTokens };
}

/** Pools the NFT's PoolsVoter vote is spread over (votes persist across Mezo epochs until reset). */
export async function votedPools(c: Ctx, voter: Address, tokenId: bigint): Promise<Address[]> {
  const out: Address[] = [];
  for (let i = 0n; ; i++) {
    try {
      out.push(await rd<Address>(c, voter, poolsVoterAbi, "poolVote", [tokenId, i]));
    } catch (e) {
      if (isRevert(e)) return out; // past the end of the array
      throw e;
    }
  }
}

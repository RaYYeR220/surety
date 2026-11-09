/**
 * Runs Surety v2 end to end on Mezo testnet (31611), each role from its own account, and records every transaction
 * it sends in the deployment file under `proof.txs` ({ label, hash, block }; a call sent to be refused also carries
 * `status: "reverted"` and its `reason`).
 *
 * Phases, in the order `--phase all` runs them (each skips what the proof file and chain state show is done):
 *
 *   fund       the deployer funds the role accounts: MUSD, a little BTC for gas, BTC for the borrower's locks and
 *              collateral, and veBTC #1711 for the voter
 *   lend       the lender deposits 100 MUSD; the vault's liquidity adapter parks it in sMUSD
 *   vote       the voter votes #1711 30/70 over line 0 (BTC/MUSD on Morpho) and line 1 (veBTC credit line); the
 *              sponsor posts 10 MUSD of incentives on each line; a rebalance moves the capital out of sMUSD
 *   loan       the borrower locks 0.003 BTC in veBTC, borrows 25 MUSD against it (origination fee to the treasury)
 *              and turns auto-repay on
 *   escrow     the loan's escrow votes the NFT on Mezo's PoolsVoter (MUSD/mUSDC stable pool); the sponsor posts a
 *              20 MUSD bribe on that gauge for the current Mezo epoch
 *   morpho     the borrower posts 0.001 BTC on the BTC/MUSD Morpho market and borrows MUSD at about 35% LTV
 *   peg        MUSD is pushed to $0.94 through the stressed peg source; a borrowMore is sent anyway and reverts on
 *              chain with PegUnhealthy; the override is then cleared
 *   liquidate  a second loan at 48.5% LTV on a 0.001 BTC lock; the BTC price is shocked until it sits at 70% (the
 *              line liquidates from 65%); a keeper account starts the auction, the bidder buys after five minutes
 *              of decay above debt and fee, and the fee is split between lenders, treasury and keeper
 *   market     the lender lists 20 srMUSD at 1% below the share price, the share buyer fills 10 (10 bps to the
 *              treasury), the lender cancels the rest (or redeems it, while the deposit gate is shut)
 *   savings    the savings adapter's sMUSD yield is claimed and parked again, if there is any
 *   kit        the starter-kit relayer hands one team test wallet its kit through the Sponsor
 *
 * and, separately, once the Mezo epoch of the bribe is over (Thursday 00:00 UTC; run from 00:15):
 *
 *   harvest    the escrow loan's fees, bribes and veBTC rebase are harvested by anyone (auto-repay): the MUSD repays
 *              the loan and the rebase compounds into the lock. A harvest the Surety keeper already sent is recorded.
 *
 * Build and run from the repository root:
 *
 *   pnpm --filter @surety/keeper build:scripts
 *   node keeper/dist/scripts/testnet-cycle-v2.js --phase all --env-file <.env> --roles-file <roles .env>
 *
 * Keys stay in the two files (keep both outside the repository) and are never printed: DEPLOYER_PRIVATE_KEY and
 * RELAYER_PRIVATE_KEY in --env-file; LENDER_, BORROWER_, VOTER_, SPONSOR_, BIDDER_, BUYER_ and KEEPER_PRIVATE_KEY,
 * and KIT_ADDRESS (the wallet that gets the starter kit), in --roles-file. Only the funding comes from the deployer,
 * which the keeper also sends from; those sends wait for the keeper to be idle.
 */
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";

import {
  MORPHO_ORACLE_PRICE_SCALE,
  btcMusdPriceSourceAbi,
  creditVoterAbi,
  erc20Abi,
  explorerUrl,
  getLogsChunked,
  morphoAbi,
  morphoPriceOracleAbi,
  morphoToAssetsUp,
  musdPegAbi,
  musdSavingsRateAbi,
  savingsAdapterAbi,
  shareMarketAbi,
  sponsorAbi,
  stressedPegSourceAbi,
  stressedPriceSourceAbi,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCAbi,
  veBTCCreditLineAbi,
  voteAllocatorAbi,
  type MarketParams,
} from "@surety/sdk";
import { getAbiItem, getAddress, isAddress, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { sleep } from "../src/retry.js";
import { gaugeOf, lockLabel, symbolOf, type GaugeInfo, type LoanRecord as V1LoanRecord } from "./lib/escrow.js";
import {
  MEZO_WEEK,
  VEBTC_MAX_LOCK,
  mezoEpochNext,
  mezoEpochStart,
  mezoVoteEnd,
  mezoVoteStart,
  poolsVoterAbi,
  rewardsDistributorAbi,
  veBTCLockAbi,
  votingRewardAbi,
} from "./lib/mezo.js";
import {
  BPS,
  CHAIN_ID,
  WAD,
  btc,
  chainNow,
  ensureAllowance,
  epochOf,
  fmt,
  hhmm,
  keyFromEnv,
  musd,
  openContext,
  pct,
  proofTxs,
  rd,
  record,
  relabel,
  runMain,
  say,
  send,
  sendBuilt,
  sendRefused,
  utc,
  waitUntil,
  withSender,
  type Ctx,
} from "./lib/testnet.js";

/* Scenario */

const MORPHO_LINE = 0;
const VEBTC_LINE = 1;
/** MUSD/mUSDC stable pool: its gauge collects swap fees every epoch and lists MUSD as a bribe token. */
const DEFAULT_POOL: Address = "0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e";

const GAS_BTC = 2n * 10n ** 13n; // 0.00002 BTC: thousands of transactions at testnet gas prices
const VOTER_NFT = 1711n;
const BALLOT_BPS = [3_000n, 7_000n] as const; // line 0 (Morpho) / line 1 (veBTC)
const DEPOSIT = 100n * WAD;
const INCENTIVES: readonly { lineId: number; assets: bigint }[] = [
  { lineId: MORPHO_LINE, assets: 10n * WAD },
  { lineId: VEBTC_LINE, assets: 10n * WAD },
];
const BRIBE = 20n * WAD;
const ESCROW_LOCK = 3n * 10n ** 15n; // 0.003 BTC
const ESCROW_LOAN = 25n * WAD;
const MORPHO_COLLATERAL = 10n ** 15n; // 0.001 BTC
const MORPHO_LTV_BPS = 3_500n;
/** The Morpho borrow takes at most this share of the market's liquidity. */
const MORPHO_UTIL_BPS = 8_000n;
const AUCTION_LOCK = 10n ** 15n; // 0.001 BTC
const AUCTION_LTV_BPS = 4_850n;
/** The shock puts the auction loan at this LTV; the line auctions from its liqLtv (65%). */
const AUCTION_SHOCKED_LTV_BPS = 7_000n;
/** No other position may sit above these LTVs under the shock. */
const SAFE_LINE_LTV_BPS = 6_000n;
const SAFE_MORPHO_MARGIN_BPS = 500n;
const SHOCK_SECONDS = 1_200;
/** Seconds of auction decay before the bid. */
const DECAY_WAIT = 300n;
const PEG_STRESS_WAD = 94n * 10n ** 16n; // $0.94
const PEG_STRESS_SECONDS = 600;
const REFUSED_BORROW = 1n * WAD;
/** Explicit limit for the borrowMore sent to be refused (it reverts after the peg read, far below this). */
const REFUSED_GAS = 500_000n;
const LIST_SHARES = 20n * WAD;
const LIST_DISCOUNT_BPS = 100n;
const FILL_SHARES = 10n * WAD;
const LOCK_DURATION = VEBTC_MAX_LOCK;

/** Seconds after a flip before voting: ballots revert in an epoch's first second. */
const FLIP_DELAY = 5n;
/** Votes and incentives must land in the same epoch; don't start them closer than this to a flip. */
const SETUP_MARGIN = 600n;
/** The keeper rebalances right after each flip; keep the peg stress clear of it. */
const PEG_CLEAR_OF_FLIP = 300n;
/** Don't start the Mezo vote or bribe this close to the end of PoolsVoter's vote window. */
const VOTE_SAFETY = 3_600n;

const ROLE_KEYS = {
  lender: "LENDER_PRIVATE_KEY",
  borrower: "BORROWER_PRIVATE_KEY",
  voter: "VOTER_PRIVATE_KEY",
  sponsor: "SPONSOR_PRIVATE_KEY",
  bidder: "BIDDER_PRIVATE_KEY",
  buyer: "BUYER_PRIVATE_KEY",
  keeper: "KEEPER_PRIVATE_KEY",
} as const;
type RoleName = keyof typeof ROLE_KEYS;
const ROLE_LABEL: Record<RoleName | "relayer", string> = {
  lender: "lender",
  borrower: "borrower",
  voter: "voter",
  sponsor: "sponsor",
  bidder: "bidder",
  buyer: "share buyer",
  keeper: "keeper wallet",
  relayer: "starter-kit relayer",
};

interface Roles {
  deployer: Ctx;
  lender: Ctx;
  borrower: Ctx;
  voter: Ctx;
  sponsor: Ctx;
  bidder: Ctx;
  buyer: Ctx;
  keeper: Ctx;
  relayer: Ctx | null;
  kit: Address | null;
  pool: Address;
  keeperLog: string | null;
}

const LOAN_STATES = ["None", "Active", "Auction", "Closed", "Liquidated"] as const;
interface LoanRecord extends V1LoanRecord {
  keeper: Address;
  autoRepay: boolean;
}

const lineAbi = veBTCCreditLineAbi;
const day = (ts: bigint) => utc(ts).slice(0, 10);
const shortAddr = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A dry run stops where a step needs an earlier one on chain. */
class DryRunStop extends Error {}
function needOnChain(c: Ctx, ok: boolean, what: string): void {
  if (ok) return;
  if (c.dryRun) throw new DryRunStop(what);
  throw new Error(what);
}

/* Proof file */

const has = (c: Ctx, prefix: string) => proofTxs(c).some((t) => t.label.startsWith(prefix));
const find = (c: Ctx, re: RegExp) => proofTxs(c).map((t) => ({ t, m: re.exec(t.label) })).filter((x) => x.m);

/* Reads */

async function balances(c: Ctx, who: Address) {
  const [m, gas, shares] = await Promise.all([
    rd<bigint>(c, c.d.external.musd, erc20Abi, "balanceOf", [who]),
    c.pc.getBalance({ address: who }),
    rd<bigint>(c, c.d.contracts.vault, vaultV2Abi, "balanceOf", [who]),
  ]);
  return { musd: m, btc: gas, shares };
}

async function printWallets(r: Roles): Promise<void> {
  const rows: [string, Address][] = [
    ["deployer", r.deployer.me],
    ...(Object.keys(ROLE_KEYS) as RoleName[]).map((k) => [ROLE_LABEL[k], r[k].me] as [string, Address]),
    ...(r.relayer ? [[ROLE_LABEL.relayer, r.relayer.me] as [string, Address]] : []),
    ...(r.kit ? [["starter-kit wallet", r.kit] as [string, Address]] : []),
  ];
  for (const [name, who] of rows) {
    const b = await balances(r.deployer, who);
    say(`  ${name.padEnd(20)} ${who}: ${btc(b.btc)}, ${musd(b.musd)}, ${fmt(b.shares)} srMUSD`);
  }
}

async function loanOf(c: Ctx, loanId: bigint): Promise<LoanRecord> {
  return rd<LoanRecord>(c, c.d.contracts.veBTCLine, lineAbi, "loan", [loanId]);
}

/** Latest loan of `c.me` on `tokenId`, or null. */
async function loanOn(c: Ctx, tokenId: bigint): Promise<{ loanId: bigint; loan: LoanRecord } | null> {
  const count = await rd<bigint>(c, c.d.contracts.veBTCLine, lineAbi, "loanCount");
  for (let id = count; id >= 1n; id--) {
    const loan = await loanOf(c, id);
    if (loan.tokenId === tokenId && loan.borrower.toLowerCase() === c.me.toLowerCase()) return { loanId: id, loan };
  }
  return null;
}

async function savingsState(c: Ctx) {
  const d = c.d;
  const adapter = d.contracts.savingsAdapter!;
  const smusd = d.external.smusd!;
  const [real, staked, claimable, idle, total] = await Promise.all([
    rd<bigint>(c, adapter, savingsAdapterAbi, "realAssets"),
    rd<bigint>(c, smusd, musdSavingsRateAbi, "balanceOf", [adapter]),
    rd<bigint>(c, adapter, savingsAdapterAbi, "claimableYield"),
    rd<bigint>(c, d.external.musd, erc20Abi, "balanceOf", [d.contracts.vault]),
    rd<bigint>(c, d.contracts.vault, vaultV2Abi, "totalAssets"),
  ]);
  return { real, staked, claimable, idle, total };
}

async function printCapital(c: Ctx, label: string): Promise<void> {
  const va = c.d.contracts.voteAllocator;
  const s = await savingsState(c);
  const [l0, l1] = await Promise.all(
    [MORPHO_LINE, VEBTC_LINE].map((l) => rd<bigint>(c, va, voteAllocatorAbi, "lineAssets", [l])),
  );
  say(
    `  capital ${label}: vault ${musd(s.total)}; idle ${musd(s.idle)}; sMUSD (savings adapter) ${musd(s.real)} ` +
      `(${fmt(s.staked)} sMUSD held, yield ${musd(s.claimable, 6)}); line 0 ${musd(l0!)}; line 1 ${musd(l1!)}`,
  );
}

function morphoMarket(c: Ctx): { id: Hex; params: MarketParams } {
  const line = c.d.lines.find((l) => l.id === MORPHO_LINE);
  if (!line?.marketId || !line.marketParams) throw new Error("deployment has no Morpho line 0 market");
  return { id: line.marketId, params: line.marketParams };
}

async function morphoPosition(c: Ctx, user: Address) {
  const { id, params } = morphoMarket(c);
  const [pos, market, price] = await Promise.all([
    rd<{ supplyShares: bigint; borrowShares: bigint; collateral: bigint }>(c, c.d.contracts.morpho, morphoAbi, "position", [id, user]),
    rd<{ totalSupplyAssets: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint }>(
      c, c.d.contracts.morpho, morphoAbi, "market", [id],
    ),
    rd<bigint>(c, params.oracle, morphoPriceOracleAbi, "price"),
  ]);
  const borrowAssets = morphoToAssetsUp(pos.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
  const value = (pos.collateral * price) / MORPHO_ORACLE_PRICE_SCALE;
  const liquidity = market.totalSupplyAssets - market.totalBorrowAssets;
  return { ...pos, borrowAssets, value, price, liquidity, lltv: params.lltv };
}

/** veBTC locks this script created, by purpose, from the proof labels. */
const LOCK_RE = /^borrower: veBTC lock #(\d+) created .* for the (escrow-vote|auction) loan$/;
function recordedLock(c: Ctx, purpose: "escrow-vote" | "auction"): bigint | null {
  const hit = find(c, LOCK_RE).filter((x) => x.m![2] === purpose).at(-1);
  return hit ? BigInt(hit.m![1]!) : null;
}

/** The escrow-vote loan: the borrower's loan on the escrow-vote lock. */
async function escrowLoan(r: Roles): Promise<{ loanId: bigint; loan: LoanRecord } | null> {
  const tokenId = recordedLock(r.borrower, "escrow-vote");
  return tokenId === null ? null : loanOn(r.borrower, tokenId);
}

/* Phase: fund */

interface Funding {
  role: RoleName | "relayer";
  musd?: bigint;
  btc?: bigint;
  btcWhy?: string;
  nft?: bigint;
}

function fundingPlan(r: Roles): Funding[] {
  return [
    { role: "lender", musd: DEPOSIT, btc: GAS_BTC },
    {
      role: "borrower",
      btc: ESCROW_LOCK + MORPHO_COLLATERAL + AUCTION_LOCK + GAS_BTC,
      btcWhy: "for two veBTC locks, Morpho collateral and gas",
    },
    { role: "voter", nft: VOTER_NFT, btc: GAS_BTC },
    { role: "sponsor", musd: INCENTIVES.reduce((s, i) => s + i.assets, 0n) + BRIBE, btc: GAS_BTC },
    { role: "bidder", musd: 55n * WAD, btc: GAS_BTC },
    { role: "buyer", musd: 12n * WAD, btc: GAS_BTC },
    { role: "keeper", btc: GAS_BTC },
    ...(r.relayer ? [{ role: "relayer" as const, btc: GAS_BTC }] : []),
  ];
}

async function fund(r: Roles): Promise<void> {
  const c = r.deployer;
  const d = c.d;
  say("== fund");
  const plan = fundingPlan(r);
  const needBtc = plan.reduce((s, f) => s + (f.btc ?? 0n), 0n);
  const needMusd = plan.reduce((s, f) => s + (f.musd ?? 0n), 0n);
  say(`  plan: ${btc(needBtc)} and ${musd(needMusd)} from the deployer ${c.me}, plus veBTC #${VOTER_NFT}`);
  for (const f of plan) {
    const name = ROLE_LABEL[f.role];
    const to = f.role === "relayer" ? r.relayer!.me : r[f.role].me;
    if (f.musd) {
      const label = `fund ${name}: ${fmt(f.musd, 0)} MUSD`;
      if (has(c, label)) say(`  · ${label}: done`);
      else await send(c, label, { address: d.external.musd, abi: erc20Abi, functionName: "transfer", args: [to, f.musd] });
    }
    if (f.nft !== undefined) {
      const label = `fund ${name}: veBTC #${f.nft}`;
      const owner = await rd<Address>(c, d.external.veBTC, veBTCLockAbi, "ownerOf", [f.nft]);
      if (owner.toLowerCase() === to.toLowerCase()) say(`  · ${label}: done (held by the ${name})`);
      else if (owner.toLowerCase() !== c.me.toLowerCase()) throw new Error(`veBTC #${f.nft} is held by ${owner}`);
      else {
        await send(c, label, {
          address: d.external.veBTC, abi: veBTCLockAbi, functionName: "transferFrom", args: [c.me, to, f.nft],
        });
      }
    }
    if (f.btc) {
      const label = `fund ${name}: ${fmt(f.btc, 5)} BTC ${f.btcWhy ?? "for gas"}`;
      if (has(c, label)) say(`  · ${label}: done`);
      // BTC is Mezo's gas coin and an ERC-20 precompile over the same balance; a precompile transfer moves it.
      else await send(c, label, { address: d.external.btc, abi: erc20Abi, functionName: "transfer", args: [to, f.btc] });
    }
  }
}

/* Phase: lend */

async function lend(r: Roles): Promise<void> {
  const c = r.lender;
  const d = c.d;
  say("== lend");
  const label = `lender: deposit ${fmt(DEPOSIT, 0)} MUSD, parked in sMUSD`;
  if (has(c, label)) {
    say(`  · ${label}: done`);
  } else {
    const held = await rd<bigint>(c, d.external.musd, erc20Abi, "balanceOf", [c.me]);
    needOnChain(c, held >= DEPOSIT, `the lender holds ${musd(held)}; run --phase fund first`);
    const liquidity = await rd<Address>(c, d.contracts.vault, vaultV2Abi, "liquidityAdapter");
    say(`  vault liquidity adapter ${liquidity} (savings adapter ${d.contracts.savingsAdapter})`);
    await printCapital(c, "before");
    await ensureAllowance(c, d.external.musd, d.contracts.vault, DEPOSIT, `lender: approve ${fmt(DEPOSIT, 0)} MUSD to vault`);
    const allowance = await rd<bigint>(c, d.external.musd, erc20Abi, "allowance", [c.me, d.contracts.vault]);
    needOnChain(c, allowance >= DEPOSIT, "the deposit needs the MUSD approve above on chain first");
    const sent = await sendBuilt(c, label, c.surety.buildDeposit({ assets: DEPOSIT, receiver: c.me }), vaultV2Abi);
    if (sent) {
      for (const ev of parseEventLogs({ abi: vaultV2Abi, logs: sent.receipt.logs, eventName: "Allocate" })) {
        say(`      VaultV2 Allocate: ${musd(ev.args.assets)} to ${ev.args.adapter} (change ${fmt(ev.args.change)})`);
      }
    }
  }
  await printCapital(c, "now");
  const shares = await rd<bigint>(c, d.contracts.vault, vaultV2Abi, "balanceOf", [c.me]);
  say(`  lender holds ${fmt(shares)} srMUSD`);
}

/* Phase: vote */

/** Epoch to vote and post incentives in: past its first seconds, with time left in it. */
async function votingEpoch(c: Ctx, cast: bigint): Promise<bigint> {
  const len = BigInt(c.d.epochLength);
  for (;;) {
    const now = await chainNow(c);
    const epoch = epochOf(c, now);
    if (cast === epoch) return epoch;
    if (now < epoch + FLIP_DELAY) {
      await waitUntil(c, epoch + FLIP_DELAY, "ballots revert in an epoch's first second");
      continue;
    }
    if (epoch + len - now < SETUP_MARGIN) {
      await waitUntil(c, epoch + len + FLIP_DELAY, "too close to the flip to vote and post incentives in one epoch");
      continue;
    }
    return epoch;
  }
}

async function vote(r: Roles): Promise<void> {
  const d = r.voter.d;
  say("== vote");
  const voteLabel = `voter: vote #${VOTER_NFT} ${Number(BALLOT_BPS[0]) / 100}/${Number(BALLOT_BPS[1]) / 100} (line 0 Morpho / line 1 veBTC)`;
  const owner = await rd<Address>(r.voter, d.external.veBTC, veBTCLockAbi, "ownerOf", [VOTER_NFT]);
  const [, , epochCast] = await rd<readonly [readonly bigint[], readonly bigint[], bigint]>(
    r.voter, d.contracts.creditVoter, creditVoterAbi, "ballotOf", [VOTER_NFT],
  );
  const voted = has(r.voter, "voter: vote #");
  const epoch = voted ? epochOf(r.voter, await chainNow(r.voter)) : await votingEpoch(r.voter, epochCast);

  // 1. Ballot. Once cast, the keeper pokes it into every later epoch.
  if (voted) {
    say(`  · ${voteLabel}: done (ballot last counted in ${epochCast === 0n ? "-" : hhmm(epochCast)})`);
  } else {
    needOnChain(r.voter, owner.toLowerCase() === r.voter.me.toLowerCase(), `veBTC #${VOTER_NFT} is held by ${owner}, not the voter`);
    const power = await rd<bigint>(r.voter, d.external.veBTC, veBTCAbi, "votingPowerOfNFTAt", [VOTER_NFT, epoch]);
    say(`  epoch ${hhmm(epoch)}; #${VOTER_NFT} voting power at its snapshot ${fmt(power, 6)}`);
    await sendBuilt(
      r.voter,
      voteLabel,
      r.voter.surety.buildVote({ tokenId: VOTER_NFT, lineIds: [MORPHO_LINE, VEBTC_LINE], weightsBps: [...BALLOT_BPS] }),
      creditVoterAbi,
    );
  }

  // 2. Incentives for this epoch's voters.
  const pool = d.contracts.suretyPool;
  const todo = INCENTIVES.filter((i) => !has(r.sponsor, `sponsor: incentive ${fmt(i.assets, 0)} MUSD to line ${i.lineId}`));
  if (todo.length === 0) say("  · incentives: done");
  else {
    const total = todo.reduce((s, i) => s + i.assets, 0n);
    await ensureAllowance(r.sponsor, d.external.musd, pool, total, `sponsor: approve ${fmt(total, 0)} MUSD to SuretyPool`);
    const allowance = await rd<bigint>(r.sponsor, d.external.musd, erc20Abi, "allowance", [r.sponsor.me, pool]);
    needOnChain(r.sponsor, allowance >= total, "the incentives need the MUSD approve above on chain first");
    for (const inc of todo) {
      const name = d.lines.find((l) => l.id === inc.lineId)?.name ?? `line ${inc.lineId}`;
      await sendBuilt(
        r.sponsor,
        `sponsor: incentive ${fmt(inc.assets, 0)} MUSD to line ${inc.lineId} (${name})`,
        r.sponsor.surety.buildPostIncentive({ lineId: inc.lineId, assets: inc.assets }),
        suretyPoolAbi,
      );
    }
  }

  // 3. Rebalance: re-runs follow the epoch's tally, so the capital moves now instead of at the next flip.
  const va = d.contracts.voteAllocator;
  const lineAssets = () =>
    Promise.all([MORPHO_LINE, VEBTC_LINE].map((l) => rd<bigint>(r.keeper, va, voteAllocatorAbi, "lineAssets", [l])));
  const before = await lineAssets();
  await printCapital(r.keeper, "before the rebalance");
  if (before.every((a) => a > 0n)) {
    say(`  · rebalance: both lines already hold capital (${before.map((a) => musd(a)).join(" / ")})`);
  } else {
    const now = await chainNow(r.keeper);
    const label = `keeper wallet: rebalance (epoch ${hhmm(epochOf(r.keeper, now))}): sMUSD to the lines by the votes`;
    const sent = await sendBuilt(r.keeper, label, r.keeper.surety.buildRebalance(), voteAllocatorAbi);
    if (sent) {
      for (const ev of parseEventLogs({ abi: voteAllocatorAbi, logs: sent.receipt.logs })) {
        if (ev.eventName === "Rebalanced") {
          say(`      tally ${hhmm(ev.args.tallyEpoch)}, targets ${ev.args.targets.map((t) => musd(t)).join(" / ")}`);
        }
        if (ev.eventName === "MoveFailed") say(`      MoveFailed line ${ev.args.lineId}: ${ev.args.reason}`);
        if (ev.eventName === "SavingsMoveFailed") say(`      SavingsMoveFailed: ${ev.args.reason}`);
      }
    }
  }
  await printCapital(r.keeper, "after");
}

/* Phases: loan and liquidate share the lock and open steps */

async function createLock(c: Ctx, amount: bigint, purpose: "escrow-vote" | "auction"): Promise<bigint | null> {
  const ve = c.d.external.veBTC;
  const known = recordedLock(c, purpose);
  if (known !== null) {
    const owner = await rd<Address>(c, ve, veBTCLockAbi, "ownerOf", [known]);
    say(`  · lock for the ${purpose} loan: veBTC #${known} (held by ${owner})`);
    return known;
  }
  const minTerm = BigInt((await rd<{ minTerm: number }>(c, c.d.contracts.veBTCLine, lineAbi, "params")).minTerm);
  const now = await chainNow(c);
  const end = ((now + LOCK_DURATION) / MEZO_WEEK) * MEZO_WEEK;
  if (end < now + minTerm) throw new Error(`a ${LOCK_DURATION}s lock ends ${utc(end)}, inside the line's min term`);
  const balance = await rd<bigint>(c, c.d.external.btc, erc20Abi, "balanceOf", [c.me]);
  needOnChain(c, balance >= amount + GAS_BTC / 2n, `the borrower holds ${btc(balance)}; locking ${btc(amount)} needs more`);
  await ensureAllowance(c, c.d.external.btc, ve, amount, `borrower: approve ${fmt(amount, 3)} BTC to veBTC`);
  const allowance = await rd<bigint>(c, c.d.external.btc, erc20Abi, "allowance", [c.me, ve]);
  needOnChain(c, allowance >= amount, "createLock needs the BTC approve above on chain first");
  const { result: predicted } = await c.pc.simulateContract({
    address: ve, abi: veBTCLockAbi, functionName: "createLock", args: [amount, LOCK_DURATION], account: c.me,
  });
  const labelFor = (id: bigint) =>
    `borrower: ${lockLabel(id, fmt(amount, 3), LOCK_DURATION / 86_400n)} for the ${purpose} loan`;
  const sent = await send(c, labelFor(predicted), {
    address: ve, abi: veBTCLockAbi, functionName: "createLock", args: [amount, LOCK_DURATION],
  });
  if (!sent) return null;
  const minted = parseEventLogs({ abi: veBTCLockAbi, logs: sent.receipt.logs, eventName: "Transfer" }).find(
    (ev) => ev.address.toLowerCase() === ve.toLowerCase() && ev.args.from === zeroAddress &&
      ev.args.to.toLowerCase() === c.me.toLowerCase(),
  );
  if (!minted) throw new Error(`createLock ${sent.hash} minted no NFT to the borrower`);
  if (minted.args.tokenId !== predicted) relabel(c, sent.hash, labelFor(minted.args.tokenId));
  say(`      minted veBTC #${minted.args.tokenId}, ends ${utc(end)}`);
  return minted.args.tokenId;
}

/** Opens a loan of `amount` on `tokenId` (or finds it), showing the origination fee paid to the treasury. */
async function openLoan(
  c: Ctx,
  tokenId: bigint,
  amount: bigint,
  describe: (loanId: bigint, fee: bigint, ltvBps: bigint) => string,
): Promise<{ loanId: bigint; loan: LoanRecord } | null> {
  const line = c.d.contracts.veBTCLine;
  const existing = await loanOn(c, tokenId);
  if (existing) {
    say(`  · loan #${existing.loanId} on veBTC #${tokenId}: ${LOAN_STATES[existing.loan.state]}, escrow ${existing.loan.escrow}`);
    return existing;
  }
  const [paused, cash, healthy] = await Promise.all([
    rd<boolean>(c, line, lineAbi, "paused"),
    rd<bigint>(c, line, lineAbi, "cash"),
    rd<boolean>(c, c.d.contracts.musdPeg!, musdPegAbi, "pegHealthy"),
  ]);
  if (paused) throw new Error("the veBTC credit line is paused");
  if (!healthy) throw new Error("the MUSD peg reads unhealthy, so the line lends nothing now; retry once it clears");
  needOnChain(c, cash >= amount, `the veBTC credit line has ${musd(cash)} of cash, less than ${musd(amount)}; run --phase vote first`);
  const q = await c.surety.quoteVeBTCBorrow(tokenId, amount);
  say(
    `  quote #${tokenId}: collateral ${musd(q.collateralValue ?? 0n)} at ${musd(q.priceWad ?? 0n, 0)}/BTC, ` +
      `${musd(amount, 0)} = LTV ${pct(q.ltvBps ?? 0n)} (max ${pct(q.maxLtvBps)}, liquidation ${pct(q.liqLtvBps)}); ` +
      `origination fee ${musd(q.originationFee, 4)}, borrower receives ${musd(q.receives, 4)}`,
  );
  if (!q.eligible) throw new Error(`veBTC #${tokenId} cannot borrow ${musd(amount)}: ${q.reasons.join(", ")}`);
  const [approveNft, open] = c.surety.buildOpenLoan({ tokenId, amount });
  const approved = await rd<Address>(c, c.d.external.veBTC, veBTCAbi, "getApproved", [tokenId]);
  if (approved.toLowerCase() === line.toLowerCase()) say(`  · veBTC #${tokenId} already approved to the line`);
  else await sendBuilt(c, `borrower: approve veBTC #${tokenId} to credit line`, approveNft!, veBTCAbi);
  needOnChain(
    c,
    (await rd<Address>(c, c.d.external.veBTC, veBTCAbi, "getApproved", [tokenId])).toLowerCase() === line.toLowerCase(),
    "open needs the NFT approve above on chain first",
  );
  const predicted = (await rd<bigint>(c, line, lineAbi, "loanCount")) + 1n;
  const fee = q.originationFee;
  const ltv = q.ltvBps ?? 0n;
  const sent = await sendBuilt(c, describe(predicted, fee, ltv), open!, lineAbi);
  if (!sent) return null;
  const events = parseEventLogs({ abi: lineAbi, logs: sent.receipt.logs });
  const opened = events.find((e) => e.eventName === "Opened");
  if (!opened || opened.eventName !== "Opened") throw new Error(`open ${sent.hash} emitted no Opened event`);
  const loanId = opened.args.loanId;
  if (loanId !== predicted) relabel(c, sent.hash, describe(loanId, fee, ltv));
  for (const e of events) {
    if (e.eventName === "OriginationFeePaid") say(`      OriginationFeePaid: loan #${e.args.loanId}, ${musd(e.args.fee, 4)}`);
  }
  for (const ev of parseEventLogs({ abi: erc20Abi, logs: sent.receipt.logs, eventName: "Transfer" })) {
    if (ev.address.toLowerCase() !== c.d.external.musd.toLowerCase()) continue;
    const to = ev.args.to.toLowerCase();
    const who = to === c.me.toLowerCase() ? "borrower" : to === c.d.contracts.treasury?.toLowerCase() ? "treasury" : ev.args.to;
    say(`      MUSD ${musd(ev.args.value, 4)} to the ${who}`);
  }
  const loan = await loanOf(c, loanId);
  say(`      loan #${loanId}, escrow ${loan.escrow}`);
  return { loanId, loan };
}

/* Phase: loan */

async function loan(r: Roles): Promise<void> {
  const c = r.borrower;
  say("== loan");
  const tokenId = await createLock(c, ESCROW_LOCK, "escrow-vote");
  if (tokenId === null) return;
  const opened = await openLoan(
    c,
    tokenId,
    ESCROW_LOAN,
    (id, fee, ltv) =>
      `borrower: veBTC loan #${id} opened on #${tokenId} (${fmt(ESCROW_LOAN, 0)} MUSD, LTV ${pct(ltv)}; ` +
      `${fmt(fee, 4)} MUSD origination fee to the treasury)`,
  );
  if (!opened) return;
  const { loanId } = opened;
  const loanNow = await loanOf(c, loanId);
  if (loanNow.autoRepay) say(`  · auto-repay: on for loan #${loanId}`);
  else {
    const sent = await sendBuilt(
      c,
      `borrower: auto-repay on for loan #${loanId} (anyone may harvest its rewards into repayment)`,
      c.surety.buildSetAutoRepay({ loanId, enabled: true }),
      lineAbi,
    );
    if (sent) say(`      loan #${loanId} autoRepay ${(await loanOf(c, loanId)).autoRepay}`);
  }
}

/* Phase: escrow */

async function checkVoteWindow(c: Ctx): Promise<void> {
  const now = await chainNow(c);
  if (now <= mezoVoteStart(now)) throw new Error(`PoolsVoter refuses votes in an epoch's first hour; retry after ${utc(mezoVoteStart(now))}`);
  if (now >= mezoVoteEnd(now) - VOTE_SAFETY) {
    throw new Error(
      `too close to the end of PoolsVoter's vote window (${utc(mezoVoteEnd(now))}); the vote and bribe would miss this ` +
        `Mezo epoch. Retry after ${utc(mezoVoteStart(mezoEpochNext(now)))}`,
    );
  }
}

async function escrow(r: Roles): Promise<void> {
  const c = r.borrower;
  const d = c.d;
  const voter = d.external.poolsVoter;
  say("== escrow");
  const g = await gaugeOf(c, voter, r.pool);
  if (!g.alive) throw new Error(`the gauge ${g.gauge} of pool ${r.pool} has been killed`);
  const found = await escrowLoan(r);
  needOnChain(c, found !== null, "no escrow-vote loan yet; run --phase loan first");
  const { loanId, loan: l } = found!;
  const now = await chainNow(c);
  say(
    `  Mezo epoch ${day(mezoEpochStart(now))}: votes open ${utc(mezoVoteStart(now))} to ${utc(mezoVoteEnd(now))}, ` +
      `flips ${utc(mezoEpochNext(now))}`,
  );
  say(`  pool ${g.pool} (${g.name}): gauge ${g.gauge}, fees ${g.fees}, bribe ${g.bribe}`);

  // 1. Escrow vote.
  const [votes, lastVoted] = await Promise.all([
    rd<bigint>(c, voter, poolsVoterAbi, "votes", [l.tokenId, g.pool]),
    rd<bigint>(c, voter, poolsVoterAbi, "lastVoted", [l.tokenId]),
  ]);
  if (votes > 0n) {
    say(`  · escrow vote: veBTC #${l.tokenId} already votes ${fmt(votes, 6)} on ${g.pair} (since ${utc(lastVoted)})`);
  } else {
    if (lastVoted >= mezoEpochStart(now)) throw new Error(`veBTC #${l.tokenId} already voted this Mezo epoch, elsewhere`);
    await checkVoteWindow(c);
    // veBTC reads an NFT's voting power as zero in the block it changed hands (here: into the escrow).
    for (let i = 0; (await rd<bigint>(c, d.external.veBTC, veBTCLockAbi, "votingPowerOfNFT", [l.tokenId])) === 0n; i++) {
      if (i >= 30) throw new Error(`veBTC #${l.tokenId} has no voting power`);
      await sleep(2_000);
    }
    await send(c, `borrower: escrow vote loan #${loanId} (veBTC #${l.tokenId}) 100% on ${g.name}`, {
      address: d.contracts.veBTCLine, abi: lineAbi, functionName: "escrowVote", args: [loanId, [g.pool], [BPS]],
    });
  }

  // 2. The sponsor's MUSD bribe on that gauge, credited to the current Mezo epoch.
  await bribe(r, g);
  await outlook(c, loanId, l.tokenId, g);
}

async function bribe(r: Roles, g: GaugeInfo): Promise<void> {
  const c = r.sponsor;
  const token = c.d.external.musd;
  const now = await chainNow(c);
  const epoch = mezoEpochStart(now);
  const label = `sponsor: bribe ${fmt(BRIBE, 0)} MUSD on ${g.pair} gauge (Mezo epoch ${day(epoch)})`;
  if (has(c, label)) {
    say(`  · ${label}: done`);
    return;
  }
  const listed = await rd<boolean>(c, g.bribe, votingRewardAbi, "isReward", [token]);
  const whitelisted = await rd<boolean>(c, c.d.external.poolsVoter, poolsVoterAbi, "isWhitelistedToken", [token]);
  if (!listed && !whitelisted) throw new Error(`MUSD is neither a reward of bribe ${g.bribe} nor whitelisted on PoolsVoter`);
  const balance = await rd<bigint>(c, token, erc20Abi, "balanceOf", [c.me]);
  needOnChain(c, balance >= BRIBE, `the sponsor holds ${musd(balance)}, less than the ${musd(BRIBE)} bribe`);
  await checkVoteWindow(c);
  const before = await rd<bigint>(c, g.bribe, votingRewardAbi, "tokenRewardsPerEpoch", [token, epoch]);
  await ensureAllowance(c, token, g.bribe, BRIBE, `sponsor: approve ${fmt(BRIBE, 0)} MUSD to ${g.pair} bribe`);
  needOnChain(c, (await rd<bigint>(c, token, erc20Abi, "allowance", [c.me, g.bribe])) >= BRIBE, "the bribe needs the MUSD approve above on chain first");
  const sent = await send(c, label, {
    address: g.bribe, abi: votingRewardAbi, functionName: "notifyRewardAmount", args: [token, BRIBE],
  });
  if (!sent) return;
  const after = await rd<bigint>(c, g.bribe, votingRewardAbi, "tokenRewardsPerEpoch", [token, epoch]);
  say(`      MUSD bribes credited to the Mezo epoch of ${day(epoch)}: ${musd(before, 4)} -> ${musd(after, 4)}`);
}

async function outlook(c: Ctx, loanId: bigint, tokenId: bigint, g: GaugeInfo): Promise<void> {
  const now = await chainNow(c);
  const epoch = mezoEpochStart(now);
  const [bal, supply, total] = await Promise.all([
    rd<bigint>(c, g.bribe, votingRewardAbi, "balanceOf", [tokenId]),
    rd<bigint>(c, g.bribe, votingRewardAbi, "totalSupply"),
    rd<bigint>(c, g.bribe, votingRewardAbi, "tokenRewardsPerEpoch", [c.d.external.musd, epoch]),
  ]);
  say(
    `  escrow of loan #${loanId} holds ${fmt(bal, 6)} of the gauge's ${fmt(supply, 6)} votes ` +
      `(${pct(supply === 0n ? 0n : (bal * BPS) / supply)}): ~${musd(supply === 0n ? 0n : (bal * total) / supply, 4)} of the ` +
      `${musd(total)} MUSD bribes at today's shares`,
  );
  say(`  claimable from ${utc(mezoEpochNext(now))}; harvest then with --phase harvest`);
}

/* Phase: morpho */

async function morpho(r: Roles): Promise<void> {
  const c = r.borrower;
  const d = c.d;
  say("== morpho");
  const { params } = morphoMarket(c);
  let pos = await morphoPosition(c, c.me);
  if (pos.collateral === 0n) {
    await ensureAllowance(c, d.external.btc, d.contracts.morpho, MORPHO_COLLATERAL, `borrower: approve ${fmt(MORPHO_COLLATERAL, 3)} BTC to Morpho`);
    needOnChain(
      c,
      (await rd<bigint>(c, d.external.btc, erc20Abi, "allowance", [c.me, d.contracts.morpho])) >= MORPHO_COLLATERAL,
      "supplyCollateral needs the BTC approve above on chain first",
    );
    await sendBuilt(
      c,
      `borrower: Morpho supplyCollateral ${fmt(MORPHO_COLLATERAL, 3)} BTC`,
      c.surety.buildSupplyCollateral({ marketParams: params, assets: MORPHO_COLLATERAL, onBehalf: c.me }),
      morphoAbi,
    );
    pos = await morphoPosition(c, c.me);
  } else say(`  · Morpho collateral: ${btc(pos.collateral)} posted`);
  needOnChain(c, pos.collateral > 0n, "the borrow needs the collateral above on chain first");
  if (pos.borrowShares === 0n) {
    const byLtv = (pos.value * MORPHO_LTV_BPS) / BPS;
    const byLiquidity = (pos.liquidity * MORPHO_UTIL_BPS) / BPS;
    const amount = ((byLtv < byLiquidity ? byLtv : byLiquidity) / WAD) * WAD;
    if (amount === 0n) throw new Error(`the Morpho market has ${musd(pos.liquidity)} of liquidity; run --phase vote first`);
    const ltv = (amount * BPS) / pos.value;
    await sendBuilt(
      c,
      `borrower: Morpho borrow ${fmt(amount, 0)} MUSD (LTV ${pct(ltv)}, LLTV ${pct((params.lltv * BPS) / WAD)})`,
      c.surety.buildBorrow({ marketParams: params, assets: amount, onBehalf: c.me, receiver: c.me }),
      morphoAbi,
    );
    pos = await morphoPosition(c, c.me);
  } else say("  · Morpho borrow: done");
  say(
    `  Morpho position: ${btc(pos.collateral)} (${musd(pos.value)}), debt ${musd(pos.borrowAssets)}, ` +
      `LTV ${pct(pos.value === 0n ? 0n : (pos.borrowAssets * BPS) / pos.value)}; market liquidity left ${musd(pos.liquidity)}`,
  );
}

/* Phase: peg */

async function printPeg(c: Ctx, when: string): Promise<boolean> {
  const d = c.d;
  const [healthy, readings, gate, check, price, active] = await Promise.all([
    rd<boolean>(c, d.contracts.musdPeg!, musdPegAbi, "pegHealthy"),
    rd<readonly { source: Address; ok: boolean; musdUsdWad: bigint }[]>(c, d.contracts.musdPeg!, musdPegAbi, "readings"),
    rd<boolean>(c, d.contracts.voteAllocator, voteAllocatorAbi, "pegGateOpen"),
    rd<boolean>(c, d.contracts.veBTCLine, lineAbi, "pegCheck"),
    rd<bigint>(c, d.contracts.btcMusdSource!, btcMusdPriceSourceAbi, "priceWad"),
    rd<readonly [boolean, bigint]>(c, d.contracts.stressedPegSource!, stressedPegSourceAbi, "activeStress"),
  ]);
  say(
    `  peg ${when}: pegHealthy ${healthy}; readings ${readings.map((x) => `${x.ok ? "$" + fmt(x.musdUsdWad, 4) : "none"}`).join(", ")}; ` +
      `override ${active[0] ? `$${fmt(active[1], 4)}` : "none"}; allocator gate ${gate ? "open" : "shut"}; ` +
      `line peg check ${check ? "on" : "off"}; BTC ${musd(price, 0)} for the lines`,
  );
  return healthy;
}

async function peg(r: Roles): Promise<void> {
  const d = r.keeper.d;
  const sps = d.contracts.stressedPegSource;
  if (!sps || !d.contracts.musdPeg) throw new Error("this deployment has no stressed peg source");
  say("== peg");
  const found = await escrowLoan(r);
  needOnChain(r.borrower, found !== null && found.loan.state === 1, "no active escrow-vote loan to borrow more on; run --phase loan first");
  const { loanId } = found!;
  const refusedLabel = `borrower: borrowMore ${fmt(REFUSED_BORROW, 0)} MUSD on loan #${loanId} while MUSD is off its peg (refused on chain: PegUnhealthy)`;
  const clearLabel = "keeper wallet: peg override cleared, MUSD back at $1";
  const [active] = await rd<readonly [boolean, bigint]>(r.keeper, sps, stressedPegSourceAbi, "activeStress");

  if (!has(r.borrower, refusedLabel)) {
    // Keep the stress clear of the keeper's rebalance right after each flip.
    const len = BigInt(d.epochLength);
    const now = await chainNow(r.keeper);
    const start = epochOf(r.keeper, now);
    if (now - start < PEG_CLEAR_OF_FLIP) await waitUntil(r.keeper, start + PEG_CLEAR_OF_FLIP, "the keeper rebalances right after the flip");
    else if (start + len - now < PEG_CLEAR_OF_FLIP) {
      await waitUntil(r.keeper, start + len + PEG_CLEAR_OF_FLIP, "too close to the flip for the override");
    }
    await printPeg(r.keeper, "before");
    if (!active) {
      await sendBuilt(
        r.keeper,
        `keeper wallet: peg override, MUSD at $${fmt(PEG_STRESS_WAD, 2)} for ${PEG_STRESS_SECONDS / 60} min (StressedPegSource)`,
        r.keeper.surety.buildStressPeg({ musdUsdWad: PEG_STRESS_WAD, duration: PEG_STRESS_SECONDS }),
        stressedPegSourceAbi,
      );
    } else say("  · peg override: already active");
    const healthy = await printPeg(r.keeper, "under the override");
    if (healthy && r.keeper.dryRun) throw new DryRunStop("the refused borrow needs the peg override on chain first");
    if (healthy) throw new Error("the peg still reads healthy under the override");
    await sendRefused(
      r.borrower,
      refusedLabel,
      { address: d.contracts.veBTCLine, abi: lineAbi, functionName: "borrowMore", args: [loanId, REFUSED_BORROW] },
      "PegUnhealthy",
      REFUSED_GAS,
    );
  } else say(`  · ${refusedLabel}: done`);

  const [stillActive] = await rd<readonly [boolean, bigint]>(r.keeper, sps, stressedPegSourceAbi, "activeStress");
  if (stillActive) {
    // A zero-length override at $1 ends the active one now.
    await sendBuilt(r.keeper, clearLabel, r.keeper.surety.buildStressPeg({ musdUsdWad: WAD, duration: 0 }), stressedPegSourceAbi);
  } else say("  · peg override: none active");
  await printPeg(r.keeper, "after");
}

/* Phase: liquidate */

/** Waits for the keeper's next tick in its log, so the shock and the auction start land well before the one after. */
async function afterKeeperTick(path: string | null): Promise<void> {
  if (!path) return;
  const lastTick = () => {
    const text = readFileSync(path, "utf8");
    const lines = text.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
      if (lines[i]!.includes('"msg":"tick"')) return lines[i]!;
    }
    return null;
  };
  statSync(path);
  const start = lastTick();
  say("  … waiting for the keeper's next tick (it would start the auction itself)");
  for (let i = 0; i < 150; i++) {
    await sleep(1_000);
    if (lastTick() !== start) return;
  }
  say("  ! no keeper tick seen for 150 s; going ahead");
}

async function liquidate(r: Roles): Promise<void> {
  const c = r.borrower;
  const d = c.d;
  const line = d.contracts.veBTCLine;
  const ps = d.contracts.btcUsdSource!;
  say("== liquidate");
  const tokenId = await createLock(c, AUCTION_LOCK, "auction");
  if (tokenId === null) return;

  let found = await loanOn(c, tokenId);
  if (!found) {
    const q = await c.surety.quoteVeBTCBorrow(tokenId);
    const amount = (((q.collateralValue ?? 0n) * AUCTION_LTV_BPS) / BPS / WAD) * WAD;
    if (amount === 0n || amount > q.maxBorrow) throw new Error(`veBTC #${tokenId} cannot borrow ${musd(amount)} (max ${musd(q.maxBorrow)})`);
    found = await openLoan(
      c,
      tokenId,
      amount,
      (id, fee, ltv) =>
        `borrower: veBTC loan #${id} opened on #${tokenId} (${fmt(amount, 0)} MUSD, LTV ${pct(ltv)}; ` +
        `${fmt(fee, 4)} MUSD origination fee to the treasury), the loan the shock sends to auction`,
    );
    if (!found) return;
  }
  const { loanId } = found;
  let l = await loanOf(c, loanId);

  // 1. Shock and auction start.
  if (l.state === 1) {
    const [base, debt, [ltvNow, value]] = await Promise.all([
      rd<bigint>(c, ps, stressedPriceSourceAbi, "priceWad"),
      rd<bigint>(c, line, lineAbi, "debtOf", [loanId]),
      rd<readonly [bigint, bigint]>(c, line, lineAbi, "healthOf", [loanId]),
    ]);
    const haircut = await rd<number>(c, ps, stressedPriceSourceAbi, "haircutBps");
    // The haircut that puts this loan at AUCTION_SHOCKED_LTV_BPS, rounded up.
    const keep = (debt * BPS * BPS) / (value * AUCTION_SHOCKED_LTV_BPS); // (1 - h) in bps
    const shockBps = Number(BPS - keep);
    say(`  loan #${loanId}: debt ${musd(debt)}, collateral ${musd(value)}, LTV ${pct(ltvNow)}; shock needed ${pct(BigInt(shockBps))}`);
    await checkOthersUnderShock(r, BigInt(shockBps), loanId);
    if (haircut < shockBps) {
      await afterKeeperTick(r.keeperLog);
      await send(
        r.keeper,
        `keeper wallet: shock −${pct(BigInt(shockBps))} for ${SHOCK_SECONDS / 60} min (StressedPriceSource)`,
        { address: ps, abi: stressedPriceSourceAbi, functionName: "shock", args: [shockBps, SHOCK_SECONDS] },
      );
      say(`      BTC/USD ${musd(base, 0)} -> ${musd(await rd<bigint>(c, ps, stressedPriceSourceAbi, "priceWad"), 0)}`);
    } else say(`  · shock: −${pct(BigInt(haircut))} active`);
    if (r.keeper.dryRun && haircut < shockBps) throw new DryRunStop("the auction start needs the shock on chain first");
    const [ltv] = await rd<readonly [bigint, bigint]>(c, line, lineAbi, "healthOf", [loanId]);
    l = await loanOf(c, loanId);
    if (l.state === 1) {
      await send(r.keeper, `keeper wallet: veBTC auction started (loan #${loanId}, LTV ${pct(ltv)} at the shocked price)`, {
        address: line, abi: lineAbi, functionName: "startAuction", args: [loanId],
      });
      l = await loanOf(c, loanId);
    }
  }
  if (l.state === 2) await recordAuctionStart(r, loanId, l);

  // 2. Bid once the price has decayed for a while, above debt plus fee.
  if (l.state === 2) {
    const p = await rd<{ auctionDuration: number; floorBps: number; liqFeeBps: number }>(c, line, lineAbi, "params");
    const bidAt = l.auctionStart + DECAY_WAIT;
    say(`  auction started ${utc(l.auctionStart)} by ${l.keeper}; decays to its ${p.floorBps / 100}% floor by ${utc(l.auctionStart + BigInt(p.auctionDuration))}`);
    if (!r.bidder.dryRun) await waitUntil(r.bidder, bidAt, `${DECAY_WAIT}s of decay before the bid`);
    const [price, debt, [, value]] = await Promise.all([
      rd<bigint>(c, line, lineAbi, "auctionPrice", [loanId]),
      rd<bigint>(c, line, lineAbi, "debtOf", [loanId]),
      rd<readonly [bigint, bigint]>(c, line, lineAbi, "healthOf", [loanId]),
    ]);
    const owed = debt + (debt * BigInt(p.liqFeeBps)) / BPS;
    const floor = (value * BigInt(p.floorBps)) / BPS;
    say(
      `  price now ${musd(price)} (${pct((price * BPS) / value)} of ${musd(value)}); debt ${musd(debt)} + fee = ${musd(owed)}; ` +
        `floor ${musd(floor)}, ${floor >= owed ? "above" : "BELOW"} debt + fee`,
    );
    const maxPrice = (price * 1_005n) / 1_000n;
    await ensureAllowance(r.bidder, d.external.musd, line, maxPrice, "bidder: approve MUSD to credit line (bid)");
    needOnChain(
      r.bidder,
      (await rd<bigint>(r.bidder, d.external.musd, erc20Abi, "allowance", [r.bidder.me, line])) >= maxPrice,
      "the bid needs the MUSD approve above on chain first",
    );
    const sent = await sendBuilt(
      r.bidder,
      `bidder: veBTC auction bid on loan #${loanId} at ${pct((price * BPS) / value)} of collateral, above debt + fee (no shortfall)`,
      r.bidder.surety.buildBid({ loanId, maxPrice }),
      lineAbi,
    );
    if (sent) {
      for (const ev of parseEventLogs({ abi: lineAbi, logs: sent.receipt.logs })) {
        if (ev.eventName === "Bid") {
          say(
            `      Bid: paid ${musd(ev.args.price, 4)} for debt ${musd(ev.args.debt, 4)}; shortfall ${musd(ev.args.shortfall, 4)}, ` +
              `surplus to the borrower ${musd(ev.args.surplus, 4)}`,
          );
        }
        if (ev.eventName === "LiquidationFeePaid") {
          say(
            `      LiquidationFeePaid: lenders ${musd(ev.args.toLenders, 4)}, treasury ${musd(ev.args.toTreasury, 4)}, ` +
              `keeper ${musd(ev.args.toKeeper, 4)} (to ${ev.args.keeper})`,
          );
        }
      }
      say(`      veBTC #${l.tokenId} now held by ${await rd<Address>(c, d.external.veBTC, veBTCLockAbi, "ownerOf", [l.tokenId])}`);
    }
    l = await loanOf(c, loanId);
  }
  if (l.state === 4) say(`  · loan #${loanId}: liquidated; line bad debt total ${musd(await rd<bigint>(c, line, lineAbi, "badDebtTotal"))}`);

  // 3. End the shock once nothing is left to sell.
  if (l.state === 4 && (await rd<number>(c, ps, stressedPriceSourceAbi, "haircutBps")) > 0) {
    await send(r.keeper, "keeper wallet: shock cleared (BTC back at its Skip price)", {
      address: ps, abi: stressedPriceSourceAbi, functionName: "shock", args: [0, 0],
    });
  }
}

/** Refuses a shock that would also put the escrow-vote loan or the Morpho position near liquidation. */
async function checkOthersUnderShock(r: Roles, shockBps: bigint, auctionLoan: bigint): Promise<void> {
  const c = r.borrower;
  const keep = BPS - shockBps;
  const count = await rd<bigint>(c, c.d.contracts.veBTCLine, lineAbi, "loanCount");
  for (let id = 1n; id <= count; id++) {
    if (id === auctionLoan) continue;
    const l = await loanOf(c, id);
    if (l.state !== 1) continue;
    const [ltv] = await rd<readonly [bigint, bigint]>(c, c.d.contracts.veBTCLine, lineAbi, "healthOf", [id]);
    const shocked = (ltv * BPS) / keep;
    say(`    loan #${id} (${l.borrower === c.me ? "borrower" : shortAddr(l.borrower)}): LTV ${pct(ltv)} -> ${pct(shocked)} under the shock`);
    if (shocked >= SAFE_LINE_LTV_BPS) throw new Error(`the shock would put loan #${id} at ${pct(shocked)}; not shocking`);
  }
  const m = await morphoPosition(c, c.me);
  if (m.borrowAssets > 0n) {
    const shocked = (m.borrowAssets * BPS * BPS) / (m.value * keep);
    const limit = (m.lltv * BPS) / WAD - SAFE_MORPHO_MARGIN_BPS;
    say(`    Morpho position: LTV ${pct((m.borrowAssets * BPS) / m.value)} -> ${pct(shocked)} under the shock (LLTV ${pct((m.lltv * BPS) / WAD)})`);
    if (shocked >= limit) throw new Error(`the shock would put the Morpho position at ${pct(shocked)}; not shocking`);
  }
}

/** If the Surety keeper started the auction before this run's keeper wallet did, records its transaction. */
async function recordAuctionStart(r: Roles, loanId: bigint, l: LoanRecord): Promise<void> {
  const c = r.keeper;
  if (has(c, `keeper wallet: veBTC auction started (loan #${loanId}`) || has(c, `Surety keeper: veBTC auction started (loan #${loanId}`)) return;
  const head = await c.pc.getBlockNumber();
  const logs = await c.pc.getLogs({
    address: c.d.contracts.veBTCLine,
    event: getAbiItem({ abi: lineAbi, name: "AuctionStarted" }),
    args: { loanId },
    fromBlock: head > 5_000n ? head - 5_000n : 0n,
    toBlock: head,
  });
  const ev = logs.at(-1);
  if (!ev) return;
  record(c, {
    label: `Surety keeper: veBTC auction started (loan #${loanId}, by ${shortAddr(l.keeper)} before this run's keeper wallet)`,
    hash: ev.transactionHash!,
    block: Number(ev.blockNumber),
  });
  say(`  + auction started by ${l.keeper}: ${explorerUrl(CHAIN_ID, "tx", ev.transactionHash!)}`);
}

/* Phase: market */

async function market(r: Roles): Promise<void> {
  const d = r.lender.d;
  const sm = d.contracts.shareMarket!;
  const vault = d.contracts.vault;
  say("== market");
  const open = await rd<boolean>(r.lender, sm, shareMarketAbi, "isOpen");
  say(`  ShareMarket ${sm}: ${open ? "open" : "SHUT (the deposit gate holds new shares back)"}`);

  // 1. List.
  const listRe = /^lender: list .* \(listing #(\d+)\)$/;
  let id = find(r.lender, listRe).at(-1)?.m?.[1];
  if (id === undefined) {
    if (!open) {
      say("  · list: skipped, the market cannot take shares while the deposit gate is shut");
      return;
    }
    const [approve, list] = r.lender.surety.buildListShares({ shares: LIST_SHARES, discountBps: LIST_DISCOUNT_BPS });
    const allowance = await rd<bigint>(r.lender, vault, erc20Abi, "allowance", [r.lender.me, sm]);
    if (allowance < LIST_SHARES) await sendBuilt(r.lender, `lender: approve ${fmt(LIST_SHARES, 0)} srMUSD to ShareMarket`, approve!, vaultV2Abi);
    needOnChain(r.lender, (await rd<bigint>(r.lender, vault, erc20Abi, "allowance", [r.lender.me, sm])) >= LIST_SHARES, "list needs the share approve above on chain first");
    const next = (await rd<bigint>(r.lender, sm, shareMarketAbi, "listingCount")) + 1n;
    const labelFor = (n: bigint) =>
      `lender: list ${fmt(LIST_SHARES, 0)} srMUSD at ${pct(LIST_DISCOUNT_BPS)} below the share price (listing #${n})`;
    const sent = await sendBuilt(r.lender, labelFor(next), list!, shareMarketAbi);
    if (!sent) return;
    const listed = parseEventLogs({ abi: shareMarketAbi, logs: sent.receipt.logs, eventName: "Listed" })[0];
    if (!listed) throw new Error(`list ${sent.hash} emitted no Listed event`);
    if (listed.args.id !== next) relabel(r.lender, sent.hash, labelFor(listed.args.id));
    id = String(listed.args.id);
  } else say(`  · list: listing #${id}`);
  const listingId = BigInt(id);

  // 2. Fill part of it.
  if (has(r.buyer, `share buyer: fill `)) say("  · fill: done");
  else {
    const [filled, assets, fee] = await rd<readonly [bigint, bigint, bigint]>(r.buyer, sm, shareMarketAbi, "quote", [listingId, FILL_SHARES]);
    const value = await rd<bigint>(r.buyer, vault, vaultV2Abi, "convertToAssets", [filled]);
    say(`  quote: ${fmt(filled)} srMUSD (worth ${musd(value, 4)}) for ${musd(assets, 4)}; fee ${musd(fee, 4)} to the treasury`);
    const maxAssets = assets + assets / 1_000n;
    const [approve, fill] = r.buyer.surety.buildFillListing({ id: listingId, shares: FILL_SHARES, maxAssets });
    const allowance = await rd<bigint>(r.buyer, d.external.musd, erc20Abi, "allowance", [r.buyer.me, sm]);
    if (allowance < maxAssets) await sendBuilt(r.buyer, `share buyer: approve ${fmt(maxAssets, 4)} MUSD to ShareMarket`, approve!, erc20Abi);
    needOnChain(r.buyer, (await rd<bigint>(r.buyer, d.external.musd, erc20Abi, "allowance", [r.buyer.me, sm])) >= maxAssets, "fill needs the MUSD approve above on chain first");
    if (!(await rd<boolean>(r.buyer, sm, shareMarketAbi, "isOpen"))) {
      say("  · fill: skipped, the deposit gate is shut");
    } else {
      const sent = await sendBuilt(
        r.buyer,
        `share buyer: fill ${fmt(filled, 0)} srMUSD of listing #${listingId} for ${fmt(assets, 4)} MUSD (fee ${fmt(fee, 4)} MUSD to the treasury)`,
        fill!,
        shareMarketAbi,
      );
      if (sent) {
        for (const ev of parseEventLogs({ abi: shareMarketAbi, logs: sent.receipt.logs, eventName: "Filled" })) {
          say(`      Filled: ${fmt(ev.args.shares)} srMUSD for ${musd(ev.args.assets, 4)}, seller got ${musd(ev.args.assets - ev.args.fee, 4)}, treasury ${musd(ev.args.fee, 4)}`);
        }
      }
    }
  }

  // 3. Take the rest back: cancel, or redeem it while the gate is shut.
  const left = await rd<{ seller: Address; discountBps: number; shares: bigint }>(r.lender, sm, shareMarketAbi, "listing", [listingId]);
  if (left.shares === 0n) say(`  · listing #${listingId}: closed`);
  else if (await rd<boolean>(r.lender, sm, shareMarketAbi, "isOpen")) {
    await sendBuilt(
      r.lender,
      `lender: cancel listing #${listingId} (${fmt(left.shares, 0)} srMUSD back)`,
      r.lender.surety.buildCancelListing({ id: listingId }),
      shareMarketAbi,
    );
  } else {
    const assets = await rd<bigint>(r.lender, vault, vaultV2Abi, "previewRedeem", [left.shares]);
    await sendBuilt(
      r.lender,
      `lender: cancelAndRedeem listing #${listingId} (${fmt(left.shares, 0)} srMUSD redeemed while the deposit gate is shut)`,
      r.lender.surety.buildCancelAndRedeem({ id: listingId, minAssets: (assets * 99n) / 100n }),
      shareMarketAbi,
    );
  }
  const b = await balances(r.lender, r.lender.me);
  const bb = await balances(r.buyer, r.buyer.me);
  say(`  lender ${fmt(b.shares)} srMUSD, ${musd(b.musd)}; share buyer ${fmt(bb.shares)} srMUSD, ${musd(bb.musd)}`);
}

/* Phase: savings */

async function savings(r: Roles): Promise<void> {
  const c = r.keeper;
  say("== savings");
  const s = await savingsState(c);
  say(`  savings adapter: ${musd(s.real)} in sMUSD, claimable yield ${musd(s.claimable, 8)}`);
  if (has(c, "keeper wallet: savings harvest")) {
    say("  · savings harvest: done");
    return;
  }
  if (s.claimable === 0n) {
    say("  · savings harvest: no yield to claim yet; skipped");
    return;
  }
  const sent = await sendBuilt(
    c,
    `keeper wallet: savings harvest (${fmt(s.claimable, 8)} MUSD of sMUSD yield claimed and parked again)`,
    c.surety.buildSavingsHarvest(),
    savingsAdapterAbi,
  );
  if (sent) {
    for (const ev of parseEventLogs({ abi: savingsAdapterAbi, logs: sent.receipt.logs, eventName: "Harvested" })) {
      say(`      Harvested: yield ${musd(ev.args.yield, 8)}, deposited back ${musd(ev.args.deposited, 8)}`);
    }
  }
}

/* Phase: kit */

async function kit(r: Roles): Promise<void> {
  say("== kit");
  if (!r.relayer || !r.kit) {
    say("  · starter kit: skipped (RELAYER_PRIVATE_KEY or KIT_ADDRESS not set)");
    return;
  }
  const c = r.relayer;
  const sponsor = c.d.contracts.sponsor!;
  const [isRelayer, claimed, left] = await Promise.all([
    rd<boolean>(c, sponsor, sponsorAbi, "isRelayer", [c.me]),
    rd<boolean>(c, sponsor, sponsorAbi, "claimed", [r.kit]),
    rd<bigint>(c, sponsor, sponsorAbi, "kitsLeft"),
  ]);
  say(`  Sponsor ${sponsor}: relayer ${c.me} ${isRelayer ? "allowed" : "NOT ALLOWED"}, ${left} kits funded`);
  if (claimed) {
    say(`  · starter kit: team test wallet ${r.kit} already has its kit`);
    return;
  }
  if (!isRelayer) throw new Error(`${c.me} is not a relayer on the Sponsor`);
  const next = (await rd<bigint>(c, sponsor, sponsorAbi, "kitsIssued")) + 1n;
  const sent = await send(
    c,
    `starter-kit relayer: starter kit #${next} for team test wallet ${shortAddr(r.kit)} (not an outside user)`,
    { address: sponsor, abi: sponsorAbi, functionName: "starterKit", args: [r.kit] },
  );
  if (sent) {
    for (const ev of parseEventLogs({ abi: sponsorAbi, logs: sent.receipt.logs, eventName: "StarterKit" })) {
      say(
        `      StarterKit: ${ev.args.user} got veBTC #${ev.args.tokenId} (${btc(ev.args.lockAmount)}), ` +
          `${btc(ev.args.btcGas)} for gas, ${musd(ev.args.musd)}`,
      );
    }
  }
}

/* Phase: harvest (after the Mezo flip) */

async function harvest(r: Roles): Promise<void> {
  const c = r.keeper;
  const d = c.d;
  const line = d.contracts.veBTCLine;
  say("== harvest");
  const found = await escrowLoan(r);
  if (!found) throw new Error("no escrow-vote loan; run the other phases first");
  const { loanId } = found;
  const bribeTx = proofTxs(c).find((t) => t.label.startsWith("sponsor: bribe "));
  if (!bribeTx) throw new Error("no bribe recorded; run --phase escrow first");
  const bribeBlock = await c.pc.getBlock({ blockNumber: BigInt(bribeTx.block) });
  const claimableFrom = mezoEpochNext(bribeBlock.timestamp);
  const now = await chainNow(c);
  if (now < claimableFrom) {
    throw new Error(`the bribe's Mezo epoch ends ${utc(claimableFrom)}; harvest after that (from ${utc(claimableFrom + 900n)})`);
  }
  let l = await loanOf(c, loanId);
  say(`  loan #${loanId} (${LOAN_STATES[l.state]}), veBTC #${l.tokenId}, escrow ${l.escrow}, auto-repay ${l.autoRepay ? "on" : "OFF"}`);

  // Harvests the Surety keeper already sent for this loan since the flip.
  const head = await c.pc.getBlockNumber();
  const flipBlock = await blockAt(c, claimableFrom, BigInt(bribeTx.block), head);
  const logs = await getLogsChunked(c.pc, {
    address: line, event: getAbiItem({ abi: lineAbi, name: "Harvested" }), args: { loanId }, fromBlock: flipBlock, toBlock: head,
  });
  for (const ev of logs) {
    if (proofTxs(c).some((t) => t.hash === ev.transactionHash)) continue;
    const who = ev.args.caller;
    const by = who.toLowerCase() === r.deployer.me.toLowerCase() ? "Surety keeper" : who.toLowerCase() === c.me.toLowerCase() ? "keeper wallet" : shortAddr(who);
    record(c, {
      label:
        `${by}: harvest loan #${loanId} (auto-repay): ${fmt(ev.args.musdClaimed, 6)} MUSD claimed, ${fmt(ev.args.repaid, 6)} repaid, ` +
        `rebase ${ev.args.rebaseClaimed ? "claimed" : "not booked yet"}`,
      hash: ev.transactionHash,
      block: Number(ev.blockNumber),
    });
    say(`  + harvest by ${who}: ${explorerUrl(CHAIN_ID, "tx", ev.transactionHash)}`);
  }

  const plan = await c.surety.getHarvestPlan(loanId);
  const debtBefore = await rd<bigint>(c, line, lineAbi, "debtOf", [loanId]);
  const lockBefore = await rd<{ amount: bigint }>(c, d.external.veBTC, veBTCLockAbi, "locked", [l.tokenId]);
  for (const e of plan.earned) say(`    earned: ${fmt(e.amount, 8)} ${await symbolOf(c, e.token)} from ${e.reward}`);
  say(`    rebase claimable: ${fmt(plan.claimableRebase, 12)} BTC; debt ${musd(debtBefore, 6)}; lock ${btc(lockBefore.amount)}`);
  if (!plan.worthHarvesting) {
    say("  · harvest: nothing left to claim (already harvested, or the rebase is not booked yet)");
    return;
  }
  const musdEarned = plan.earned.filter((e) => e.token.toLowerCase() === d.external.musd.toLowerCase()).reduce((s, e) => s + e.amount, 0n);
  const sent = await sendBuilt(
    c,
    `keeper wallet: harvest loan #${loanId} (auto-repay): ${fmt(musdEarned, 6)} MUSD of fees and bribes repay the loan` +
      (plan.claimableRebase > 0n ? ", rebase compounds into the lock" : ""),
    c.surety.buildHarvest({ loanId, rewards: plan.rewards, tokens: plan.tokens }),
    lineAbi,
  );
  if (!sent) return;
  for (const ev of parseEventLogs({ abi: lineAbi, logs: sent.receipt.logs })) {
    if (ev.eventName === "Harvested") {
      say(`      Harvested: ${musd(ev.args.musdClaimed, 6)} claimed, ${musd(ev.args.repaid, 6)} repaid, rebase ${ev.args.rebaseClaimed ? "claimed" : "refused"}`);
    }
    if (ev.eventName === "RewardForwarded") say(`      forwarded ${fmt(ev.args.amount, 8)} ${await symbolOf(c, ev.args.token)} to the borrower`);
  }
  for (const ev of parseEventLogs({ abi: rewardsDistributorAbi, logs: sent.receipt.logs, eventName: "Claimed" })) {
    say(`      rebase ${fmt(ev.args.amount, 12)} BTC for weeks ${utc(ev.args.epochStart)} to ${utc(ev.args.epochEnd)}`);
  }
  l = await loanOf(c, loanId);
  const debtAfter = await rd<bigint>(c, line, lineAbi, "debtOf", [loanId]);
  const lockAfter = await rd<{ amount: bigint }>(c, d.external.veBTC, veBTCLockAbi, "locked", [l.tokenId]);
  say(`  debt ${musd(debtBefore, 6)} -> ${musd(debtAfter, 6)}; lock ${btc(lockBefore.amount)} -> ${btc(lockAfter.amount)}`);
}

/** First block at or after `ts`, between `lo` and `hi` (binary search on timestamps). */
async function blockAt(c: Ctx, ts: bigint, lo: bigint, hi: bigint): Promise<bigint> {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await c.pc.getBlock({ blockNumber: mid });
    if (b.timestamp < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/* Status */

async function status(r: Roles): Promise<void> {
  const c = r.keeper;
  const d = c.d;
  say("== status");
  await printWallets(r);
  await printCapital(c, "now");
  await printPeg(c, "now");
  const count = await rd<bigint>(c, d.contracts.veBTCLine, lineAbi, "loanCount");
  for (let id = 1n; id <= count; id++) {
    const l = await loanOf(c, id);
    const debt = await rd<bigint>(c, d.contracts.veBTCLine, lineAbi, "debtOf", [id]);
    say(`  loan #${id}: ${LOAN_STATES[l.state]}, veBTC #${l.tokenId}, borrower ${l.borrower}, debt ${musd(debt, 4)}, auto-repay ${l.autoRepay}`);
  }
  const m = await morphoPosition(c, r.borrower.me);
  say(`  Morpho: borrower ${btc(m.collateral)} collateral, debt ${musd(m.borrowAssets, 4)}; market liquidity ${musd(m.liquidity)}`);
  const paused = await rd<boolean>(c, d.contracts.suretyPool, suretyPoolAbi, "depositsPaused");
  say(`  deposits ${paused ? "PAUSED" : "open"}; proof file holds ${proofTxs(c).length} transactions`);
}

/* Main */

const PHASES = ["fund", "lend", "vote", "loan", "escrow", "morpho", "peg", "liquidate", "market", "savings", "kit"] as const;
type Phase = (typeof PHASES)[number] | "all" | "harvest" | "status";
const RUN: Record<(typeof PHASES)[number] | "harvest", (r: Roles) => Promise<void>> = {
  fund, lend, vote, loan, escrow, morpho, peg, liquidate, market, savings, kit, harvest,
};

const DEFAULT_DEPLOYMENT = fileURLToPath(new URL("../../../contracts/deployments/31611.json", import.meta.url));

const USAGE = `Usage: node keeper/dist/scripts/testnet-cycle-v2.js --phase <name> --env-file <path> --roles-file <path> [options]

Runs Surety v2 end to end on Mezo testnet (${CHAIN_ID}), each role from its own account.

Options:
  --phase <name>        all (${PHASES.join(", ")}), one of those, harvest (after the bribe's Mezo epoch ends), or status
  --env-file <path>     .env with DEPLOYER_PRIVATE_KEY (funds the roles) and RELAYER_PRIVATE_KEY (starter kits)
  --roles-file <path>   .env with LENDER_, BORROWER_, VOTER_, SPONSOR_, BIDDER_, BUYER_, KEEPER_PRIVATE_KEY and KIT_ADDRESS
  --deployment <path>   deployment JSON to read and record proof into (default contracts/deployments/31611.json)
  --rpc <url>           RPC URL (default https://rpc.test.mezo.org)
  --pool <address>      PoolsVoter pool for the escrow vote and bribe (default ${DEFAULT_POOL}, MUSD/mUSDC stable)
  --keeper-log <path>   the keeper's log: the price shock waits for its next tick, so this run's keeper wallet starts
                        the auction
  --dry-run             simulate each step, send nothing (stops where a step needs an earlier one on chain)

Keep both .env files outside the repository; no key is ever printed.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      phase: { type: "string" },
      "env-file": { type: "string" },
      "roles-file": { type: "string" },
      deployment: { type: "string" },
      rpc: { type: "string" },
      pool: { type: "string" },
      "keeper-log": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const phase = values.phase as Phase | undefined;
  if (!phase || !([...PHASES, "all", "harvest", "status"] as string[]).includes(phase)) {
    process.stderr.write(`--phase is required\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (!values["roles-file"]) throw new Error("--roles-file is required");
  const poolArg = values.pool ?? DEFAULT_POOL;
  if (!isAddress(poolArg)) throw new Error(`--pool ${poolArg} is not an address`);

  const base = openContext({
    envFile: values["env-file"],
    deployment: values.deployment ?? DEFAULT_DEPLOYMENT,
    rpc: values.rpc,
    dryRun: values["dry-run"],
    quiet: true,
    logFields: { script: "cycle-v2", role: "deployer" },
  });
  if (base.d.version !== 2) throw new Error(`${base.deploymentPath} is a v${base.d.version} deployment; this run needs v2`);
  const chainId = await base.pc.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`the RPC serves chain ${chainId}, not Mezo testnet ${CHAIN_ID}`);
  process.loadEnvFile(values["roles-file"]);
  const role = (name: RoleName) => withSender(base, keyFromEnv(ROLE_KEYS[name]), { logFields: { script: "cycle-v2", role: name } });
  const relayerKey = process.env.RELAYER_PRIVATE_KEY?.trim() ? keyFromEnv("RELAYER_PRIVATE_KEY") : null;
  const kitRaw = process.env.KIT_ADDRESS?.trim();
  const r: Roles = {
    deployer: base,
    lender: role("lender"),
    borrower: role("borrower"),
    voter: role("voter"),
    sponsor: role("sponsor"),
    bidder: role("bidder"),
    buyer: role("buyer"),
    keeper: role("keeper"),
    relayer: relayerKey ? withSender(base, relayerKey, { logFields: { script: "cycle-v2", role: "relayer" } }) : null,
    kit: kitRaw && isAddress(kitRaw) ? getAddress(kitRaw) : null,
    pool: getAddress(poolArg),
    keeperLog: values["keeper-log"] ?? null,
  };
  if (r.kit && process.env.KIT_PRIVATE_KEY?.trim()) {
    const derived = privateKeyToAccount(keyFromEnv("KIT_PRIVATE_KEY")).address;
    if (derived !== r.kit) throw new Error("KIT_ADDRESS does not match KIT_PRIVATE_KEY");
  }

  say(`Surety v2 testnet cycle: phase ${phase}, chain ${CHAIN_ID}${base.dryRun ? " (dry run)" : ""}`);
  say(`  proof file ${base.deploymentPath}`);
  try {
    if (phase === "status") await status(r);
    else if (phase === "all") for (const p of PHASES) await RUN[p](r);
    else await RUN[phase](r);
  } catch (e) {
    if (!(e instanceof DryRunStop)) throw e;
    say(`  · dry run stops here: ${e.message}`);
    return;
  }
  if (phase === "all" || phase === "escrow") {
    say("");
    say("  After the Mezo flip (Thursday 00:00 UTC), from 00:15 UTC:");
    say("    node keeper/dist/scripts/testnet-cycle-v2.js --phase harvest --env-file <.env> --roles-file <roles .env>");
  }
  if (phase === "all") await status(r);
}

runMain(main);


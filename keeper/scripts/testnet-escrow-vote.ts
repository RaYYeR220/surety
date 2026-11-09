/**
 * Puts a veBTC loan's escrowed NFT to work on Mezo's PoolsVoter, live on Mezo testnet (31611), and records every
 * transaction it sends in the deployment file under `proof.txs` ({ label, hash, block }):
 *
 *   lock    approve BTC to veBTC and lock it for 28 days (veBTC's maximum; checked against the line's minTerm)
 *   loan    approve the NFT to the veBTC credit line and open a small MUSD loan on it, inside maxLtv and the cash
 *   vote    escrowVote: the loan's escrow votes the NFT 100% on one PoolsVoter pool
 *   bribe   post a MUSD bribe on that pool's gauge (BribeVotingReward.notifyRewardAmount), credited to the current
 *           Mezo epoch, so the NFT's voters (the escrow among them) share it once the epoch is over
 *
 * Mezo epochs are weeks from Thursday 00:00 UTC. Fees and bribes credited to an epoch go to the NFTs voting the gauge
 * at its end, pro rata, and are claimable from the next epoch on: run testnet-escrow-claims then. PoolsVoter takes one
 * vote per NFT per epoch and none in an epoch's first hour or (for NFTs it has not whitelisted) its last, so this
 * refuses to start inside either hour, or within an hour of the last one.
 *
 * Re-running skips what chain state and the proof file show is done. Sends wait while the keeper, which shares the
 * sending address, is busy around a Surety epoch flip.
 *
 * Build and run from the repo root:
 *
 *   pnpm --filter @surety/keeper build:scripts
 *   node keeper/dist/scripts/testnet-escrow-vote.js --env-file /path/outside/repo/.env [--dry-run]
 */
import { parseArgs } from "node:util";

import { erc20Abi, explorerUrl, veBTCAbi, veBTCCreditLineAbi } from "@surety/sdk";
import { getAddress, isAddress, parseEventLogs, parseUnits, zeroAddress, type Address } from "viem";

import { sleep } from "../src/retry.js";
import {
  LOAN_ACTIVE,
  LOAN_STATES,
  gaugeOf,
  latestLoanOn,
  lockLabel,
  recordedLockId,
  symbolOf,
  type GaugeInfo,
} from "./lib/escrow.js";
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
  btc,
  chainNow,
  ensureAllowance,
  fmt,
  hhmm,
  musd,
  openContext,
  pct,
  proofTxs,
  rd,
  relabel,
  runMain,
  say,
  send,
  sendBuilt,
  utc,
  type Ctx,
} from "./lib/testnet.js";

/* Scenario */

/** MUSD/mUSDC stable pool: its gauge collects swap fees every epoch and already lists MUSD as a bribe token. */
const DEFAULT_POOL: Address = "0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e";
const DEFAULT_LOCK_BTC = "0.005";
const DEFAULT_LOAN_MUSD = "10";
const DEFAULT_BRIBE_MUSD = "20";
const LOCK_DURATION = VEBTC_MAX_LOCK;
/** BTC kept back for gas (BTC is also Mezo's gas token). */
const GAS_RESERVE = 10n ** 15n;
/** Don't start this close to the end of PoolsVoter's vote window. */
const VOTE_SAFETY = 3_600n;

const day = (ts: bigint) => utc(ts).slice(0, 10);

/* Steps */

interface Position {
  tokenId: bigint;
  loanId: bigint | null;
  escrow: Address | null;
}

async function printState(c: Ctx, g: GaugeInfo): Promise<void> {
  const d = c.d;
  const line = d.contracts.veBTCLine;
  const voter = d.external.poolsVoter;
  const now = await chainNow(c);
  const [m, b, gas, nfts] = await Promise.all([
    rd<bigint>(c, d.external.musd, erc20Abi, "balanceOf", [c.me]),
    rd<bigint>(c, d.external.btc, erc20Abi, "balanceOf", [c.me]),
    c.pc.getBalance({ address: c.me }),
    rd<bigint>(c, d.external.veBTC, veBTCLockAbi, "balanceOf", [c.me]),
  ]);
  say(`  wallet ${c.me}: ${musd(m)}, ${btc(b)} (BTC ERC-20), ${btc(gas)} (native gas)`);
  for (let i = 0n; i < nfts; i++) {
    const id = await rd<bigint>(c, d.external.veBTC, veBTCLockAbi, "ownerToNFTokenIdList", [c.me, i]);
    const [l, vp] = await Promise.all([
      rd<{ amount: bigint; end: bigint; isPermanent: boolean }>(c, d.external.veBTC, veBTCLockAbi, "locked", [id]),
      rd<bigint>(c, d.external.veBTC, veBTCLockAbi, "votingPowerOfNFT", [id]),
    ]);
    say(`    veBTC #${id}: ${btc(l.amount)}, ${l.isPermanent ? "permanent" : `ends ${utc(l.end)}`}, voting power ${fmt(vp, 6)}`);
  }

  const [cash, paused, p] = await Promise.all([
    rd<bigint>(c, line, veBTCCreditLineAbi, "cash"),
    rd<boolean>(c, line, veBTCCreditLineAbi, "paused"),
    rd<{ maxLtvTimedBps: number; maxLtvPermanentBps: number; liqLtvBps: number; minTerm: number }>(
      c, line, veBTCCreditLineAbi, "params",
    ),
  ]);
  say(
    `  veBTC credit line ${line}: cash ${musd(cash)}, ${paused ? "PAUSED" : "open"}; max LTV ${pct(BigInt(p.maxLtvTimedBps))} ` +
      `timed / ${pct(BigInt(p.maxLtvPermanentBps))} permanent, liquidation ${pct(BigInt(p.liqLtvBps))}, min term ${p.minTerm}s`,
  );

  const epoch = mezoEpochStart(now);
  say(
    `  Mezo epoch ${day(epoch)} (Thu 00:00 UTC): votes open ${utc(mezoVoteStart(now))} to ${utc(mezoVoteEnd(now))}, ` +
      `flips ${utc(mezoEpochNext(now))} (in ${((Number(mezoEpochNext(now) - now)) / 3600).toFixed(1)} h)`,
  );
  const [weight, total] = await Promise.all([
    rd<bigint>(c, voter, poolsVoterAbi, "weights", [g.pool]),
    rd<bigint>(c, voter, poolsVoterAbi, "totalWeight"),
  ]);
  say(`  pool ${g.pool} (${g.name}): gauge ${g.gauge} ${g.alive ? "alive" : "KILLED"}, votes ${fmt(weight, 6)} of ${fmt(total, 6)}`);
  for (const [kind, reward, tokens] of [["fees", g.fees, g.feeTokens], ["bribe", g.bribe, g.bribeTokens]] as const) {
    const parts: string[] = [];
    for (const t of tokens) {
      const [cur, prev] = await Promise.all([
        rd<bigint>(c, reward, votingRewardAbi, "tokenRewardsPerEpoch", [t, epoch]),
        rd<bigint>(c, reward, votingRewardAbi, "tokenRewardsPerEpoch", [t, epoch - MEZO_WEEK]),
      ]);
      parts.push(`${await symbolOf(c, t)} ${fmt(cur, 6)} this epoch / ${fmt(prev, 6)} last`);
    }
    say(`    ${kind} ${reward}: ${parts.join("; ") || "no reward tokens"}`);
  }
}

/** Refuses outside PoolsVoter's vote window, with an hour's margin before it closes. */
async function checkVoteWindow(c: Ctx): Promise<void> {
  const now = await chainNow(c);
  if (now <= mezoVoteStart(now)) {
    throw new Error(`PoolsVoter refuses votes in an epoch's first hour; retry after ${utc(mezoVoteStart(now))}`);
  }
  if (now >= mezoVoteEnd(now) - VOTE_SAFETY) {
    throw new Error(
      `too close to the end of the vote window (${utc(mezoVoteEnd(now))}); the vote and bribe would miss this ` +
        `epoch. Retry after ${utc(mezoVoteStart(mezoEpochNext(now)))}`,
    );
  }
}

/** The NFT this run works with: --token-id, else the lock recorded by an earlier run, else a new lock. */
async function lock(c: Ctx, amount: bigint, explicit: bigint | null): Promise<bigint | null> {
  const ve = c.d.external.veBTC;
  const minTerm = BigInt((await rd<{ minTerm: number }>(c, c.d.contracts.veBTCLine, veBTCCreditLineAbi, "params")).minTerm);
  const known = explicit ?? recordedLockId(c);
  if (known !== null) {
    const owner = await rd<Address>(c, ve, veBTCLockAbi, "ownerOf", [known]);
    const held = owner.toLowerCase() === c.me.toLowerCase();
    const escrowed = await rd<boolean>(c, c.d.contracts.veBTCLine, veBTCCreditLineAbi, "isEscrow", [owner]);
    if (held || escrowed) {
      say(`  · lock: using veBTC #${known} (${held ? "held by the sender" : `in loan escrow ${owner}`})`);
      return known;
    }
    if (explicit !== null) throw new Error(`veBTC #${known} is held by ${owner}, neither the sender nor a loan escrow`);
    say(`  · lock: veBTC #${known} from an earlier run is held by ${owner}; creating a new lock`);
  }

  const now = await chainNow(c);
  const end = ((now + LOCK_DURATION) / MEZO_WEEK) * MEZO_WEEK;
  if (end < now + minTerm) throw new Error(`a ${LOCK_DURATION}s lock ends ${utc(end)}, inside the line's min term`);
  // The loan must stay live (not auctionable for expiry) until the claims after the next flip.
  if (end <= mezoEpochNext(now) + MEZO_WEEK) throw new Error(`a lock ending ${utc(end)} expires before the claims`);
  const balance = await rd<bigint>(c, c.d.external.btc, erc20Abi, "balanceOf", [c.me]);
  if (balance < amount + GAS_RESERVE) {
    throw new Error(`the sender holds ${btc(balance)}; locking ${btc(amount)} needs ${btc(amount + GAS_RESERVE)} with gas`);
  }
  say(`  new lock: ${btc(amount)} until ${utc(end)} (min term ${minTerm}s)`);

  await ensureAllowance(c, c.d.external.btc, ve, amount, `approve ${fmt(amount, 3)} BTC to veBTC`);
  if (c.dryRun) {
    const allowance = await rd<bigint>(c, c.d.external.btc, erc20Abi, "allowance", [c.me, ve]);
    if (allowance < amount) {
      say("  · createLock: needs the BTC approve above on chain first; stopping the dry run here");
      return null;
    }
  }
  // The id the lock will get, for the label; checked against the minted NFT below.
  const { result: predicted } = await c.pc.simulateContract({
    address: ve, abi: veBTCLockAbi, functionName: "createLock", args: [amount, LOCK_DURATION], account: c.me,
  });
  const days = LOCK_DURATION / 86_400n;
  const label = lockLabel(predicted, fmt(amount, 3), days);
  const sent = await send(c, label, { address: ve, abi: veBTCLockAbi, functionName: "createLock", args: [amount, LOCK_DURATION] });
  if (!sent) return null; // dry run
  const minted = parseEventLogs({ abi: veBTCLockAbi, logs: sent.receipt.logs, eventName: "Transfer" }).find(
    (ev) => ev.address.toLowerCase() === ve.toLowerCase() && ev.args.from === zeroAddress &&
      ev.args.to.toLowerCase() === c.me.toLowerCase(),
  );
  if (!minted) throw new Error(`createLock ${sent.hash} minted no NFT to the sender`);
  const tokenId = minted.args.tokenId;
  if (tokenId !== predicted) relabel(c, sent.hash, lockLabel(tokenId, fmt(amount, 3), days));
  say(`      minted veBTC #${tokenId}`);
  return tokenId;
}

/** Opens the loan on `tokenId`, or finds the one already open. */
async function openLoan(c: Ctx, tokenId: bigint, amount: bigint): Promise<Position | null> {
  const line = c.d.contracts.veBTCLine;
  const existing = await latestLoanOn(c, tokenId);
  if (existing && existing.loan.state === LOAN_ACTIVE) {
    say(`  · loan: #${existing.loanId} on veBTC #${tokenId} is open, escrow ${existing.loan.escrow}`);
    return { tokenId, loanId: existing.loanId, escrow: existing.loan.escrow };
  }
  if (existing) say(`  · loan: #${existing.loanId} on veBTC #${tokenId} is ${LOAN_STATES[existing.loan.state]}; opening a new one`);

  const [paused, cash] = await Promise.all([
    rd<boolean>(c, line, veBTCCreditLineAbi, "paused"),
    rd<bigint>(c, line, veBTCCreditLineAbi, "cash"),
  ]);
  if (paused) throw new Error("the veBTC credit line is paused: open is disabled");
  if (cash < amount) throw new Error(`the veBTC credit line has ${musd(cash)} of cash, less than the ${musd(amount)} loan`);
  const q = await c.surety.quoteVeBTCBorrow(tokenId, amount);
  say(
    `  quote #${tokenId}: collateral ${musd(q.collateralValue ?? 0n)} at ${musd(q.priceWad ?? 0n, 0)}/BTC, ` +
      `${musd(amount, 0)} = LTV ${pct(q.ltvBps ?? 0n)} (max ${pct(q.maxLtvBps)}, liquidation ${pct(q.liqLtvBps)}), ` +
      `max borrow ${musd(q.maxBorrow)}`,
  );
  if (!q.eligible) throw new Error(`veBTC #${tokenId} cannot borrow ${musd(amount)}: ${q.reasons.join(", ")}`);

  const [approveNft, open] = c.surety.buildOpenLoan({ tokenId, amount });
  const approved = await rd<Address>(c, c.d.external.veBTC, veBTCAbi, "getApproved", [tokenId]);
  if (approved.toLowerCase() === line.toLowerCase()) say(`  · veBTC #${tokenId} already approved to the line`);
  else await sendBuilt(c, `approve veBTC #${tokenId} to credit line`, approveNft!, veBTCAbi);
  if (c.dryRun && approved.toLowerCase() !== line.toLowerCase()) {
    say("  · open: needs the NFT approve above on chain first; stopping the dry run here");
    return null;
  }
  const sent = await sendBuilt(c, `veBTC loan opened #${tokenId} (${fmt(amount, 0)} MUSD)`, open!, veBTCCreditLineAbi);
  if (!sent) return null;
  const opened = parseEventLogs({ abi: veBTCCreditLineAbi, logs: sent.receipt.logs, eventName: "Opened" })[0];
  if (!opened) throw new Error(`open ${sent.hash} emitted no Opened event`);
  const loanId = opened.args.loanId;
  const record = await rd<{ escrow: Address }>(c, line, veBTCCreditLineAbi, "loan", [loanId]);
  say(`      loan #${loanId}, escrow ${record.escrow}`);
  return { tokenId, loanId, escrow: record.escrow };
}

async function vote(c: Ctx, pos: Position, g: GaugeInfo): Promise<void> {
  const voter = c.d.external.poolsVoter;
  const { tokenId, loanId } = pos;
  if (loanId === null) return;
  const now = await chainNow(c);
  const [votes, lastVoted] = await Promise.all([
    rd<bigint>(c, voter, poolsVoterAbi, "votes", [tokenId, g.pool]),
    rd<bigint>(c, voter, poolsVoterAbi, "lastVoted", [tokenId]),
  ]);
  if (votes > 0n) {
    say(`  · vote: veBTC #${tokenId} already votes ${fmt(votes, 6)} on ${g.pair} (last vote ${utc(lastVoted)})`);
    return;
  }
  if (lastVoted >= mezoEpochStart(now)) {
    throw new Error(
      `veBTC #${tokenId} already voted this Mezo epoch (${utc(lastVoted)}) and not on ${g.pool}; PoolsVoter takes one ` +
        `vote per NFT per epoch`,
    );
  }
  await checkVoteWindow(c);
  // veBTC reads an NFT's voting power as zero in the block it changed hands (here: moved into the escrow).
  for (let i = 0; (await rd<bigint>(c, c.d.external.veBTC, veBTCLockAbi, "votingPowerOfNFT", [tokenId])) === 0n; i++) {
    if (i >= 30) throw new Error(`veBTC #${tokenId} has no voting power`);
    await sleep(2_000);
  }
  await send(c, `escrow vote loan #${loanId} (veBTC #${tokenId}) 100% on ${g.name}`, {
    address: c.d.contracts.veBTCLine,
    abi: veBTCCreditLineAbi,
    functionName: "escrowVote",
    args: [loanId, [g.pool], [BPS]],
  });
  if (c.dryRun) return;
  const [cast, weight] = await Promise.all([
    rd<bigint>(c, voter, poolsVoterAbi, "votes", [tokenId, g.pool]),
    rd<bigint>(c, voter, poolsVoterAbi, "weights", [g.pool]),
  ]);
  say(`      votes ${fmt(cast, 6)} of the pool's ${fmt(weight, 6)} (${pct(weight === 0n ? 0n : (cast * BPS) / weight)})`);
}

/** Bribe proof entries for `pair` sent in the Mezo epoch starting `epoch`. */
async function bribesThisEpoch(c: Ctx, pair: string, epoch: bigint): Promise<number> {
  const prefix = `bribe `;
  const hits = proofTxs(c).filter((t) => t.label.startsWith(prefix) && t.label.includes(` on ${pair} gauge`));
  let n = 0;
  for (const t of hits) {
    const b = await c.pc.getBlock({ blockNumber: BigInt(t.block) });
    if (mezoEpochStart(b.timestamp) === epoch) n++;
  }
  return n;
}

async function bribe(c: Ctx, g: GaugeInfo, amount: bigint): Promise<void> {
  const token = c.d.external.musd;
  const now = await chainNow(c);
  const epoch = mezoEpochStart(now);
  if ((await bribesThisEpoch(c, g.pair, epoch)) > 0) {
    say(`  · bribe: already posted on the ${g.pair} gauge this Mezo epoch (${day(epoch)})`);
    return;
  }
  const listed = await rd<boolean>(c, g.bribe, votingRewardAbi, "isReward", [token]);
  const whitelisted = await rd<boolean>(c, c.d.external.poolsVoter, poolsVoterAbi, "isWhitelistedToken", [token]);
  if (!listed && !whitelisted) throw new Error(`MUSD is neither a reward of bribe ${g.bribe} nor whitelisted on PoolsVoter`);
  const balance = await rd<bigint>(c, token, erc20Abi, "balanceOf", [c.me]);
  if (balance < amount) throw new Error(`the sender holds ${musd(balance)}, less than the ${musd(amount)} bribe`);
  await checkVoteWindow(c);

  const before = await rd<bigint>(c, g.bribe, votingRewardAbi, "tokenRewardsPerEpoch", [token, epoch]);
  await ensureAllowance(c, token, g.bribe, amount, `approve ${fmt(amount, 0)} MUSD to ${g.pair} bribe`);
  if (c.dryRun && (await rd<bigint>(c, token, erc20Abi, "allowance", [c.me, g.bribe])) < amount) {
    say("  · bribe: needs the MUSD approve above on chain first; skipped in the dry run");
    return;
  }
  const sent = await send(c, `bribe ${fmt(amount, 0)} MUSD on ${g.pair} gauge (Mezo epoch ${day(epoch)})`, {
    address: g.bribe,
    abi: votingRewardAbi,
    functionName: "notifyRewardAmount",
    args: [token, amount],
  });
  if (!sent) return;
  for (const ev of parseEventLogs({ abi: votingRewardAbi, logs: sent.receipt.logs, eventName: "NotifyReward" })) {
    say(`      credited ${musd(ev.args.amount)} to the epoch starting ${utc(ev.args.epoch)}`);
  }
  const after = await rd<bigint>(c, g.bribe, votingRewardAbi, "tokenRewardsPerEpoch", [token, epoch]);
  say(`      MUSD bribes for this epoch: ${musd(before, 4)} -> ${musd(after, 4)}`);
}

/** What the escrow stands to collect after the flip, at the current vote shares. */
async function outlook(c: Ctx, pos: Position, g: GaugeInfo): Promise<void> {
  const now = await chainNow(c);
  const epoch = mezoEpochStart(now);
  const [bal, supply] = await Promise.all([
    rd<bigint>(c, g.bribe, votingRewardAbi, "balanceOf", [pos.tokenId]),
    rd<bigint>(c, g.bribe, votingRewardAbi, "totalSupply"),
  ]);
  say("");
  say("  Outlook");
  say(
    `  loan #${pos.loanId}, escrow ${pos.escrow}, veBTC #${pos.tokenId}; pool ${g.pool} (${g.name}), gauge ${g.gauge}, ` +
      `fees ${g.fees}, bribe ${g.bribe}`,
  );
  say(`  escrow's share of the gauge's votes: ${fmt(bal, 6)} of ${fmt(supply, 6)} (${pct(supply === 0n ? 0n : (bal * BPS) / supply)})`);
  for (const [kind, reward, tokens] of [["fees", g.fees, g.feeTokens], ["bribes", g.bribe, g.bribeTokens]] as const) {
    for (const t of tokens) {
      const total = await rd<bigint>(c, reward, votingRewardAbi, "tokenRewardsPerEpoch", [t, epoch]);
      if (total === 0n) continue;
      const share = supply === 0n ? 0n : (bal * total) / supply;
      say(`    ${kind} ${await symbolOf(c, t)}: ${fmt(total, 6)} credited this epoch, ~${fmt(share, 6)} to the escrow at today's shares`);
    }
  }
  const rebase = await rd<bigint>(c, c.d.external.rewardsDistributor, rewardsDistributorAbi, "claimable", [pos.tokenId]);
  say(`  veBTC rebase claimable now: ${btc(rebase)} (this week's share is booked at the flip)`);
  const flip = mezoEpochNext(now);
  say(`  claimable from ${utc(flip)}; then run:`);
  say(`    node keeper/dist/scripts/testnet-escrow-claims.js --env-file <.env> --loan-id ${pos.loanId} --dry-run`);
  say(`    node keeper/dist/scripts/testnet-escrow-claims.js --env-file <.env> --loan-id ${pos.loanId}`);
}

/* Main */

const USAGE = `Usage: node keeper/dist/scripts/testnet-escrow-vote.js [options]

Locks BTC in veBTC, borrows MUSD against the NFT on the veBTC credit line, votes the escrowed NFT on a Mezo
PoolsVoter pool and posts a MUSD bribe on that pool's gauge. Testnet (${CHAIN_ID}) only.

Options:
  --env-file <path>     .env file holding DEPLOYER_PRIVATE_KEY (keep it outside the repository)
  --deployment <path>   deployment JSON to read and record proof into (default contracts/deployments/v1/31611.json)
  --rpc <url>           RPC URL (default https://rpc.test.mezo.org)
  --pool <address>      PoolsVoter pool to vote and bribe (default ${DEFAULT_POOL}, MUSD/mUSDC stable)
  --token-id <id>       use this veBTC NFT (held by the sender, or already in its loan) instead of a new lock
  --lock <btc>          BTC to lock in a new veBTC NFT (default ${DEFAULT_LOCK_BTC})
  --loan <musd>         MUSD to borrow (default ${DEFAULT_LOAN_MUSD})
  --bribe <musd>        MUSD bribe to post (default ${DEFAULT_BRIBE_MUSD})
  --dry-run             simulate each step, send nothing
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      deployment: { type: "string" },
      rpc: { type: "string" },
      pool: { type: "string" },
      "token-id": { type: "string" },
      lock: { type: "string", default: DEFAULT_LOCK_BTC },
      loan: { type: "string", default: DEFAULT_LOAN_MUSD },
      bribe: { type: "string", default: DEFAULT_BRIBE_MUSD },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const poolArg = values.pool ?? DEFAULT_POOL;
  if (!isAddress(poolArg)) throw new Error(`--pool ${poolArg} is not an address`);
  const pool = getAddress(poolArg);
  const lockAmount = parseUnits(values.lock, 18);
  const loanAmount = parseUnits(values.loan, 18);
  const bribeAmount = parseUnits(values.bribe, 18);
  const tokenIdArg = values["token-id"] === undefined ? null : BigInt(values["token-id"]);

  const c = openContext({
    envFile: values["env-file"],
    deployment: values.deployment,
    rpc: values.rpc,
    dryRun: values["dry-run"],
    quiet: true,
    logFields: { script: "escrow-vote" },
  });
  const chainId = await c.pc.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`the RPC serves chain ${chainId}, not Mezo testnet ${CHAIN_ID}`);

  say(`Surety escrow vote: chain ${CHAIN_ID}, sender ${c.me}${c.dryRun ? " (dry run)" : ""}`);
  say(`  proof file ${c.deploymentPath}`);
  const g = await gaugeOf(c, c.d.external.poolsVoter, pool);
  if (!g.alive) throw new Error(`the gauge ${g.gauge} of pool ${pool} has been killed`);
  if (g.fees === zeroAddress || g.bribe === zeroAddress) throw new Error(`gauge ${g.gauge} has no fee or bribe reward`);

  say("== state");
  await printState(c, g);
  await checkVoteWindow(c);

  say("== lock");
  const tokenId = await lock(c, lockAmount, tokenIdArg);
  if (tokenId === null) return;

  say("== loan");
  const pos = await openLoan(c, tokenId, loanAmount);
  if (pos === null) return;

  say("== vote");
  await vote(c, pos, g);

  say("== bribe");
  await bribe(c, g, bribeAmount);

  await outlook(c, pos, g);
  say(`  escrow ${explorerUrl(CHAIN_ID, "address", pos.escrow ?? zeroAddress)}`);
  say(`  sender at ${hhmm(await chainNow(c))}: ${musd(await rd<bigint>(c, c.d.external.musd, erc20Abi, "balanceOf", [c.me]))}`);
}

runMain(main);

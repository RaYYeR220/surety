/**
 * Collects what a veBTC loan's escrowed NFT earned on Mezo's PoolsVoter, live on Mezo testnet (31611), through the
 * credit line's borrower-only escrow paths, and prints what reached the borrower:
 *
 *   escrowClaim        fees and bribes of every gauge the NFT votes on: the escrow claims them from the reward
 *                      contracts and forwards exactly what the claim added to the borrower
 *   escrowClaimRebase  the NFT's veBTC rebase from the RewardsDistributor: compounded into the lock while it is live,
 *                      paid to the borrower once it has expired
 *
 * Rewards credited to a Mezo epoch (weeks from Thursday 00:00 UTC) are claimable once it is over, so run this after
 * the flip that follows testnet-escrow-vote. Each claim is sent only when the reward contracts or the distributor
 * report something to collect, so a re-run sends nothing until more has accrued. Every transaction is recorded in
 * the deployment file under `proof.txs`.
 *
 * Build and run from the repo root:
 *
 *   pnpm --filter @surety/keeper build:scripts
 *   node keeper/dist/scripts/testnet-escrow-claims.js --env-file /path/outside/repo/.env [--loan-id <id>] [--dry-run]
 */
import { parseArgs } from "node:util";

import { erc20Abi, veBTCCreditLineAbi } from "@surety/sdk";
import { getAddress, isAddress, parseAbi, parseEventLogs, type Address, type Log } from "viem";

import {
  LOAN_ACTIVE,
  LOAN_AUCTION,
  LOAN_STATES,
  gaugeOf,
  latestLoanOn,
  recordedLockId,
  symbolOf,
  votedPools,
  type GaugeInfo,
  type LoanRecord,
} from "./lib/escrow.js";
import {
  mezoEpochNext,
  mezoEpochStart,
  poolsVoterAbi,
  rewardsDistributorAbi,
  splitterAbi,
  veBTCLockAbi,
  votingRewardAbi,
} from "./lib/mezo.js";
import {
  CHAIN_ID,
  chainNow,
  fmt,
  openContext,
  rd,
  runMain,
  say,
  send,
  utc,
  type Ctx,
} from "./lib/testnet.js";

/** A small lock's weekly rebase can be a few satoshis, so BTC prints to 12 decimals here. */
const btc = (x: bigint) => `${fmt(x, 12)} BTC`;

const erc20TransferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

interface Loan {
  loanId: bigint;
  loan: LoanRecord;
}

/** --loan-id, else the open loan on the lock testnet-escrow-vote recorded, else the sender's latest open loan. */
async function findLoan(c: Ctx, explicit: bigint | null): Promise<Loan> {
  const line = c.d.contracts.veBTCLine;
  if (explicit !== null) {
    const loan = await rd<LoanRecord>(c, line, veBTCCreditLineAbi, "loan", [explicit]);
    if (loan.state === 0) throw new Error(`loan #${explicit} does not exist`);
    return { loanId: explicit, loan };
  }
  const lockId = recordedLockId(c);
  if (lockId !== null) {
    const found = await latestLoanOn(c, lockId);
    if (found) return found;
  }
  const count = await rd<bigint>(c, line, veBTCCreditLineAbi, "loanCount");
  for (let id = count; id >= 1n; id--) {
    const loan = await rd<LoanRecord>(c, line, veBTCCreditLineAbi, "loan", [id]);
    const open = loan.state === LOAN_ACTIVE || loan.state === LOAN_AUCTION;
    if (open && loan.borrower.toLowerCase() === c.me.toLowerCase()) return { loanId: id, loan };
  }
  throw new Error("the sender has no open veBTC loan; pass --loan-id");
}

interface Claim {
  reward: Address;
  kind: "bribes" | "fees";
  pair: string;
  tokens: Address[];
  earned: bigint[];
}

/** Bribes then fees for every gauge, with what each token has earned. Bribe tokens: MUSD plus any that earned. */
async function plan(c: Ctx, tokenId: bigint, gauges: GaugeInfo[]): Promise<Claim[]> {
  const out: Claim[] = [];
  const earned = (reward: Address, t: Address) => rd<bigint>(c, reward, votingRewardAbi, "earned", [t, tokenId]);
  const ve = c.d.external.veBTC.toLowerCase();
  for (const g of gauges) {
    const bribeTokens: Address[] = [];
    const bribeEarned: bigint[] = [];
    for (const t of g.bribeTokens) {
      if (t.toLowerCase() === ve) continue;
      const e = await earned(g.bribe, t);
      if (e > 0n || t.toLowerCase() === c.d.external.musd.toLowerCase()) {
        bribeTokens.push(t);
        bribeEarned.push(e);
      }
    }
    out.push({ reward: g.bribe, kind: "bribes", pair: g.pair, tokens: bribeTokens, earned: bribeEarned });
    const feeTokens = (g.tokens ? [...g.tokens] : g.feeTokens).filter((t) => t.toLowerCase() !== ve);
    out.push({ reward: g.fees, kind: "fees", pair: g.pair, tokens: feeTokens, earned: await Promise.all(feeTokens.map((t) => earned(g.fees, t))) });
  }
  return out;
}

/** ERC-20 amounts `from` sent to `to` in these logs, by token. */
function transfers(logs: Log[], from: Address, to: Address): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const ev of parseEventLogs({ abi: erc20TransferAbi, logs, eventName: "Transfer", strict: true })) {
    if (ev.args.from.toLowerCase() !== from.toLowerCase() || ev.args.to.toLowerCase() !== to.toLowerCase()) continue;
    const key = ev.address.toLowerCase();
    out.set(key, (out.get(key) ?? 0n) + ev.args.value);
  }
  return out;
}

async function claimFeesAndBribes(c: Ctx, l: Loan, gauges: GaugeInfo[], received: Map<string, bigint>): Promise<void> {
  const { loanId, loan } = l;
  const claims = await plan(c, loan.tokenId, gauges);
  let any = false;
  for (const cl of claims) {
    for (let i = 0; i < cl.tokens.length; i++) {
      const e = cl.earned[i]!;
      if (e > 0n) any = true;
      say(`    ${cl.pair} ${cl.kind} ${cl.reward}: ${await symbolOf(c, cl.tokens[i]!)} earned ${fmt(e, 8)}`);
    }
  }
  const pairs = [...new Set(gauges.map((g) => g.pair))].join(", ");
  const label = `escrow claim loan #${loanId}: ${pairs} fees and bribes`;
  if (!any && !c.dryRun) {
    say("  · escrowClaim: nothing earned to claim (already claimed, or the epoch voted in has not ended)");
    return;
  }
  if (!any) say("  · escrowClaim: nothing earned yet; simulating the call path only");
  const sent = await send(c, label, {
    address: c.d.contracts.veBTCLine,
    abi: veBTCCreditLineAbi,
    functionName: "escrowClaim",
    args: [loanId, claims.map((cl) => cl.reward), claims.map((cl) => cl.tokens)],
  });
  if (!sent) return;
  for (const ev of parseEventLogs({ abi: votingRewardAbi, logs: sent.receipt.logs, eventName: "ClaimRewards" })) {
    const cl = claims.find((x) => x.reward.toLowerCase() === ev.address.toLowerCase());
    if (ev.args.amount === 0n) continue;
    say(`      ${cl ? `${cl.pair} ${cl.kind}` : ev.address} paid the escrow ${fmt(ev.args.amount, 8)} ${await symbolOf(c, ev.args.reward)}`);
  }
  for (const [token, amount] of transfers(sent.receipt.logs, loan.escrow, loan.borrower)) {
    received.set(token, (received.get(token) ?? 0n) + amount);
    say(`      escrow forwarded ${fmt(amount, 8)} ${await symbolOf(c, getAddress(token))} to the borrower`);
  }
}

async function claimRebase(c: Ctx, l: Loan, received: Map<string, bigint>): Promise<bigint> {
  const { loanId, loan } = l;
  const d = c.d;
  const distributor = d.external.rewardsDistributor;
  const now = await chainNow(c);
  const [claimable, depositor, lastTokenTime] = await Promise.all([
    rd<bigint>(c, distributor, rewardsDistributorAbi, "claimable", [loan.tokenId]),
    rd<Address>(c, distributor, rewardsDistributorAbi, "depositor"),
    rd<bigint>(c, distributor, rewardsDistributorAbi, "lastTokenTime"),
  ]);
  const active = await rd<bigint>(c, depositor, splitterAbi, "activePeriod");
  say(
    `    distributor ${distributor}: ${btc(claimable)} claimable for veBTC #${loan.tokenId}; rewards booked up to ` +
      `${utc(lastTokenTime)}, splitter period ${utc(active)}`,
  );
  const label = `escrow rebase claim loan #${loanId} (veBTC #${loan.tokenId})`;
  if (active < mezoEpochStart(now)) {
    say(`  · escrowClaimRebase: the distributor's splitter has not run for the week of ${utc(mezoEpochStart(now))} yet; retry later`);
    return 0n;
  }
  if (claimable === 0n && !c.dryRun) {
    say("  · escrowClaimRebase: no rebase to claim (already claimed, or the week's rebase is not booked yet)");
    return 0n;
  }
  if (claimable === 0n) say("  · escrowClaimRebase: no rebase yet; simulating the call path only");
  const sent = await send(c, label, {
    address: d.contracts.veBTCLine,
    abi: veBTCCreditLineAbi,
    functionName: "escrowClaimRebase",
    args: [loanId],
  });
  if (!sent) return 0n;
  const lockAt = (blockNumber: bigint) =>
    rd<{ amount: bigint; end: bigint }>(c, d.external.veBTC, veBTCLockAbi, "locked", [loan.tokenId], blockNumber);
  const [before, after] = await Promise.all([lockAt(sent.block - 1n), lockAt(sent.block)]);
  for (const ev of parseEventLogs({ abi: rewardsDistributorAbi, logs: sent.receipt.logs, eventName: "Claimed" })) {
    say(`      distributor paid ${btc(ev.args.amount)} for weeks ${utc(ev.args.epochStart)} to ${utc(ev.args.epochEnd)}`);
  }
  const compounded = after.amount - before.amount;
  say(`      lock ${btc(before.amount)} -> ${btc(after.amount)} (compounded ${btc(compounded)})`);
  for (const [token, amount] of transfers(sent.receipt.logs, loan.escrow, loan.borrower)) {
    received.set(token, (received.get(token) ?? 0n) + amount);
    say(`      escrow forwarded ${btc(amount)} to the borrower (expired lock)`);
  }
  return compounded;
}

/* Main */

const USAGE = `Usage: node keeper/dist/scripts/testnet-escrow-claims.js [options]

Claims the fees, bribes and veBTC rebase a loan's escrowed NFT earned on Mezo's PoolsVoter, through the veBTC
credit line's escrowClaim and escrowClaimRebase, and prints what the borrower received. Testnet (${CHAIN_ID}) only.

Options:
  --env-file <path>     .env file holding DEPLOYER_PRIVATE_KEY (keep it outside the repository)
  --deployment <path>   deployment JSON to read and record proof into (default contracts/deployments/31611.json)
  --rpc <url>           RPC URL (default https://rpc.test.mezo.org)
  --loan-id <id>        loan to claim for (default: the loan testnet-escrow-vote opened)
  --pool <address>      claim this pool's gauge rewards (default: every pool the NFT votes on)
  --dry-run             show what is claimable and simulate the claims, send nothing
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      deployment: { type: "string" },
      rpc: { type: "string" },
      "loan-id": { type: "string" },
      pool: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const pools = (values.pool ?? []).map((p) => {
    if (!isAddress(p)) throw new Error(`--pool ${p} is not an address`);
    return getAddress(p);
  });

  const c = openContext({
    envFile: values["env-file"],
    deployment: values.deployment,
    rpc: values.rpc,
    dryRun: values["dry-run"],
    quiet: true,
    logFields: { script: "escrow-claims" },
  });
  const chainId = await c.pc.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`the RPC serves chain ${chainId}, not Mezo testnet ${CHAIN_ID}`);
  say(`Surety escrow claims: chain ${CHAIN_ID}, sender ${c.me}${c.dryRun ? " (dry run)" : ""}`);
  say(`  proof file ${c.deploymentPath}`);

  const l = await findLoan(c, values["loan-id"] === undefined ? null : BigInt(values["loan-id"]));
  const { loanId, loan } = l;
  if (loan.state !== LOAN_ACTIVE && loan.state !== LOAN_AUCTION) {
    throw new Error(`loan #${loanId} is ${LOAN_STATES[loan.state]}: escrow claims need an open loan`);
  }
  if (loan.borrower.toLowerCase() !== c.me.toLowerCase()) {
    throw new Error(`loan #${loanId} belongs to ${loan.borrower}; only the borrower can claim through the escrow`);
  }
  const voter = c.d.external.poolsVoter;
  const now = await chainNow(c);
  const lastVoted = await rd<bigint>(c, voter, poolsVoterAbi, "lastVoted", [loan.tokenId]);
  say(`  loan #${loanId} (${LOAN_STATES[loan.state]}), veBTC #${loan.tokenId}, escrow ${loan.escrow}, borrower ${loan.borrower}`);
  say(
    `  now ${utc(now)}, Mezo epoch from ${utc(mezoEpochStart(now))}; last PoolsVoter vote ${lastVoted === 0n ? "none" : utc(lastVoted)}` +
      (lastVoted > 0n && mezoEpochStart(now) <= mezoEpochStart(lastVoted)
        ? `: that epoch's rewards are claimable from ${utc(mezoEpochNext(lastVoted))}`
        : ""),
  );

  const voted = pools.length ? pools : await votedPools(c, voter, loan.tokenId);
  if (!voted.length) throw new Error(`veBTC #${loan.tokenId} votes on no PoolsVoter pool; pass --pool`);
  const gauges = await Promise.all(voted.map((p) => gaugeOf(c, voter, p)));
  for (const g of gauges) say(`  pool ${g.pool} (${g.name}): gauge ${g.gauge}, fees ${g.fees}, bribe ${g.bribe}`);

  const tracked = [c.d.external.musd, c.d.external.btc, ...gauges.flatMap((g) => [...g.feeTokens, ...g.bribeTokens])];
  const balances = async () =>
    new Map(await Promise.all([...new Set(tracked.map((t) => t.toLowerCase()))].map(async (t) =>
      [t, await rd<bigint>(c, getAddress(t), erc20Abi, "balanceOf", [loan.borrower])] as const)));
  const before = await balances();
  const received = new Map<string, bigint>();

  say("== fees and bribes");
  await claimFeesAndBribes(c, l, gauges, received);
  say("== rebase");
  const compounded = await claimRebase(c, l, received);

  say("");
  say("  Borrower received");
  if (received.size === 0 && compounded === 0n) say("    nothing this run");
  for (const [token, amount] of received) say(`    ${fmt(amount, 8)} ${await symbolOf(c, getAddress(token))}`);
  if (compounded > 0n) say(`    ${btc(compounded)} compounded into veBTC #${loan.tokenId} (collateral of loan #${loanId})`);
  if (!c.dryRun && received.size > 0) {
    const after = await balances();
    say("  Borrower balances (BTC also pays this run's gas)");
    for (const [t, b] of before) {
      const a = after.get(t) ?? b;
      if (a !== b) say(`    ${await symbolOf(c, getAddress(t))}: ${fmt(b, 8)} -> ${fmt(a, 8)} (${a > b ? "+" : ""}${fmt(a - b, 8)})`);
    }
  }
}

runMain(main);

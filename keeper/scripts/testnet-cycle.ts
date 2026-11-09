/**
 * Runs Surety's whole lifecycle live on Mezo testnet (31611) and records every transaction it sends in the
 * deployment file under `proof.txs` ({ label, hash, block }).
 *
 * Phases run separately and skip what chain state shows is already done, so a phase can be re-run after a failure:
 *
 *   setup   deposit 1,000 MUSD; vote veBTC #1711 70/30 and #1712 30/70 over line 0 (BTC/MUSD Morpho) and line 1
 *           (veBTC credit line); rebalance (bootstrap tally); post 100 + 150 MUSD incentives; open a 100 MUSD veBTC
 *           loan on #1712; borrow ~77% LTV on the Morpho market against 0.004 BTC
 *   stress  shock the price source -60%; liquidate the Morpho position seizing all collateral (bad debt); start the
 *           veBTC loan's auction and bid at the 70% floor once it has decayed (shortfall)
 *   settle  checkpoint and cover both lines; print the loss waterfall
 *   epoch   after an hourly flip: poke the ballots, rebalance (fees go to cohorts), show the cohorts maturing
 *
 * Build and run from the repo root:
 *
 *   pnpm --filter @surety/keeper build:cycle
 *   node keeper/dist/scripts/testnet-cycle.js --phase setup --env-file /path/outside/repo/.env
 *
 * The sending key is DEPLOYER_PRIVATE_KEY, from the environment or the --env-file. It is never printed: every
 * line this script writes is scrubbed of it. Every send goes through the keeper's Executor: simulated first, then
 * sent with gas = estimate x 1.3 (Mezo estimates can come in low, and it charges at least half the limit).
 */
import { parseArgs } from "node:util";

import {
  MORPHO_ORACLE_PRICE_SCALE,
  creditVoterAbi,
  erc20Abi,
  morphoAbi,
  morphoLiquidationIncentiveFactor,
  morphoPriceOracleAbi,
  morphoToAssetsUp,
  stressedPriceSourceAbi,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCAbi,
  veBTCCreditLineAbi,
  voteAllocatorAbi,
  type TxRequest,
} from "@surety/sdk";
import { parseEventLogs, type Abi, type Address } from "viem";

import {
  BPS,
  RPC,
  WAD,
  btc,
  chainNow,
  ensureAllowance,
  epochOf,
  fmt,
  hhmm,
  lastProof,
  musd,
  openContext,
  pct,
  proofTxs,
  rd,
  runMain,
  say,
  send,
  sendBuilt,
  utc,
  waitUntil,
  type Ctx,
  type ProofEntry,
  type Sent,
} from "./lib/testnet.js";

/* Scenario */

const MORPHO_LINE = 0;
const VEBTC_LINE = 1;
const DEPOSIT = 1_000n * WAD;
const INCENTIVES: readonly { lineId: number; assets: bigint }[] = [
  { lineId: MORPHO_LINE, assets: 100n * WAD },
  { lineId: VEBTC_LINE, assets: 150n * WAD },
];
const BALLOTS: readonly { tokenId: bigint; weightsBps: readonly [bigint, bigint] }[] = [
  { tokenId: 1711n, weightsBps: [7_000n, 3_000n] },
  { tokenId: 1712n, weightsBps: [3_000n, 7_000n] },
];
const LOAN_NFT = 1712n;
const LOAN_AMOUNT = 100n * WAD;
const MORPHO_COLLATERAL = 4n * 10n ** 15n; // 0.004 BTC
const MORPHO_TARGET_LTV_BPS = 7_700n;
const SHOCK_BPS = 6_000;
const SHOCK_SECONDS = 7_200;

/** Seconds after a flip before voting: ballots revert in an epoch's first second. */
const FLIP_DELAY = 5n;
/** Setup votes and incentives must land in the same epoch; don't start them closer than this to a flip. */
const SETUP_MARGIN = 600n;

const LABEL_SHOCK = "shock −60%";
const LABEL_LIQUIDATION = "Morpho liquidation with bad debt";
const SETTLE_LABELS = [
  "checkpoint Morpho line (loss recorded)",
  "checkpoint veBTC line (loss recorded)",
  "cover Morpho line",
  "cover veBTC line",
] as const;

const realAssetsAbi = [
  { type: "function", name: "realAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const satisfies Abi;

/* Reads */

interface MorphoPosition {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
  borrowAssets: bigint;
}

function morphoMarket(c: Ctx) {
  const line = c.d.lines.find((l) => l.id === MORPHO_LINE);
  if (!line?.marketId || !line.marketParams) throw new Error("deployment has no Morpho line 0 market");
  return { id: line.marketId, params: line.marketParams };
}

async function morphoPosition(c: Ctx, user: Address): Promise<MorphoPosition> {
  const { id } = morphoMarket(c);
  const [pos, market] = await Promise.all([
    rd<{ supplyShares: bigint; borrowShares: bigint; collateral: bigint }>(
      c, c.d.contracts.morpho, morphoAbi, "position", [id, user],
    ),
    rd<{ totalBorrowAssets: bigint; totalBorrowShares: bigint }>(c, c.d.contracts.morpho, morphoAbi, "market", [id]),
  ]);
  const borrowAssets = morphoToAssetsUp(pos.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
  return { ...pos, borrowAssets };
}

async function morphoOraclePrice(c: Ctx): Promise<bigint> {
  return rd<bigint>(c, morphoMarket(c).params.oracle, morphoPriceOracleAbi, "price");
}

interface LoanRecord {
  borrower: Address;
  escrow: Address;
  tokenId: bigint;
  normDebt: bigint;
  state: number;
  auctionStart: bigint;
}

const LOAN_STATES = ["None", "Active", "Auction", "Closed", "Liquidated"] as const;

/** Latest loan the deployer opened on `tokenId`, or null. */
async function findLoan(c: Ctx, tokenId: bigint): Promise<{ loanId: bigint; loan: LoanRecord } | null> {
  const count = await rd<bigint>(c, c.d.contracts.veBTCLine, veBTCCreditLineAbi, "loanCount");
  for (let id = count; id >= 1n; id--) {
    const loan = await rd<LoanRecord>(c, c.d.contracts.veBTCLine, veBTCCreditLineAbi, "loan", [id]);
    if (loan.tokenId === tokenId && loan.borrower.toLowerCase() === c.me.toLowerCase()) return { loanId: id, loan };
  }
  return null;
}

interface VaultState {
  totalAssets: bigint;
  totalSupply: bigint;
  sharePrice: bigint;
  realAssets: bigint;
  idle: bigint;
  maxRate: bigint;
}

async function vaultState(c: Ctx, blockNumber?: bigint): Promise<VaultState> {
  const v = c.d.contracts.vault;
  const [totalAssets, totalSupply, sharePrice, idle, morphoReal, lineReal, maxRate] = await Promise.all([
    rd<bigint>(c, v, vaultV2Abi, "totalAssets", [], blockNumber),
    rd<bigint>(c, v, vaultV2Abi, "totalSupply", [], blockNumber),
    rd<bigint>(c, v, vaultV2Abi, "convertToAssets", [WAD], blockNumber),
    rd<bigint>(c, c.d.external.musd, erc20Abi, "balanceOf", [v], blockNumber),
    rd<bigint>(c, c.d.contracts.morphoAdapter, realAssetsAbi, "realAssets", [], blockNumber),
    rd<bigint>(c, c.d.contracts.veBTCLine, realAssetsAbi, "realAssets", [], blockNumber),
    rd<bigint>(c, v, vaultV2Abi, "maxRate", [], blockNumber),
  ]);
  return { totalAssets, totalSupply, sharePrice, realAssets: idle + morphoReal + lineReal, idle, maxRate };
}

function printVault(label: string, v: VaultState): void {
  say(
    `  vault ${label}: totalAssets ${musd(v.totalAssets)}, supply ${fmt(v.totalSupply)} srMUSD, ` +
      `share price ${fmt(v.sharePrice, 6)} MUSD, idle ${musd(v.idle)}, real assets ${musd(v.realAssets)}`,
  );
}

async function printBalances(c: Ctx): Promise<void> {
  const [m, b, gas, shares] = await Promise.all([
    rd<bigint>(c, c.d.external.musd, erc20Abi, "balanceOf", [c.me]),
    rd<bigint>(c, c.d.external.btc, erc20Abi, "balanceOf", [c.me]),
    c.pc.getBalance({ address: c.me }),
    rd<bigint>(c, c.d.contracts.vault, vaultV2Abi, "balanceOf", [c.me]),
  ]);
  say(`  wallet ${c.me}: ${musd(m)}, ${btc(b)} (BTC ERC-20), ${btc(gas)} (native gas), ${fmt(shares)} srMUSD`);
}

async function printBoard(c: Ctx): Promise<void> {
  const board = await c.surety.getBoard();
  const e = board.epoch;
  say(
    `  epoch ${hhmm(e.currentEpoch)} (next flip ${hhmm(e.nextFlip)}, in ${e.secondsToFlip}s); ` +
      `active tally ${e.activeTallyEpoch === 0n ? "-" : hhmm(e.activeTallyEpoch)}, last rebalance ` +
      `${e.lastRebalanceEpoch === 0n ? "-" : hhmm(e.lastRebalanceEpoch)}`,
  );
  say(
    `  vault: TVL ${musd(board.vault.totalAssets)}, share price ${fmt(board.vault.sharePrice, 6)}, ` +
      `idle ${musd(board.vault.idle)}`,
  );
  for (const l of board.lines) {
    say(
      `  line ${l.id} ${l.name}: votes ${(l.votes.currentShare * 100).toFixed(1)}% now / ` +
        `${(l.votes.lastClosedShare * 100).toFixed(1)}% last epoch, allocation ${musd(l.allocation ?? 0n)}, ` +
        `target ${musd(l.target ?? 0n)}, utilisation ${fmt(l.utilizationWad ?? 0n, 4)}, ` +
        `incentives ${musd(l.incentives.assets)}, cover capacity ${musd(l.coverCapacity ?? 0n)}, ` +
        `loss ${musd(l.lossRecorded ?? 0n)} recorded / ${musd(l.lossCovered ?? 0n)} covered`,
    );
  }
}

/* Phase: setup */

/** Epoch to cast the setup ballots in: both NFTs have power, past its first seconds, with time left in it. */
async function votingEpoch(c: Ctx): Promise<bigint> {
  const len = BigInt(c.d.epochLength);
  for (;;) {
    const now = await chainNow(c);
    const epoch = epochOf(c, now);
    const next = epoch + len;
    const ballots = await Promise.all(
      BALLOTS.map((b) => rd<readonly [readonly bigint[], readonly bigint[], bigint]>(
        c, c.d.contracts.creditVoter, creditVoterAbi, "ballotOf", [b.tokenId],
      )),
    );
    if (ballots.every((b) => b[2] === epoch)) return epoch; // already cast here: finish setup in this epoch
    const powers = await Promise.all(
      BALLOTS.map((b) => rd<bigint>(c, c.d.external.veBTC, veBTCAbi, "votingPowerOfNFTAt", [b.tokenId, epoch])),
    );
    if (powers.some((p) => p === 0n)) {
      await waitUntil(c, next + FLIP_DELAY, "a new lock has voting power only from the next epoch start");
      continue;
    }
    if (now < epoch + FLIP_DELAY) {
      await waitUntil(c, epoch + FLIP_DELAY, "ballots revert in an epoch's first second");
      continue;
    }
    if (next - now < SETUP_MARGIN) {
      await waitUntil(c, next + FLIP_DELAY, "too close to the flip to cast votes and incentives in one epoch");
      continue;
    }
    say(`  voting epoch ${hhmm(epoch)}; powers ${powers.map((p) => fmt(p, 6)).join(", ")}`);
    return epoch;
  }
}

async function setup(c: Ctx): Promise<void> {
  const d = c.d;
  say("== setup");
  await printBalances(c);

  // 1. Lender deposit.
  const held = await rd<bigint>(c, d.contracts.vault, vaultV2Abi, "balanceOf", [c.me]);
  if (held > 0n) {
    say(`  · deposit: already holds ${fmt(held)} srMUSD`);
  } else {
    await ensureAllowance(c, d.external.musd, d.contracts.vault, DEPOSIT, "approve 1,000 MUSD to vault");
    await sendBuilt(c, "deposit 1,000 MUSD", c.surety.buildDeposit({ assets: DEPOSIT, receiver: c.me }), vaultV2Abi);
  }

  // 2. Ballots.
  const epoch = await votingEpoch(c);
  for (const b of BALLOTS) {
    const [lineIds, weights, epochCast] = await rd<readonly [readonly bigint[], readonly bigint[], bigint]>(
      c, d.contracts.creditVoter, creditVoterAbi, "ballotOf", [b.tokenId],
    );
    const tag = `${Number(b.weightsBps[0]) / 100}/${Number(b.weightsBps[1]) / 100}`;
    const same =
      lineIds.length === 2 && lineIds[0] === 0n && lineIds[1] === 1n &&
      weights[0] === b.weightsBps[0] && weights[1] === b.weightsBps[1];
    if (epochCast === epoch && same) {
      say(`  · vote #${b.tokenId} ${tag}: already cast in ${hhmm(epoch)}`);
      continue;
    }
    const owner = await rd<Address>(c, d.external.veBTC, veBTCAbi, "ownerOf", [b.tokenId]);
    if (owner.toLowerCase() !== c.me.toLowerCase()) throw new Error(`#${b.tokenId} is held by ${owner}; cannot vote`);
    await sendBuilt(
      c,
      `vote #${b.tokenId} ${tag}`,
      c.surety.buildVote({ tokenId: b.tokenId, lineIds: [MORPHO_LINE, VEBTC_LINE], weightsBps: [...b.weightsBps] }),
      creditVoterAbi,
    );
  }

  // 3. Rebalance: with no closed epoch voted yet, the allocator bootstraps from the current tally.
  const va = d.contracts.voteAllocator;
  const lineAssets = () =>
    Promise.all([MORPHO_LINE, VEBTC_LINE].map((l) => rd<bigint>(c, va, voteAllocatorAbi, "lineAssets", [l])));
  const lastRebalance = await rd<bigint>(c, va, voteAllocatorAbi, "lastRebalanceEpoch");
  const before = await lineAssets();
  if (lastRebalance === epoch && before.every((a) => a > 0n)) {
    say(`  · rebalance: done this epoch, lines hold ${before.map((a) => musd(a)).join(" / ")}`);
  } else {
    const label = lastRebalance === 0n ? "rebalance (bootstrap)" : `rebalance (epoch ${hhmm(epoch)})`;
    const sent = await sendBuilt(c, label, c.surety.buildRebalance(), voteAllocatorAbi);
    if (sent) {
      for (const ev of parseEventLogs({ abi: voteAllocatorAbi, logs: sent.receipt.logs })) {
        if (ev.eventName === "Rebalanced") {
          say(`      tally epoch ${hhmm(ev.args.tallyEpoch)}, targets ${ev.args.targets.map((t) => musd(t)).join(" / ")}`);
        }
        if (ev.eventName === "MoveFailed") say(`      MoveFailed line ${ev.args.lineId}: ${ev.args.reason}`);
      }
    }
  }
  const after = await lineAssets();
  say(`  allocation: line 0 ${musd(after[0]!)}, line 1 ${musd(after[1]!)}`);
  if (after.some((a) => a === 0n)) throw new Error("the rebalance did not allocate to both lines");

  // 4. Sponsor incentives for this epoch's voters.
  const pool = d.contracts.suretyPool;
  const todo: { lineId: number; assets: bigint }[] = [];
  for (const inc of INCENTIVES) {
    const posted = await rd<bigint>(c, pool, suretyPoolAbi, "sponsorShares", [inc.lineId, epoch, c.me]);
    if (posted > 0n) say(`  · incentive line ${inc.lineId}: already posted (${fmt(posted)} srMUSD)`);
    else todo.push(inc);
  }
  if (todo.length) {
    const total = todo.reduce((s, i) => s + i.assets, 0n);
    await ensureAllowance(c, d.external.musd, pool, total, `approve ${fmt(total, 0)} MUSD to SuretyPool`);
    for (const inc of todo) {
      const name = d.lines.find((l) => l.id === inc.lineId)?.name ?? `line ${inc.lineId}`;
      await sendBuilt(
        c,
        `incentive ${fmt(inc.assets, 0)} MUSD to line ${inc.lineId} (${name})`,
        c.surety.buildPostIncentive({ lineId: inc.lineId, assets: inc.assets }),
        suretyPoolAbi,
      );
    }
  }

  // 5. veBTC loan on #1712 (its ballot is already counted; an escrowed NFT cannot vote again).
  const existing = await findLoan(c, LOAN_NFT);
  if (existing) {
    say(`  · veBTC loan: #${existing.loanId} on #${LOAN_NFT} exists (${LOAN_STATES[existing.loan.state]})`);
  } else {
    const q = await c.surety.quoteVeBTCBorrow(LOAN_NFT, LOAN_AMOUNT);
    say(
      `  quote #${LOAN_NFT}: collateral ${musd(q.collateralValue ?? 0n)} at ${musd(q.priceWad ?? 0n, 0)}/BTC, ` +
        `${musd(LOAN_AMOUNT, 0)} = LTV ${pct(q.ltvBps ?? 0n)} (max ${pct(q.maxLtvBps)}, liquidation ${pct(q.liqLtvBps)}), ` +
        `max borrow ${musd(q.maxBorrow)}`,
    );
    if (!q.eligible) throw new Error(`#${LOAN_NFT} cannot borrow ${fmt(LOAN_AMOUNT)}: ${q.reasons.join(", ")}`);
    const [approveNft, open] = c.surety.buildOpenLoan({ tokenId: LOAN_NFT, amount: LOAN_AMOUNT });
    const approved = await rd<Address>(c, d.external.veBTC, veBTCAbi, "getApproved", [LOAN_NFT]);
    if (approved.toLowerCase() === d.contracts.veBTCLine.toLowerCase()) say(`  · veBTC #${LOAN_NFT} already approved`);
    else await sendBuilt(c, `approve veBTC #${LOAN_NFT} to credit line`, approveNft!, veBTCAbi);
    await sendBuilt(c, `veBTC loan opened #${LOAN_NFT} (${fmt(LOAN_AMOUNT, 0)} MUSD)`, open!, veBTCCreditLineAbi);
  }

  // 6. BTC borrower on the Morpho market.
  const { params } = morphoMarket(c);
  const morpho = d.contracts.morpho;
  if (lastProof(c, LABEL_LIQUIDATION)) {
    say("  · Morpho borrow: the position was already liquidated in the stress phase");
  } else {
    let pos = await morphoPosition(c, c.me);
    if (pos.collateral === 0n) {
      await ensureAllowance(c, d.external.btc, morpho, MORPHO_COLLATERAL, `approve ${fmt(MORPHO_COLLATERAL, 3)} BTC to Morpho`);
      await sendBuilt(
        c,
        `Morpho supplyCollateral ${fmt(MORPHO_COLLATERAL, 3)} BTC`,
        c.surety.buildSupplyCollateral({ marketParams: params, assets: MORPHO_COLLATERAL, onBehalf: c.me }),
        morphoAbi,
      );
      pos = await morphoPosition(c, c.me);
    }
    if (pos.borrowShares === 0n) {
      const price = await morphoOraclePrice(c);
      const value = (pos.collateral * price) / MORPHO_ORACLE_PRICE_SCALE;
      const amount = ((value * MORPHO_TARGET_LTV_BPS) / BPS / WAD) * WAD; // whole MUSD
      const ltv = (amount * BPS) / value;
      if (amount * WAD >= value * params.lltv) throw new Error("target borrow is not below the LLTV");
      await sendBuilt(
        c,
        `Morpho borrow ${fmt(amount, 0)} MUSD (LTV ${pct(ltv)})`,
        c.surety.buildBorrow({ marketParams: params, assets: amount, onBehalf: c.me, receiver: c.me }),
        morphoAbi,
      );
      pos = await morphoPosition(c, c.me);
    }
    const price = await morphoOraclePrice(c);
    const value = (pos.collateral * price) / MORPHO_ORACLE_PRICE_SCALE;
    say(
      `  Morpho position: ${btc(pos.collateral)} (${musd(value)}), debt ${musd(pos.borrowAssets)}, ` +
        `LTV ${pct(value === 0n ? 0n : (pos.borrowAssets * BPS) / value)} (LLTV ${pct((params.lltv * BPS) / WAD)})`,
    );
  }

  await printBoard(c);
  await printBalances(c);
}

/* Phase: stress */

async function stress(c: Ctx): Promise<void> {
  const d = c.d;
  say("== stress");
  const { params } = morphoMarket(c);
  const pos = await morphoPosition(c, c.me);
  const found = await findLoan(c, LOAN_NFT);
  const loanOpen = found !== null && (found.loan.state === 1 || found.loan.state === 2);
  printVault("before shock", await vaultState(c));

  // 1. Shock the price source, unless it is already shocked or nothing is left to liquidate.
  const ps = d.contracts.priceSource;
  const haircut = await rd<number>(c, ps, stressedPriceSourceAbi, "haircutBps");
  if (haircut === SHOCK_BPS) {
    const endsAt = await rd<bigint>(c, ps, stressedPriceSourceAbi, "shockEndsAt");
    say(`  · shock: −${haircut / 100}% already active until ${utc(endsAt)}`);
  } else if (pos.collateral === 0n && !loanOpen) {
    say("  · shock: nothing left to liquidate");
  } else {
    // Ratchet the Morpho line's high-water mark first, so the recorded loss is the bad debt alone.
    await sendBuilt(
      c,
      "checkpoint Morpho line (pre-shock high-water mark)",
      c.surety.buildCheckpoint({ lineId: MORPHO_LINE }),
      suretyPoolAbi,
    );
    const base = await rd<bigint>(c, ps, stressedPriceSourceAbi, "priceWad");
    await send(c, LABEL_SHOCK, { address: ps, abi: stressedPriceSourceAbi, functionName: "shock", args: [SHOCK_BPS, SHOCK_SECONDS] });
    const shocked = await rd<bigint>(c, ps, stressedPriceSourceAbi, "priceWad");
    say(`      BTC ${musd(base, 0)} -> ${musd(shocked, 0)} for ${SHOCK_SECONDS / 3600} h`);
  }

  // 2. Liquidate the Morpho position, seizing all collateral so Morpho realises the rest as bad debt.
  if (pos.collateral === 0n) {
    say("  · Morpho liquidation: position has no collateral left");
  } else {
    const price = await morphoOraclePrice(c);
    const value = (pos.collateral * price) / MORPHO_ORACLE_PRICE_SCALE;
    const lif = morphoLiquidationIncentiveFactor(params.lltv);
    const repaid = (value * WAD) / lif;
    say(
      `  Morpho position: ${btc(pos.collateral)} worth ${musd(value)}, debt ${musd(pos.borrowAssets)}, ` +
        `LTV ${pct((pos.borrowAssets * BPS) / value)}; seizing all repays ~${musd(repaid)} (LIF ${fmt(lif, 4)}), ` +
        `bad debt ~${musd(pos.borrowAssets - repaid)}`,
    );
    await ensureAllowance(
      c, d.external.musd, d.contracts.morpho, (pos.borrowAssets * 101n) / 100n, "approve MUSD to Morpho (liquidation)",
    );
    const sent = await sendBuilt(
      c,
      LABEL_LIQUIDATION,
      c.surety.buildLiquidateMorpho({ marketParams: params, borrower: c.me, seizedAssets: pos.collateral }),
      morphoAbi,
    );
    if (sent) {
      for (const ev of parseEventLogs({ abi: morphoAbi, logs: sent.receipt.logs, eventName: "Liquidate" })) {
        say(
          `      repaid ${musd(ev.args.repaidAssets)}, seized ${btc(ev.args.seizedAssets)}, ` +
            `bad debt realised ${musd(ev.args.badDebtAssets)}`,
        );
      }
    }
  }

  // 3. Auction the veBTC loan and bid once the price has decayed to its floor.
  if (!found) throw new Error(`no veBTC loan on #${LOAN_NFT}; run --phase setup first`);
  const line = d.contracts.veBTCLine;
  const { loanId } = found;
  let loan = found.loan;
  if (loan.state === 1) {
    const [ltv, value] = await rd<readonly [bigint, bigint]>(c, line, veBTCCreditLineAbi, "healthOf", [loanId]);
    say(`  veBTC loan #${loanId}: collateral ${musd(value)}, LTV ${pct(ltv)}`);
    if (ltv < 7_000n) throw new Error(`loan #${loanId} LTV ${pct(ltv)} is below the 70% liquidation LTV`);
    await sendBuilt(
      c,
      `veBTC auction started (loan #${loanId}, LTV ${pct(ltv)})`,
      c.surety.buildStartAuction({ loanId }),
      veBTCCreditLineAbi,
    );
    loan = await rd<LoanRecord>(c, line, veBTCCreditLineAbi, "loan", [loanId]);
  }
  if (loan.state === 2) {
    const p = await rd<{ auctionDuration: number; floorBps: number }>(c, line, veBTCCreditLineAbi, "params");
    const floorAt = loan.auctionStart + BigInt(p.auctionDuration);
    say(`  auction started ${utc(loan.auctionStart)}, reaches its ${p.floorBps / 100}% floor at ${utc(floorAt)}`);
    await waitUntil(c, floorAt + 2n, "auction decays to its floor");
    const [price, debt] = await Promise.all([
      rd<bigint>(c, line, veBTCCreditLineAbi, "auctionPrice", [loanId]),
      rd<bigint>(c, line, veBTCCreditLineAbi, "debtOf", [loanId]),
    ]);
    const maxPrice = (price * 1_005n) / 1_000n; // the live oracle may tick up between simulation and inclusion
    say(`  floor price ${musd(price)} vs debt ${musd(debt)}`);
    await ensureAllowance(c, d.external.musd, line, maxPrice, "approve MUSD to credit line (bid)");
    const sent = await sendBuilt(c, "veBTC auction bid at floor", c.surety.buildBid({ loanId, maxPrice }), veBTCCreditLineAbi);
    if (sent) {
      for (const ev of parseEventLogs({ abi: veBTCCreditLineAbi, logs: sent.receipt.logs, eventName: "Bid" })) {
        say(
          `      paid ${musd(ev.args.price)} for debt ${musd(ev.args.debt)}: shortfall ${musd(ev.args.shortfall)}, ` +
            `surplus ${musd(ev.args.surplus)}`,
        );
      }
    }
  } else if (loan.state === 4) {
    say(`  · veBTC loan #${loanId}: already liquidated`);
  }

  const bad = await rd<bigint>(c, line, veBTCCreditLineAbi, "badDebtTotal");
  say(`  veBTC line bad debt total ${musd(bad)}`);
  printVault("after loss", await vaultState(c));
  await printBalances(c);
}

/* Phase: settle */

interface Snapshot {
  block: bigint;
  vault: VaultState;
  reserveShares: bigint;
  lines: { lossRecorded: bigint; lossCovered: bigint; cohorts: { epoch: bigint; shares: bigint }[] }[];
}

/** Epochs whose cohorts can hold shares now: current back to current - (SEASON + 1), plus extra ones. */
async function cohortEpochs(c: Ctx, at: bigint, extra: bigint[] = []): Promise<bigint[]> {
  const season = await rd<bigint>(c, c.d.contracts.suretyPool, suretyPoolAbi, "SEASON");
  const len = BigInt(c.d.epochLength);
  const out = new Set<bigint>(extra);
  for (let k = 0n, e = epochOf(c, at); k < season + 2n && e >= len; k++, e -= len) out.add(e);
  return [...out].sort((a, b) => (a < b ? -1 : 1));
}

/** Epochs the recorded incentive transactions were posted in (their cohorts hold the incentives). */
async function incentiveEpochs(c: Ctx): Promise<bigint[]> {
  const txs = proofTxs(c).filter((t) => t.label.startsWith("incentive "));
  const blocks = await Promise.all(txs.map((t) => c.pc.getBlock({ blockNumber: BigInt(t.block) })));
  return [...new Set(blocks.map((b) => epochOf(c, b.timestamp)))];
}

async function snapshot(c: Ctx, epochs: bigint[], blockNumber?: bigint): Promise<Snapshot> {
  const pool = c.d.contracts.suretyPool;
  const block = blockNumber ?? (await c.pc.getBlockNumber());
  const [vault, reserveShares] = await Promise.all([
    vaultState(c, block),
    rd<bigint>(c, pool, suretyPoolAbi, "reserveShares", [], block),
  ]);
  const lines = await Promise.all(
    [MORPHO_LINE, VEBTC_LINE].map(async (l) => {
      const [lossRecorded, lossCovered, cohorts] = await Promise.all([
        rd<bigint>(c, pool, suretyPoolAbi, "lossRecorded", [l], block),
        rd<bigint>(c, pool, suretyPoolAbi, "lossCovered", [l], block),
        Promise.all(
          epochs.map(async (e) => ({
            epoch: e,
            shares: (await rd<readonly [bigint, bigint, boolean]>(c, pool, suretyPoolAbi, "cohort", [l, e], block))[0],
          })),
        ),
      ]);
      return { lossRecorded, lossCovered, cohorts };
    }),
  );
  return { block, vault, reserveShares, lines };
}

const toAssets = (shares: bigint, v: VaultState) => (v.totalSupply === 0n ? 0n : (shares * v.totalAssets) / v.totalSupply);

async function settle(c: Ctx): Promise<void> {
  const d = c.d;
  say("== settle");

  const shockTx = lastProof(c, LABEL_SHOCK);
  const epochs = await cohortEpochs(c, await chainNow(c), await incentiveEpochs(c));

  // Settle: checkpoint each line, then cover (cover checkpoints too; a no-op is skipped after simulation).
  const isZero = (r: unknown) => r === 0n;
  const priorSettle = SETTLE_LABELS.map((l) => lastProof(c, l)).filter((t): t is ProofEntry => t !== undefined);
  const live = await snapshot(c, epochs);
  const sent: Sent[] = [];
  const steps: [string, TxRequest][] = [
    [SETTLE_LABELS[0], c.surety.buildCheckpoint({ lineId: MORPHO_LINE })],
    [SETTLE_LABELS[1], c.surety.buildCheckpoint({ lineId: VEBTC_LINE })],
    [SETTLE_LABELS[2], c.surety.buildCover({ lineId: MORPHO_LINE })],
    [SETTLE_LABELS[3], c.surety.buildCover({ lineId: VEBTC_LINE })],
  ];
  for (const [label, tx] of steps) {
    const s = await sendBuilt(c, label, tx, suretyPoolAbi, { skipIfResult: isZero });
    if (s) sent.push(s);
  }

  // The waterfall: before = just before this run's first settle tx, or before an earlier run's.
  let before = live;
  let receipts = sent.map((s) => s.receipt);
  if (sent.length === 0 && priorSettle.length) {
    const first = priorSettle.reduce((a, b) => (a.block < b.block ? a : b));
    before = await snapshot(c, epochs, BigInt(first.block) - 1n);
    receipts = await Promise.all(priorSettle.map((t) => c.pc.getTransactionReceipt({ hash: t.hash })));
    say(`  (settle already ran: waterfall from block ${first.block - 1} to now)`);
  }
  const after = await snapshot(c, epochs);
  const preShock = shockTx ? await vaultState(c, BigInt(shockTx.block) - 1n) : null;

  const covered = new Map<number, { units: bigint; assets: bigint; fromCohorts: bigint; fromReserve: bigint }>();
  const recorded = new Map<number, bigint>();
  for (const r of receipts) {
    for (const ev of parseEventLogs({ abi: suretyPoolAbi, logs: r.logs })) {
      if (ev.eventName === "Covered") {
        const l = Number(ev.args.lineId);
        const prev = covered.get(l) ?? { units: 0n, assets: 0n, fromCohorts: 0n, fromReserve: 0n };
        covered.set(l, {
          units: prev.units + ev.args.lossUnitsCovered,
          assets: prev.assets + ev.args.assetsMoved,
          fromCohorts: prev.fromCohorts + ev.args.fromCohorts,
          fromReserve: prev.fromReserve + ev.args.fromReserve,
        });
      }
      if (ev.eventName === "LossRecorded") {
        const l = Number(ev.args.lineId);
        recorded.set(l, (recorded.get(l) ?? 0n) + ev.args.assets);
      }
    }
  }

  say("");
  say("  Waterfall");
  if (preShock) say(`  share price before shock ${fmt(preShock.sharePrice, 6)} MUSD (block ${shockTx!.block - 1})`);
  say(`  share price after loss   ${fmt(before.vault.sharePrice, 6)} MUSD (block ${before.block})`);
  say(`  share price after cover  ${fmt(after.vault.sharePrice, 6)} MUSD (block ${after.block})`);
  for (const l of [VEBTC_LINE, MORPHO_LINE]) {
    const name = d.lines.find((x) => x.id === l)?.name ?? `line ${l}`;
    const a = after.lines[l]!;
    const b = before.lines[l]!;
    const cov = covered.get(l);
    say(`  line ${l} ${name}`);
    say(
      `    loss recorded ${musd(a.lossRecorded, 4)}${recorded.has(l) ? ` (this settle: ${musd(recorded.get(l)!, 4)})` : ""}, ` +
        `covered ${musd(a.lossCovered, 4)} units, uncovered (lenders) ${musd(a.lossRecorded - a.lossCovered, 4)}`,
    );
    if (cov) {
      say(
        `    cover moved ${musd(cov.assets, 4)}: ${fmt(cov.fromCohorts, 4)} srMUSD from voter cohorts, ` +
          `${fmt(cov.fromReserve, 4)} srMUSD from the reserve`,
      );
    }
    for (let k = 0; k < b.cohorts.length; k++) {
      const cb = b.cohorts[k]!;
      const ca = a.cohorts[k]!;
      if (cb.shares === 0n && ca.shares === 0n) continue;
      say(
        `    cohort ${hhmm(cb.epoch)}: ${fmt(cb.shares, 4)} srMUSD (${musd(toAssets(cb.shares, before.vault))}) -> ` +
          `${fmt(ca.shares, 4)} srMUSD (${musd(toAssets(ca.shares, after.vault))})`,
      );
    }
  }
  say(
    `  reserve ${fmt(before.reserveShares, 4)} srMUSD (${musd(toAssets(before.reserveShares, before.vault))}) -> ` +
      `${fmt(after.reserveShares, 4)} srMUSD (${musd(toAssets(after.reserveShares, after.vault))})`,
  );
  printVault("after cover", after.vault);
  const pending = after.vault.realAssets - after.vault.totalAssets;
  if (pending > 0n && after.vault.maxRate > 0n) {
    const perSecond = (after.vault.totalAssets * after.vault.maxRate) / WAD;
    const eta = perSecond === 0n ? 0n : pending / perSecond;
    say(
      `  ${musd(pending)} returned by covers is not recognised yet: VaultV2 re-recognises it no faster than maxRate ` +
        `(${fmt(after.vault.maxRate * 31_536_000n * 100n, 0)}% a year), ~${(Number(eta) / 3600).toFixed(1)} h at the current rate`,
    );
  }
}

/* Phase: epoch */

async function epochPhase(c: Ctx, waitForFlip: boolean): Promise<void> {
  const d = c.d;
  const len = BigInt(d.epochLength);
  const va = d.contracts.voteAllocator;
  say("== epoch");
  let now = await chainNow(c);
  let epoch = epochOf(c, now);
  const lastRebalance = await rd<bigint>(c, va, voteAllocatorAbi, "lastRebalanceEpoch");
  if (lastRebalance >= epoch && waitForFlip) {
    await waitUntil(c, epoch + len + FLIP_DELAY, "next epoch flip");
  } else if (now < epoch + FLIP_DELAY) {
    await waitUntil(c, epoch + FLIP_DELAY, "the veBTC snapshot is final one second after the flip");
  }
  now = await chainNow(c);
  epoch = epochOf(c, now);
  say(`  epoch ${hhmm(epoch)} (next flip ${hhmm(epoch + len)})`);

  // Pokes: recast stored ballots into this epoch at the new snapshot.
  for (const b of BALLOTS) {
    const [, , epochCast] = await rd<readonly [readonly bigint[], readonly bigint[], bigint]>(
      c, d.contracts.creditVoter, creditVoterAbi, "ballotOf", [b.tokenId],
    );
    if (epochCast === 0n) {
      say(`  · poke #${b.tokenId}: no ballot`);
      continue;
    }
    if (epochCast >= epoch) {
      say(`  · poke #${b.tokenId}: ballot already counts in ${hhmm(epoch)}`);
      continue;
    }
    const owner = await rd<Address>(c, d.external.veBTC, veBTCAbi, "ownerOf", [b.tokenId]);
    if (await rd<boolean>(c, d.contracts.veBTCLine, veBTCCreditLineAbi, "isEscrow", [owner])) {
      say(`  · poke #${b.tokenId}: in a loan escrow, cannot vote`);
      continue;
    }
    await sendBuilt(c, `poke #${b.tokenId} (epoch ${hhmm(epoch)})`, c.surety.buildPoke({ tokenId: b.tokenId }), creditVoterAbi);
  }

  // Rebalance: the first one of an epoch hands the interest since the last attribution to the pool's cohorts.
  const last = await rd<bigint>(c, va, voteAllocatorAbi, "lastRebalanceEpoch");
  if (last >= epoch) {
    say(`  · rebalance: already ran in ${hhmm(epoch)}`);
  } else {
    const sent = await sendBuilt(c, `rebalance (epoch ${hhmm(epoch)})`, c.surety.buildRebalance(), voteAllocatorAbi);
    if (sent) {
      for (const ev of parseEventLogs({ abi: voteAllocatorAbi, logs: sent.receipt.logs })) {
        if (ev.eventName === "Rebalanced") {
          say(
            `      tally ${hhmm(ev.args.tallyEpoch)}; targets ${ev.args.targets.map((t) => musd(t)).join(" / ")}; ` +
              `interest ${ev.args.interest.map((t) => musd(t, 6)).join(" / ")}`,
          );
        }
        if (ev.eventName === "InterestAttributed") {
          say(`      interest attributed to cohort ${hhmm(ev.args.cohortEpoch)}: ${ev.args.interest.map((t) => musd(t, 6)).join(" / ")}`);
        }
        if (ev.eventName === "MoveFailed") say(`      MoveFailed line ${ev.args.lineId}: ${ev.args.reason}`);
      }
      for (const ev of parseEventLogs({ abi: suretyPoolAbi, logs: sent.receipt.logs, eventName: "FeesDistributed" })) {
        say(
          `      fees distributed for cohort ${hhmm(ev.args.cohortEpoch)}: ${fmt(ev.args.shares, 6)} srMUSD, ` +
            `${fmt(ev.args.toReserve, 6)} to the reserve`,
        );
      }
    }
  }

  // Cohorts maturing.
  const pool = d.contracts.suretyPool;
  const epochs = await cohortEpochs(c, now, await incentiveEpochs(c));
  const v = await vaultState(c);
  const reserve = await rd<bigint>(c, pool, suretyPoolAbi, "reserveShares");
  say("  cohorts (line, tally epoch): shares, value, maturity");
  for (const l of [MORPHO_LINE, VEBTC_LINE]) {
    for (const e of epochs) {
      const [shares, finalShares, frozen] = await rd<readonly [bigint, bigint, boolean]>(
        c, pool, suretyPoolAbi, "cohort", [l, e],
      );
      if (shares === 0n && finalShares === 0n) continue;
      const maturity = await rd<bigint>(c, pool, suretyPoolAbi, "maturityOf", [e]);
      const votes = await rd<bigint>(c, d.contracts.creditVoter, creditVoterAbi, "lineVotes", [e, l]);
      const status = now >= maturity ? (frozen ? "matured, claiming" : "matured, claimable") : `maturing, ${((Number(maturity - now)) / 3600).toFixed(1)} h left`;
      say(
        `    line ${l}, ${hhmm(e)}: ${fmt(shares, 4)} srMUSD (${musd(toAssets(shares, v))}), votes ${fmt(votes, 6)}, ` +
          `matures ${utc(maturity)} (${status})`,
      );
    }
  }
  say(`  reserve ${fmt(reserve, 4)} srMUSD (${musd(toAssets(reserve, v))})`);
  for (const l of [MORPHO_LINE, VEBTC_LINE]) {
    const [unc, cap] = await Promise.all([
      rd<bigint>(c, pool, suretyPoolAbi, "uncoveredLoss", [l]),
      rd<bigint>(c, pool, suretyPoolAbi, "coverCapacity", [l]),
    ]);
    say(`  line ${l}: uncovered loss ${musd(unc, 4)}, cover capacity ${musd(cap, 4)}`);
  }
  printVault("now", v);
  await printBoard(c);
}

/* Main */

const USAGE = `Usage: node keeper/dist/scripts/testnet-cycle.js --phase <setup|stress|settle|epoch> [options]

Options:
  --phase <name>        setup | stress | settle | epoch (required)
  --env-file <path>     .env file holding DEPLOYER_PRIVATE_KEY (keep it outside the repository)
  --deployment <path>   deployment JSON to read and record proof into (default contracts/deployments/31611.json)
  --rpc <url>           RPC URL (default ${RPC})
  --wait                epoch: if this epoch's rebalance already ran, wait for the next flip
  --dry-run             simulate each step, send nothing
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      phase: { type: "string" },
      "env-file": { type: "string" },
      deployment: { type: "string" },
      rpc: { type: "string" },
      wait: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const phase = values.phase;
  if (phase !== "setup" && phase !== "stress" && phase !== "settle" && phase !== "epoch") {
    process.stderr.write(`--phase must be setup, stress, settle or epoch

${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const c = openContext({
    envFile: values["env-file"],
    deployment: values.deployment,
    rpc: values.rpc,
    dryRun: values["dry-run"],
    logFields: { phase },
  });

  say(`Surety testnet cycle: phase ${phase}, chain ${c.d.chainId}, sender ${c.me}`);
  say(`  proof file ${c.deploymentPath}`);
  if (phase === "setup") await setup(c);
  else if (phase === "stress") await stress(c);
  else if (phase === "settle") await settle(c);
  else await epochPhase(c, values.wait);
}

runMain(main);

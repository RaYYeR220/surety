import type {
  Ballot,
  Board,
  BorrowQuote,
  Cohorts,
  EpochInfo,
  LoanView,
  AuctionView,
} from "@surety/sdk";
import { formatUnits } from "viem";

/** Token amount (18 decimals) as a decimal string, trimmed to `digits` fraction digits. */
export function units(value: bigint | null | undefined, digits = 4): string | null {
  if (value === null || value === undefined) return null;
  const [whole, frac = ""] = formatUnits(value, 18).split(".");
  const cut = frac.slice(0, digits).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole!;
}

/** A 0..1 ratio or rate as a percentage with two decimals. */
export function percent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 10_000) / 100;
}

function wadPercent(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value / 10n ** 12n) / 10_000;
}

function bpsPercent(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value) / 100;
}

export function iso(seconds: bigint | null | undefined): string | null {
  if (seconds === null || seconds === undefined || seconds === 0n) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

/** BTC/USD WAD price as dollars. */
function usd(value: bigint | null | undefined): string | null {
  return units(value, 2);
}

export function presentEpoch(e: EpochInfo) {
  return {
    block: e.blockNumber.toString(),
    now: iso(e.now),
    epochLengthSeconds: Number(e.epochLength),
    currentEpoch: e.currentEpoch.toString(),
    currentEpochStart: iso(e.currentEpoch),
    nextFlip: iso(e.nextFlip),
    secondsToFlip: Number(e.secondsToFlip),
    lastClosedEpoch: e.lastClosedEpoch.toString(),
    activeTallyEpoch: e.activeTallyEpoch.toString(),
    lastRebalanceEpoch: e.lastRebalanceEpoch.toString(),
    rebalanceDue: e.rebalanceDue,
    seasonEpochs: Number(e.season),
  };
}

export function presentBoard(b: Board) {
  return {
    epoch: presentEpoch(b.epoch),
    vault: {
      address: b.vault.address,
      symbol: b.vault.symbol,
      tvlMusd: units(b.vault.totalAssets, 2),
      sharePrice: units(b.vault.sharePrice, 6),
      idleMusd: units(b.vault.idle, 2),
      idleBufferPct: bpsPercent(b.vault.idleBufferBps),
      performanceFeePct: wadPercent(b.vault.performanceFee),
      estSupplyApyPct: percent(b.vault.supplyApy),
    },
    lines: b.lines.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      active: l.active,
      ...(l.paused === undefined ? {} : { paused: l.paused }),
      oracleLive: l.oracleLive,
      voteSharePct: percent(l.votes.currentShare),
      lastEpochVoteSharePct: percent(l.votes.lastClosedShare),
      allocationMusd: units(l.allocation, 2),
      targetMusd: units(l.target, 2),
      utilizationPct: wadPercent(l.utilizationWad),
      supplyApyPct: percent(l.supplyApy),
      borrowApyPct: percent(l.borrowApy),
      incentivesThisEpochMusd: units(l.incentives.assets, 2),
      coverCapacityMusd: units(l.coverCapacity, 2),
      uncoveredLossMusd: units(l.uncoveredLoss, 2),
    })),
  };
}

export function presentQuote(q: BorrowQuote) {
  return {
    tokenId: q.tokenId.toString(),
    owner: q.owner,
    eligible: q.eligible,
    reasons: q.reasons,
    lockedBtc: units(q.lock.amount, 8),
    permanentLock: q.lock.isPermanent,
    maturity: iso(q.maturity),
    btcPriceUsd: usd(q.priceWad),
    collateralValueMusd: units(q.collateralValue, 2),
    maxLtvPct: bpsPercent(q.maxLtvBps),
    liquidationLtvPct: bpsPercent(q.liqLtvBps),
    maxBorrowMusd: units(q.maxBorrow, 2),
    quotedMusd: units(q.amount, 2),
    ltvPct: bpsPercent(q.ltvBps),
    liquidationBtcPriceUsd: usd(q.liquidationPriceWad),
    lineCashMusd: units(q.lineCash, 2),
    borrowAprNowPct: percent(q.borrowAprNow),
    borrowAprAfterPct: percent(q.borrowAprAfter),
  };
}

export function presentLoan(l: LoanView | AuctionView) {
  return {
    loanId: l.loanId.toString(),
    state: l.state,
    borrower: l.borrower,
    tokenId: l.tokenId.toString(),
    debtMusd: units(l.debt, 4),
    collateralValueMusd: units(l.collateralValue, 2),
    ltvPct: bpsPercent(l.ltvBps),
    maxLtvPct: bpsPercent(l.maxLtvBps),
    liquidationLtvPct: bpsPercent(l.liqLtvBps),
    liquidationBtcPriceUsd: usd(l.liquidationPriceWad),
    maturity: iso(l.maturity),
    expired: l.expired,
    liquidatable: l.liquidatable,
    liquidationReason: l.liquidationReason,
    ...(l.state === "Auction"
      ? {
          auctionStarted: iso(l.auctionStart),
          auctionFloorAt: iso(l.auctionEndsAt),
          auctionPriceMusd: units(l.auctionPrice, 2),
          ...("floorPrice" in l ? { auctionFloorMusd: units(l.floorPrice, 2) } : {}),
        }
      : {}),
  };
}

export function presentCohorts(c: Cohorts) {
  return {
    tokenId: c.tokenId.toString(),
    currentEpoch: c.currentEpoch.toString(),
    seasonEpochs: Number(c.season),
    totals: {
      claimableMusd: units(c.totals.claimableAssets),
      maturingMusd: units(c.totals.maturingAssets),
      atRiskMusd: units(c.totals.atRiskAssets),
    },
    cohorts: c.cohorts.map((x) => ({
      lineId: x.lineId,
      epoch: x.epoch.toString(),
      status: x.status,
      maturity: iso(x.maturity),
      valueMusd: units(x.assets),
      shares: x.shares.toString(),
    })),
  };
}

export function presentBallot(b: Ballot) {
  return {
    tokenId: b.tokenId.toString(),
    lineIds: b.lineIds,
    weightsBps: b.weightsBps,
    castThisEpoch: b.castThisEpoch,
    pokeable: b.pokeable,
    powerAtEpochStart: units(b.powerAtEpochStart, 8),
  };
}

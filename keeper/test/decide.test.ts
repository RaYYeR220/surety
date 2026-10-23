import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  ballotsToPoke,
  decide,
  lossActions,
  rebalanceDue,
  sizeMorphoLiquidation,
  type BallotState,
  type KeeperSnapshot,
  type MorphoPosition,
} from "../src/decide.js";

const EPOCH = 1_792_771_200n;
const L = 3600n;
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const WAD = 10n ** 18n;

function ballot(over: Partial<BallotState> = {}): BallotState {
  return { tokenId: 7n, lineIds: [0, 1], epochCast: EPOCH - L, owner: ALICE, ownerIsEscrow: false, power: 10n, ...over };
}

function snapshot(over: Partial<KeeperSnapshot> = {}): KeeperSnapshot {
  return {
    now: EPOCH + 60n,
    currentEpoch: EPOCH,
    epochLength: L,
    lastRebalanceEpoch: EPOCH,
    vaultIdle: 1_000n * WAD,
    ballots: [],
    lines: [
      { id: 0, kind: "Morpho", active: true, uncoveredLoss: 0n, pendingLoss: 0n, coverCapacity: 50n * WAD },
      { id: 1, kind: "VeBTC", active: true, uncoveredLoss: 0n, pendingLoss: 0n, coverCapacity: 50n * WAD },
    ],
    loans: [],
    morphoPositions: [],
    ...over,
  };
}

describe("pokes at the flip", () => {
  it("pokes ballots stored in an earlier epoch", () => {
    const s = snapshot({ ballots: [ballot({ tokenId: 1n }), ballot({ tokenId: 2n, epochCast: EPOCH })] });
    expect(ballotsToPoke(s)).toEqual([1n]);
  });

  it("waits out the first second of the epoch (snapshot not final)", () => {
    expect(ballotsToPoke(snapshot({ now: EPOCH, ballots: [ballot()] }))).toEqual([]);
    expect(ballotsToPoke(snapshot({ now: EPOCH + 1n, ballots: [ballot()] }))).toEqual([7n]);
  });

  it("skips burned, escrowed, powerless and empty ballots", () => {
    const s = snapshot({
      ballots: [
        ballot({ tokenId: 1n, owner: "0x0000000000000000000000000000000000000000" }),
        ballot({ tokenId: 2n, ownerIsEscrow: true }),
        ballot({ tokenId: 3n, power: 0n }),
        ballot({ tokenId: 4n, lineIds: [] }),
        ballot({ tokenId: 5n }),
      ],
    });
    expect(ballotsToPoke(s)).toEqual([5n]);
  });

  it("skips ballots whose lines are all inactive", () => {
    const s = snapshot({ ballots: [ballot({ lineIds: [1] })] });
    s.lines[1]!.active = false;
    expect(ballotsToPoke(s)).toEqual([]);
  });
});

describe("rebalance once per epoch", () => {
  it("is due only after the flip delay and before this epoch's rebalance", () => {
    const due = { lastRebalanceEpoch: EPOCH - L };
    expect(rebalanceDue(snapshot({ ...due, now: EPOCH + 4n }))).toBe(false);
    expect(rebalanceDue(snapshot({ ...due, now: EPOCH + 5n }))).toBe(true);
    expect(rebalanceDue(snapshot({ lastRebalanceEpoch: EPOCH, now: EPOCH + 100n }))).toBe(false);
    expect(rebalanceDue(snapshot({ ...due, now: EPOCH + 9n }), 10n)).toBe(false);
  });
});

describe("loss handling", () => {
  it("does nothing without a loss", () => {
    expect(lossActions(snapshot())).toEqual([]);
  });

  it("covers an uncovered loss when there is capacity and idle MUSD", () => {
    const s = snapshot();
    s.lines[1]!.uncoveredLoss = 10n;
    expect(lossActions(s)).toEqual([{ kind: "cover", lineId: 1, loss: 10n }]);
  });

  it("covers a loss a checkpoint would record", () => {
    const s = snapshot();
    s.lines[0]!.pendingLoss = 7n;
    expect(lossActions(s)).toEqual([{ kind: "cover", lineId: 0, loss: 7n }]);
  });

  it("only checkpoints when nothing can pay the cover", () => {
    const s = snapshot({ vaultIdle: 0n });
    s.lines[0]!.pendingLoss = 7n;
    s.lines[1]!.uncoveredLoss = 3n; // already recorded, nothing to do
    expect(lossActions(s)).toEqual([{ kind: "checkpoint", lineId: 0, loss: 7n }]);

    const noCapacity = snapshot();
    noCapacity.lines[0]!.coverCapacity = 0n;
    noCapacity.lines[0]!.pendingLoss = 7n;
    expect(lossActions(noCapacity)).toEqual([{ kind: "checkpoint", lineId: 0, loss: 7n }]);
  });

  it("ignores a failed checkpoint simulation", () => {
    const s = snapshot();
    s.lines[0]!.pendingLoss = null;
    expect(lossActions(s)).toEqual([]);
  });
});

describe("auctions", () => {
  it("starts auctions for loans past liquidation LTV or expiry only", () => {
    const s = snapshot({
      loans: [
        { loanId: 1n, state: "Active", liquidatable: true, reason: "ltv" },
        { loanId: 2n, state: "Active", liquidatable: true, reason: "expiry" },
        { loanId: 3n, state: "Active", liquidatable: false, reason: null },
        { loanId: 4n, state: "Active", liquidatable: null, reason: null },
        { loanId: 5n, state: "Auction", liquidatable: false, reason: null },
      ],
    });
    expect(decide(s)).toEqual([
      { kind: "startAuction", loanId: 1n, reason: "ltv" },
      { kind: "startAuction", loanId: 2n, reason: "expiry" },
    ]);
  });
});

describe("Morpho liquidation backstop", () => {
  const params = {
    loanToken: ALICE,
    collateralToken: ALICE,
    oracle: ALICE,
    irm: ALICE,
    lltv: 860_000_000_000_000_000n,
  };
  const position = (over: Partial<MorphoPosition> = {}): MorphoPosition => ({
    lineId: 0,
    marketParams: params,
    borrower: ALICE,
    borrowShares: 70_000n * WAD * 10n ** 6n,
    collateral: WAD, // 1 BTC
    totalBorrowAssets: 70_000n * WAD,
    totalBorrowShares: 70_000n * WAD * 10n ** 6n,
    oraclePrice: 100_000n * WAD * WAD, // $100k: max borrow 86k, healthy
    ...over,
  });

  it("leaves healthy positions alone", () => {
    expect(sizeMorphoLiquidation(position())).toBeNull();
    expect(sizeMorphoLiquidation(position({ oraclePrice: null }))).toBeNull();
  });

  it("repays all shares when the collateral covers the incentive", () => {
    // $80k: max borrow 68.8k < 70k debt; seizing 70k * 1.0438 / 80k = 0.913 BTC <= 1 BTC.
    const size = sizeMorphoLiquidation(position({ oraclePrice: 80_000n * WAD * WAD }));
    expect(size).toEqual({ seizedAssets: 0n, repaidShares: 70_000n * WAD * 10n ** 6n });
  });

  it("seizes all collateral when it cannot cover the debt", () => {
    const size = sizeMorphoLiquidation(position({ oraclePrice: 60_000n * WAD * WAD }));
    expect(size).toEqual({ seizedAssets: WAD, repaidShares: 0n });
  });

  it("runs only when enabled", () => {
    const s = snapshot({ morphoPositions: [position({ oraclePrice: 60_000n * WAD * WAD })] });
    expect(decide(s)).toEqual([]);
    expect(decide(s, { morphoLiquidations: true })).toEqual([
      expect.objectContaining({ kind: "liquidateMorpho", borrower: ALICE, seizedAssets: WAD }),
    ]);
  });
});

describe("decide", () => {
  it("orders auctions, losses, pokes, then the rebalance", () => {
    const s = snapshot({
      lastRebalanceEpoch: EPOCH - L,
      ballots: [ballot()],
      loans: [{ loanId: 9n, state: "Active", liquidatable: true, reason: "ltv" }],
    });
    s.lines[1]!.uncoveredLoss = 5n;
    expect(decide(s).map((a) => a.kind)).toEqual(["startAuction", "cover", "poke", "rebalance"]);
  });

  it("is idle mid-epoch with nothing to do", () => {
    expect(decide(snapshot({ now: EPOCH + 1800n }))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { MULTICALL3_ADDRESS } from "../src/chains.js";
import { stringifyJson, toJsonSafe } from "../src/json.js";
import { WAD } from "../src/math.js";
import { ALICE, BOB, FIXTURE_EPOCH, createSuretyFixture, fakeAddress } from "../src/testing/index.js";

const e18 = (x: number) => BigInt(x) * WAD;

describe("getEpoch", () => {
  it("reads the epoch clock and rebalance state", async () => {
    const { client } = createSuretyFixture();
    const epoch = await client.getEpoch();
    expect(epoch.currentEpoch).toBe(FIXTURE_EPOCH);
    expect(epoch.epochLength).toBe(3600n);
    expect(epoch.nextFlip).toBe(FIXTURE_EPOCH + 3600n);
    expect(epoch.secondsToFlip).toBe(1800n);
    expect(epoch.lastClosedEpoch).toBe(FIXTURE_EPOCH - 3600n);
    expect(epoch.activeTallyEpoch).toBe(FIXTURE_EPOCH - 3600n);
    expect(epoch.rebalanceDue).toBe(false);
    expect(epoch.season).toBe(4n);
  });

  it("flags a due rebalance after the flip", async () => {
    const { client } = createSuretyFixture({ patch: (s) => (s.lastRebalanceEpoch = FIXTURE_EPOCH - 3600n) });
    expect((await client.getEpoch()).rebalanceDue).toBe(true);
  });
});

describe("getBoard", () => {
  it("decodes every line with votes, allocation, rates and cover", async () => {
    const { client, chain } = createSuretyFixture();
    const board = await client.getBoard();

    // All reads went through Multicall3.
    const calls = chain.requests.filter((r) => r.method === "eth_call");
    expect(calls.length).toBeGreaterThan(0);
    for (const r of calls) expect((r.params[0] as { to: string }).to.toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase());

    expect(board.lines).toHaveLength(2);
    const [morpho, ve] = board.lines;

    expect(morpho!.kind).toBe("Morpho");
    expect(morpho!.marketParams?.lltv).toBe(860_000_000_000_000_000n);
    expect(morpho!.votes.current).toBe(6n * 10n ** 17n);
    expect(morpho!.votes.currentShare).toBeCloseTo(0.6, 12);
    expect(morpho!.votes.lastClosedShare).toBeCloseTo(0.5, 12);
    expect(morpho!.allocation).toBe(e18(5_400));
    expect(morpho!.target).toBe(e18(5_400));
    expect(morpho!.utilizationWad).toBe(75n * 10n ** 16n);
    expect(morpho!.borrowRateSource).toBe("irm");
    expect(morpho!.borrowApy).toBeCloseTo(Math.expm1(0.05), 6);
    expect(morpho!.supplyApy).toBeCloseTo(Math.expm1(0.05) * 0.75, 6);
    expect(morpho!.incentives).toEqual({ shares: e18(99), assets: e18(100) });
    expect(morpho!.oracleLive).toBe(true);

    expect(ve!.kind).toBe("VeBTC");
    expect(ve!.paused).toBe(false);
    // Debt 2,500 over cash 1,800 + debt.
    const util = (e18(2_500) * WAD) / e18(4_300);
    expect(ve!.utilizationWad).toBe(util);
    const apr = 0.02 + (0.06 * Number(util)) / 1e18 / 0.8;
    expect(ve!.borrowApy).toBeCloseTo(Math.expm1(apr), 9);
    expect(ve!.uncoveredLoss).toBe(e18(10));
    expect(ve!.coverCapacity).toBe(e18(40));

    expect(board.totals.currentVotes).toBe(10n ** 18n);
    expect(board.vault.totalAssets).toBe(e18(10_000));
    expect(board.vault.idle).toBe(e18(1_000));
    expect(board.vault.symbol).toBe("srMUSD");
    expect(board.vault.sharePrice).toBe((WAD * 10_000n) / 9_900n);
    const gross = 0.54 * morpho!.supplyApy! + 0.36 * ve!.supplyApy!;
    expect(board.vault.supplyApy).toBeCloseTo(gross * 0.9, 9);
  });

  it("derives the Morpho rate when the IRM view is unavailable", async () => {
    const { client } = createSuretyFixture({ patch: (s) => (s.morphoBorrowRate = null) });
    const [morpho] = (await client.getBoard()).lines;
    expect(morpho!.borrowRateSource).toBe("derived");
    expect(morpho!.borrowApy).toBeGreaterThan(0);
  });

  it("reports a stale oracle instead of failing", async () => {
    const { client } = createSuretyFixture({ patch: (s) => (s.priceWad = null) });
    const board = await client.getBoard();
    expect(board.lines.map((l) => l.oracleLive)).toEqual([false, false]);
  });

  it("gives the same board through individual eth_calls", async () => {
    const viaMulticall = await createSuretyFixture().client.getBoard();
    const { client, chain } = createSuretyFixture({ multicall: false });
    const direct = await client.getBoard();
    expect(stringifyJson(direct)).toBe(stringifyJson(viaMulticall));
    expect(chain.requests.some((r) => (r.params[0] as { to?: string })?.to === MULTICALL3_ADDRESS)).toBe(false);
  });
});

describe("ballots and positions", () => {
  it("reads a ballot cast this epoch", async () => {
    const { client } = createSuretyFixture();
    const ballot = await client.getBallot(7);
    expect(ballot.lineIds).toEqual([0, 1]);
    expect(ballot.weightsBps).toEqual([6000, 4000]);
    expect(ballot.castThisEpoch).toBe(true);
    expect(ballot.pokeable).toBe(false);
    expect(ballot.powerAtEpochStart).toBe(25n * 10n ** 15n);
    expect(ballot.votesThisEpoch).toEqual([
      { lineId: 0, votes: 6n * 10n ** 16n },
      { lineId: 1, votes: 4n * 10n ** 16n },
    ]);
  });

  it("marks a ballot from an earlier epoch as pokeable", async () => {
    const { client } = createSuretyFixture();
    const ballot = await client.getBallot(9n);
    expect(ballot.pokeable).toBe(true);
    expect(ballot.castThisEpoch).toBe(false);
  });

  it("lists owned and escrowed veBTC NFTs", async () => {
    const { client } = createSuretyFixture();
    const positions = await client.getVeBTCPositions(ALICE);
    expect(positions.map((p) => [p.tokenId, p.escrowed, p.loanId])).toEqual([
      [7n, false, null],
      [9n, false, null],
      [11n, true, 1n],
    ]);
    const [seven, nine] = positions;
    // 0.05 BTC at $80k = $4,000; 50% = 2,000, capped by line cash 1,800.
    expect(seven!.maxBorrow).toBe(e18(1_800));
    // Permanent: 0.02 BTC = $1,600 at 40%.
    expect(nine!.maxBorrow).toBe(e18(640));
    expect(nine!.lock.isPermanent).toBe(true);
    expect(nine!.votedOnMezo).toBe(true);
    expect(seven!.ballotEpoch).toBe(FIXTURE_EPOCH);

    const ownedOnly = await client.getVeBTCPositions(ALICE, { includeEscrowed: false });
    expect(ownedOnly).toHaveLength(2);
  });
});

describe("getCohorts", () => {
  it("classifies claimable, at-risk and maturing cohorts", async () => {
    const { client } = createSuretyFixture();
    const result = await client.getCohorts(7);
    const byKey = Object.fromEntries(result.cohorts.map((c) => [`${c.lineId}:${c.epoch}`, c]));

    const matured = byKey[`0:${FIXTURE_EPOCH - 6n * 3600n}`]!;
    expect(matured.status).toBe("claimable");
    expect(matured.shares).toBe(e18(5));

    const prev = byKey[`1:${FIXTURE_EPOCH - 3600n}`]!;
    expect(prev.status).toBe("at-risk"); // line 1 has an uncovered loss
    expect(prev.shares).toBe(e18(4));

    expect(byKey[`0:${FIXTURE_EPOCH}`]!.status).toBe("maturing");
    expect(result.totals.claimableAssets).toBe((e18(5) * 10_000n) / 9_900n);
    expect(result.totals.atRiskAssets).toBe((e18(4) * 10_000n) / 9_900n);
  });

  it("drops claimed cohorts to zero", async () => {
    const epoch = FIXTURE_EPOCH - 6n * 3600n;
    const { client } = createSuretyFixture({ patch: (s) => (s.pool.claimed[`7:0:${epoch}`] = true) });
    const cohort = (await client.getCohorts(7)).cohorts.find((c) => c.epoch === epoch)!;
    expect(cohort.status).toBe("claimed");
    expect(cohort.assets).toBe(0n);
  });
});

describe("loans", () => {
  it("finds a borrower's loans from Opened logs in 10,000-block windows", async () => {
    const { client, chain } = createSuretyFixture();
    const loans = await client.getLoans(ALICE);
    expect(loans).toHaveLength(1);
    const loan = loans[0]!;
    expect(loan.loanId).toBe(1n);
    expect(loan.state).toBe("Active");
    expect(loan.debt).toBe(e18(1_500));
    expect(loan.collateralValue).toBe(e18(4_000));
    expect(loan.ltvBps).toBe(3750n);
    expect(loan.liquidatable).toBe(false);
    expect(loan.maxLtvBps).toBe(5000n);
    expect(loan.maturity).toBe(loan.lock.end);
    // 1,500 / (0.05 BTC * 70%) = $42,857.14...
    expect(Number(loan.liquidationPriceWad! / 10n ** 14n) / 1e4).toBeCloseTo(42_857.1429, 3);

    const windows = chain.requests.filter((r) => r.method === "eth_getLogs");
    // Blocks 16,300,000 .. 16,400,000 inclusive.
    expect(windows).toHaveLength(11);
    const first = windows[0]!.params[0] as { fromBlock: string; toBlock: string };
    expect(BigInt(first.toBlock) - BigInt(first.fromBlock)).toBe(9_999n);

    expect(await client.getLoans(fakeAddress(0xdead))).toEqual([]);
  });

  it("flags a loan past its liquidation LTV", async () => {
    const { client } = createSuretyFixture({ patch: (s) => (s.priceWad = e18(40_000)) });
    const [loan] = await client.getLoans(ALICE);
    expect(loan!.ltvBps).toBe(7500n);
    expect(loan!.liquidatable).toBe(true);
    expect(loan!.liquidationReason).toBe("ltv");
  });

  it("cannot tell liquidatability while the oracle is down", async () => {
    const { client } = createSuretyFixture({ patch: (s) => (s.priceWad = null) });
    const loan = await client.getLoan(1);
    expect(loan!.collateralValue).toBeNull();
    expect(loan!.liquidatable).toBeNull();
  });

  it("lists live auctions with the decayed price", async () => {
    const { client } = createSuretyFixture();
    const auctions = await client.getAuctions();
    expect(auctions).toHaveLength(1);
    const a = auctions[0]!;
    expect(a.borrower).toBe(BOB);
    expect(a.state).toBe("Auction");
    // $1,280 of collateral, half-way through a 600 s decay to 70%.
    expect(a.auctionPrice).toBe(e18(1_088));
    expect(a.floorPrice).toBe(e18(896));
    expect(a.auctionEndsAt).toBe(a.auctionStart! + 600n);
  });
});

describe("quoteVeBTCBorrow", () => {
  it("quotes the max borrow against a timed lock", async () => {
    const { client } = createSuretyFixture();
    const q = await client.quoteVeBTCBorrow(7);
    expect(q.eligible).toBe(true);
    expect(q.reasons).toEqual([]);
    expect(q.collateralValue).toBe(e18(4_000));
    expect(q.maxBorrow).toBe(e18(1_800));
    expect(q.amount).toBe(e18(1_800));
    expect(q.ltvBps).toBe(4500n);
    expect(q.maxLtvBps).toBe(5000n);
    expect(q.borrowAprAfter).toBeCloseTo(0.6, 12); // borrowing all cash -> 100% utilisation
    expect(q.maturity).toBe(q.lock.end);
  });

  it("quotes a smaller amount and rejects one above the max", async () => {
    const { client } = createSuretyFixture();
    const q = await client.quoteVeBTCBorrow(7, e18(500));
    expect(q.ltvBps).toBe(1250n);
    expect(q.eligible).toBe(true);
    const tooMuch = await client.quoteVeBTCBorrow(7, e18(5_000));
    expect(tooMuch.eligible).toBe(false);
    expect(tooMuch.reasons).toContain("above-max");
  });

  it("explains why an NFT cannot be borrowed against", async () => {
    const { client } = createSuretyFixture({ patch: (s) => (s.priceWad = null) });
    expect((await client.quoteVeBTCBorrow(11)).reasons).toEqual(
      expect.arrayContaining(["escrowed", "oracle-unavailable"]),
    );
    const expiring = createSuretyFixture({ patch: (s) => (s.nfts["7"]!.lock.end = s.now + 60n) });
    expect((await expiring.client.quoteVeBTCBorrow(7)).reasons).toContain("term-too-short");
  });
});

describe("JSON output", () => {
  it("turns bigints into strings", () => {
    expect(toJsonSafe({ a: 1n, b: [2n], c: { d: 3n, e: "x" } })).toEqual({ a: "1", b: ["2"], c: { d: "3", e: "x" } });
  });
});

import { decodeFunctionData, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import exampleV2 from "../src/deployments/example.v2.31611.json";
import { savingsAdapterAbi, shareMarketAbi, stressedPegSourceAbi, veBTCCreditLineAbi } from "../src/abis/index.js";
import {
  exampleDeployment,
  exampleDeploymentV2,
  getDeployment,
  getDeployments,
  isV2Deployment,
  parseDeployment,
} from "../src/deployments/index.js";
import {
  amountToBorrowFor,
  bidOutcome,
  borrowerReceives,
  btcInMusdWad,
  liquidationFeeSplit,
  managementFeeAprWad,
  originationFee,
  pegDivisorWad,
  pegHealth,
  shareFillPrice,
  WAD,
} from "../src/math.js";
import {
  ALICE,
  BOB,
  FIXTURE_BRIBE,
  FIXTURE_FEES,
  FIXTURE_POOL,
  FIXTURE_USDC,
  createSuretyFixture,
  fakeAddress,
} from "../src/testing/index.js";

const e18 = (x: number) => BigInt(x) * WAD;
const params = { minSources: 2, maxSpreadBps: 500, bandBps: 300 };
const reading = (x: bigint | null) => ({ ok: x !== null, musdUsdWad: x });

describe("deployment schema v2", () => {
  it("parses a v2 file with the peg, savings, fees and Sponsor", () => {
    const d = exampleDeploymentV2;
    expect(d.version).toBe(2);
    expect(isV2Deployment(d)).toBe(true);
    expect(d.contracts.musdPeg).toMatch(/^0x5e/);
    expect(d.contracts.btcMusdSource).toBe(d.contracts.priceSource);
    expect(d.contracts.savingsAdapter).toBeDefined();
    expect(d.contracts.shareMarket).toBeDefined();
    expect(d.contracts.sponsor).toBeDefined();
    expect(d.contracts.stressedPegSource).toBeDefined();
    expect(d.external.smusd).toBe("0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16");
    expect(d.pegSources).toEqual([{ kind: "Stressed", address: d.contracts.stressedPegSource, base: zeroAddress }]);
    expect(d.peg).toEqual({ minSources: 1, maxSpreadBps: 1000, bandBps: 300, maxPremiumBps: 300 });
    expect(d.lineParams.floorBps).toBe(8500);
    expect(d.lineParams.originationFeeBps).toBe(25);
    expect(d.fees.managementFee).toBe(63_419_583n);
    expect(d.caps.savings).toBe(10n ** 27n);
    expect(d.sponsorKit?.fundedBtc).toBe(6n * 10n ** 15n);
    expect(d.morphoMarketId).toBe(d.lines[0]!.marketId);
    expect(d.lines[0]!.marketParams!.lltv).toBe(770_000_000_000_000_000n);
    expect(d.proof.txs).toEqual([]);
  });

  it("reads a file without a version as v1", () => {
    expect(exampleDeployment.version).toBe(1);
    expect(isV2Deployment(exampleDeployment)).toBe(false);
    expect(exampleDeployment.contracts.musdPeg).toBeUndefined();
  });

  it("requires every v2 key in a v2 file", () => {
    const noPeg = structuredClone(exampleV2) as Record<string, unknown>;
    delete (noPeg.contracts as Record<string, unknown>).musdPeg;
    expect(() => parseDeployment(noPeg)).toThrow(/contracts\.musdPeg/);

    const badKind = structuredClone(exampleV2) as { pegSources: { kind: string }[] };
    badKind.pegSources[0]!.kind = "Oracle";
    expect(() => parseDeployment(badKind)).toThrow(/pegSources\[0\]\.kind/);

    const noFees = structuredClone(exampleV2) as Record<string, unknown>;
    delete noFees.fees;
    expect(() => parseDeployment(noFees)).toThrow(/fees/);

    const future = structuredClone(exampleV2) as Record<string, unknown>;
    future.version = 3;
    expect(() => parseDeployment(future)).toThrow(/version/);

    const noPremium = structuredClone(exampleV2) as { peg: Record<string, unknown> };
    delete noPremium.peg.maxPremiumBps;
    expect(() => parseDeployment(noPremium)).toThrow(/peg\.maxPremiumBps/);
  });

  it("reads the CL floors and basic-pool age limits of a mainnet peg", () => {
    const mainnet = structuredClone(exampleV2) as { chainId: number; pegSources: Record<string, unknown>[] };
    mainnet.pegSources = [
      { kind: "ClTwap", address: "0x5e00000000000000000000000000000000000020", pool: "0xCC372B7E15535aB225fe17c1075831D38ef7aC1a", window: "1800", minLiquidity: "10000000000000000000" },
      { kind: "StableTwap", address: "0x5e00000000000000000000000000000000000021", pool: "0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356", granularity: "2", maxAge: "21600" },
      { kind: "BtcCross", address: "0x5e00000000000000000000000000000000000022", pool: "0x9CBc1537d255768b431488305b1C7EFc2ac95022", window: "1800", minLiquidity: "200000000000000000000", btcUsd: "0x5e0000000000000000000000000000000000000e" },
    ];
    const d = parseDeployment(mainnet);
    expect(d.pegSources![0]).toMatchObject({ kind: "ClTwap", window: 1800, minLiquidity: 10n ** 19n });
    expect(d.pegSources![1]).toMatchObject({ kind: "StableTwap", granularity: 2, maxAge: 21_600 });
    expect(d.pegSources![2]!.minLiquidity).toBe(2n * 10n ** 20n);

    delete mainnet.pegSources[0]!.minLiquidity;
    expect(() => parseDeployment(mainnet)).toThrow(/pegSources\[0\]\.minLiquidity/);
  });

  it("keeps the v1 deployments bundled, with their proof", () => {
    for (const chainId of [31611, 31612]) {
      const v1 = getDeployment(chainId, { version: 1 });
      expect(v1?.version).toBe(1);
      expect(v1?.chainId).toBe(chainId);
      // Without a current file the chain falls back to its newest archived deployment.
      const current = getDeployment(chainId);
      expect(current).toBeDefined();
      expect(getDeployments(chainId).map((d) => d.version)[0]).toBe(current!.version);
    }
    expect(getDeployment(31611, { version: 1 })!.proof.txs.length).toBeGreaterThan(20);
    expect(getDeployment(31611, { version: 1 })!.contracts.vault).toBe("0xdb2526679a0F285aEF9B31507364c4DD8CE59481");
  });
});

describe("peg math", () => {
  it("takes the median of the usable readings, as MusdPeg does", () => {
    const h = pegHealth([reading(991_440_000_000_000_000n), reading(null), reading(986_040_000_000_000_000n), reading(1_002_460_000_000_000_000n)], params);
    expect(h.count).toBe(3);
    expect(h.medianWad).toBe(991_440_000_000_000_000n);
    expect(h.lowWad).toBe(986_040_000_000_000_000n);
    expect(h.highWad).toBe(1_002_460_000_000_000_000n);
    expect(h.spreadBps).toBe(165n);
    expect(h.offPegBps).toBe(85n);
    expect(h.healthy).toBe(true);
    expect(h.issues).toEqual([]);
  });

  it("averages the middle two of an even count, rounding down", () => {
    const h = pegHealth([reading(3n), reading(10n ** 18n), reading(10n ** 18n + 3n), reading(2n * 10n ** 18n)], {
      ...params,
      maxSpreadBps: 2000,
      bandBps: 1000,
    });
    expect(h.medianWad).toBe(10n ** 18n + 1n);
  });

  it("names why the peg is unhealthy", () => {
    expect(pegHealth([reading(WAD)], params).issues).toEqual(["too-few-sources"]);
    expect(pegHealth([], params)).toMatchObject({ count: 0, medianWad: null, healthy: false, available: false });
    expect(pegHealth([reading(e18(1)), reading(1_060_000_000_000_000_000n)], params).issues).toEqual([
      "sources-disagree",
    ]);
    const depeg = pegHealth([reading(950_000_000_000_000_000n), reading(955_000_000_000_000_000n)], params);
    expect(depeg.issues).toEqual(["off-peg"]);
    expect(depeg.available).toBe(true);
    // Exactly on the band edge is still healthy.
    expect(pegHealth([reading(970_000_000_000_000_000n), reading(970_000_000_000_000_000n)], params).healthy).toBe(
      true,
    );
  });

  it("never values BTC above BTC/USD, and caps the MUSD premium", () => {
    expect(btcInMusdWad(e18(80_000), 990_000_000_000_000_000n)).toBe(e18(80_000));
    expect(btcInMusdWad(e18(80_000), null)).toBe(e18(80_000));
    expect(btcInMusdWad(e18(80_000), 1_010_000_000_000_000_000n)).toBe((e18(80_000) * WAD) / 1_010_000_000_000_000_000n);
    // A pushed peg divides by at most $1.03.
    expect(pegDivisorWad(1_200_000_000_000_000_000n, 300)).toBe(1_030_000_000_000_000_000n);
    expect(btcInMusdWad(e18(80_000), 1_200_000_000_000_000_000n, 300)).toBe((e18(80_000) * WAD) / 1_030_000_000_000_000_000n);
    expect(pegDivisorWad(null, 300)).toBe(WAD);
    expect(pegDivisorWad(980_000_000_000_000_000n, 300)).toBe(WAD);
  });
});

describe("fee math", () => {
  it("takes the origination fee out of what the borrower receives", () => {
    expect(originationFee(e18(100), 25)).toBe(e18(1) / 4n);
    expect(borrowerReceives(e18(100), 25)).toBe(e18(100) - e18(1) / 4n);
    expect(originationFee(399n, 25)).toBe(0n);
    const amount = amountToBorrowFor(e18(50), 25);
    expect(borrowerReceives(amount, 25)).toBeGreaterThanOrEqual(e18(50));
    expect(borrowerReceives(amount - 1n, 25)).toBeLessThan(e18(50));
    expect(amountToBorrowFor(e18(50), 0)).toBe(e18(50));
  });

  it("splits the liquidation fee 80 / 10 / 10 and adds up exactly", () => {
    const split = liquidationFeeSplit(e18(3), 2000, 5000);
    expect(split).toEqual({ toLenders: e18(3) - e18(6) / 10n, toTreasury: e18(3) / 10n, toKeeper: e18(3) / 10n });
    const odd = liquidationFeeSplit(12_345n, 2000, 5000);
    expect(odd.toLenders + odd.toTreasury + odd.toKeeper).toBe(12_345n);
  });

  it("books a bid like the line does", () => {
    const covered = bidOutcome({ price: e18(110), debt: e18(100), liqFeeBps: 300, protocolShareBps: 2000, keeperShareBps: 5000 });
    expect(covered).toMatchObject({ toLine: e18(103), fee: e18(3), surplus: e18(7), shortfall: 0n });
    expect(covered.toTreasury + covered.toKeeper + covered.toLenders).toBe(e18(3));
    const short = bidOutcome({ price: e18(90), debt: e18(100), liqFeeBps: 300, protocolShareBps: 2000, keeperShareBps: 5000 });
    expect(short).toMatchObject({ toLine: e18(90), fee: 0n, surplus: 0n, shortfall: e18(10), toKeeper: 0n });
  });

  it("states the management fee as a yearly rate", () => {
    // 63,419,583 WAD per second is 0.19999999987% a year.
    const apr = managementFeeAprWad(63_419_583n);
    expect(apr).toBe(1_999_999_969_488_000n);
    expect(Number(apr) / 1e18).toBeCloseTo(0.002, 9);
  });

  it("prices a ShareMarket fill in the seller's favour", () => {
    expect(shareFillPrice(e18(100), 200, 10)).toEqual({ assets: e18(98), fee: e18(98) / 1000n, sellerReceives: e18(98) - e18(98) / 1000n });
    expect(shareFillPrice(1n, 1, 10).assets).toBe(1n); // rounded up
  });
});

describe("v2 reads", () => {
  it("reads the peg, its sources and the BTC price over it", async () => {
    const { client, deployment } = createSuretyFixture({ version: 2 });
    const peg = await client.getPeg();
    expect(peg.address).toBe(deployment.contracts.musdPeg);
    expect(peg.sources.map((s) => s.kind)).toEqual(["ClTwap", "StableTwap", "Stressed"]);
    expect(peg.sources[0]!.pool).toBe(fakeAddress(0x30));
    expect(peg.count).toBe(3);
    expect(peg.medianWad).toBe(991_440_000_000_000_000n);
    expect(peg.healthy).toBe(true);
    expect(peg.healthyOnChain).toBe(true);
    expect(peg.allocatorGateOpen).toBe(true);
    expect(peg.btcUsdWad).toBe(e18(80_000));
    // MUSD under $1 is ignored: BTC is never valued above BTC/USD.
    expect(peg.btcMusdWad).toBe(e18(80_000));
    expect(peg.stress).toEqual({ active: false, musdUsdWad: 0n, endsAt: 0n });
    expect(peg.linePegCheck).toBe(true);
    expect(peg.maxPremiumBps).toBe(300);
    expect(peg.divisorWad).toBe(WAD);
  });

  it("shows the CL source's window liquidity and the basic pool's observation age", async () => {
    const { client } = createSuretyFixture({
      version: 2,
      patch: (s) => {
        s.peg.windowLiquidity = 5n * 10n ** 18n;
        s.peg.poolObservedAt = s.now - 7_200n;
        s.peg.lineCheck = false;
      },
    });
    const peg = await client.getPeg();
    const [cl, stable, stressed] = peg.sources;
    expect(cl).toMatchObject({ windowLiquidity: 5n * 10n ** 18n, minLiquidity: 10n ** 19n, observationAge: null });
    expect(stable).toMatchObject({ observationAge: 7_200n, maxAge: 21_600n, windowLiquidity: null });
    expect(stressed).toMatchObject({ windowLiquidity: null, observationAge: null, maxAge: null });
    expect(peg.linePegCheck).toBe(false);
  });

  it("caps what a pushed peg can take off the BTC price", async () => {
    const { client } = createSuretyFixture({
      version: 2,
      patch: (s) => {
        s.peg.readings = [1_020_000_000_000_000_000n, 1_025_000_000_000_000_000n, 1_022_000_000_000_000_000n];
      },
    });
    const peg = await client.getPeg();
    expect(peg.healthy).toBe(true);
    expect(peg.divisorWad).toBe(1_022_000_000_000_000_000n);
    expect(peg.btcMusdWad).toBe((e18(80_000) * WAD) / 1_022_000_000_000_000_000n);
  });

  it("shows a depeg on the stressed source and blocks the borrow quote", async () => {
    const { client } = createSuretyFixture({
      version: 2,
      patch: (s) => {
        s.peg.readings = [940_000_000_000_000_000n, 935_000_000_000_000_000n, 900_000_000_000_000_000n];
        s.peg.stress = { musdUsdWad: 900_000_000_000_000_000n, endsAt: s.now + 3600n };
      },
    });
    const peg = await client.getPeg();
    expect(peg.healthy).toBe(false);
    expect(peg.issues).toContain("off-peg");
    expect(peg.healthyOnChain).toBe(false);
    expect(peg.allocatorGateOpen).toBe(false);
    expect(peg.stress?.active).toBe(true);
    const quote = await client.quoteVeBTCBorrow(7n);
    expect(quote.reasons).toContain("peg-unhealthy");
    expect(quote.eligible).toBe(false);
  });

  it("quotes the origination fee on a v2 line and none on v1", async () => {
    const v2 = createSuretyFixture({ version: 2 });
    const quote = await v2.client.quoteVeBTCBorrow(7n, e18(100));
    expect(quote.originationFee).toBe(e18(1) / 4n);
    expect(quote.receives).toBe(e18(100) - e18(1) / 4n);
    expect(quote.liqLtvBps).toBe(6500n);

    const v1 = createSuretyFixture();
    const old = await v1.client.quoteVeBTCBorrow(7n, e18(100));
    expect(old.originationFee).toBe(0n);
    expect(old.receives).toBe(e18(100));
    expect(old.reasons).not.toContain("peg-unhealthy");
  });

  it("reads the fee schedule", async () => {
    const { client } = createSuretyFixture({ version: 2 });
    const fees = await client.getFees();
    expect(fees.line.originationFeeBps).toBe(25);
    expect(fees.line.protocolShareBps).toBe(2000);
    expect(fees.line.keeperShareBps).toBe(5000);
    expect(fees.line.liqFeeBps).toBe(300);
    expect(fees.treasury).toBe(fakeAddress(0x16));
    expect(fees.managementFee).toBe(63_419_583n);
    expect(fees.managementFeeAprWad).toBe(63_419_583n * 31_536_000n);
    expect(fees.managementFeeRecipient).toBe(fakeAddress(0x16));
    expect(fees.performanceFee).toBe(10n ** 17n);
    expect(fees.shareMarketFeeBps).toBe(10);
  });

  it("counts savings in the vault's idle MUSD", async () => {
    const { client } = createSuretyFixture({ version: 2 });
    const savings = await client.getSavings();
    expect(savings.vaultIdle).toBe(e18(1_000));
    expect(savings.parked).toBe(e18(400));
    expect(savings.idle).toBe(e18(1_400));
    expect(savings.parking).toBe(true);
    expect(savings.liquidityAdapter).toBe(savings.adapter);
    expect(savings.claimableYield).toBe(e18(1) / 100n);

    const board = await client.getBoard();
    expect(board.vault.idleInVault).toBe(e18(1_000));
    expect(board.vault.parked).toBe(e18(400));
    expect(board.vault.idle).toBe(e18(1_400));

    const v1 = await createSuretyFixture().client.getBoard();
    expect(v1.vault.idle).toBe(e18(1_000));
    expect(v1.vault.parked).toBe(0n);
  });

  it("lists ShareMarket offers priced at the live share price", async () => {
    const { client } = createSuretyFixture({ version: 2 });
    const market = await client.getShareMarket();
    expect(market.feeBps).toBe(10);
    expect(market.isOpen).toBe(true);
    expect(market.openCount).toBe(2n);
    const [first, second] = market.listings;
    // 10,000 MUSD over 9,900 srMUSD: 100 shares are worth 101.0101… MUSD.
    const value = (e18(100) * e18(10_000)) / e18(9_900);
    expect(first).toMatchObject({ id: 1n, seller: ALICE, discountBps: 200, shares: e18(100), value });
    expect(first!.price).toBe(shareFillPrice(value, 200, 10).assets);
    expect(second!.seller).toBe(BOB);
    expect(market.best?.id).toBe(1n);

    const quote = await client.quoteShareFill(1n, e18(10));
    expect(quote.filled).toBe(e18(10));
    expect(quote.assets).toBe(shareFillPrice((e18(10) * e18(10_000)) / e18(9_900), 200, 10).assets);
    expect(quote.sellerReceives).toBe(quote.assets - quote.fee);

    expect((await client.getShareListingsOf(BOB)).map((l) => l.id)).toEqual([3n]);
  });

  it("reads the Sponsor's ledger of starter kits", async () => {
    const { client } = createSuretyFixture({ version: 2 });
    const ledger = await client.getSponsorLedger();
    expect(ledger.kitsIssued).toBe(1n);
    expect(ledger.kitsLeft).toBe(4n);
    expect(ledger.kit).toEqual({ btcGas: 5n * 10n ** 13n, lockAmount: 10n ** 15n, musd: e18(50), lockDuration: 2_419_200n });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ user: fakeAddress(0xc0de), tokenId: 2001n, musd: e18(50) });
  });

  it("plans a harvest from the escrow's votes, earned rewards and rebase", async () => {
    const { client } = createSuretyFixture({
      version: 2,
      patch: (s) => {
        s.loans[0]!.autoRepay = true;
      },
    });
    const plan = await client.getHarvestPlan(1n);
    expect(plan.tokenId).toBe(11n);
    expect(plan.autoRepay).toBe(true);
    expect(plan.pools).toEqual([FIXTURE_POOL]);
    // MUSD on both contracts earned nothing on the fee side; veBTC is never listed.
    expect(plan.rewards).toEqual([FIXTURE_FEES, FIXTURE_BRIBE]);
    expect(plan.tokens).toEqual([[FIXTURE_USDC], [fakeAddress(0x101)]]);
    expect(plan.claimableRebase).toBe(1_000n);
    expect(plan.worthHarvesting).toBe(true);

    const loans = await client.listLoans();
    expect(loans[0]!.autoRepay).toBe(true);
    expect(loans[1]!.autoRepay).toBe(false);
  });

  it("finds nothing to harvest on an NFT that votes nowhere", async () => {
    const { client } = createSuretyFixture({ version: 2, patch: (s) => (s.mezo.rebase = {}) });
    const plan = await client.getHarvestPlan(2n);
    expect(plan.pools).toEqual([]);
    expect(plan.rewards).toEqual([]);
    expect(plan.worthHarvesting).toBe(false);
  });

  it("refuses v2 reads on a v1 deployment", async () => {
    const { client } = createSuretyFixture();
    await expect(client.getPeg()).rejects.toThrow(/v2 deployment/);
    await expect(client.getShareMarket()).rejects.toThrow(/v2 deployment/);
    expect(() => client.buildSavingsHarvest()).toThrow(/savings adapter/);
  });

  it("reads v1 loans through the v1 ABI", async () => {
    const { client } = createSuretyFixture();
    const loans = await client.listLoans();
    expect(loans).toHaveLength(2);
    expect(loans[0]!.autoRepay).toBe(false);
    expect(loans[0]!.keeper).toBeNull();
  });
});

describe("v2 builders", () => {
  const { client, deployment } = createSuretyFixture({ version: 2 });
  const d = deployment;

  it("builds auto-repay and harvest calls on the line", () => {
    const on = client.buildSetAutoRepay({ loanId: 3, enabled: true });
    expect(on.to).toBe(d.contracts.veBTCLine);
    expect(decodeFunctionData({ abi: veBTCCreditLineAbi, data: on.data })).toMatchObject({
      functionName: "setAutoRepay",
      args: [3n, true],
    });
    const harvest = client.buildHarvest({ loanId: 3, rewards: [FIXTURE_FEES], tokens: [[FIXTURE_USDC]] });
    expect(decodeFunctionData({ abi: veBTCCreditLineAbi, data: harvest.data })).toMatchObject({
      functionName: "harvest",
      args: [3n, [FIXTURE_FEES], [[FIXTURE_USDC]]],
    });
    expect(() => client.buildHarvest({ loanId: 3, rewards: [FIXTURE_FEES], tokens: [] })).toThrow(/differ in length/);
  });

  it("builds the savings harvest and the testnet peg stress", () => {
    const tx = client.buildSavingsHarvest();
    expect(tx.to).toBe(d.contracts.savingsAdapter);
    expect(decodeFunctionData({ abi: savingsAdapterAbi, data: tx.data }).functionName).toBe("harvest");
    const stress = client.buildStressPeg({ musdUsdWad: 900_000_000_000_000_000n, duration: 3600 });
    expect(stress.to).toBe(d.contracts.stressedPegSource);
    expect(decodeFunctionData({ abi: stressedPegSourceAbi, data: stress.data }).args).toEqual([
      900_000_000_000_000_000n,
      3600,
    ]);
  });

  it("builds ShareMarket list, fill and cancel with their approvals", () => {
    const [approveShares, list] = client.buildListShares({ shares: e18(5), discountBps: 150 });
    expect(approveShares!.to).toBe(d.contracts.vault);
    expect(list!.to).toBe(d.contracts.shareMarket);
    expect(decodeFunctionData({ abi: shareMarketAbi, data: list!.data }).args).toEqual([e18(5), 150]);
    expect(() => client.buildListShares({ shares: 1, discountBps: 2001 })).toThrow(/discountBps/);

    const [approveMusd, fill] = client.buildFillListing({ id: 1, shares: e18(5), maxAssets: e18(6) });
    expect(approveMusd!.to).toBe(d.external.musd);
    expect(decodeFunctionData({ abi: shareMarketAbi, data: fill!.data }).args).toEqual([1n, e18(5), e18(6)]);

    expect(decodeFunctionData({ abi: shareMarketAbi, data: client.buildCancelListing({ id: 1 }).data }).functionName).toBe(
      "cancel",
    );
    expect(
      decodeFunctionData({ abi: shareMarketAbi, data: client.buildCancelAndRedeem({ id: 1, minAssets: 7 }).data }).args,
    ).toEqual([1n, 7n]);
  });
});

import { describe, expect, it } from "vitest";

import {
  BPS,
  WAD,
  adaptiveCurveBorrowRate,
  aprToApy,
  auctionPrice,
  collateralValue,
  kinkAprAt,
  lineSupplyAprWad,
  liquidationPriceWad,
  ltvBps,
  maxBorrowFor,
  morphoLiquidationIncentiveFactor,
  morphoMaxBorrow,
  morphoSupplyApy,
  morphoToAssetsDown,
  morphoToAssetsUp,
  ratePerSecondToApy,
  ratio,
  utilizationWad,
  wadToNumber,
  weightedApy,
} from "../src/math.js";

const pct = (x: number) => (BigInt(Math.round(x * 1e6)) * WAD) / 1_000_000n;
// Plan params: base 2%, 8% at 80% utilisation, 60% at 100%.
const curve = { baseApr: pct(0.02), kinkApr: pct(0.08), maxApr: pct(0.6), kinkUtilWad: pct(0.8) };

describe("veBTC line rates (LinearKinkIrm)", () => {
  it("is the base APR at zero utilisation", () => {
    expect(kinkAprAt(curve, 0n)).toBe(curve.baseApr);
  });
  it("is the kink APR at the kink", () => {
    expect(kinkAprAt(curve, curve.kinkUtilWad)).toBe(curve.kinkApr);
  });
  it("is the max APR at and above 100%", () => {
    expect(kinkAprAt(curve, WAD)).toBe(curve.maxApr);
    expect(kinkAprAt(curve, 2n * WAD)).toBe(curve.maxApr);
  });
  it("interpolates linearly on both slopes", () => {
    expect(wadToNumber(kinkAprAt(curve, pct(0.4)))).toBeCloseTo(0.05, 12);
    expect(wadToNumber(kinkAprAt(curve, pct(0.9)))).toBeCloseTo(0.34, 12);
  });
  it("pays suppliers borrow APR times utilisation", () => {
    expect(lineSupplyAprWad(pct(0.1), pct(0.5))).toBe(pct(0.05));
  });
});

describe("APY conversion", () => {
  it("compounds a per-second rate continuously over 365 days", () => {
    const rate = pct(0.05) / 31_536_000n;
    expect(ratePerSecondToApy(rate)).toBeCloseTo(Math.expm1(0.05), 6);
  });
  it("converts an APR to its continuous APY", () => {
    expect(aprToApy(pct(0.1))).toBeCloseTo(Math.expm1(0.1), 12);
  });
  it("derives Morpho supply APY from borrow APY, utilisation and fee", () => {
    expect(morphoSupplyApy(0.1, pct(0.8), pct(0.1))).toBeCloseTo(0.072, 12);
  });
  it("weights APYs by assets", () => {
    expect(weightedApy([{ assets: 3n, apy: 0.1 }, { assets: 1n, apy: 0.02 }], 4n)).toBeCloseTo(0.08, 12);
    expect(weightedApy([], 0n)).toBe(0);
  });
});

describe("AdaptiveCurveIrm curve", () => {
  const r = pct(0.04) / 31_536_000n;
  it("is the rate at target at 90% utilisation", () => {
    expect(adaptiveCurveBorrowRate(r, pct(0.9))).toBe(r);
  });
  it("is a quarter of it at zero utilisation", () => {
    expect(adaptiveCurveBorrowRate(r, 0n)).toBe(r / 4n);
  });
  it("is four times it at full utilisation", () => {
    expect(adaptiveCurveBorrowRate(r, WAD)).toBe(r * 4n);
  });
});

describe("collateral, LTV and liquidation", () => {
  const price = 81_565_583_100_000_000_000_000n; // $81,565.5831
  it("values locked BTC at the oracle price", () => {
    expect(collateralValue(WAD, price)).toBe(price);
    expect(collateralValue(0n, price)).toBe(0n);
    expect(collateralValue(-1n, price)).toBe(0n);
  });
  it("computes LTV in bps, rounded down", () => {
    expect(ltvBps(500n, 1000n)).toBe(5000n);
    expect(ltvBps(1n, 3n)).toBe(3333n);
    expect(ltvBps(0n, 0n)).toBe(0n);
    expect(ltvBps(1n, 0n)).toBeNull();
  });
  it("caps max borrow by LTV and line cash", () => {
    expect(maxBorrowFor(1000n, 5000n, 10_000n)).toBe(500n);
    expect(maxBorrowFor(1000n, 5000n, 200n)).toBe(200n);
  });
  it("finds the BTC price where debt reaches the liquidation LTV", () => {
    const debt = 35_000n * WAD;
    const liq = liquidationPriceWad(debt, WAD, 7000n)!;
    expect(liq).toBe(50_000n * WAD);
    // At that price the loan is exactly at 70%.
    expect(ltvBps(debt, collateralValue(WAD, liq))).toBe(7000n);
    expect(liquidationPriceWad(debt, 0n, 7000n)).toBeNull();
  });
});

describe("Dutch auction price", () => {
  const value = 1_000n * WAD;
  it("starts at the full collateral value", () => {
    expect(auctionPrice(value, 0n, 600n, 7000n)).toBe(value);
  });
  it("decays linearly toward the floor", () => {
    expect(auctionPrice(value, 300n, 600n, 7000n)).toBe(850n * WAD);
  });
  it("stays at the floor after the duration", () => {
    expect(auctionPrice(value, 600n, 600n, 7000n)).toBe((value * 7000n) / BPS);
    expect(auctionPrice(value, 10_000n, 600n, 7000n)).toBe(700n * WAD);
  });
});

describe("Morpho share math", () => {
  it("rounds share conversions with virtual shares", () => {
    expect(morphoToAssetsDown(10n ** 6n, 0n, 0n)).toBe(1n);
    expect(morphoToAssetsUp(1n, 0n, 0n)).toBe(1n);
    expect(morphoToAssetsDown(1n, 0n, 0n)).toBe(0n);
  });
  it("computes the liquidation incentive factor for LLTV 86%", () => {
    const lif = morphoLiquidationIncentiveFactor(pct(0.86));
    expect(wadToNumber(lif)).toBeCloseTo(1 / (1 - 0.3 * 0.14), 12);
    expect(morphoLiquidationIncentiveFactor(0n)).toBe(115n * 10n ** 16n);
  });
  it("computes borrow capacity from collateral, price and LLTV", () => {
    const oraclePrice = 80_000n * WAD * WAD; // BTC at $80k in Morpho's 1e36 scale
    expect(morphoMaxBorrow(WAD, oraclePrice, pct(0.86))).toBe(68_800n * WAD);
  });
});

describe("small helpers", () => {
  it("ratio and utilisation", () => {
    expect(ratio(1n, 4n)).toBe(0.25);
    expect(ratio(1n, 0n)).toBe(0);
    expect(utilizationWad(3n, 4n)).toBe(pct(0.75));
    expect(utilizationWad(3n, 0n)).toBe(0n);
  });
});

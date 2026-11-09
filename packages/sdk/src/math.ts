// Pure math mirroring the on-chain formulas. Integer (bigint) results round exactly as the contracts do;
// APY figures are floats for display.

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
/** 365 days, the year both LinearKinkIrm and Morpho's AdaptiveCurveIrm use. */
export const SECONDS_PER_YEAR = 31_536_000n;

/** Morpho Blue SharesMathLib virtual shares and assets. */
export const MORPHO_VIRTUAL_SHARES = 10n ** 6n;
export const MORPHO_VIRTUAL_ASSETS = 1n;
export const MORPHO_ORACLE_PRICE_SCALE = 10n ** 36n;
const MORPHO_LIQUIDATION_CURSOR = 3n * 10n ** 17n;
const MORPHO_MAX_LIF = 115n * 10n ** 16n;

/** AdaptiveCurveIrm constants. */
const CURVE_STEEPNESS = 4n * WAD;
const TARGET_UTILIZATION = 9n * 10n ** 17n;

function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d;
}

function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d;
}

/** A WAD-scaled bigint as a float (1e18 -> 1). */
export function wadToNumber(x: bigint): number {
  const whole = x / WAD;
  const frac = x % WAD;
  return Number(whole) + Number(frac) / 1e18;
}

/** `part / total` as a float in [0, 1]; 0 when `total` is 0. */
export function ratio(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return wadToNumber((part * WAD) / total);
}

/** Debt / supply, WAD; 0 when nothing is supplied. Mirrors VeBTCCreditLine._utilization with supply = cash + debt. */
export function utilizationWad(borrowed: bigint, supplied: bigint): bigint {
  if (supplied === 0n) return 0n;
  return (borrowed * WAD) / supplied;
}

/** Continuously compounded APY of a per-second WAD rate (what Morpho's Taylor-compounded accrual approximates). */
export function ratePerSecondToApy(rateWad: bigint): number {
  return Math.expm1(wadToNumber(rateWad * SECONDS_PER_YEAR));
}

/** APY of a simple-interest APR that is compounded at every accrual (continuous limit). */
export function aprToApy(aprWad: bigint): number {
  return Math.expm1(wadToNumber(aprWad));
}

/** Supply APY of a Morpho market: borrow APY times utilisation, less the market fee. */
export function morphoSupplyApy(borrowApy: number, utilWad: bigint, feeWad: bigint): number {
  return borrowApy * wadToNumber(utilWad) * (1 - wadToNumber(feeWad));
}

/** Parameters of a LinearKinkIrm (all WAD). */
export interface KinkCurve {
  baseApr: bigint;
  kinkApr: bigint;
  maxApr: bigint;
  kinkUtilWad: bigint;
}

/** Borrow APR of a LinearKinkIrm at `utilWad`, exactly as `LinearKinkIrm.aprAt`. */
export function kinkAprAt(curve: KinkCurve, utilWad: bigint): bigint {
  if (utilWad >= WAD) return curve.maxApr;
  if (utilWad <= curve.kinkUtilWad) return curve.baseApr + ((curve.kinkApr - curve.baseApr) * utilWad) / curve.kinkUtilWad;
  return curve.kinkApr + ((curve.maxApr - curve.kinkApr) * (utilWad - curve.kinkUtilWad)) / (WAD - curve.kinkUtilWad);
}

/** Supply APR the veBTC line pays the vault: borrow APR times utilisation (interest on debt over cash + debt). */
export function lineSupplyAprWad(borrowAprWad: bigint, utilWad: bigint): bigint {
  return (borrowAprWad * utilWad) / WAD;
}

/**
 * AdaptiveCurveIrm borrow rate per second for `utilWad`, given the market's stored `rateAtTarget`. Ignores the
 * adaptation of `rateAtTarget` since the market's last update, so it is the rate as of that update; use the IRM's
 * `borrowRateView` for the live figure when it is available.
 */
export function adaptiveCurveBorrowRate(rateAtTarget: bigint, utilWad: bigint): bigint {
  const errNormFactor = utilWad > TARGET_UTILIZATION ? WAD - TARGET_UTILIZATION : TARGET_UTILIZATION;
  const err = ((utilWad - TARGET_UTILIZATION) * WAD) / errNormFactor;
  const coeff = err < 0n ? WAD - (WAD * WAD) / CURVE_STEEPNESS : CURVE_STEEPNESS - WAD;
  return (((coeff * err) / WAD + WAD) * rateAtTarget) / WAD;
}

/** MUSD value of a veBTC lock: `amount * priceWad / 1e18`, zero for empty locks (VeBTCCreditLine._collateralValue). */
export function collateralValue(lockedAmount: bigint, priceWad: bigint): bigint {
  if (lockedAmount <= 0n) return 0n;
  return (lockedAmount * priceWad) / WAD;
}

/** LTV in bps, rounded down; `null` when there is debt but no collateral value (unbounded). */
export function ltvBps(debt: bigint, value: bigint): bigint | null {
  if (debt === 0n) return 0n;
  if (value === 0n) return null;
  return (debt * BPS) / value;
}

/** Largest principal allowed at `maxLtvBps`, capped by the line's cash (VeBTCCreditLine.maxBorrow). */
export function maxBorrowFor(value: bigint, maxLtvBps: bigint, cash: bigint): bigint {
  const limit = (value * maxLtvBps) / BPS;
  return limit < cash ? limit : cash;
}

/** BTC/USD price (WAD) at which `debt` reaches `liqLtvBps` of a lock holding `lockedAmount` BTC. */
export function liquidationPriceWad(debt: bigint, lockedAmount: bigint, liqLtvBps: bigint): bigint | null {
  if (lockedAmount <= 0n || liqLtvBps === 0n) return null;
  return mulDivUp(debt * BPS, WAD, lockedAmount * liqLtvBps);
}

/** Dutch auction price, exactly as VeBTCCreditLine.auctionPrice. */
export function auctionPrice(value: bigint, elapsed: bigint, duration: bigint, floorBps: bigint): bigint {
  if (elapsed >= duration) return (value * floorBps) / BPS;
  const span = BPS * duration;
  return mulDivDown(value, span - (BPS - floorBps) * elapsed, span);
}

/** Asset-weighted average of per-part APYs over `total` (parts not adding up to `total` earn 0). */
export function weightedApy(parts: { assets: bigint; apy: number }[], total: bigint): number {
  if (total === 0n) return 0;
  let acc = 0;
  for (const p of parts) acc += ratio(p.assets, total) * p.apy;
  return acc;
}

/* Morpho Blue */

export function morphoToAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, totalAssets + MORPHO_VIRTUAL_ASSETS, totalShares + MORPHO_VIRTUAL_SHARES);
}

export function morphoToAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + MORPHO_VIRTUAL_ASSETS, totalShares + MORPHO_VIRTUAL_SHARES);
}

/** Morpho liquidation incentive factor for `lltv`: min(1.15, 1 / (1 - 0.3 * (1 - lltv))), WAD. */
export function morphoLiquidationIncentiveFactor(lltv: bigint): bigint {
  const lif = mulDivDown(WAD, WAD, WAD - mulDivDown(MORPHO_LIQUIDATION_CURSOR, WAD - lltv, WAD));
  return lif < MORPHO_MAX_LIF ? lif : MORPHO_MAX_LIF;
}

/** Borrow capacity of a Morpho position: collateral * price / 1e36 * lltv (Morpho._isHealthy). */
export function morphoMaxBorrow(collateral: bigint, oraclePrice: bigint, lltv: bigint): bigint {
  return mulDivDown(mulDivDown(collateral, oraclePrice, MORPHO_ORACLE_PRICE_SCALE), lltv, WAD);
}

/* MUSD peg (MusdPeg) */

export type PegIssue = "too-few-sources" | "sources-disagree" | "off-peg";

export interface PegHealth {
  /** Usable readings (ok with a non-zero price). */
  count: number;
  /** Median of the usable readings (the mean of the middle two for an even count, rounded down); null without any. */
  medianWad: bigint | null;
  lowWad: bigint | null;
  highWad: bigint | null;
  /** (high - low) / median, bps rounded down; null without a reading. */
  spreadBps: bigint | null;
  /** |median - 1|, bps rounded down; null without a reading. */
  offPegBps: bigint | null;
  /** Whether `musdUsdWad()` answers (at least `minSources` usable readings). */
  available: boolean;
  /** `pegHealthy()`: available, the readings agree within `maxSpreadBps` and the median is within `bandBps` of $1. */
  healthy: boolean;
  /** Why it is not healthy; empty when healthy. */
  issues: PegIssue[];
}

/**
 * MusdPeg's health check over a set of readings, exactly as the contract computes it: a reading counts when it is ok
 * with a non-zero price; the spread is checked against `maxSpreadBps` of the median (rounded down) and the median's
 * distance from $1 against `bandBps` of 1e18.
 */
export function pegHealth(
  readings: readonly { ok: boolean; musdUsdWad: bigint | null }[],
  params: { minSources: number | bigint; maxSpreadBps: number | bigint; bandBps: number | bigint },
): PegHealth {
  const prices = readings
    .filter((r) => r.ok && r.musdUsdWad !== null && r.musdUsdWad > 0n)
    .map((r) => r.musdUsdWad as bigint)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const count = prices.length;
  const available = count >= Number(params.minSources);
  if (count === 0) {
    return {
      count,
      medianWad: null,
      lowWad: null,
      highWad: null,
      spreadBps: null,
      offPegBps: null,
      available,
      healthy: false,
      issues: ["too-few-sources"],
    };
  }
  const low = prices[0]!;
  const high = prices[count - 1]!;
  const median = count % 2 === 1 ? prices[(count - 1) / 2]! : (prices[count / 2 - 1]! + prices[count / 2]!) / 2n;
  const offPeg = median > WAD ? median - WAD : WAD - median;
  const issues: PegIssue[] = [];
  if (!available) issues.push("too-few-sources");
  if (high - low > mulDivDown(median, BigInt(params.maxSpreadBps), BPS)) issues.push("sources-disagree");
  if (offPeg > (WAD * BigInt(params.bandBps)) / BPS) issues.push("off-peg");
  return {
    count,
    medianWad: median,
    lowWad: low,
    highWad: high,
    spreadBps: mulDivDown(high - low, BPS, median),
    offPegBps: mulDivDown(offPeg, BPS, WAD),
    available,
    healthy: issues.length === 0,
    issues,
  };
}

/**
 * BtcMusdPriceSource: BTC in MUSD from BTC/USD and the MUSD peg, with MUSD never taken below $1
 * (`btcUsd * 1e18 / max(peg, 1e18)`, rounded down; the peg counts as $1 while it is unavailable).
 */
export function btcInMusdWad(btcUsdWad: bigint, musdUsdWad: bigint | null): bigint {
  const peg = musdUsdWad ?? WAD;
  return peg > WAD ? mulDivDown(btcUsdWad, WAD, peg) : btcUsdWad;
}

/* veBTC line fees */

/** Origination fee on borrowing `amount`, rounded down as the line takes it. */
export function originationFee(amount: bigint, originationFeeBps: bigint | number): bigint {
  return (amount * BigInt(originationFeeBps)) / BPS;
}

/** What a borrower receives for borrowing `amount` (the debt is the full amount). */
export function borrowerReceives(amount: bigint, originationFeeBps: bigint | number): bigint {
  return amount - originationFee(amount, originationFeeBps);
}

/** Smallest amount to borrow so the borrower receives at least `wanted` after the origination fee. */
export function amountToBorrowFor(wanted: bigint, originationFeeBps: bigint | number): bigint {
  const bps = BigInt(originationFeeBps);
  if (bps === 0n) return wanted;
  let amount = mulDivUp(wanted, BPS, BPS - bps);
  while (amount > 0n && borrowerReceives(amount - 1n, bps) >= wanted) amount -= 1n;
  return amount;
}

export interface LiquidationFeeSplit {
  toLenders: bigint;
  toTreasury: bigint;
  toKeeper: bigint;
}

/**
 * Split of the liquidation fee a bid leaves in the line: `protocolShareBps` of it leaves (rounded down), of which
 * `keeperShareBps` (rounded down) goes to the address that started the auction and the rest to the treasury; the
 * lenders keep the remainder. The three parts add up to the fee.
 */
export function liquidationFeeSplit(
  fee: bigint,
  protocolShareBps: bigint | number,
  keeperShareBps: bigint | number,
): LiquidationFeeSplit {
  const protocolPart = (fee * BigInt(protocolShareBps)) / BPS;
  const toKeeper = (protocolPart * BigInt(keeperShareBps)) / BPS;
  return { toLenders: fee - protocolPart, toTreasury: protocolPart - toKeeper, toKeeper };
}

export interface BidOutcome extends LiquidationFeeSplit {
  /** Proceeds the line keeps before the fee split: min(price, debt + fee). */
  toLine: bigint;
  /** Liquidation fee kept: proceeds above the debt, up to `liqFeeBps` of it. */
  fee: bigint;
  /** Paid back to the borrower. */
  surplus: bigint;
  /** Recorded as bad debt when the price is below the debt. */
  shortfall: bigint;
}

/** Where a winning bid's MUSD goes, as `VeBTCCreditLine.bid` books it. */
export function bidOutcome(args: {
  price: bigint;
  debt: bigint;
  liqFeeBps: bigint | number;
  protocolShareBps: bigint | number;
  keeperShareBps: bigint | number;
}): BidOutcome {
  const owed = args.debt + (args.debt * BigInt(args.liqFeeBps)) / BPS;
  const toLine = args.price < owed ? args.price : owed;
  const fee = toLine > args.debt ? toLine - args.debt : 0n;
  return {
    toLine,
    fee,
    surplus: args.price - toLine,
    shortfall: args.price < args.debt ? args.debt - args.price : 0n,
    ...liquidationFeeSplit(fee, args.protocolShareBps, args.keeperShareBps),
  };
}

/** A VaultV2 management fee (WAD of total assets per second) as a yearly rate, WAD. */
export function managementFeeAprWad(feePerSecond: bigint): bigint {
  return feePerSecond * SECONDS_PER_YEAR;
}

/* ShareMarket */

/**
 * ShareMarket's price of shares worth `value` MUSD at the live share price, sold at `discountBps`: the buyer pays
 * `assets` (rounded up, in the seller's favour), of which `fee` (rounded down) goes to the treasury.
 */
export function shareFillPrice(
  value: bigint,
  discountBps: bigint | number,
  feeBps: bigint | number,
): { assets: bigint; fee: bigint; sellerReceives: bigint } {
  const assets = mulDivUp(value, BPS - BigInt(discountBps), BPS);
  const fee = (assets * BigInt(feeBps)) / BPS;
  return { assets, fee, sellerReceives: assets - fee };
}

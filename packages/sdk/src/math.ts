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

// Unit economics of the protocol's fees: what the treasury, the keeper and the lenders earn a year at a given size,
// under stated assumptions. Plain numbers in MUSD (1 MUSD ≈ $1), so the page and docs/BUSINESS.md can show the same
// model. Interest is not in it: interest goes to lenders, with the voters' performance fee to the SuretyPool, and
// none of it to the treasury.

/** Fee rates, as the contracts are configured. */
export interface FeeRates {
  /** Origination fee on every amount borrowed from the veBTC line, bps. */
  originationBps: number;
  /** Liquidation fee the line keeps on a bid, bps of the debt. */
  liqFeeBps: number;
  /** Share of that fee that leaves the line, bps. */
  protocolShareBps: number;
  /** Share of the protocol part paid to the keeper that started the auction, bps. */
  keeperShareBps: number;
  /** Vault management fee, a fraction of assets per year (0.002 = 0.20%). */
  managementApr: number;
  /** ShareMarket fee on every fill, bps. */
  marketFeeBps: number;
}

/** The v2 schedule as designed; the page prefers the live values read from chain. */
export const DESIGNED_RATES: FeeRates = {
  originationBps: 25,
  liqFeeBps: 300,
  protocolShareBps: 2000,
  keeperShareBps: 5000,
  managementApr: 0.002,
  marketFeeBps: 10,
};

/** How the vault is used over a year. Every field is an assumption, shown next to the result. */
export interface UsageAssumptions {
  /** Share of the vault in the veBTC line (the rest is in the Morpho line or idle). */
  veBtcShare: number;
  /** Share of the veBTC line's MUSD that is borrowed. */
  utilization: number;
  /** Times a year the line's debt is borrowed anew (veBTC locks run up to four weeks). */
  turnover: number;
  /** Share of the line's debt that ends in an auction in a year. */
  auctionedShare: number;
  /** ShareMarket fills in a year, as a share of the vault. */
  marketVolumeShare: number;
}

export const ASSUMPTIONS: UsageAssumptions = {
  veBtcShare: 0.5,
  utilization: 0.6,
  turnover: 4,
  auctionedShare: 0.02,
  marketVolumeShare: 0.1,
};

/** Yearly running costs the treasury has to cover, MUSD. Estimates, not quotes. */
export interface Costs {
  /** Hosting and a paid RPC endpoint. */
  ops: number;
  /** One independent security review per major version, spread over a year. */
  audits: number;
}

export const COSTS: Costs = { ops: 1_200, audits: 20_000 };

export interface YearlyRevenue {
  tvl: number;
  /** veBTC debt outstanding on average. */
  debt: number;
  management: number;
  origination: number;
  /** Liquidation fee kept by the line, before the split. */
  liquidationFee: number;
  liquidationToLenders: number;
  liquidationToTreasury: number;
  liquidationToKeeper: number;
  market: number;
  /** Everything the treasury receives. */
  treasury: number;
}

const bps = (n: number) => n / 10_000;

/** What a year at `tvl` MUSD earns, by stream. */
export function yearlyRevenue(tvl: number, rates: FeeRates, a: UsageAssumptions = ASSUMPTIONS): YearlyRevenue {
  const debt = tvl * a.veBtcShare * a.utilization;
  const management = tvl * rates.managementApr;
  const origination = debt * a.turnover * bps(rates.originationBps);
  const liquidationFee = debt * a.auctionedShare * bps(rates.liqFeeBps);
  const protocolPart = liquidationFee * bps(rates.protocolShareBps);
  const liquidationToKeeper = protocolPart * bps(rates.keeperShareBps);
  const liquidationToTreasury = protocolPart - liquidationToKeeper;
  const market = tvl * a.marketVolumeShare * bps(rates.marketFeeBps);
  return {
    tvl,
    debt,
    management,
    origination,
    liquidationFee,
    liquidationToLenders: liquidationFee - protocolPart,
    liquidationToTreasury,
    liquidationToKeeper,
    market,
    treasury: management + origination + liquidationToTreasury + market,
  };
}

/** Treasury income per MUSD of vault per year. */
export function treasuryYield(rates: FeeRates, a: UsageAssumptions = ASSUMPTIONS): number {
  return yearlyRevenue(1, rates, a).treasury;
}

/** Vault size at which the treasury's income covers `costs`, MUSD; Infinity when it never does. */
export function breakEvenTvl(rates: FeeRates, costs: Costs = COSTS, a: UsageAssumptions = ASSUMPTIONS): number {
  const perMusd = treasuryYield(rates, a);
  return perMusd > 0 ? (costs.ops + costs.audits) / perMusd : Number.POSITIVE_INFINITY;
}

/** The liquidation fee split of one bid, as fractions of the fee (the contract's rounding aside). */
export function liquidationSplitShares(rates: Pick<FeeRates, "protocolShareBps" | "keeperShareBps">): {
  lenders: number;
  treasury: number;
  keeper: number;
} {
  const protocol = bps(rates.protocolShareBps);
  const keeper = protocol * bps(rates.keeperShareBps);
  return { lenders: 1 - protocol, treasury: protocol - keeper, keeper };
}

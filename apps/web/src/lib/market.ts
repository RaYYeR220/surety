// Pure helpers for the ShareMarket page: slippage bounds, prices per share and paging. Prices themselves come
// from the contract (`quote`, `convertToAssets`) or the SDK's `shareFillPrice`, which mirrors it.
import { BPS, WAD, type ShareListing } from "@surety/sdk";

/** Listings per page. `bestListing` scans every open listing, so the page reads them a page at a time. */
export const PAGE_SIZE = 10;

/** Most a buyer agrees to pay: the quote plus `slippageBps`, rounded up. */
export function maxAssetsFor(assets: bigint, slippageBps: number): bigint {
  const n = assets * (BPS + BigInt(slippageBps));
  return (n + BPS - 1n) / BPS;
}

/** Least a seller agrees to receive when redeeming: the value less `slippageBps`, rounded down. */
export function minAssetsFor(value: bigint, slippageBps: number): bigint {
  return (value * (BPS - BigInt(slippageBps))) / BPS;
}

/** MUSD per whole srMUSD for a price of `assets` for `shares`; null for no shares. */
export function pricePerShare(assets: bigint, shares: bigint): bigint | null {
  return shares === 0n ? null : (assets * WAD) / shares;
}

/** A listing's price per whole share for a buyer, fee included. */
export function listingPricePerShare(l: ShareListing): bigint | null {
  return pricePerShare(l.price, l.shares);
}

export interface PageInfo {
  start: number;
  end: number;
  total: number;
  page: number;
  pages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Position of the page starting at `start` among `total` open listings. */
export function pageInfo(total: number, start: number, size = PAGE_SIZE): PageInfo {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages - 1, Math.floor(start / size));
  const first = page * size;
  return {
    start: total === 0 ? 0 : first + 1,
    end: Math.min(total, first + size),
    total,
    page,
    pages,
    hasPrev: page > 0,
    hasNext: page < pages - 1,
  };
}

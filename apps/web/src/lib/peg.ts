// Pure helpers for the MUSD peg panels: names of the source kinds, why the peg is not healthy, and what the peg
// would read if the testnet stress switch were pushed. The health rule itself is the SDK's `pegHealth`, which
// mirrors MusdPeg exactly.
import { pegHealth, WAD, type PegHealth, type PegIssue, type PegSourceKind, type PegView } from "@surety/sdk";

export const SOURCE_KINDS: Record<PegSourceKind, { name: string; detail: string }> = {
  ClTwap: {
    name: "Concentrated pool TWAP",
    detail: "Time-weighted price of a MUSD/stablecoin concentrated-liquidity pool on Mezo.",
  },
  StableTwap: {
    name: "Stable pool TWAP",
    detail: "Quote of a MUSD/stablecoin stable pool on Mezo, averaged over its recent observations.",
  },
  BtcCross: {
    name: "BTC cross",
    detail: "BTC/USD from Skip divided by BTC's price in MUSD on a BTC/MUSD pool on Mezo.",
  },
  Stressed: {
    name: "Testnet switch",
    detail: "Reads $1 until someone pushes it off the peg, for up to two hours. Testnet only.",
  },
};

export function sourceKindName(kind: PegSourceKind | null): string {
  return kind ? SOURCE_KINDS[kind].name : "Source";
}

export const ISSUE_TEXT: Record<PegIssue, string> = {
  "too-few-sources": "Too few sources give a usable reading.",
  "sources-disagree": "The sources disagree by more than the allowed spread.",
  "off-peg": "The median is outside the band around $1.",
};

/** Lowest and highest reading a peg source reports as usable (PegSourceBase); anything else reads as not ok. */
export const MIN_SOURCE_USD = WAD / 2n;
export const MAX_SOURCE_USD = 2n * WAD;

/** Index of the testnet stress switch among the peg's sources, or null when there is none. */
export function stressedSourceIndex(peg: PegView, stressedAddress: string | undefined): number | null {
  const byAddress = stressedAddress
    ? peg.sources.find((s) => s.address.toLowerCase() === stressedAddress.toLowerCase())
    : undefined;
  const found = byAddress ?? peg.sources.find((s) => s.kind === "Stressed");
  return found ? found.index : null;
}

/**
 * What MusdPeg would report if the stressed source read `musdUsdWad` (zero for an outage) and every other source
 * kept its current reading. Lets the depeg switch say up front whether it will actually trip the breaker.
 */
export function pegUnderStress(peg: PegView, index: number, musdUsdWad: bigint): PegHealth {
  const usable = musdUsdWad >= MIN_SOURCE_USD && musdUsdWad <= MAX_SOURCE_USD;
  const readings = peg.sources.map((s) =>
    s.index === index ? { ok: usable, musdUsdWad: usable ? musdUsdWad : null } : { ok: s.ok, musdUsdWad: s.musdUsdWad },
  );
  return pegHealth(readings, peg);
}

/** Bounds of the peg chart: $1 ± twice the band, widened to show every reading with a margin. */
export function pegChartDomain(peg: PegView): { min: number; max: number } {
  const band = peg.bandBps / 10_000;
  let min = 1 - 2 * band;
  let max = 1 + 2 * band;
  for (const s of peg.sources) {
    if (s.musdUsdWad === null) continue;
    const v = Number(s.musdUsdWad) / 1e18;
    if (v < min) min = v - band / 2;
    if (v > max) max = v + band / 2;
  }
  return { min, max };
}

// What the landing and the app's proof page claim about verification, in one place.
import type { SuretyContracts } from "@surety/sdk";

/** Test suite size at the testnet deployment (contracts: forge test; SDK, keeper and MCP: vitest). */
export const TEST_COUNTS = {
  /** Foundry tests, invariants included. */
  foundry: 178,
  invariants: 6,
  /** Calls per invariant run: 256 runs x depth 64 (contracts/foundry.toml). */
  invariantCalls: 16_384,
  typescript: 98,
} as const;

/** Verified source on Sourcify's repository. */
export function sourcifyUrl(chainId: number, address: string): string {
  return `https://repo.sourcify.dev/${chainId}/${address}`;
}

/** Short names for the deployment's contracts, in reading order. */
export const CONTRACT_NAMES: [keyof SuretyContracts, string][] = [
  ["vault", "Surety vault (VaultV2)"],
  ["creditVoter", "CreditVoter"],
  ["voteAllocator", "VoteAllocator"],
  ["suretyPool", "SuretyPool"],
  ["veBTCLine", "VeBTCCreditLine"],
  ["loanEscrowImpl", "LoanEscrow (implementation)"],
  ["irmLine", "LinearKinkIrm (veBTC line)"],
  ["morphoAdapter", "Morpho market adapter"],
  ["morpho", "Morpho Blue"],
  ["irm", "AdaptiveCurveIrm"],
  ["morphoOracle", "MorphoPriceOracle"],
  ["priceSource", "Price source"],
  ["skipSource", "SkipPriceSource"],
];

/** The Mezo blog post that asks for lending gauges ("Aerodrome for lending"). */
export const MEZO_LENDING_GAUGES_POST = "https://mezo.org/blog/the-mezo-allocation-methodology-phase-1/";

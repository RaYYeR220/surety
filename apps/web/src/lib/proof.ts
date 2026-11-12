// What the landing and the app's proof page claim about verification, in one place.
import type { SuretyContracts, SuretyDeployment } from "@surety/sdk";
import type { Address } from "viem";

/** Test suite size at the v2 testnet deployment (contracts: forge test; SDK, keeper, MCP and web: pnpm -r test). */
export const TEST_COUNTS = {
  /** Foundry tests, invariants and the security reviews' regression tests included. */
  foundry: 379,
  invariants: 15,
  /** Invariant fuzzing: 256 runs x depth 64 (contracts/foundry.toml). */
  invariantRuns: 256,
  invariantDepth: 64,
  /** Regression tests written from the two security reviews' proofs of concept (contracts/test/audit): 9 v1 + 7 v2. */
  regression: 16,
  typescript: 173,
} as const;

/** Verified source on Sourcify's repository. */
export function sourcifyUrl(chainId: number, address: string): string {
  return `https://repo.sourcify.dev/${chainId}/${address}`;
}

/** The public repository. */
export const REPO_URL = "https://github.com/RaYYeR220/surety";

/** A file in the repository's main branch. */
export function repoFile(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}

/** Where the written answers live in the repository. */
export const REPO_DOCS = {
  security: "docs/SECURITY.md",
  business: "docs/BUSINESS.md",
  feedback: "FEEDBACK-RESPONSE.md",
  proof: "docs/PROOF.md",
} as const;

/** Short names for the deployment's contracts, in reading order. */
export const CONTRACT_NAMES: [keyof SuretyContracts, string][] = [
  ["vault", "Surety vault (VaultV2)"],
  ["depositGate", "DepositGate"],
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
  ["btcMusdSource", "BtcMusdPriceSource"],
  ["priceSource", "Price source"],
  ["btcUsdSource", "BTC/USD source"],
  ["skipSource", "SkipPriceSource"],
  ["musdPeg", "MusdPeg"],
  ["stressedPegSource", "StressedPegSource (testnet)"],
  ["savingsAdapter", "SavingsAdapter"],
  ["shareMarket", "ShareMarket"],
  ["sponsor", "Sponsor (testnet)"],
];

/**
 * Mezo's own Morpho Blue and IRM: the mainnet deployments and every v2 deployment use them, so they are Mezo's
 * contracts rather than ours. (The v1 testnet ran its own Morpho.)
 */
const MEZO_OWNED_MORPHO = new Set<keyof SuretyContracts>(["morpho", "irm"]);

/**
 * The contracts this deployment created, in reading order: skips any an older deployment does not have (the gate),
 * Mezo's own Morpho stack where it is used, and a second name for the same address (the plain price source is also
 * the Skip source; on v2 the price source is BtcMusdPriceSource).
 */
export function deployedContracts(d: SuretyDeployment): { key: keyof SuretyContracts; name: string; address: Address }[] {
  const seen = new Set<string>();
  return CONTRACT_NAMES.flatMap(([key, name]) => {
    const address = d.contracts[key];
    if (!address || seen.has(address.toLowerCase())) return [];
    if ((d.chainId === 31612 || d.version === 2) && MEZO_OWNED_MORPHO.has(key)) return [];
    seen.add(address.toLowerCase());
    return [{ key, name, address }];
  });
}

/**
 * Proof steps that exercise the loan escrow on Mezo: its vote, the bribe it earns, claims, rebase, a loan harvest.
 * (A savings harvest is not an escrow step.)
 */
export function isEscrowProof(label: string): boolean {
  return /escrow|bribe|harvest loan|rebase|auto-repay/i.test(label);
}

/** The steps of a mainnet proof worth showing first: money in, the split by votes, both loans, the escrow on Mezo. */
export function isKeyMainnetStep(label: string): boolean {
  return !/: approve /.test(label) && /: deposit|: rebalance|loan #\d+ opened|escrow vote|Morpho borrow|harvest loan/.test(label);
}

/** Anchor of a proof row on the proof page, e.g. "proof-v1-33" for step 33 of the v1 deployment. */
export function proofAnchor(version: number, step: number): string {
  return `proof-v${version}-${step}`;
}

export interface ReviewFinding {
  id: string;
  severity: "Medium" | "Low";
  /** What could go wrong, in plain words. */
  finding: string;
  /** What changed. */
  fix: string;
  /** Fixed in the contracts or the deploy script, or handled by operations. */
  status: "fixed" | "mitigated";
}

/** The independent security review before mainnet (the full report is docs/SECURITY.md in the repository). */
export const SECURITY_REVIEW: {
  counts: { critical: number; high: number; medium: number; low: number; info: number };
  findings: ReviewFinding[];
} = {
  counts: { critical: 0, high: 0, medium: 4, low: 6, info: 7 },
  findings: [
    {
      id: "M-01",
      severity: "Medium",
      finding:
        "Anyone could force capital out of a line just before a rebalance, wiping its measured interest and steering its voters' fees to another line.",
      fix: "Interest is measured from the Morpho share price and the veBTC line's own interest counter, which outside moves cannot change.",
      status: "fixed",
    },
    {
      id: "M-02",
      severity: "Medium",
      finding: "A forced exit right after Morpho bad debt shrank the recorded loss, so voters dodged the slash and lenders paid it.",
      fix: "A Morpho loss is valued on the shares held at the last mark, so the whole loss is recorded.",
      status: "fixed",
    },
    {
      id: "M-03",
      severity: "Medium",
      finding: "A deposit made right after a loss could soak up most of the voters' cover meant for the lenders who took the loss.",
      fix: "The new DepositGate holds deposits, srMUSD transfers, claims and refunds until the loss is recorded, covered and back in the share price. Withdrawals stay open.",
      status: "fixed",
    },
    {
      id: "M-04",
      severity: "Medium",
      finding: "The owner could list a fake line at once, then drain the reserve through it or block every rebalance.",
      fix: "A line must be a real vault adapter, listed once, and after the bootstrap a new line waits a timelock. Recorded loss is capped at the line's allocation; a broken line only sidelines itself.",
      status: "fixed",
    },
    {
      id: "L-01",
      severity: "Low",
      finding:
        "The Morpho loss mark went stale while the vault held no position there, so voters could later be slashed for a loss the vault never took.",
      fix: "The mark moves to the current price and shares at every checkpoint.",
      status: "fixed",
    },
    {
      id: "L-02",
      severity: "Low",
      finding: "A stale price feed at an epoch's first rebalance threw away the closed vote and pulled all capital to idle.",
      fix: "The tally comes from active lines whatever the feed says; a line that cannot take new money keeps what it has.",
      status: "fixed",
    },
    {
      id: "L-03",
      severity: "Low",
      finding: "The Morpho adapter's own timelocks were zero, so the curator could write the line off instantly.",
      fix: "The deploy script timelocks the adapter (1 day on mainnet) before the vault adds it.",
      status: "fixed",
    },
    {
      id: "L-04",
      severity: "Low",
      finding: "Slashed voters paid about 10% more than the recorded loss: the fee the vault took on the cover went to other cohorts.",
      fix: "That fee is credited back to the cohorts the cover slashed, so together they pay the recorded loss.",
      status: "fixed",
    },
    {
      id: "L-05",
      severity: "Low",
      finding: "Anyone can pull the veBTC line's idle cash, pushing its borrowers to the maximum rate until the next rebalance.",
      fix: "The keeper rebalances at every flip and may rebalance mid-epoch; the line documents it.",
      status: "mitigated",
    },
    {
      id: "L-06",
      severity: "Low",
      finding:
        "A borrower could vote the escrowed veBTC on Mezo just before an auction bid, leaving the buyer an NFT it could not reset for up to a week.",
      fix: "Mezo votes and resets through the escrow are refused during an auction; claims still work.",
      status: "fixed",
    },
  ],
};

/** Where the full report lives in the repository. */
export const SECURITY_REPORT_PATH = "docs/SECURITY.md";

/** The Mezo blog post that asks for lending gauges ("Aerodrome for lending"). */
export const MEZO_LENDING_GAUGES_POST = "https://mezo.org/blog/the-mezo-allocation-methodology-phase-1/";

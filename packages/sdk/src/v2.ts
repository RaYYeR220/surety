// Reads of the v2 contracts: the MUSD peg, the fee schedule, idle MUSD parked in sMUSD, ShareMarket, the testnet
// Sponsor's ledger, and what a harvest of a loan's veBTC rewards would claim. Each needs a version 2 deployment.
import { getAbiItem, type Address } from "viem";

import {
  btcMusdPriceSourceAbi,
  clTwapPegSourceAbi,
  erc20Abi,
  mezoPoolsVoterAbi,
  musdPegAbi,
  musdSavingsRateAbi,
  rewardsDistributorAbi,
  savingsAdapterAbi,
  shareMarketAbi,
  sponsorAbi,
  stableTwapPegSourceAbi,
  stressedPegSourceAbi,
  vaultV2Abi,
  veBTCCreditLineAbi,
  voteAllocatorAbi,
  votingRewardAbi,
} from "./abis/index.js";
import { isV2Deployment, type SuretyDeploymentV2 } from "./deployments/types.js";
import { getLogsChunked } from "./logs.js";
import { managementFeeAprWad, pegDivisorWad, pegHealth, shareFillPrice, WAD } from "./math.js";
import { call, isRevert, orNull, type ReadCall, type Settled } from "./read.js";
import { head, normalizeLineParams, veBTCCreditLineAbiFor, type SuretyContext } from "./reads.js";
import type {
  FeeSchedule,
  HarvestPlan,
  PegSourceReading,
  PegView,
  SavingsView,
  ShareFillQuote,
  ShareListing,
  ShareMarketView,
  SponsorLedger,
  StarterKitEntry,
} from "./types.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** Longest PoolsVoter vote an NFT can hold (PoolsVoter caps pools per vote well below this). */
const MAX_VOTED_POOLS = 30;

export const starterKitEvent = getAbiItem({ abi: sponsorAbi, name: "StarterKit" });

function v2(ctx: SuretyContext, what: string): SuretyDeploymentV2 {
  if (!isV2Deployment(ctx.deployment)) {
    throw new Error(`${what} needs a v2 deployment; chain ${ctx.chainId} has v${ctx.deployment.version}`);
  }
  return ctx.deployment;
}

function must<T>(s: Settled<T>, what: string): T {
  if (!s.ok) throw new Error(`${what} failed: ${s.error.message}`, { cause: s.error });
  return s.value;
}

/* MUSD peg */

/**
 * The MUSD peg: every source's reading (with the CL sources' window liquidity against their floor and the basic-pool
 * sources' observation age against their limit), their median, spread and distance from $1, whether the line would
 * lend now (`pegHealthy` and the line's `pegCheck`), whether a rebalance would fund lines, and the BTC price in MUSD
 * the line values collateral at.
 */
export async function getPeg(ctx: SuretyContext): Promise<PegView> {
  const d = v2(ctx, "the peg");
  const c = d.contracts;
  const { blockNumber } = await head(ctx);
  const [readingsS, healthyS, minS, spreadS, bandS, gateS, btcUsdS, btcMusdS, stressS] = await ctx.reader.settle(
    [
      call(c.musdPeg, musdPegAbi, "readings"),
      call(c.musdPeg, musdPegAbi, "pegHealthy"),
      call(c.musdPeg, musdPegAbi, "minSources"),
      call(c.musdPeg, musdPegAbi, "maxSpreadBps"),
      call(c.musdPeg, musdPegAbi, "bandBps"),
      call(c.voteAllocator, voteAllocatorAbi, "pegGateOpen"),
      call(c.btcMusdSource, btcMusdPriceSourceAbi, "btcUsd"),
      call(c.btcMusdSource, btcMusdPriceSourceAbi, "priceWad"),
      ...(c.stressedPegSource ? [call(c.stressedPegSource, stressedPegSourceAbi, "activeStress")] : []),
    ] as ReadCall[],
    { blockNumber },
  );
  const readings = must(
    readingsS as Settled<readonly { source: Address; ok: boolean; musdUsdWad: bigint }[]>,
    "MusdPeg.readings",
  );
  const minSources = Number(orNull(minS as Settled<bigint>) ?? BigInt(d.peg.minSources));
  const maxSpreadBps = Number(orNull(spreadS as Settled<bigint>) ?? BigInt(d.peg.maxSpreadBps));
  const bandBps = Number(orNull(bandS as Settled<bigint>) ?? BigInt(d.peg.bandBps));

  const btcUsdSource = orNull(btcUsdS as Settled<Address>) ?? c.btcUsdSource;
  const infos = readings.map((r) => d.pegSources.find((s) => s.address.toLowerCase() === r.source.toLowerCase()) ?? null);
  const isCl = (k: string | undefined) => k === "ClTwap" || k === "BtcCross";
  const [btcUsdPrice, stressEnd, pegCheckS, premiumS, ...perSource] = await ctx.reader.settle(
    [
      call(btcUsdSource, btcMusdPriceSourceAbi, "priceWad"),
      c.stressedPegSource
        ? call(c.stressedPegSource, stressedPegSourceAbi, "stressEndsAt")
        : call(c.musdPeg, musdPegAbi, "minSources"),
      call(c.veBTCLine, veBTCCreditLineAbi, "pegCheck"),
      call(c.btcMusdSource, btcMusdPriceSourceAbi, "maxPremiumBps"),
      ...readings.map((r, i) =>
        isCl(infos[i]?.kind)
          ? call(r.source, clTwapPegSourceAbi, "windowLiquidity")
          : infos[i]?.kind === "StableTwap"
            ? call(r.source, stableTwapPegSourceAbi, "lastObservationAge")
            : call(c.musdPeg, musdPegAbi, "minSources"),
      ),
    ] as ReadCall[],
    { blockNumber },
  );

  const sources: PegSourceReading[] = readings.map((r, index) => {
    const info = infos[index];
    const extra = orNull(perSource[index] as Settled<readonly [boolean, bigint]>);
    const cl = isCl(info?.kind);
    const stable = info?.kind === "StableTwap";
    return {
      index,
      address: r.source,
      kind: info?.kind ?? null,
      pool: info?.pool ?? null,
      ok: r.ok,
      musdUsdWad: r.ok ? r.musdUsdWad : null,
      windowLiquidity: cl && extra && extra[0] ? extra[1] : null,
      minLiquidity: cl ? (info?.minLiquidity ?? null) : null,
      observationAge: stable && extra && extra[0] ? extra[1] : null,
      maxAge: stable && info?.maxAge !== undefined ? BigInt(info.maxAge) : null,
    };
  });
  const health = pegHealth(sources, { minSources, maxSpreadBps, bandBps });
  const healthyOnChain = orNull(healthyS as Settled<boolean>) ?? false;
  const maxPremiumBps = Number(orNull(premiumS as Settled<number>) ?? d.peg.maxPremiumBps);
  const stress = stressS ? orNull(stressS as Settled<readonly [boolean, bigint]>) : null;
  return {
    address: c.musdPeg,
    minSources,
    maxSpreadBps,
    bandBps,
    sources,
    ...health,
    healthyOnChain,
    allocatorGateOpen: orNull(gateS as Settled<boolean>),
    linePegCheck: orNull(pegCheckS as Settled<boolean>),
    maxPremiumBps,
    divisorWad: pegDivisorWad(healthyOnChain ? health.medianWad : null, maxPremiumBps),
    btcUsdWad: orNull(btcUsdPrice as Settled<bigint>),
    btcMusdWad: orNull(btcMusdS as Settled<bigint>),
    stress:
      stress === null
        ? null
        : { active: stress[0], musdUsdWad: stress[1], endsAt: c.stressedPegSource ? (orNull(stressEnd as Settled<bigint>) ?? 0n) : 0n },
  };
}

/* Fees */

/** Who pays what: the line's origination and liquidation fee split, the vault's fees, ShareMarket's fee. */
export async function getFeeSchedule(ctx: SuretyContext): Promise<FeeSchedule> {
  const d = ctx.deployment;
  const c = d.contracts;
  const { blockNumber } = await head(ctx);
  const [paramsS, treasuryS, perfS, perfToS, mgmtS, mgmtToS, marketFeeS] = await ctx.reader.settle(
    [
      call(c.veBTCLine, veBTCCreditLineAbiFor(d), "params"),
      call(c.veBTCLine, veBTCCreditLineAbi, "treasury"),
      call(c.vault, vaultV2Abi, "performanceFee"),
      call(c.vault, vaultV2Abi, "performanceFeeRecipient"),
      call(c.vault, vaultV2Abi, "managementFee"),
      call(c.vault, vaultV2Abi, "managementFeeRecipient"),
      ...(c.shareMarket ? [call(c.shareMarket, shareMarketAbi, "feeBps")] : []),
    ] as ReadCall[],
    { blockNumber },
  );
  const managementFee = orNull(mgmtS as Settled<bigint>) ?? 0n;
  return {
    line: normalizeLineParams(must(paramsS as Settled<object>, "VeBTCCreditLine.params")),
    treasury: orNull(treasuryS as Settled<Address>) ?? c.treasury ?? null,
    performanceFee: orNull(perfS as Settled<bigint>) ?? 0n,
    performanceFeeRecipient: orNull(perfToS as Settled<Address>) ?? ZERO,
    managementFee,
    managementFeeAprWad: managementFeeAprWad(managementFee),
    managementFeeRecipient: orNull(mgmtToS as Settled<Address>) ?? ZERO,
    shareMarketFeeBps: marketFeeS ? (orNull(marketFeeS as Settled<number>) ?? null) : null,
  };
}

/* Savings */

/** Idle MUSD: what the vault holds plus what its savings adapter parks in sMUSD, and the savings yield. */
export async function getSavings(ctx: SuretyContext): Promise<SavingsView> {
  const d = v2(ctx, "savings");
  const c = d.contracts;
  const { blockNumber } = await head(ctx);
  const [vaultIdleS, parkedS, claimableS, claimedS, parkingS, liquidityS] = await ctx.reader.settle(
    [
      call(d.external.musd, erc20Abi, "balanceOf", [c.vault]),
      call(c.savingsAdapter, savingsAdapterAbi, "realAssets"),
      call(c.savingsAdapter, savingsAdapterAbi, "claimableYield"),
      call(c.savingsAdapter, savingsAdapterAbi, "yieldClaimed"),
      call(c.voteAllocator, voteAllocatorAbi, "parking"),
      call(c.vault, vaultV2Abi, "liquidityAdapter"),
    ] as ReadCall[],
    { blockNumber },
  );
  const vaultIdle = must(vaultIdleS as Settled<bigint>, "MUSD.balanceOf(vault)");
  const parked = must(parkedS as Settled<bigint>, "SavingsAdapter.realAssets");
  return {
    adapter: c.savingsAdapter,
    smusd: d.external.smusd,
    parking: orNull(parkingS as Settled<boolean>),
    liquidityAdapter: orNull(liquidityS as Settled<Address>),
    vaultIdle,
    parked,
    idle: vaultIdle + parked,
    claimableYield: orNull(claimableS as Settled<bigint>),
    yieldClaimed: orNull(claimedS as Settled<bigint>),
  };
}

/** sMUSD held by the savings adapter (its principal), read from sMUSD itself. */
export async function getSavingsPrincipal(ctx: SuretyContext): Promise<bigint> {
  const d = v2(ctx, "savings");
  const [principal] = await ctx.reader.values([
    call(d.external.smusd, musdSavingsRateAbi, "balanceOf", [d.contracts.savingsAdapter]),
  ]);
  return principal;
}

/* ShareMarket */

type RawListing = { seller: Address; discountBps: number; shares: bigint };

async function priceListings(
  ctx: SuretyContext,
  ids: readonly bigint[],
  items: readonly RawListing[],
  feeBps: number,
  blockNumber: bigint,
): Promise<ShareListing[]> {
  const d = ctx.deployment;
  const values = await ctx.reader.values(
    items.map((l) => call(d.contracts.vault, vaultV2Abi, "convertToAssets", [l.shares])),
    { blockNumber },
  );
  return items.map((l, k) => {
    const value = values[k]!;
    const { assets, fee } = shareFillPrice(value, l.discountBps, feeBps);
    return { id: ids[k]!, seller: l.seller, discountBps: Number(l.discountBps), shares: l.shares, value, price: assets, fee };
  });
}

/** ShareMarket's open listings from position `start` (at most `count`), priced at the live share price. */
export async function getShareMarket(
  ctx: SuretyContext,
  options: { start?: number; count?: number } = {},
): Promise<ShareMarketView> {
  const d = v2(ctx, "ShareMarket");
  const market = d.contracts.shareMarket;
  const { blockNumber } = await head(ctx);
  const [feeBps, isOpen, openCount, page, best, sharePrice] = await ctx.reader.values(
    [
      call(market, shareMarketAbi, "feeBps"),
      call(market, shareMarketAbi, "isOpen"),
      call(market, shareMarketAbi, "openListingCount"),
      call(market, shareMarketAbi, "openListings", [BigInt(options.start ?? 0), BigInt(options.count ?? 50)]),
      call(market, shareMarketAbi, "bestListing"),
      call(d.contracts.vault, vaultV2Abi, "convertToAssets", [WAD]),
    ],
    { blockNumber },
  );
  const [ids, items] = page;
  return {
    address: market,
    feeBps: Number(feeBps),
    isOpen,
    openCount,
    sharePrice,
    listings: await priceListings(ctx, ids, items, Number(feeBps), blockNumber),
    best:
      best[0] === 0n
        ? null
        : { id: best[0], discountBps: Number(best[1]), shares: best[2], pricePerShare: best[3] },
  };
}

/** `seller`'s open listings, priced now. */
export async function getShareListingsOf(ctx: SuretyContext, seller: Address): Promise<ShareListing[]> {
  const d = v2(ctx, "ShareMarket");
  const market = d.contracts.shareMarket;
  const { blockNumber } = await head(ctx);
  const [ids, feeBps] = await ctx.reader.values(
    [call(market, shareMarketAbi, "listingsOf", [seller]), call(market, shareMarketAbi, "feeBps")],
    { blockNumber },
  );
  const items = await ctx.reader.values(
    ids.map((id) => call(market, shareMarketAbi, "listing", [id])),
    { blockNumber },
  );
  return priceListings(ctx, ids, items, Number(feeBps), blockNumber);
}

/** What `fill(id, shares, …)` would buy and cost now; all zero for a closed listing or a fill below MIN_SHARES. */
export async function quoteShareFill(ctx: SuretyContext, id: bigint, shares: bigint): Promise<ShareFillQuote> {
  const d = v2(ctx, "ShareMarket");
  const [[filled, assets, fee]] = await ctx.reader.values([
    call(d.contracts.shareMarket, shareMarketAbi, "quote", [id, shares]),
  ]);
  return { id, filled, assets, fee, sellerReceives: assets - fee };
}

/* Sponsor (testnet) */

/** The testnet Sponsor's kit settings and every starter kit it handed out (its `StarterKit` events). */
export async function getSponsorLedger(ctx: SuretyContext): Promise<SponsorLedger> {
  const d = v2(ctx, "the Sponsor ledger");
  const sponsor = d.contracts.sponsor;
  if (!sponsor) throw new Error(`chain ${ctx.chainId} has no Sponsor (testnet only)`);
  const at = await head(ctx);
  const [issuedS, leftS, limitS, gasS, lockS, musdS, durationS] = await ctx.reader.settle(
    [
      call(sponsor, sponsorAbi, "kitsIssued"),
      call(sponsor, sponsorAbi, "kitsLeft"),
      call(sponsor, sponsorAbi, "dailyLimit"),
      call(sponsor, sponsorAbi, "btcGas"),
      call(sponsor, sponsorAbi, "lockAmount"),
      call(sponsor, sponsorAbi, "musdAmount"),
      call(sponsor, sponsorAbi, "lockDuration"),
    ] as ReadCall[],
    { blockNumber: at.blockNumber },
  );
  const logs = await getLogsChunked(ctx.client, {
    address: sponsor,
    event: starterKitEvent,
    fromBlock: d.deployedAt,
    toBlock: at.blockNumber,
    chunkSize: ctx.logChunkSize,
  });
  const entries: StarterKitEntry[] = logs.map((l) => ({
    user: l.args.user,
    tokenId: l.args.tokenId,
    btcGas: l.args.btcGas,
    lockAmount: l.args.lockAmount,
    musd: l.args.musd,
    blockNumber: l.blockNumber,
    transactionHash: l.transactionHash,
  }));
  const n = (s: Settled<unknown>) => (orNull(s as Settled<bigint>) ?? 0n) as bigint;
  return {
    address: sponsor,
    kitsIssued: n(issuedS!),
    kitsLeft: orNull(leftS as Settled<bigint>),
    dailyLimit: n(limitS!),
    kit: { btcGas: n(gasS!), lockAmount: n(lockS!), musd: n(musdS!), lockDuration: n(durationS!) },
    entries,
  };
}

/* Harvest */

/**
 * What `harvest(loanId, rewards, tokens)` would claim now: the pools the escrowed NFT votes on (Mezo PoolsVoter),
 * their fee and bribe reward contracts, the tokens each has earned for the NFT, and the veBTC rebase. `rewards` and
 * `tokens` list only what has something to claim, ready to pass to `harvest`. veBTC is never listed (the line
 * refuses to forward it).
 */
export async function getHarvestPlan(ctx: SuretyContext, loanId: bigint): Promise<HarvestPlan> {
  const d = v2(ctx, "harvest");
  const { blockNumber } = await head(ctx);
  const [loan] = await ctx.reader.values([call(d.contracts.veBTCLine, veBTCCreditLineAbi, "loan", [loanId])], {
    blockNumber,
  });
  const tokenId = loan.tokenId;
  const voter = d.external.poolsVoter;

  const pools: Address[] = [];
  for (let i = 0; i < MAX_VOTED_POOLS; i++) {
    const [s] = await ctx.reader.settle([call(voter, mezoPoolsVoterAbi, "poolVote", [tokenId, BigInt(i)])], {
      blockNumber,
    });
    if (!s.ok) {
      if (isRevert(s.error)) break; // past the end of the NFT's vote
      throw s.error;
    }
    pools.push(s.value);
  }

  const gauges = await ctx.reader.settle(
    pools.map((p) => call(voter, mezoPoolsVoterAbi, "gauges", [p])),
    { blockNumber },
  );
  const live = gauges.map((g) => orNull(g)).filter((g): g is Address => g !== null && g !== ZERO);
  const rewardSets = await ctx.reader.settle(
    live.flatMap((g) => [
      call(voter, mezoPoolsVoterAbi, "gaugeToFees", [g]),
      call(voter, mezoPoolsVoterAbi, "gaugeToBribe", [g]),
    ]),
    { blockNumber },
  );
  const rewardContracts = [
    ...new Set(rewardSets.map((r) => orNull(r)).filter((r): r is Address => r !== null && r !== ZERO)),
  ];

  const lengths = await ctx.reader.settle(
    rewardContracts.map((r) => call(r, votingRewardAbi, "rewardsListLength")),
    { blockNumber },
  );
  const tokenCalls = rewardContracts.flatMap((r, k) => {
    const n = Number(orNull(lengths[k]!) ?? 0n);
    return Array.from({ length: n }, (_, i) => ({ reward: r, call: call(r, votingRewardAbi, "rewards", [BigInt(i)]) }));
  });
  const tokenAddrs = await ctx.reader.settle(
    tokenCalls.map((t) => t.call),
    { blockNumber },
  );
  const ve = d.external.veBTC.toLowerCase();
  const pairs = tokenCalls
    .map((t, k) => ({ reward: t.reward, token: orNull(tokenAddrs[k]!) }))
    .filter((p): p is { reward: Address; token: Address } => p.token !== null && p.token.toLowerCase() !== ve);
  const [earnedS, rebaseS] = await Promise.all([
    ctx.reader.settle(
      pairs.map((p) => call(p.reward, votingRewardAbi, "earned", [p.token, tokenId])),
      { blockNumber },
    ),
    ctx.reader.settle([call(d.external.rewardsDistributor, rewardsDistributorAbi, "claimable", [tokenId])], {
      blockNumber,
    }),
  ]);
  const earned = pairs
    .map((p, k) => ({ ...p, amount: orNull(earnedS[k]!) ?? 0n }))
    .filter((e) => e.amount > 0n);

  const rewards: Address[] = [];
  const tokens: Address[][] = [];
  for (const e of earned) {
    const i = rewards.indexOf(e.reward);
    if (i < 0) {
      rewards.push(e.reward);
      tokens.push([e.token]);
    } else if (!tokens[i]!.includes(e.token)) {
      tokens[i]!.push(e.token);
    }
  }
  const claimableRebase = orNull(rebaseS[0]!) ?? 0n;
  return {
    loanId,
    tokenId,
    autoRepay: loan.autoRepay,
    pools,
    rewards,
    tokens,
    earned,
    claimableRebase,
    worthHarvesting: earned.length > 0 || claimableRebase > 0n,
  };
}

// Example-data mode (?demo=1): every page reads from the SDK's mocked testnet fixture
// (@surety/sdk/testing) through the same SuretyClient the live app uses. The fixture covers the protocol
// views, v2 included (the MUSD peg, savings, ShareMarket, harvests); the few wallet-level reads the app adds
// (balances, allowances, a Morpho position, the reserve, the stress oracle, Mezo's pools, the treasury) are mocked
// here on top of it. Loaded with a dynamic import, so the live bundle never carries it.
import {
  createSuretyClient,
  erc20Abi,
  mezoPoolsVoterAbi,
  morphoMarketV1AdapterV2Abi,
  rewardsDistributorAbi,
  stressedPriceSourceAbi,
  suretyPoolAbi,
  type SuretyClient,
  type SuretyDeployment,
} from "@surety/sdk";
import {
  ALICE,
  createMockChain,
  createSuretyFixture,
  fakeAddress,
  fixtureDeployment,
  mockLog,
  MockRevert,
  type FixtureState,
  type MockContract,
} from "@surety/sdk/testing";
import type { Abi, Address, Hex } from "viem";

import { poolMetaAbi, poolsVoterAbi, votingRewardAbi } from "./mezoAbis";

/**
 * default: the v2 fixture with its past losses covered. stale: the BTC price feed is down, so lines fail closed.
 * paused: a recorded loss waits for cover, so the DepositGate holds deposits, claims, refunds and the share market.
 * depeg: MUSD trades off its peg, so the breaker refuses new loans and new allocations. v1: the first contracts,
 * without the peg, the fees, savings or the share market.
 */
export type DemoScenario = "default" | "stale" | "paused" | "depeg" | "v1";

export const DEMO_SCENARIOS: readonly DemoScenario[] = ["default", "stale", "paused", "depeg", "v1"];

export interface Demo {
  client: SuretyClient;
  deployment: SuretyDeployment;
  account: Address;
  state: FixtureState;
}

const e18 = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The treasury's own balances, so the business page has something to show. */
const TREASURY_MUSD = e18(18.37);
const TREASURY_SHARES = e18(0.42);
const TREASURY_BTC = e18(0.0003);
/** Who started the auctions, paid the keeper share of their liquidation fee. */
const KEEPER = fakeAddress(0x4ee);

/**
 * The scenario to build. The app shell may pass only the scenarios it knew of first and "default" for any other,
 * so a newer one named in the URL (?demo=depeg) wins over "default".
 */
function resolve(scenario: DemoScenario): DemoScenario {
  if (scenario !== "default" || typeof window === "undefined") return scenario;
  const asked = new URLSearchParams(window.location.search).get("demo");
  return DEMO_SCENARIOS.find((s) => s === asked) ?? scenario;
}

/** One ABI from several, keeping the first item of each name (the mock looks functions up by name). */
function mergeAbis(...abis: readonly Abi[]): Abi {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const abi of abis) {
    for (const item of abi) {
      const key = "name" in item ? `${item.type}:${item.name}` : item.type;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out as Abi;
}

/** Twelve more ShareMarket listings, one of them Alice's, so the market page has pages to turn. */
function sampleListings(): FixtureState["shareMarket"]["listings"] {
  const discounts = [120, 300, 75, 150, 600, 25, 90, 400, 180, 60, 250, 110];
  const sizes = [250, 80, 30, 500, 60, 1_000, 45, 20, 150, 75, 300, 90];
  return discounts.map((d, i) => ({
    id: BigInt(4 + i),
    seller: i === 5 ? ALICE : fakeAddress(0xa100 + i),
    discountBps: d,
    shares: e18(sizes[i]!),
  }));
}

export function createDemo(requested: DemoScenario): Demo {
  const scenario = resolve(requested);
  const v2 = scenario !== "v1";
  const fixture = createSuretyFixture({
    version: v2 ? 2 : 1,
    patch: (s) => {
      const cur = s.now - (s.now % s.epochLength);
      const prev = cur - s.epochLength;
      // The veBTC line took a loss that was covered by slashing its seasoning cohort. In the paused scenario only
      // part of it is covered yet, so the gate holds new shares until the rest is (SuretyPool.depositsPaused).
      s.pool.lossRecorded[1] = e18(14);
      s.pool.lossCovered[1] = scenario === "paused" ? e18(4) : e18(14);
      s.pool.depositsPaused = scenario === "paused";
      // Same stress: Alice's veBTC loan is in its Dutch auction, so the escrow can no longer vote on Mezo.
      if (scenario === "paused" && s.loans[0]) {
        s.loans[0].state = 2;
        s.loans[0].auctionStart = s.now - 120n;
        s.loans[0].keeper = KEEPER;
      }
      // Alice lets her loan's Mezo rewards repay it; a keeper started Bob's auction.
      if (s.loans[0]) s.loans[0].autoRepay = true;
      if (s.loans[1]) s.loans[1].keeper = KEEPER;
      s.extraLogs.push(
        mockLog({
          abi: suretyPoolAbi,
          eventName: "CohortSlashed",
          args: { lineId: 1n, epoch: prev, shares: s.pool.lossCovered[1]! },
          address: fixtureDeployment.contracts.suretyPool,
          blockNumber: 16_390_000n,
        }),
      );
      // An incentive posted two epochs ago for a line that drew no votes: refundable.
      s.pool.incentiveShares[`1:${cur - 2n * s.epochLength}`] = e18(25);
      if (scenario === "stale") s.priceWad = null;

      // v2: more ShareMarket listings; the market closes while the gate holds new shares.
      s.shareMarket.listings.push(...sampleListings());
      s.shareMarket.isOpen = scenario !== "paused";
      // MUSD drifts under its peg on every pool and the testnet switch is pushed to $0.95: the median leaves the
      // band, so new loans and new allocations stop.
      if (scenario === "depeg") {
        s.peg.readings = [e18(0.962), e18(0.958), e18(0.95)];
        s.peg.stress = { musdUsdWad: e18(0.95), endsAt: s.now + 5_400n };
      }
    },
  });
  const s = fixture.state;
  const d = fixture.deployment;
  const c = d.contracts;
  const treasury = c.treasury ?? null;
  const isTreasury = (a: Address) => !!treasury && same(a, treasury);

  const vaultShares = (owner: Address) => (same(owner, ALICE) ? e18(1_200) : isTreasury(owner) ? TREASURY_SHARES : 0n);
  const toShares = (assets: bigint, up = false) => {
    if (s.vault.totalAssets === 0n) return assets;
    const n = assets * s.vault.totalSupply;
    return up ? (n + s.vault.totalAssets - 1n) / s.vault.totalAssets : n / s.vault.totalAssets;
  };

  // VaultV2 caps per id: the veBTC line sits at its absolute cap, the Morpho line has room.
  const id = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;
  const caps: Record<string, { abs: bigint; alloc: bigint }> = {
    [id(0xa1)]: { abs: e18(3_600), alloc: e18(3_600) },
    [id(0xa2)]: { abs: e18(10_000), alloc: e18(3_600) },
    [id(0xb1)]: { abs: e18(8_000), alloc: e18(5_400) },
    [id(0xb2)]: { abs: e18(10_000), alloc: e18(5_400) },
    [id(0xb3)]: { abs: e18(8_000), alloc: e18(5_400) },
  };

  // The BTC price goes through a StressedPriceSource: the price source itself on v1, its BTC/USD source on v2.
  const stressSource = c.btcUsdSource ?? c.priceSource;

  const extra: Record<string, Partial<MockContract>> = {
    [d.external.musd.toLowerCase()]: {
      functions: {
        balanceOf: (a: Address) =>
          same(a, c.vault) ? s.vault.idle : same(a, ALICE) ? e18(2_500) : isTreasury(a) ? TREASURY_MUSD : 0n,
        allowance: () => 0n,
        decimals: 18,
        symbol: "MUSD",
      },
    },
    [c.vault.toLowerCase()]: {
      functions: {
        balanceOf: (a: Address) => vaultShares(a),
        allowance: () => 0n,
        convertToShares: (x: bigint) => toShares(x),
        previewDeposit: (x: bigint) => toShares(x),
        previewWithdraw: (x: bigint) => toShares(x, true),
        // VaultV2 answers zero to every max* view; the app works out what is withdrawable itself.
        maxWithdraw: () => 0n,
        maxRedeem: () => 0n,
        absoluteCap: (k: Hex) => caps[k]?.abs ?? 0n,
        relativeCap: () => 10n ** 18n,
        allocation: (k: Hex) => caps[k]?.alloc ?? 0n,
      },
    },
    [c.veBTCLine.toLowerCase()]: {
      functions: {
        ids: () => [id(0xa1), id(0xa2)],
      },
    },
    // Listing is past its bootstrap: a second Morpho market is proposed and waits out the line timelock.
    [c.creditVoter.toLowerCase()]: {
      functions: {
        bootstrapEnded: true,
        LINE_TIMELOCK: 86_400n,
        proposalCount: 1n,
        proposal: (i: bigint) => {
          if (i !== 0n) throw new MockRevert("0x", "UnknownProposal");
          return {
            adapter: c.morphoAdapter,
            data: "0x",
            kind: 0,
            name: "BTC / MUSD 77% LLTV (Morpho)",
            executableAt: s.now + 14n * 3600n,
          };
        },
      },
    },
    [c.suretyPool.toLowerCase()]: {
      functions: {
        reserveShares: () => e18(12),
        sponsorShares: (l: bigint, e: bigint, who: Address) =>
          same(who, ALICE) ? (s.pool.incentiveShares[`${l}:${e}`] ?? 0n) : 0n,
      },
    },
    [c.morpho.toLowerCase()]: {
      functions: {
        position: (_id: Hex, user: Address) =>
          same(user, ALICE)
            ? { supplyShares: 0n, borrowShares: e18(1_200) * 10n ** 6n, collateral: e18(0.05) }
            : { supplyShares: 0n, borrowShares: 0n, collateral: 0n },
        isAuthorized: () => false,
      },
    },
    [d.external.veBTC.toLowerCase()]: {
      functions: {
        getApproved: () => ZERO,
        isApprovedOrOwner: () => false,
      },
    },
    [stressSource.toLowerCase()]: {
      abi: stressedPriceSourceAbi,
      functions: {
        haircutBps: 0,
        shockEndsAt: 0n,
        MAX_HAIRCUT_BPS: 9000,
        MAX_SHOCK_DURATION: 7200,
        base: c.skipSource,
      },
    },
  };

  const base = fixture.chain.options;
  const contracts: MockContract[] = base.contracts.map((contract) => {
    const add = extra[contract.address.toLowerCase()];
    if (!add) return contract;
    return {
      address: contract.address,
      abi: add.abi ?? contract.abi,
      functions: { ...contract.functions, ...add.functions },
    };
  });
  contracts.push(
    {
      address: c.morphoAdapter,
      abi: morphoMarketV1AdapterV2Abi,
      functions: { ids: () => [id(0xb1), id(0xb2), id(0xb3)] },
    },
    {
      address: d.external.btc,
      abi: erc20Abi,
      functions: {
        balanceOf: (a: Address) => (same(a, ALICE) ? e18(0.25) : isTreasury(a) ? TREASURY_BTC : 0n),
        allowance: () => 0n,
        decimals: 18,
        symbol: "BTC",
      },
    },
    {
      address: c.skipSource,
      abi: stressedPriceSourceAbi,
      functions: {
        priceWad: () => {
          if (s.priceWad === null) throw new MockRevert("0x", "StalePrice");
          return s.priceWad;
        },
      },
    },
  );

  // Mezo's PoolsVoter with three pools. Alice's escrowed veBTC #11 (loan 1) votes 70/30 for the first and third
  // pool and has earned their fees, a MEZO bribe and a MUSD bribe, plus its veBTC rebase.
  const WEEK = 604_800n;
  const MEZO = fakeAddress(0x341);
  const pools = [
    { pool: fakeAddress(0x301), gauge: fakeAddress(0x311), fees: fakeAddress(0x321), bribe: fakeAddress(0x331), symbol: "vAMM-MUSD/BTC" },
    { pool: fakeAddress(0x302), gauge: fakeAddress(0x312), fees: fakeAddress(0x322), bribe: fakeAddress(0x332), symbol: null },
    { pool: fakeAddress(0x303), gauge: fakeAddress(0x313), fees: fakeAddress(0x323), bribe: fakeAddress(0x333), symbol: "sAMM-MUSD/mUSDC" },
  ];
  const poolBy = (a: Address) => pools.find((p) => same(p.pool, a));
  const gaugeBy = (a: Address) => pools.find((p) => same(p.gauge, a));
  const VOTED = 11n;
  const voteOf: Record<string, bigint> = {
    [pools[0]!.pool.toLowerCase()]: e18(0.035),
    [pools[2]!.pool.toLowerCase()]: e18(0.015),
  };
  const votedPools = pools.filter((p) => voteOf[p.pool.toLowerCase()]).map((p) => p.pool);
  const musd = d.external.musd.toLowerCase();
  const earned: Record<string, Record<string, bigint>> = {
    [pools[0]!.fees.toLowerCase()]: { [musd]: e18(1.84), [d.external.btc.toLowerCase()]: e18(0.00002) },
    [pools[0]!.bribe.toLowerCase()]: { [MEZO.toLowerCase()]: e18(42) },
    [pools[2]!.fees.toLowerCase()]: { [musd]: e18(0.62) },
    [pools[2]!.bribe.toLowerCase()]: { [musd]: e18(5) },
  };
  const rewardTokens: Record<string, Address[]> = {
    [pools[0]!.fees.toLowerCase()]: [d.external.musd, d.external.btc],
    [pools[0]!.bribe.toLowerCase()]: [MEZO],
    [pools[1]!.fees.toLowerCase()]: [d.external.musd, d.external.btc],
    [pools[2]!.fees.toLowerCase()]: [d.external.musd],
    [pools[2]!.bribe.toLowerCase()]: [d.external.musd],
  };
  contracts.push(
    {
      address: d.external.poolsVoter,
      abi: mergeAbis(poolsVoterAbi as Abi, mezoPoolsVoterAbi as Abi),
      functions: {
        length: BigInt(pools.length),
        pools: (i: bigint) => pools[Number(i)]?.pool ?? ZERO,
        gauges: (a: Address) => poolBy(a)?.gauge ?? ZERO,
        isAlive: (g: Address) => !!gaugeBy(g),
        gaugeToFees: (g: Address) => gaugeBy(g)?.fees ?? ZERO,
        gaugeToBribe: (g: Address) => gaugeBy(g)?.bribe ?? ZERO,
        votes: (tokenId: bigint, a: Address) => (tokenId === VOTED ? (voteOf[a.toLowerCase()] ?? 0n) : 0n),
        poolVote: (tokenId: bigint, i: bigint) => {
          const p = tokenId === VOTED ? votedPools[Number(i)] : undefined;
          if (!p) throw new MockRevert();
          return p;
        },
        lastVoted: () => 0n,
        maxVotingNum: 30n,
        epochStart: (t: bigint) => t - (t % WEEK),
        epochVoteStart: (t: bigint) => t - (t % WEEK) + 3600n,
        epochVoteEnd: (t: bigint) => t - (t % WEEK) + WEEK - 3600n,
      },
    },
    {
      address: d.external.rewardsDistributor,
      abi: rewardsDistributorAbi,
      functions: { claimable: (tokenId: bigint) => (tokenId === VOTED ? e18(0.00041) : 0n) },
    },
    ...pools.map((p) => ({
      address: p.pool,
      abi: poolMetaAbi,
      functions: p.symbol
        ? { symbol: p.symbol }
        : { token0: d.external.musd, token1: d.external.btc, tickSpacing: 200 },
    })),
    ...pools.flatMap((p) =>
      [p.fees, p.bribe].map((r) => ({
        address: r,
        abi: votingRewardAbi,
        functions: {
          rewardsListLength: BigInt(rewardTokens[r.toLowerCase()]?.length ?? 0),
          rewards: (i: bigint) => rewardTokens[r.toLowerCase()]?.[Number(i)] ?? ZERO,
          earned: (token: Address, tokenId: bigint) =>
            tokenId === VOTED ? (earned[r.toLowerCase()]?.[token.toLowerCase()] ?? 0n) : 0n,
        },
      })),
    ),
    {
      address: MEZO,
      abi: erc20Abi,
      functions: { symbol: "MEZO", decimals: 18 },
    },
  );

  const chain = createMockChain({
    chain: base.chain,
    blockNumber: s.blockNumber,
    timestamp: s.now,
    contracts,
    logs: base.logs,
  });
  const client = createSuretyClient({ chainId: d.chainId, publicClient: chain.client, deployment: d });
  return { client, deployment: d, account: ALICE, state: s };
}

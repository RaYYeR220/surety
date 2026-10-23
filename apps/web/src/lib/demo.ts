// Example-data mode (?demo=1): every page reads from the SDK's mocked testnet fixture
// (@surety/sdk/testing) through the same SuretyClient the live app uses. The fixture covers the protocol
// views; the few wallet-level reads the app adds (balances, allowances, a Morpho position, the reserve,
// the stress oracle) are mocked here on top of it. Loaded with a dynamic import, so the live bundle never
// carries it.
import {
  createSuretyClient,
  erc20Abi,
  morphoMarketV1AdapterV2Abi,
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
import type { Address, Hex } from "viem";

import { poolMetaAbi, poolsVoterAbi, votingRewardAbi } from "./mezoAbis";

/** default: the fixture as shipped. stale: the BTC price feed is down, so lines fail closed. */
export type DemoScenario = "default" | "stale";

export interface Demo {
  client: SuretyClient;
  deployment: SuretyDeployment;
  account: Address;
  state: FixtureState;
}

const e18 = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function createDemo(scenario: DemoScenario): Demo {
  const fixture = createSuretyFixture({
    patch: (s) => {
      const cur = s.now - (s.now % s.epochLength);
      const prev = cur - s.epochLength;
      // The veBTC line's recorded loss was partly covered by slashing its seasoning cohort.
      s.pool.lossRecorded[1] = e18(14);
      s.pool.lossCovered[1] = e18(4);
      s.extraLogs.push(
        mockLog({
          abi: suretyPoolAbi,
          eventName: "CohortSlashed",
          args: { lineId: 1n, epoch: prev, shares: e18(4) },
          address: fixtureDeployment.contracts.suretyPool,
          blockNumber: 16_390_000n,
        }),
      );
      // An incentive posted two epochs ago for a line that drew no votes: refundable.
      s.pool.incentiveShares[`1:${cur - 2n * s.epochLength}`] = e18(25);
      if (scenario === "stale") s.priceWad = null;
    },
  });
  const s = fixture.state;
  const d = fixture.deployment;
  const c = d.contracts;

  const vaultShares = (owner: Address) => (same(owner, ALICE) ? e18(1_200) : 0n);
  const toAssets = (shares: bigint) =>
    s.vault.totalSupply === 0n ? shares : (shares * s.vault.totalAssets) / s.vault.totalSupply;
  const toShares = (assets: bigint, up = false) => {
    if (s.vault.totalAssets === 0n) return assets;
    const n = assets * s.vault.totalSupply;
    return up ? (n + s.vault.totalAssets - 1n) / s.vault.totalAssets : n / s.vault.totalAssets;
  };
  const minOf = (a: bigint, b: bigint) => (a < b ? a : b);

  // VaultV2 caps per id: the veBTC line sits at its absolute cap, the Morpho line has room.
  const id = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;
  const caps: Record<string, { abs: bigint; alloc: bigint }> = {
    [id(0xa1)]: { abs: e18(3_600), alloc: e18(3_600) },
    [id(0xa2)]: { abs: e18(10_000), alloc: e18(3_600) },
    [id(0xb1)]: { abs: e18(8_000), alloc: e18(5_400) },
    [id(0xb2)]: { abs: e18(10_000), alloc: e18(5_400) },
    [id(0xb3)]: { abs: e18(8_000), alloc: e18(5_400) },
  };

  const extra: Record<string, Partial<MockContract>> = {
    [d.external.musd.toLowerCase()]: {
      functions: {
        balanceOf: (a: Address) => (same(a, c.vault) ? s.vault.idle : same(a, ALICE) ? e18(2_500) : 0n),
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
        maxWithdraw: (a: Address) => minOf(toAssets(vaultShares(a)), s.vault.idle),
        maxRedeem: (a: Address) => minOf(vaultShares(a), toShares(s.vault.idle)),
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
    [c.priceSource.toLowerCase()]: {
      // The testnet deployment wraps the Skip source in a StressedPriceSource.
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
        balanceOf: (a: Address) => (same(a, ALICE) ? e18(0.25) : 0n),
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

  // Mezo's PoolsVoter with three pools. Alice's escrowed veBTC #11 (loan 1) votes for the first pool and has
  // earned its fees and a sponsor bribe.
  const WEEK = 604_800n;
  const MEZO = fakeAddress(0x341);
  const pools = [
    { pool: fakeAddress(0x301), gauge: fakeAddress(0x311), fees: fakeAddress(0x321), bribe: fakeAddress(0x331), symbol: "vAMM-MUSD/BTC" },
    { pool: fakeAddress(0x302), gauge: fakeAddress(0x312), fees: fakeAddress(0x322), bribe: fakeAddress(0x332), symbol: null },
    { pool: fakeAddress(0x303), gauge: fakeAddress(0x313), fees: fakeAddress(0x323), bribe: fakeAddress(0x333), symbol: "sAMM-MUSD/mUSDC" },
  ];
  const poolBy = (a: Address) => pools.find((p) => same(p.pool, a));
  const gaugeBy = (a: Address) => pools.find((p) => same(p.gauge, a));
  const earned: Record<string, Record<string, bigint>> = {
    [pools[0]!.fees.toLowerCase()]: { [d.external.musd.toLowerCase()]: e18(1.84), [d.external.btc.toLowerCase()]: e18(0.00002) },
    [pools[0]!.bribe.toLowerCase()]: { [MEZO.toLowerCase()]: e18(42) },
  };
  const rewardTokens: Record<string, Address[]> = {
    [pools[0]!.fees.toLowerCase()]: [d.external.musd, d.external.btc],
    [pools[0]!.bribe.toLowerCase()]: [MEZO],
    [pools[1]!.fees.toLowerCase()]: [d.external.musd, d.external.btc],
    [pools[2]!.fees.toLowerCase()]: [d.external.musd],
  };
  contracts.push(
    {
      address: d.external.poolsVoter,
      abi: poolsVoterAbi,
      functions: {
        length: BigInt(pools.length),
        pools: (i: bigint) => pools[Number(i)]?.pool ?? ZERO,
        gauges: (a: Address) => poolBy(a)?.gauge ?? ZERO,
        isAlive: (g: Address) => !!gaugeBy(g),
        gaugeToFees: (g: Address) => gaugeBy(g)?.fees ?? ZERO,
        gaugeToBribe: (g: Address) => gaugeBy(g)?.bribe ?? ZERO,
        votes: (tokenId: bigint, a: Address) => (tokenId === 11n && same(a, pools[0]!.pool) ? e18(0.05) : 0n),
        lastVoted: () => 0n,
        maxVotingNum: 30n,
        epochStart: (t: bigint) => t - (t % WEEK),
        epochVoteStart: (t: bigint) => t - (t % WEEK) + 3600n,
        epochVoteEnd: (t: bigint) => t - (t % WEEK) + WEEK - 3600n,
      },
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
          earned: (token: Address, tokenId: bigint) => (tokenId === 11n ? (earned[r.toLowerCase()]?.[token.toLowerCase()] ?? 0n) : 0n),
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

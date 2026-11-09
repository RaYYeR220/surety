import { encodeAbiParameters, getAddress, type Address, type Hex } from "viem";

import type { Abi } from "viem";

import {
  adaptiveCurveIrmAbi,
  btcMusdPriceSourceAbi,
  clTwapPegSourceAbi,
  creditVoterAbi,
  erc20Abi,
  linearKinkIrmAbi,
  mezoPoolsVoterAbi,
  morphoAbi,
  morphoPriceOracleAbi,
  musdPegAbi,
  musdSavingsRateAbi,
  rewardsDistributorAbi,
  savingsAdapterAbi,
  shareMarketAbi,
  skipPriceSourceAbi,
  sponsorAbi,
  stableTwapPegSourceAbi,
  stressedPegSourceAbi,
  suretyPoolAbi,
  tigrisBasicPoolAbi,
  vaultV2Abi,
  veBTCAbi,
  veBTCCreditLineAbi,
  veBTCCreditLineV1Abi,
  voteAllocatorAbi,
  votingRewardAbi,
} from "../abis/index.js";
import { mezoTestnet } from "../chains.js";
import { createSuretyClient, type SuretyClient } from "../client.js";
import type { MarketParams, SuretyDeployment, SuretyDeploymentV2 } from "../deployments/types.js";
import {
  auctionPrice,
  BPS,
  btcInMusdWad,
  collateralValue,
  pegDivisorWad,
  pegHealth,
  shareFillPrice,
  WAD,
} from "../math.js";
import { marketIdOf } from "../reads.js";
import { createMockChain, mockLog, MockRevert, type MockChain, type RpcLog } from "./mock.js";

/** Deterministic fake address `0x5e7e…{n}`. */
export function fakeAddress(n: number): Address {
  return getAddress(`0x5e7e${n.toString(16).padStart(36, "0")}`);
}

const e18 = (x: number | bigint) => BigInt(x) * WAD;

export const FIXTURE_EPOCH_LENGTH = 3600n;
/** A testnet epoch start (multiple of 3600). */
export const FIXTURE_EPOCH = 1_792_771_200n;

export const fixtureMarketParams: MarketParams = {
  loanToken: fakeAddress(0x101),
  collateralToken: fakeAddress(0x102),
  oracle: fakeAddress(0x0d),
  irm: fakeAddress(0x04),
  lltv: 860_000_000_000_000_000n,
};

/** A testnet deployment with distinct fake addresses, for mocked chains. */
export const fixtureDeployment: SuretyDeployment = {
  version: 1,
  chainId: 31611,
  epochLength: Number(FIXTURE_EPOCH_LENGTH),
  deployedAt: 16_300_000n,
  contracts: {
    vault: fakeAddress(0x01),
    morphoAdapter: fakeAddress(0x02),
    morpho: fakeAddress(0x03),
    irm: fakeAddress(0x04),
    creditVoter: fakeAddress(0x05),
    voteAllocator: fakeAddress(0x06),
    suretyPool: fakeAddress(0x07),
    veBTCLine: fakeAddress(0x08),
    loanEscrowImpl: fakeAddress(0x09),
    irmLine: fakeAddress(0x0a),
    priceSource: fakeAddress(0x0b),
    skipSource: fakeAddress(0x0c),
    morphoOracle: fakeAddress(0x0d),
  },
  external: {
    musd: fakeAddress(0x101),
    btc: fakeAddress(0x102),
    veBTC: fakeAddress(0x103),
    poolsVoter: fakeAddress(0x104),
    rewardsDistributor: fakeAddress(0x105),
    skipAggregator: fakeAddress(0x106),
  },
  lines: [
    {
      id: 0,
      kind: "Morpho",
      name: "BTC / MUSD (Morpho)",
      adapter: fakeAddress(0x02),
      marketId: marketIdOf(fixtureMarketParams),
      marketParams: fixtureMarketParams,
    },
    { id: 1, kind: "VeBTC", name: "veBTC credit line", adapter: fakeAddress(0x08) },
  ],
  proof: { txs: [] },
};

/** Fake addresses of the v2 fixture's Mezo vote-reward contracts and a stablecoin. */
export const FIXTURE_POOL = fakeAddress(0x201);
export const FIXTURE_GAUGE = fakeAddress(0x202);
export const FIXTURE_FEES = fakeAddress(0x203);
export const FIXTURE_BRIBE = fakeAddress(0x204);
export const FIXTURE_USDC = fakeAddress(0x205);

/** The fixture deployment in the v2 schema: the same core plus the peg, savings, ShareMarket and Sponsor. */
export const fixtureDeploymentV2: SuretyDeploymentV2 = {
  ...fixtureDeployment,
  version: 2,
  contracts: {
    ...fixtureDeployment.contracts,
    depositGate: fakeAddress(0x0e),
    btcMusdSource: fakeAddress(0x0b),
    btcUsdSource: fakeAddress(0x10),
    musdPeg: fakeAddress(0x11),
    stressedPegSource: fakeAddress(0x12),
    savingsAdapter: fakeAddress(0x13),
    shareMarket: fakeAddress(0x14),
    sponsor: fakeAddress(0x15),
    treasury: fakeAddress(0x16),
  },
  external: { ...fixtureDeployment.external, smusd: fakeAddress(0x107) },
  stress: true,
  timelock: 0,
  morphoMarketId: marketIdOf(fixtureMarketParams),
  lineParams: {
    maxLtvTimedBps: 5000,
    maxLtvPermanentBps: 4000,
    liqLtvBps: 6500,
    liqFeeBps: 300,
    floorBps: 8500,
    auctionDuration: 600,
    minTerm: 3600,
    originationFeeBps: 25,
    protocolShareBps: 2000,
    keeperShareBps: 5000,
  },
  peg: { minSources: 2, maxSpreadBps: 1000, bandBps: 300, maxPremiumBps: 300 },
  pegSources: [
    { kind: "ClTwap", address: fakeAddress(0x20), pool: fakeAddress(0x30), window: 1800, minLiquidity: 10n ** 19n },
    { kind: "StableTwap", address: fakeAddress(0x21), pool: fakeAddress(0x31), granularity: 2, maxAge: 21_600 },
    { kind: "Stressed", address: fakeAddress(0x12), base: "0x0000000000000000000000000000000000000000" },
  ],
  fees: {
    performanceFee: 10n ** 17n,
    performanceFeeRecipient: fakeAddress(0x07),
    managementFee: 63_419_583n,
    managementFeeRecipient: fakeAddress(0x16),
    forceDeallocatePenalty: 10n ** 16n,
    shareMarketFeeBps: 10,
  },
  caps: { morpho: 10n ** 25n, line: 10n ** 25n, savings: 10n ** 27n },
  sponsorKit: {
    relayer: fakeAddress(0x17),
    btcGas: 5n * 10n ** 13n,
    lockAmount: 10n ** 15n,
    musd: 50n * WAD,
    lockDuration: 2_419_200,
    dailyLimit: 100,
    fundedBtc: 6n * 10n ** 15n,
    fundedMusd: 300n * WAD,
  },
};

export interface FixtureLock {
  amount: bigint;
  end: bigint;
  isPermanent: boolean;
  boost: bigint;
}

export interface FixtureLoan {
  borrower: Address;
  escrow: Address;
  tokenId: bigint;
  debt: bigint;
  /** 1 Active, 2 Auction, 3 Closed, 4 Liquidated. */
  state: number;
  auctionStart: bigint;
  openedAtBlock: bigint;
  amount: bigint;
  /** v2 only. */
  autoRepay?: boolean;
  /** v2 only: who started the auction. */
  keeper?: Address;
}

/** Mutable state behind the mocked contracts; handlers read it on every call. */
export interface FixtureState {
  blockNumber: bigint;
  now: bigint;
  epochLength: bigint;
  season: bigint;
  lines: { name: string; kind: 0 | 1; active: boolean; adapter: Address; data: Hex }[];
  /** `${epoch}:${lineId}` -> votes. */
  lineVotes: Record<string, bigint>;
  /** `${epoch}:${tokenId}:${lineId}` -> votes. */
  tokenVotes: Record<string, bigint>;
  ballots: Record<string, { lineIds: bigint[]; weightsBps: bigint[]; epochCast: bigint }>;
  activeTallyEpoch: bigint;
  lastRebalanceEpoch: bigint;
  idleBufferBps: bigint;
  lineAssets: bigint[];
  targets: bigint[];
  vault: {
    totalAssets: bigint;
    totalSupply: bigint;
    idle: bigint;
    performanceFee: bigint;
    managementFee: bigint;
    maxRate: bigint;
  };
  market: {
    totalSupplyAssets: bigint;
    totalSupplyShares: bigint;
    totalBorrowAssets: bigint;
    totalBorrowShares: bigint;
    lastUpdate: bigint;
    fee: bigint;
  };
  /** AdaptiveCurveIrm.borrowRateView result, or null to make it revert. */
  morphoBorrowRate: bigint | null;
  rateAtTarget: bigint;
  /** BTC/USD WAD, or null for a stale (reverting) oracle. */
  priceWad: bigint | null;
  line: { cash: bigint; paused: boolean; badDebtTotal: bigint };
  lineParams: {
    maxLtvTimedBps: number;
    maxLtvPermanentBps: number;
    liqLtvBps: number;
    liqFeeBps: number;
    floorBps: number;
    auctionDuration: number;
    minTerm: number;
    /** v2 fields; a v1 line does not return them. */
    originationFeeBps: number;
    protocolShareBps: number;
    keeperShareBps: number;
  };
  curve: { baseApr: bigint; kinkApr: bigint; maxApr: bigint; kinkUtilWad: bigint };
  pool: {
    incentiveShares: Record<string, bigint>;
    coverCapacity: bigint[];
    lossRecorded: bigint[];
    lossCovered: bigint[];
    /** `${lineId}:${epoch}` -> cohort shares. */
    cohorts: Record<string, bigint>;
    /** `${tokenId}:${lineId}:${epoch}` -> claimed. */
    claimed: Record<string, boolean>;
    /** Loss a `checkpoint(lineId)` would record now. */
    pendingLoss: bigint[];
    /** Whether each line has a supply-price high-water mark. */
    markSet: boolean[];
    /** What SuretyPool.depositsPaused reports. */
    depositsPaused: boolean;
  };
  /** Ballots cast, as `Voted` logs: token, voter, block. */
  votes: { tokenId: bigint; voter: Address; block: bigint }[];
  /** More logs for the mocked `eth_getLogs`. */
  extraLogs: RpcLog[];
  nfts: Record<string, { owner: Address; lock: FixtureLock; escrowType: number; grantManager: Address; voted: boolean }>;
  loans: FixtureLoan[];
  /* v2 only */
  peg: {
    /** Each source's answer, in the deployment's order; null = no usable reading. */
    readings: (bigint | null)[];
    /** Overrides MusdPeg.pegHealthy; null = compute it from the readings. */
    healthy: boolean | null;
    stress: { musdUsdWad: bigint; endsAt: bigint };
    /** The CL source's harmonic-mean window liquidity. */
    windowLiquidity: bigint;
    /** When the basic pool behind the StableTwap source last stored an observation. */
    poolObservedAt: bigint;
    /** The veBTC line's `pegCheck`. */
    lineCheck: boolean;
  };
  allocator: { parking: boolean };
  savings: { parked: bigint; claimableYield: bigint; yieldClaimed: bigint };
  treasury: Address;
  shareMarket: {
    feeBps: number;
    isOpen: boolean;
    listings: { id: bigint; seller: Address; discountBps: number; shares: bigint }[];
  };
  sponsor: {
    kitsLeft: bigint;
    dailyLimit: bigint;
    kits: { user: Address; tokenId: bigint; block: bigint }[];
  };
  /**
   * Mezo PoolsVoter: the pools each NFT votes on, each reward contract's tokens, and what it has earned per
   * `${token}:${tokenId}`; the distributor's claimable rebase per NFT.
   */
  mezo: {
    votes: Record<string, Address[]>;
    rewardTokens: Record<string, Address[]>;
    earned: Record<string, Record<string, bigint>>;
    rebase: Record<string, bigint>;
  };
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const ALICE = fakeAddress(0xa11ce);
export const BOB = fakeAddress(0xb0b);

export function defaultFixtureState(): FixtureState {
  const cur = FIXTURE_EPOCH;
  const L = FIXTURE_EPOCH_LENGTH;
  const prev = cur - L;
  const matured = cur - 6n * L; // maturity = epoch + (2 + 4) * L = cur
  const now = cur + 1800n;
  const day = 86_400n;
  return {
    blockNumber: 16_400_000n,
    now,
    epochLength: L,
    season: 4n,
    lines: [
      {
        name: "BTC / MUSD (Morpho)",
        kind: 0,
        active: true,
        adapter: fixtureDeployment.contracts.morphoAdapter,
        data: encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "loanToken", type: "address" },
                { name: "collateralToken", type: "address" },
                { name: "oracle", type: "address" },
                { name: "irm", type: "address" },
                { name: "lltv", type: "uint256" },
              ],
            },
          ],
          [fixtureMarketParams],
        ),
      },
      { name: "veBTC credit line", kind: 1, active: true, adapter: fixtureDeployment.contracts.veBTCLine, data: "0x" },
    ],
    lineVotes: {
      [`${cur}:0`]: 6n * 10n ** 17n,
      [`${cur}:1`]: 4n * 10n ** 17n,
      [`${prev}:0`]: 5n * 10n ** 17n,
      [`${prev}:1`]: 5n * 10n ** 17n,
      [`${matured}:0`]: 5n * 10n ** 17n,
    },
    tokenVotes: {
      [`${cur}:7:0`]: 6n * 10n ** 16n,
      [`${cur}:7:1`]: 4n * 10n ** 16n,
      [`${prev}:7:1`]: 1n * 10n ** 17n,
      [`${matured}:7:0`]: 1n * 10n ** 17n,
    },
    ballots: {
      "7": { lineIds: [0n, 1n], weightsBps: [6000n, 4000n], epochCast: cur },
      "9": { lineIds: [1n], weightsBps: [10000n], epochCast: prev },
    },
    activeTallyEpoch: prev,
    lastRebalanceEpoch: cur,
    idleBufferBps: 1000n,
    lineAssets: [e18(5_400), e18(3_600)],
    targets: [e18(5_400), e18(3_600)],
    vault: {
      totalAssets: e18(10_000),
      totalSupply: e18(9_900),
      idle: e18(1_000),
      performanceFee: 10n ** 17n,
      managementFee: 0n,
      maxRate: 0n,
    },
    market: {
      totalSupplyAssets: e18(8_000),
      totalSupplyShares: e18(8_000) * 10n ** 6n,
      totalBorrowAssets: e18(6_000),
      totalBorrowShares: e18(6_000) * 10n ** 6n,
      lastUpdate: now - 60n,
      fee: 0n,
    },
    morphoBorrowRate: (5n * 10n ** 16n) / 31_536_000n,
    rateAtTarget: (4n * 10n ** 16n) / 31_536_000n,
    priceWad: e18(80_000),
    line: { cash: e18(1_800), paused: false, badDebtTotal: 0n },
    lineParams: {
      maxLtvTimedBps: 5000,
      maxLtvPermanentBps: 4000,
      liqLtvBps: 7000,
      liqFeeBps: 300,
      floorBps: 7000,
      auctionDuration: 600,
      minTerm: 3600,
      originationFeeBps: 0,
      protocolShareBps: 0,
      keeperShareBps: 0,
    },
    curve: { baseApr: 2n * 10n ** 16n, kinkApr: 8n * 10n ** 16n, maxApr: 6n * 10n ** 17n, kinkUtilWad: 8n * 10n ** 17n },
    pool: {
      incentiveShares: { [`0:${cur}`]: e18(99) },
      coverCapacity: [e18(50), e18(40)],
      lossRecorded: [0n, e18(10)],
      lossCovered: [0n, 0n],
      cohorts: { [`1:${prev}`]: e18(20), [`0:${matured}`]: e18(25) },
      claimed: {},
      pendingLoss: [0n, 0n],
      markSet: [true, false],
      depositsPaused: false,
    },
    votes: [
      { tokenId: 9n, voter: ALICE, block: 16_305_000n },
      { tokenId: 7n, voter: ALICE, block: 16_320_000n },
    ],
    extraLogs: [],
    nfts: {
      "7": {
        owner: ALICE,
        lock: { amount: 5n * 10n ** 16n, end: now + 30n * day, isPermanent: false, boost: 0n },
        escrowType: 0,
        grantManager: ZERO,
        voted: false,
      },
      "9": {
        owner: ALICE,
        lock: { amount: 2n * 10n ** 16n, end: 0n, isPermanent: true, boost: 0n },
        escrowType: 0,
        grantManager: ZERO,
        voted: true,
      },
      "11": {
        owner: fakeAddress(0xe1),
        lock: { amount: 5n * 10n ** 16n, end: now + 60n * day, isPermanent: false, boost: 0n },
        escrowType: 0,
        grantManager: ZERO,
        voted: false,
      },
      "12": {
        owner: fakeAddress(0xe2),
        lock: { amount: 16n * 10n ** 15n, end: now + 60n * day, isPermanent: false, boost: 0n },
        escrowType: 0,
        grantManager: ZERO,
        voted: false,
      },
    },
    loans: [
      {
        borrower: ALICE,
        escrow: fakeAddress(0xe1),
        tokenId: 11n,
        debt: e18(1_500),
        state: 1,
        auctionStart: 0n,
        openedAtBlock: 16_315_000n,
        amount: e18(1_500),
      },
      {
        borrower: BOB,
        escrow: fakeAddress(0xe2),
        tokenId: 12n,
        debt: e18(1_000),
        state: 2,
        auctionStart: now - 300n,
        openedAtBlock: 16_325_000n,
        amount: e18(1_000),
      },
    ],
    peg: {
      readings: [991_440_000_000_000_000n, 991_250_000_000_000_000n, WAD],
      healthy: null,
      stress: { musdUsdWad: 0n, endsAt: 0n },
      windowLiquidity: 267n * 10n ** 18n,
      poolObservedAt: now - 1200n,
      lineCheck: true,
    },
    allocator: { parking: true },
    savings: { parked: e18(400), claimableYield: e18(1) / 100n, yieldClaimed: e18(2) / 100n },
    treasury: fakeAddress(0x16),
    shareMarket: {
      feeBps: 10,
      isOpen: true,
      listings: [
        { id: 1n, seller: ALICE, discountBps: 200, shares: e18(100) },
        { id: 3n, seller: BOB, discountBps: 50, shares: e18(40) },
      ],
    },
    sponsor: {
      kitsLeft: 4n,
      dailyLimit: 100n,
      kits: [{ user: fakeAddress(0xc0de), tokenId: 2001n, block: 16_390_000n }],
    },
    mezo: {
      votes: { "11": [FIXTURE_POOL] },
      rewardTokens: {
        [FIXTURE_FEES]: [FIXTURE_USDC, fakeAddress(0x101)],
        [FIXTURE_BRIBE]: [fakeAddress(0x101), fakeAddress(0x103)],
      },
      earned: {
        [FIXTURE_FEES]: { [`${FIXTURE_USDC}:11`]: 700_000n },
        [FIXTURE_BRIBE]: { [`${fakeAddress(0x101)}:11`]: e18(14) / 100n, [`${fakeAddress(0x103)}:11`]: 5n },
      },
      rebase: { "11": 1_000n },
    },
  };
}

export interface SuretyFixture {
  state: FixtureState;
  chain: MockChain;
  client: SuretyClient;
  deployment: SuretyDeployment;
}

/**
 * A mocked Mezo testnet with a two-line Surety deployment (a Morpho BTC line and the veBTC line), two veBTC
 * holders and two loans. `version: 2` uses the v2 deployment and line (fees, auto-repay) and adds the peg, savings,
 * ShareMarket, Sponsor and Mezo's vote-reward contracts. Mutate `state` to shape what the contracts return.
 */
export function createSuretyFixture(
  options: { patch?: (s: FixtureState) => void; multicall?: false; version?: 1 | 2 } = {},
): SuretyFixture {
  const s = defaultFixtureState();
  const version = options.version ?? 1;
  if (version === 2) {
    Object.assign(s.lineParams, fixtureDeploymentV2.lineParams);
    s.vault.managementFee = 63_419_583n;
  }
  options.patch?.(s);
  const d: SuretyDeployment = version === 2 ? fixtureDeploymentV2 : fixtureDeployment;
  const c = d.contracts;
  const cur = () => s.now - (s.now % s.epochLength);
  const price = () => {
    if (s.priceWad === null) throw new MockRevert("0x", "StalePrice");
    return s.priceWad;
  };
  const nft = (id: bigint) => s.nfts[id.toString()];
  const loanAt = (id: bigint) => s.loans[Number(id) - 1];
  const totalDebt = () => s.loans.filter((l) => l.state === 1 || l.state === 2).reduce((a, l) => a + l.debt, 0n);
  const sharesToAssets = (x: bigint) => (s.vault.totalSupply === 0n ? x : (x * s.vault.totalAssets) / s.vault.totalSupply);
  const lineCollateral = (id: bigint) => {
    const n = nft(id);
    return n ? collateralValue(n.lock.amount, price()) : 0n;
  };
  const ownedBy = (owner: Address) =>
    Object.entries(s.nfts)
      .filter(([, n]) => n.owner.toLowerCase() === owner.toLowerCase())
      .map(([id]) => BigInt(id));
  const lineUtil = () => {
    const debt = totalDebt();
    const supply = s.line.cash + debt;
    return supply === 0n ? 0n : (debt * WAD) / supply;
  };

  const pegReadings = () => s.peg.readings.map((r) => ({ ok: r !== null, musdUsdWad: r }));
  const pegIsHealthy = () => s.peg.healthy ?? pegHealth(pegReadings(), fixtureDeploymentV2.peg).healthy;
  const pegMedian = () => {
    const h = pegHealth(pegReadings(), fixtureDeploymentV2.peg);
    return h.available ? h.medianWad : null;
  };
  const healthyMedian = () => (pegIsHealthy() ? pegMedian() : null);
  const openListings = () => s.shareMarket.listings.filter((l) => l.shares > 0n);
  const v2Contracts = () => {
    const v = fixtureDeploymentV2;
    const vc = v.contracts;
    const pools = (tokenId: bigint) => s.mezo.votes[tokenId.toString()] ?? [];
    const rewardContract = (address: Address) => ({
      address,
      abi: votingRewardAbi as Abi,
      functions: {
        rewardsListLength: () => BigInt((s.mezo.rewardTokens[address] ?? []).length),
        rewards: (i: bigint) => {
          const t = (s.mezo.rewardTokens[address] ?? [])[Number(i)];
          if (!t) throw new MockRevert();
          return t;
        },
        earned: (token: Address, tokenId: bigint) => s.mezo.earned[address]?.[`${token}:${tokenId}`] ?? 0n,
      },
    });
    return [
      {
        address: vc.musdPeg,
        abi: musdPegAbi as Abi,
        functions: {
          readings: () =>
            v.pegSources.map((src, i) => ({
              source: src.address,
              ok: s.peg.readings[i] !== null && s.peg.readings[i] !== undefined,
              musdUsdWad: s.peg.readings[i] ?? 0n,
            })),
          pegHealthy: () => pegIsHealthy(),
          musdUsdWad: () => {
            const m = pegMedian();
            if (m === null) throw new MockRevert("0x", "PegUnavailable");
            return m;
          },
          minSources: () => BigInt(v.peg.minSources),
          maxSpreadBps: () => BigInt(v.peg.maxSpreadBps),
          bandBps: () => BigInt(v.peg.bandBps),
          sources: () => v.pegSources.map((src) => src.address),
        },
      },
      { address: vc.btcUsdSource, abi: skipPriceSourceAbi as Abi, functions: { priceWad: () => price() } },
      {
        address: v.pegSources[0]!.address,
        abi: clTwapPegSourceAbi as Abi,
        functions: { windowLiquidity: () => [true, s.peg.windowLiquidity], minLiquidity: () => 10n ** 19n },
      },
      {
        address: v.pegSources[1]!.address,
        abi: stableTwapPegSourceAbi as Abi,
        functions: {
          lastObservationAge: () => [true, s.now > s.peg.poolObservedAt ? s.now - s.peg.poolObservedAt : 0n],
          maxAge: () => 21_600,
        },
      },
      {
        address: v.pegSources[1]!.pool!,
        abi: tigrisBasicPoolAbi as Abi,
        functions: {
          lastObservation: () => ({ timestamp: s.peg.poolObservedAt, reserve0Cumulative: 0n, reserve1Cumulative: 0n }),
          periodSize: () => 1800n,
          sync: () => undefined,
        },
      },
      {
        address: vc.stressedPegSource!,
        abi: stressedPegSourceAbi as Abi,
        functions: {
          activeStress: () => {
            const active = s.now < s.peg.stress.endsAt;
            return [active, active ? s.peg.stress.musdUsdWad : 0n];
          },
          stressEndsAt: () => s.peg.stress.endsAt,
        },
      },
      {
        address: vc.savingsAdapter,
        abi: savingsAdapterAbi as Abi,
        functions: {
          realAssets: () => s.savings.parked,
          claimableYield: () => s.savings.claimableYield,
          yieldClaimed: () => s.savings.yieldClaimed,
          harvest: () => s.savings.claimableYield,
        },
      },
      {
        address: v.external.smusd,
        abi: musdSavingsRateAbi as Abi,
        functions: { balanceOf: () => s.savings.parked - s.savings.claimableYield },
      },
      {
        address: vc.shareMarket,
        abi: shareMarketAbi as Abi,
        functions: {
          feeBps: () => s.shareMarket.feeBps,
          isOpen: () => s.shareMarket.isOpen,
          openListingCount: () => BigInt(openListings().length),
          openListings: (start: bigint, count: bigint) => {
            const page = openListings().slice(Number(start), Number(start + count));
            return [
              page.map((l) => l.id),
              page.map((l) => ({ seller: l.seller, discountBps: l.discountBps, shares: l.shares })),
            ];
          },
          bestListing: () => {
            const open = openListings();
            if (open.length === 0) return [0n, 0, 0n, 0n];
            const best = open.reduce((a, l) =>
              l.discountBps > a.discountBps || (l.discountBps === a.discountBps && l.id < a.id) ? l : a,
            );
            const perShare = shareFillPrice(sharesToAssets(WAD), best.discountBps, s.shareMarket.feeBps).assets;
            return [best.id, best.discountBps, best.shares, perShare];
          },
          listing: (id: bigint) => {
            const l = s.shareMarket.listings.find((x) => x.id === id);
            return l
              ? { seller: l.seller, discountBps: l.discountBps, shares: l.shares }
              : { seller: ZERO, discountBps: 0, shares: 0n };
          },
          listingsOf: (seller: Address) =>
            openListings()
              .filter((l) => l.seller.toLowerCase() === seller.toLowerCase())
              .map((l) => l.id),
          quote: (id: bigint, shares: bigint) => {
            const l = s.shareMarket.listings.find((x) => x.id === id);
            const filled = l ? (shares < l.shares ? shares : l.shares) : 0n;
            if (!l || filled < 10n ** 12n) return [0n, 0n, 0n];
            const { assets, fee } = shareFillPrice(sharesToAssets(filled), l.discountBps, s.shareMarket.feeBps);
            return [filled, assets, fee];
          },
        },
      },
      {
        address: vc.sponsor!,
        abi: sponsorAbi as Abi,
        functions: {
          kitsIssued: () => BigInt(s.sponsor.kits.length),
          kitsLeft: () => s.sponsor.kitsLeft,
          dailyLimit: () => s.sponsor.dailyLimit,
          btcGas: () => v.sponsorKit!.btcGas,
          lockAmount: () => v.sponsorKit!.lockAmount,
          musdAmount: () => v.sponsorKit!.musd,
          lockDuration: () => BigInt(v.sponsorKit!.lockDuration),
        },
      },
      {
        address: v.external.poolsVoter,
        abi: mezoPoolsVoterAbi as Abi,
        functions: {
          poolVote: (tokenId: bigint, i: bigint) => {
            const p = pools(tokenId)[Number(i)];
            if (!p) throw new MockRevert();
            return p;
          },
          gauges: (pool: Address) => (pool.toLowerCase() === FIXTURE_POOL.toLowerCase() ? FIXTURE_GAUGE : ZERO),
          gaugeToFees: () => FIXTURE_FEES,
          gaugeToBribe: () => FIXTURE_BRIBE,
        },
      },
      rewardContract(FIXTURE_FEES),
      rewardContract(FIXTURE_BRIBE),
      {
        address: v.external.rewardsDistributor,
        abi: rewardsDistributorAbi as Abi,
        functions: { claimable: (tokenId: bigint) => s.mezo.rebase[tokenId.toString()] ?? 0n },
      },
    ];
  };

  const chain = createMockChain({
    chain: mezoTestnet,
    get blockNumber() {
      return s.blockNumber;
    },
    get timestamp() {
      return s.now;
    },
    logs: [
      ...s.loans.map((l, i) =>
        mockLog({
          abi: veBTCCreditLineAbi,
          eventName: "Opened",
          args: { loanId: BigInt(i + 1), borrower: l.borrower, tokenId: l.tokenId, amount: l.amount },
          address: c.veBTCLine,
          blockNumber: l.openedAtBlock,
        }),
      ),
      ...s.votes.map((v) => {
        const b = s.ballots[v.tokenId.toString()];
        return mockLog({
          abi: creditVoterAbi,
          eventName: "Voted",
          args: {
            epoch: b?.epochCast ?? 0n,
            tokenId: v.tokenId,
            voter: v.voter,
            power: 1n,
            lineIds: b?.lineIds ?? [],
            weightsBps: b?.weightsBps ?? [],
          },
          address: c.creditVoter,
          blockNumber: v.block,
        });
      }),
      ...(version === 2
        ? s.sponsor.kits.map((k) =>
            mockLog({
              abi: sponsorAbi,
              eventName: "StarterKit",
              args: {
                user: k.user,
                tokenId: k.tokenId,
                btcGas: fixtureDeploymentV2.sponsorKit!.btcGas,
                lockAmount: fixtureDeploymentV2.sponsorKit!.lockAmount,
                musd: fixtureDeploymentV2.sponsorKit!.musd,
              },
              address: fixtureDeploymentV2.contracts.sponsor!,
              blockNumber: k.block,
            }),
          )
        : []),
      ...s.extraLogs,
    ],
    contracts: [
      {
        address: c.creditVoter,
        abi: creditVoterAbi,
        functions: {
          EPOCH_LENGTH: () => s.epochLength,
          currentEpoch: () => cur(),
          lineCount: () => BigInt(s.lines.length),
          line: (i: bigint) => {
            const l = s.lines[Number(i)];
            if (!l) throw new MockRevert();
            return l;
          },
          lineVotes: (e: bigint, l: bigint) => s.lineVotes[`${e}:${l}`] ?? 0n,
          totalVotes: (e: bigint) =>
            Object.entries(s.lineVotes)
              .filter(([k]) => k.startsWith(`${e}:`))
              .reduce((a, [, v]) => a + v, 0n),
          tokenVotes: (e: bigint, t: bigint, l: bigint) => s.tokenVotes[`${e}:${t}:${l}`] ?? 0n,
          ballotOf: (t: bigint) => {
            const b = s.ballots[t.toString()];
            return b ? [b.lineIds, b.weightsBps, b.epochCast] : [[], [], 0n];
          },
        },
      },
      {
        address: c.voteAllocator,
        abi: voteAllocatorAbi,
        functions: {
          activeTallyEpoch: () => s.activeTallyEpoch,
          lastRebalanceEpoch: () => s.lastRebalanceEpoch,
          idleBufferBps: () => s.idleBufferBps,
          lineAssets: (i: bigint) => s.lineAssets[Number(i)] ?? 0n,
          targets: () => [s.targets.map((_, i) => BigInt(i)), s.targets],
          ...(version === 2
            ? {
                parking: () => s.allocator.parking,
                savings: () => c.savingsAdapter!,
                peg: () => c.musdPeg!,
                pegGateOpen: () => pegIsHealthy(),
              }
            : {}),
        },
      },
      {
        address: c.suretyPool,
        abi: suretyPoolAbi,
        functions: {
          SEASON: () => s.season,
          checkpoint: (l: bigint) => s.pool.pendingLoss[Number(l)] ?? 0n,
          highWaterMark: (l: bigint) => [0n, 0n, s.pool.markSet[Number(l)] ?? false, 0n],
          depositsPaused: () => s.pool.depositsPaused,
          cover: (l: bigint) => {
            const n = Number(l);
            const uncovered = (s.pool.lossRecorded[n] ?? 0n) - (s.pool.lossCovered[n] ?? 0n) + (s.pool.pendingLoss[n] ?? 0n);
            const capacity = s.pool.coverCapacity[n] ?? 0n;
            return uncovered < capacity ? uncovered : capacity;
          },
          incentiveShares: (l: bigint, e: bigint) => s.pool.incentiveShares[`${l}:${e}`] ?? 0n,
          coverCapacity: (l: bigint) => s.pool.coverCapacity[Number(l)] ?? 0n,
          uncoveredLoss: (l: bigint) => (s.pool.lossRecorded[Number(l)] ?? 0n) - (s.pool.lossCovered[Number(l)] ?? 0n),
          lossRecorded: (l: bigint) => s.pool.lossRecorded[Number(l)] ?? 0n,
          lossCovered: (l: bigint) => s.pool.lossCovered[Number(l)] ?? 0n,
          maturityOf: (e: bigint) => e + (2n + s.season) * s.epochLength,
          cohort: (l: bigint, e: bigint) => [s.pool.cohorts[`${l}:${e}`] ?? 0n, 0n, false],
          isClaimed: (t: bigint, l: bigint, e: bigint) => s.pool.claimed[`${t}:${l}:${e}`] ?? false,
          claimable: (t: bigint, l: bigint, e: bigint) => {
            if (s.now < e + (2n + s.season) * s.epochLength || s.pool.claimed[`${t}:${l}:${e}`]) return 0n;
            const votes = s.tokenVotes[`${e}:${t}:${l}`] ?? 0n;
            const total = s.lineVotes[`${e}:${l}`] ?? 0n;
            return total === 0n ? 0n : ((s.pool.cohorts[`${l}:${e}`] ?? 0n) * votes) / total;
          },
        },
      },
      {
        address: c.vault,
        abi: vaultV2Abi,
        functions: {
          name: "Surety MUSD",
          symbol: "srMUSD",
          decimals: 18,
          asset: () => d.external.musd,
          totalAssets: () => s.vault.totalAssets,
          totalSupply: () => s.vault.totalSupply,
          convertToAssets: (x: bigint) => sharesToAssets(x),
          previewRedeem: (x: bigint) => sharesToAssets(x),
          performanceFee: () => s.vault.performanceFee,
          performanceFeeRecipient: () => c.suretyPool,
          managementFee: () => s.vault.managementFee,
          managementFeeRecipient: () => (version === 2 ? s.treasury : ZERO),
          maxRate: () => s.vault.maxRate,
          liquidityAdapter: () => (version === 2 && s.allocator.parking ? c.savingsAdapter! : ZERO),
        },
      },
      {
        address: d.external.musd,
        abi: erc20Abi,
        functions: {
          balanceOf: (a: Address) => (a.toLowerCase() === c.vault.toLowerCase() ? s.vault.idle : 0n),
        },
      },
      {
        address: c.veBTCLine,
        abi: (version === 2 ? veBTCCreditLineAbi : veBTCCreditLineV1Abi) as Abi,
        functions: {
          utilizationWad: () => lineUtil(),
          paused: () => s.line.paused,
          cash: () => s.line.cash,
          totalDebt: () => totalDebt(),
          badDebtTotal: () => s.line.badDebtTotal,
          params: () => {
            if (version === 2) return s.lineParams;
            const { originationFeeBps: _o, protocolShareBps: _p, keeperShareBps: _k, ...v1 } = s.lineParams;
            return v1;
          },
          treasury: () => s.treasury,
          peg: () => c.musdPeg ?? ZERO,
          pegCheck: () => s.peg.lineCheck,
          loanCount: () => BigInt(s.loans.length),
          loan: (id: bigint) => {
            const l = loanAt(id);
            const extra = (x?: FixtureLoan) =>
              version === 2 ? { keeper: x?.keeper ?? ZERO, autoRepay: x?.autoRepay ?? false } : {};
            if (!l) {
              return { borrower: ZERO, escrow: ZERO, tokenId: 0n, normDebt: 0n, state: 0, auctionStart: 0n, ...extra() };
            }
            return {
              borrower: l.borrower,
              escrow: l.escrow,
              tokenId: l.tokenId,
              normDebt: l.debt,
              state: l.state,
              auctionStart: l.auctionStart,
              ...extra(l),
            };
          },
          debtOf: (id: bigint) => {
            const l = loanAt(id);
            return l && (l.state === 1 || l.state === 2) ? l.debt : 0n;
          },
          healthOf: (id: bigint) => {
            const l = loanAt(id);
            const value = l ? lineCollateral(l.tokenId) : 0n;
            const debt = l && (l.state === 1 || l.state === 2) ? l.debt : 0n;
            if (debt === 0n) return [0n, value];
            return [value === 0n ? 2n ** 256n - 1n : (debt * BPS) / value, value];
          },
          auctionPrice: (id: bigint) => {
            const l = loanAt(id);
            if (!l || l.state !== 2) throw new MockRevert("0x", "NoAuction");
            return auctionPrice(
              lineCollateral(l.tokenId),
              s.now - l.auctionStart,
              BigInt(s.lineParams.auctionDuration),
              BigInt(s.lineParams.floorBps),
            );
          },
          maxBorrow: (id: bigint) => {
            const n = nft(id);
            if (!n || n.escrowType !== 0 || n.grantManager !== ZERO || n.lock.amount <= 0n) return 0n;
            if (!n.lock.isPermanent && n.lock.end < s.now + BigInt(s.lineParams.minTerm)) return 0n;
            const ltv = BigInt(n.lock.isPermanent ? s.lineParams.maxLtvPermanentBps : s.lineParams.maxLtvTimedBps);
            const limit = (collateralValue(n.lock.amount, price()) * ltv) / BPS;
            return limit < s.line.cash ? limit : s.line.cash;
          },
          isEscrow: (a: Address) => s.loans.some((l) => l.escrow.toLowerCase() === a.toLowerCase()),
        },
      },
      {
        address: c.irmLine,
        abi: linearKinkIrmAbi,
        functions: {
          baseApr: () => s.curve.baseApr,
          kinkApr: () => s.curve.kinkApr,
          maxApr: () => s.curve.maxApr,
          kinkUtilWad: () => s.curve.kinkUtilWad,
        },
      },
      version === 2
        ? {
            address: c.priceSource,
            abi: btcMusdPriceSourceAbi as Abi,
            functions: {
              priceWad: () => btcInMusdWad(price(), healthyMedian(), fixtureDeploymentV2.peg.maxPremiumBps),
              musdUsdWad: () => pegDivisorWad(healthyMedian(), fixtureDeploymentV2.peg.maxPremiumBps),
              btcUsd: () => c.btcUsdSource!,
              peg: () => c.musdPeg!,
              maxPremiumBps: () => fixtureDeploymentV2.peg.maxPremiumBps,
            },
          }
        : { address: c.priceSource, abi: skipPriceSourceAbi as Abi, functions: { priceWad: () => price() } },
      {
        address: c.morphoOracle,
        abi: morphoPriceOracleAbi,
        functions: {
          price: () =>
            (version === 2 ? btcInMusdWad(price(), healthyMedian(), fixtureDeploymentV2.peg.maxPremiumBps) : price()) *
            WAD,
        },
      },
      ...(version === 2 ? v2Contracts() : []),
      {
        address: c.morpho,
        abi: morphoAbi,
        functions: { market: () => s.market },
      },
      {
        address: c.irm,
        abi: adaptiveCurveIrmAbi,
        functions: {
          rateAtTarget: () => s.rateAtTarget,
          borrowRateView: () => {
            if (s.morphoBorrowRate === null) throw new MockRevert();
            return s.morphoBorrowRate;
          },
        },
      },
      {
        address: d.external.veBTC,
        abi: veBTCAbi,
        functions: {
          balanceOf: (owner: Address) => BigInt(ownedBy(owner).length),
          ownerToNFTokenIdList: (owner: Address, i: bigint) => ownedBy(owner)[Number(i)] ?? 0n,
          ownerOf: (id: bigint) => nft(id)?.owner ?? ZERO,
          locked: (id: bigint) => nft(id)?.lock ?? { amount: 0n, end: 0n, isPermanent: false, boost: 0n },
          escrowType: (id: bigint) => nft(id)?.escrowType ?? 0,
          grantManager: (id: bigint) => nft(id)?.grantManager ?? ZERO,
          voted: (id: bigint) => nft(id)?.voted ?? false,
          votingPowerOfNFTAt: (id: bigint) => {
            const n = nft(id);
            if (!n) return 0n;
            return n.lock.isPermanent ? n.lock.amount : n.lock.amount / 2n;
          },
        },
      },
    ],
  });

  const client = createSuretyClient({
    chainId: d.chainId,
    publicClient: chain.client,
    deployment: d,
    ...(options.multicall === false ? { multicall: false as const } : {}),
  });
  return { state: s, chain, client, deployment: d };
}

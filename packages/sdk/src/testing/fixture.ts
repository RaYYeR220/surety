import { encodeAbiParameters, getAddress, type Address, type Hex } from "viem";

import {
  adaptiveCurveIrmAbi,
  creditVoterAbi,
  erc20Abi,
  linearKinkIrmAbi,
  morphoAbi,
  morphoPriceOracleAbi,
  skipPriceSourceAbi,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCAbi,
  veBTCCreditLineAbi,
  voteAllocatorAbi,
} from "../abis/index.js";
import { mezoTestnet } from "../chains.js";
import { createSuretyClient, type SuretyClient } from "../client.js";
import type { MarketParams, SuretyDeployment } from "../deployments/types.js";
import { auctionPrice, BPS, collateralValue, WAD } from "../math.js";
import { marketIdOf } from "../reads.js";
import { createMockChain, mockLog, MockRevert, type MockChain } from "./mock.js";

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
  };
  nfts: Record<string, { owner: Address; lock: FixtureLock; escrowType: number; grantManager: Address; voted: boolean }>;
  loans: FixtureLoan[];
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
    },
    curve: { baseApr: 2n * 10n ** 16n, kinkApr: 8n * 10n ** 16n, maxApr: 6n * 10n ** 17n, kinkUtilWad: 8n * 10n ** 17n },
    pool: {
      incentiveShares: { [`0:${cur}`]: e18(99) },
      coverCapacity: [e18(50), e18(40)],
      lossRecorded: [0n, e18(10)],
      lossCovered: [0n, 0n],
      cohorts: { [`1:${prev}`]: e18(20), [`0:${matured}`]: e18(25) },
      claimed: {},
    },
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
 * holders and two loans. Mutate `state` to shape what the contracts return.
 */
export function createSuretyFixture(options: { patch?: (s: FixtureState) => void; multicall?: false } = {}): SuretyFixture {
  const s = defaultFixtureState();
  options.patch?.(s);
  const d = fixtureDeployment;
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

  const chain = createMockChain({
    chain: mezoTestnet,
    get blockNumber() {
      return s.blockNumber;
    },
    get timestamp() {
      return s.now;
    },
    logs: s.loans.map((l, i) =>
      mockLog({
        abi: veBTCCreditLineAbi,
        eventName: "Opened",
        args: { loanId: BigInt(i + 1), borrower: l.borrower, tokenId: l.tokenId, amount: l.amount },
        address: c.veBTCLine,
        blockNumber: l.openedAtBlock,
      }),
    ),
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
        },
      },
      {
        address: c.suretyPool,
        abi: suretyPoolAbi,
        functions: {
          SEASON: () => s.season,
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
          maxRate: () => s.vault.maxRate,
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
        abi: veBTCCreditLineAbi,
        functions: {
          utilizationWad: () => lineUtil(),
          paused: () => s.line.paused,
          cash: () => s.line.cash,
          totalDebt: () => totalDebt(),
          badDebtTotal: () => s.line.badDebtTotal,
          params: () => s.lineParams,
          loanCount: () => BigInt(s.loans.length),
          loan: (id: bigint) => {
            const l = loanAt(id);
            if (!l) return { borrower: ZERO, escrow: ZERO, tokenId: 0n, normDebt: 0n, state: 0, auctionStart: 0n };
            return {
              borrower: l.borrower,
              escrow: l.escrow,
              tokenId: l.tokenId,
              normDebt: l.debt,
              state: l.state,
              auctionStart: l.auctionStart,
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
      { address: c.priceSource, abi: skipPriceSourceAbi, functions: { priceWad: () => price() } },
      { address: c.morphoOracle, abi: morphoPriceOracleAbi, functions: { price: () => price() * WAD } },
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

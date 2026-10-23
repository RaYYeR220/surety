import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAbiItem,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

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
} from "./abis/index.js";
import type { LineKind, MarketParams, SuretyDeployment } from "./deployments/types.js";
import { getLogsChunked } from "./logs.js";
import {
  BPS,
  SECONDS_PER_YEAR,
  adaptiveCurveBorrowRate,
  aprToApy,

  collateralValue as collateralValueMath,
  kinkAprAt,
  lineSupplyAprWad,
  liquidationPriceWad,
  ltvBps as ltvBpsMath,
  morphoSupplyApy,
  ratePerSecondToApy,
  ratio,
  utilizationWad,
  wadToNumber,
  weightedApy,
  type KinkCurve,
} from "./math.js";
import { call, orNull, type ReadCall, type Reader, type Settled } from "./read.js";
import type {
  AuctionView,
  Ballot,
  Board,
  BoardLine,
  BorrowIneligibility,
  BorrowQuote,
  CohortPosition,
  Cohorts,
  EpochInfo,
  EscrowType,
  LoanState,
  LoanView,
  VaultStats,
  VeBTCLock,
  VeBTCPosition,
} from "./types.js";

export interface SuretyContext {
  chainId: number;
  client: PublicClient;
  reader: Reader;
  deployment: SuretyDeployment;
  /** Blocks per eth_getLogs window. */
  logChunkSize: bigint;
}

/** Block a view is read at. */
export interface At {
  blockNumber: bigint;
  timestamp: bigint;
}

const WAD = 10n ** 18n;
const LOAN_STATES: LoanState[] = ["None", "Active", "Auction", "Closed", "Liquidated"];
const ESCROW_TYPES: EscrowType[] = ["NORMAL", "LOCKED", "MANAGED"];
const LINE_KINDS: LineKind[] = ["Morpho", "VeBTC"];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const MARKET_PARAMS_TUPLE = [
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
] as const;

/** Decodes a Morpho line's CreditVoter data (abi-encoded MarketParams). */
export function decodeMarketParams(data: Hex): MarketParams {
  const [p] = decodeAbiParameters(MARKET_PARAMS_TUPLE, data);
  return { ...p };
}

/** Morpho market id: keccak256(abi.encode(marketParams)). */
export function marketIdOf(params: MarketParams): Hex {
  return keccak256(encodeAbiParameters(MARKET_PARAMS_TUPLE, [params]));
}

export const openedEvent = getAbiItem({ abi: veBTCCreditLineAbi, name: "Opened" });
export const votedEvent = getAbiItem({ abi: creditVoterAbi, name: "Voted" });

function must<T>(s: Settled<T>, what: string): T {
  if (!s.ok) throw new Error(`${what} failed: ${s.error.message}`, { cause: s.error });
  return s.value;
}

function toLock(raw: { amount: bigint; end: bigint; isPermanent: boolean; boost: bigint }): VeBTCLock {
  return { amount: raw.amount, end: raw.end, isPermanent: raw.isPermanent, boost: raw.boost };
}

export async function head(ctx: SuretyContext): Promise<At> {
  const block = await ctx.client.getBlock({ blockTag: "latest" });
  if (block.number === null) throw new Error("latest block has no number");
  return { blockNumber: block.number, timestamp: block.timestamp };
}

/* Epoch */

export async function getEpoch(ctx: SuretyContext, at?: At): Promise<EpochInfo> {
  const { blockNumber, timestamp } = at ?? (await head(ctx));
  const c = ctx.deployment.contracts;
  const [epochLength, currentEpoch, activeTallyEpoch, lastRebalanceEpoch, season] = await ctx.reader.values(
    [
      call(c.creditVoter, creditVoterAbi, "EPOCH_LENGTH"),
      call(c.creditVoter, creditVoterAbi, "currentEpoch"),
      call(c.voteAllocator, voteAllocatorAbi, "activeTallyEpoch"),
      call(c.voteAllocator, voteAllocatorAbi, "lastRebalanceEpoch"),
      call(c.suretyPool, suretyPoolAbi, "SEASON"),
    ],
    { blockNumber },
  );
  const nextFlip = currentEpoch + epochLength;
  return {
    blockNumber,
    now: timestamp,
    epochLength,
    currentEpoch,
    nextFlip,
    secondsToFlip: nextFlip > timestamp ? nextFlip - timestamp : 0n,
    lastClosedEpoch: currentEpoch >= epochLength ? currentEpoch - epochLength : 0n,
    activeTallyEpoch,
    lastRebalanceEpoch,
    rebalanceDue: lastRebalanceEpoch < currentEpoch,
    season,
  };
}

/* Board */

export async function getBoard(ctx: SuretyContext): Promise<Board> {
  const at = await head(ctx);
  const { blockNumber } = at;
  const c = ctx.deployment.contracts;
  const r = ctx.reader;

  const [epoch, base] = await Promise.all([
    getEpoch(ctx, at),
    r.settle(
      [
        call(c.creditVoter, creditVoterAbi, "lineCount"),
        call(c.voteAllocator, voteAllocatorAbi, "idleBufferBps"),
        call(c.voteAllocator, voteAllocatorAbi, "targets"),
        call(c.vault, vaultV2Abi, "name"),
        call(c.vault, vaultV2Abi, "symbol"),
        call(c.vault, vaultV2Abi, "decimals"),
        call(c.vault, vaultV2Abi, "asset"),
        call(c.vault, vaultV2Abi, "totalAssets"),
        call(c.vault, vaultV2Abi, "totalSupply"),
        call(c.vault, vaultV2Abi, "convertToAssets", [WAD]),
        call(c.vault, vaultV2Abi, "performanceFee"),
        call(c.vault, vaultV2Abi, "performanceFeeRecipient"),
        call(c.vault, vaultV2Abi, "managementFee"),
        call(c.vault, vaultV2Abi, "maxRate"),
        call(ctx.deployment.external.musd, erc20Abi, "balanceOf", [c.vault]),
        call(c.veBTCLine, veBTCCreditLineAbi, "utilizationWad"),
        call(c.veBTCLine, veBTCCreditLineAbi, "paused"),
        call(c.priceSource, skipPriceSourceAbi, "priceWad"),
        call(c.irmLine, linearKinkIrmAbi, "baseApr"),
        call(c.irmLine, linearKinkIrmAbi, "kinkApr"),
        call(c.irmLine, linearKinkIrmAbi, "maxApr"),
        call(c.irmLine, linearKinkIrmAbi, "kinkUtilWad"),
        call(c.suretyPool, suretyPoolAbi, "depositsPaused"),
      ],
      { blockNumber },
    ),
  ]);
  const [
    lineCountS,
    idleBufferS,
    targetsS,
    nameS,
    symbolS,
    decimalsS,
    assetS,
    totalAssetsS,
    totalSupplyS,
    sharePriceS,
    perfFeeS,
    perfRecipientS,
    mgmtFeeS,
    maxRateS,
    idleS,
    lineUtilS,
    pausedS,
    priceS,
    baseAprS,
    kinkAprS,
    maxAprS,
    kinkUtilS,
    depositsPausedS,
  ] = base;

  const lineCount = Number(must(lineCountS, "CreditVoter.lineCount"));
  const cur = epoch.currentEpoch;
  const prev = epoch.lastClosedEpoch;
  const ids = Array.from({ length: lineCount }, (_, i) => BigInt(i));

  const [perLine, totals] = await Promise.all([
    r.settle(
      ids.flatMap((i) => [
        call(c.creditVoter, creditVoterAbi, "line", [i]),
        call(c.creditVoter, creditVoterAbi, "lineVotes", [cur, i]),
        call(c.creditVoter, creditVoterAbi, "lineVotes", [prev, i]),
        call(c.voteAllocator, voteAllocatorAbi, "lineAssets", [i]),
        call(c.suretyPool, suretyPoolAbi, "incentiveShares", [i, cur]),
        call(c.suretyPool, suretyPoolAbi, "coverCapacity", [i]),
        call(c.suretyPool, suretyPoolAbi, "uncoveredLoss", [i]),
        call(c.suretyPool, suretyPoolAbi, "lossRecorded", [i]),
        call(c.suretyPool, suretyPoolAbi, "lossCovered", [i]),
      ]) as ReadCall[],
      { blockNumber },
    ),
    r.values(
      [
        call(c.creditVoter, creditVoterAbi, "totalVotes", [cur]),
        call(c.creditVoter, creditVoterAbi, "totalVotes", [prev]),
      ],
      { blockNumber },
    ),
  ]);
  const [totalCurrent, totalPrev] = totals;
  const FIELDS = 9;

  type LineInfo = { adapter: Address; data: Hex; kind: number; active: boolean; name: string };
  const infos = ids.map((_, i) => must(perLine[i * FIELDS] as Settled<LineInfo>, `CreditVoter.line(${i})`));
  const morpho = infos
    .map((info, i) => ({ i, info }))
    .filter(({ info }) => LINE_KINDS[info.kind] === "Morpho")
    .map(({ i, info }) => {
      const params = decodeMarketParams(info.data);
      return { i, params, id: marketIdOf(params) };
    });

  // Morpho market state, IRM rate at target, oracle; incentive shares in assets.
  const incentiveShares = ids.map((_, i) => orNull(perLine[i * FIELDS + 4] as Settled<bigint>) ?? 0n);
  const second = await r.settle(
    [
      ...morpho.flatMap((m) => [
        call(c.morpho, morphoAbi, "market", [m.id]),
        call(m.params.irm, adaptiveCurveIrmAbi, "rateAtTarget", [m.id]),
        call(m.params.oracle, morphoPriceOracleAbi, "price"),
      ]),
      ...incentiveShares.map((s) => call(c.vault, vaultV2Abi, "convertToAssets", [s])),
    ] as ReadCall[],
    { blockNumber },
  );
  type MarketState = {
    totalSupplyAssets: bigint;
    totalSupplyShares: bigint;
    totalBorrowAssets: bigint;
    totalBorrowShares: bigint;
    lastUpdate: bigint;
    fee: bigint;
  };
  const markets = morpho.map((m, k) => ({
    ...m,
    market: orNull(second[k * 3] as Settled<MarketState>),
    rateAtTarget: orNull(second[k * 3 + 1] as Settled<bigint>),
    oracleLive: (orNull(second[k * 3 + 2] as Settled<bigint>) ?? 0n) > 0n,
  }));
  const incentiveAssets = ids.map((_, i) => orNull(second[morpho.length * 3 + i] as Settled<bigint>) ?? 0n);

  const rates = await r.settle(
    markets.map((m) =>
      call(m.params.irm, adaptiveCurveIrmAbi, "borrowRateView", [
        m.params,
        m.market ?? {
          totalSupplyAssets: 0n,
          totalSupplyShares: 0n,
          totalBorrowAssets: 0n,
          totalBorrowShares: 0n,
          lastUpdate: 0n,
          fee: 0n,
        },
      ]),
    ),
    { blockNumber },
  );

  const curve: KinkCurve | null =
    baseAprS.ok && kinkAprS.ok && maxAprS.ok && kinkUtilS.ok
      ? { baseApr: baseAprS.value, kinkApr: kinkAprS.value, maxApr: maxAprS.value, kinkUtilWad: kinkUtilS.value }
      : null;
  const targets = orNull(targetsS);

  const lines: BoardLine[] = infos.map((info, i) => {
    const at = (k: number) => perLine[i * FIELDS + k] as Settled<bigint>;
    const kind = LINE_KINDS[info.kind] ?? "Morpho";
    const current = orNull(at(1)) ?? 0n;
    const lastClosed = orNull(at(2)) ?? 0n;
    const line: BoardLine = {
      id: i,
      name: info.name,
      kind,
      active: info.active,
      adapter: info.adapter,
      votes: {
        current,
        currentShare: ratio(current, totalCurrent),
        lastClosed,
        lastClosedShare: ratio(lastClosed, totalPrev),
      },
      allocation: orNull(at(3)),
      target: targets ? (targets[1][targets[0].findIndex((id) => id === BigInt(i))] ?? null) : null,
      utilizationWad: null,
      supplyApy: null,
      borrowApy: null,
      borrowRateSource: null,
      incentives: { shares: incentiveShares[i] ?? 0n, assets: incentiveAssets[i] ?? 0n },
      coverCapacity: orNull(at(5)),
      uncoveredLoss: orNull(at(6)),
      lossRecorded: orNull(at(7)),
      lossCovered: orNull(at(8)),
      oracleLive: null,
    };

    if (kind === "Morpho") {
      const k = markets.findIndex((m) => m.i === i);
      const m = markets[k]!;
      line.marketId = m.id;
      line.marketParams = m.params;
      line.oracleLive = m.oracleLive;
      if (m.market) {
        const util = utilizationWad(m.market.totalBorrowAssets, m.market.totalSupplyAssets);
        line.utilizationWad = util;
        const live = orNull(rates[k] as Settled<bigint>);
        const rate = live ?? (m.rateAtTarget !== null ? adaptiveCurveBorrowRate(m.rateAtTarget, util) : null);
        if (rate !== null) {
          line.borrowRateSource = live !== null ? "irm" : "derived";
          line.borrowApy = ratePerSecondToApy(rate);
          line.supplyApy = morphoSupplyApy(line.borrowApy, util, m.market.fee);
        }
      }
    } else {
      line.paused = orNull(pausedS) ?? undefined;
      line.oracleLive = priceS.ok && priceS.value > 0n;
      const util = orNull(lineUtilS);
      line.utilizationWad = util;
      if (util !== null && curve) {
        const apr = kinkAprAt(curve, util);
        line.borrowRateSource = "line";
        line.borrowApy = aprToApy(apr);
        line.supplyApy = aprToApy(lineSupplyAprWad(apr, util));
      }
    }
    return line;
  });

  const totalAssets = must(totalAssetsS, "vault.totalAssets");
  const performanceFee = orNull(perfFeeS) ?? 0n;
  const managementFee = orNull(mgmtFeeS) ?? 0n;
  const gross = weightedApy(
    lines.map((l) => ({ assets: l.allocation ?? 0n, apy: l.supplyApy ?? 0 })),
    totalAssets,
  );
  const vault: VaultStats = {
    address: c.vault,
    name: orNull(nameS) ?? "",
    symbol: orNull(symbolS) ?? "",
    decimals: orNull(decimalsS) ?? 18,
    asset: orNull(assetS) ?? ctx.deployment.external.musd,
    totalAssets,
    totalSupply: must(totalSupplyS, "vault.totalSupply"),
    sharePrice: orNull(sharePriceS) ?? 0n,
    idle: orNull(idleS) ?? 0n,
    idleBufferBps: orNull(idleBufferS) ?? 0n,
    performanceFee,
    performanceFeeRecipient: orNull(perfRecipientS) ?? ZERO_ADDRESS,
    managementFee,
    maxRate: orNull(maxRateS) ?? 0n,
    depositsPaused: orNull(depositsPausedS as Settled<boolean>),
    supplyApy: Math.max(
      0,
      gross * (1 - wadToNumber(performanceFee)) - wadToNumber(managementFee * SECONDS_PER_YEAR),
    ),
  };

  return { epoch, vault, lines, totals: { currentVotes: totalCurrent, lastClosedVotes: totalPrev } };
}

/* Ballots and veBTC positions */

export async function getBallot(ctx: SuretyContext, tokenId: bigint): Promise<Ballot> {
  const { blockNumber } = await head(ctx);
  const c = ctx.deployment.contracts;
  const [[lineIds, weightsBps, epochCast], currentEpoch] = await ctx.reader.values(
    [call(c.creditVoter, creditVoterAbi, "ballotOf", [tokenId]), call(c.creditVoter, creditVoterAbi, "currentEpoch")],
    { blockNumber },
  );
  const [power, ...votes] = (await ctx.reader.values(
    [
      call(ctx.deployment.external.veBTC, veBTCAbi, "votingPowerOfNFTAt", [tokenId, currentEpoch]),
      ...lineIds.map((l) => call(c.creditVoter, creditVoterAbi, "tokenVotes", [currentEpoch, tokenId, l])),
    ] as ReadCall[],
    { blockNumber },
  )) as bigint[];
  return {
    tokenId,
    lineIds: lineIds.map(Number),
    weightsBps: weightsBps.map(Number),
    epochCast,
    currentEpoch,
    castThisEpoch: lineIds.length > 0 && epochCast === currentEpoch,
    pokeable: lineIds.length > 0 && epochCast < currentEpoch,
    powerAtEpochStart: power ?? 0n,
    votesThisEpoch: lineIds.map((l, k) => ({ lineId: Number(l), votes: votes[k] ?? 0n })),
  };
}

export async function getVeBTCPositions(
  ctx: SuretyContext,
  owner: Address,
  options: { includeEscrowed?: boolean } = {},
): Promise<VeBTCPosition[]> {
  const at = await head(ctx);
  const { blockNumber } = at;
  const c = ctx.deployment.contracts;
  const ve = ctx.deployment.external.veBTC;
  const [count, currentEpoch] = await ctx.reader.values(
    [call(ve, veBTCAbi, "balanceOf", [owner]), call(c.creditVoter, creditVoterAbi, "currentEpoch")],
    { blockNumber },
  );
  const owned = await ctx.reader.values(
    Array.from({ length: Number(count) }, (_, i) => call(ve, veBTCAbi, "ownerToNFTokenIdList", [owner, BigInt(i)])),
    { blockNumber },
  );
  const loans =
    options.includeEscrowed === false
      ? []
      : (await getLoans(ctx, owner, at)).filter((l) => l.state === "Active" || l.state === "Auction");

  const entries: { tokenId: bigint; escrowed: boolean; loanId: bigint | null }[] = [
    ...owned.filter((id) => id !== 0n).map((tokenId) => ({ tokenId, escrowed: false, loanId: null })),
    ...loans.map((l) => ({ tokenId: l.tokenId, escrowed: true, loanId: l.loanId })),
  ];
  const PER = 7;
  const reads = await ctx.reader.settle(
    entries.flatMap(({ tokenId }) => [
      call(ve, veBTCAbi, "locked", [tokenId]),
      call(ve, veBTCAbi, "escrowType", [tokenId]),
      call(ve, veBTCAbi, "grantManager", [tokenId]),
      call(ve, veBTCAbi, "votingPowerOfNFTAt", [tokenId, currentEpoch]),
      call(ve, veBTCAbi, "voted", [tokenId]),
      call(c.creditVoter, creditVoterAbi, "ballotOf", [tokenId]),
      call(c.veBTCLine, veBTCCreditLineAbi, "maxBorrow", [tokenId]),
    ]) as ReadCall[],
    { blockNumber },
  );
  return entries.map((e, k) => {
    const get = <T>(j: number) => reads[k * PER + j] as Settled<T>;
    const lock = must(get<{ amount: bigint; end: bigint; isPermanent: boolean; boost: bigint }>(0), "veBTC.locked");
    const grant = orNull(get<Address>(2));
    const ballot = orNull(get<readonly [readonly bigint[], readonly bigint[], bigint]>(5));
    return {
      tokenId: e.tokenId,
      owner,
      escrowed: e.escrowed,
      loanId: e.loanId,
      lock: toLock(lock),
      escrowType: ESCROW_TYPES[Number(orNull(get<number>(1)) ?? 0)] ?? "NORMAL",
      grantLock: grant !== null && grant !== ZERO_ADDRESS,
      powerAtEpochStart: orNull(get<bigint>(3)) ?? 0n,
      votedOnMezo: orNull(get<boolean>(4)) ?? false,
      ballotEpoch: ballot ? ballot[2] : 0n,
      maxBorrow: e.escrowed ? 0n : orNull(get<bigint>(6)),
    };
  });
}

/* Cohorts */

export async function getCohorts(
  ctx: SuretyContext,
  tokenId: bigint,
  options: { epochs?: number } = {},
): Promise<Cohorts> {
  const { blockNumber, timestamp } = await head(ctx);
  const c = ctx.deployment.contracts;
  const r = ctx.reader;
  const [currentEpoch, epochLength, season, lineCount] = await r.values(
    [
      call(c.creditVoter, creditVoterAbi, "currentEpoch"),
      call(c.creditVoter, creditVoterAbi, "EPOCH_LENGTH"),
      call(c.suretyPool, suretyPoolAbi, "SEASON"),
      call(c.creditVoter, creditVoterAbi, "lineCount"),
    ],
    { blockNumber },
  );
  // The SEASON + 2 seasoning epochs, plus as many older (matured) ones for claims.
  const span = options.epochs ?? 2 * (Number(season) + 2);
  const epochs: bigint[] = [];
  for (let k = 0n; k < BigInt(span) && currentEpoch >= k * epochLength; k++) epochs.push(currentEpoch - k * epochLength);
  const lines = Array.from({ length: Number(lineCount) }, (_, i) => BigInt(i));
  const pairs = epochs.flatMap((epoch) => lines.map((lineId) => ({ epoch, lineId })));

  const votes = await r.values(
    pairs.map((p) => call(c.creditVoter, creditVoterAbi, "tokenVotes", [p.epoch, tokenId, p.lineId])),
    { blockNumber },
  );
  const hits = pairs.map((p, k) => ({ ...p, votes: votes[k]! })).filter((p) => p.votes > 0n);
  const hitLines = [...new Set(hits.map((h) => h.lineId))];

  const PER = 5;
  const details = await r.values(
    [
      ...hits.flatMap((h) => [
        call(c.suretyPool, suretyPoolAbi, "cohort", [h.lineId, h.epoch]),
        call(c.creditVoter, creditVoterAbi, "lineVotes", [h.epoch, h.lineId]),
        call(c.suretyPool, suretyPoolAbi, "claimable", [tokenId, h.lineId, h.epoch]),
        call(c.suretyPool, suretyPoolAbi, "isClaimed", [tokenId, h.lineId, h.epoch]),
        call(c.suretyPool, suretyPoolAbi, "maturityOf", [h.epoch]),
      ]),
      ...hitLines.map((l) => call(c.suretyPool, suretyPoolAbi, "uncoveredLoss", [l])),
    ] as ReadCall[],
    { blockNumber },
  );
  const uncovered = new Map(hitLines.map((l, k) => [l, details[hits.length * PER + k] as bigint]));

  const partial = hits.map((h, k) => {
    const [cohortShares] = details[k * PER] as readonly [bigint, bigint, boolean];
    const lineVotes = details[k * PER + 1] as bigint;
    const claimable = details[k * PER + 2] as bigint;
    const claimed = details[k * PER + 3] as boolean;
    const maturity = details[k * PER + 4] as bigint;
    const matured = timestamp >= maturity;
    let shares: bigint;
    let status: CohortPosition["status"];
    if (matured) {
      shares = claimed ? 0n : claimable;
      status = claimed ? "claimed" : claimable > 0n ? "claimable" : "empty";
    } else {
      shares = lineVotes === 0n ? 0n : (cohortShares * h.votes) / lineVotes;
      status = (uncovered.get(h.lineId) ?? 0n) > 0n ? "at-risk" : "maturing";
    }
    return { lineId: Number(h.lineId), epoch: h.epoch, votes: h.votes, lineVotes, maturity, status, shares };
  });

  const assets = await r.values(
    partial.map((p) => call(c.vault, vaultV2Abi, "convertToAssets", [p.shares])),
    { blockNumber },
  );
  const cohorts: CohortPosition[] = partial.map((p, k) => ({ ...p, assets: assets[k]! }));
  const sum = (s: CohortPosition["status"][]) =>
    cohorts.filter((x) => s.includes(x.status)).reduce((a, x) => a + x.assets, 0n);
  return {
    tokenId,
    currentEpoch,
    season,
    cohorts,
    totals: {
      claimableAssets: sum(["claimable"]),
      maturingAssets: sum(["maturing", "at-risk"]),
      atRiskAssets: sum(["at-risk"]),
    },
  };
}

/* Loans */

type RawLoan = {
  borrower: Address;
  escrow: Address;
  tokenId: bigint;
  normDebt: bigint;
  state: number;
  auctionStart: bigint;
};

type LineParams = {
  maxLtvTimedBps: number;
  maxLtvPermanentBps: number;
  liqLtvBps: number;
  liqFeeBps: number;
  floorBps: number;
  auctionDuration: number;
  minTerm: number;
};

/** Full views of the given loans at one block. Loans in state None are dropped. */
export async function loadLoans(ctx: SuretyContext, loanIds: bigint[], at?: At): Promise<AuctionView[]> {
  if (loanIds.length === 0) return [];
  const { blockNumber, timestamp } = at ?? (await head(ctx));
  const c = ctx.deployment.contracts;
  const line = c.veBTCLine;
  const PER = 3;
  const first = await ctx.reader.settle(
    [
      call(line, veBTCCreditLineAbi, "params"),
      call(c.priceSource, skipPriceSourceAbi, "priceWad"),
      ...loanIds.flatMap((id) => [
        call(line, veBTCCreditLineAbi, "loan", [id]),
        call(line, veBTCCreditLineAbi, "debtOf", [id]),
        call(line, veBTCCreditLineAbi, "healthOf", [id]),
      ]),
    ] as ReadCall[],
    { blockNumber },
  );
  const params = must(first[0] as Settled<LineParams>, "VeBTCCreditLine.params");
  const price = orNull(first[1] as Settled<bigint>);
  const loans = loanIds.map((id, k) => ({
    id,
    raw: must(first[2 + k * PER] as Settled<RawLoan>, `VeBTCCreditLine.loan(${id})`),
    debt: must(first[3 + k * PER] as Settled<bigint>, `VeBTCCreditLine.debtOf(${id})`),
    health: orNull(first[4 + k * PER] as Settled<readonly [bigint, bigint]>),
  }));
  const live = loans.filter((l) => l.raw.state !== 0);

  const second = await ctx.reader.settle(
    live.flatMap((l) => [
      call(ctx.deployment.external.veBTC, veBTCAbi, "locked", [l.raw.tokenId]),
      call(line, veBTCCreditLineAbi, "auctionPrice", [l.id]),
    ]) as ReadCall[],
    { blockNumber },
  );

  return live.map((l, k) => {
    const lock = toLock(must(second[k * 2] as Settled<VeBTCLock>, "veBTC.locked"));
    const state = LOAN_STATES[l.raw.state] ?? "None";
    const value = l.health ? l.health[1] : price !== null ? collateralValueMath(lock.amount, price) : null;
    const ltv = l.health ? (l.debt === 0n ? 0n : ltvBpsMath(l.debt, l.health[1])) : null;
    const liqLtvBps = BigInt(params.liqLtvBps);
    const expired = !lock.isPermanent && timestamp >= lock.end;
    const ltvBreached = value === null ? null : l.debt * BPS >= value * liqLtvBps;
    let liquidatable: boolean | null = false;
    let reason: LoanView["liquidationReason"] = null;
    if (state === "Active") {
      // startAuction values the collateral first, so it reverts whenever the oracle does.
      liquidatable = ltvBreached === null ? null : ltvBreached || expired;
      reason = ltvBreached ? "ltv" : expired ? "expiry" : null;
    }
    const inAuction = state === "Auction";
    return {
      loanId: l.id,
      borrower: l.raw.borrower,
      escrow: l.raw.escrow,
      tokenId: l.raw.tokenId,
      state,
      debt: l.debt,
      lock,
      collateralValue: value,
      ltvBps: ltv,
      maxLtvBps: BigInt(lock.isPermanent ? params.maxLtvPermanentBps : params.maxLtvTimedBps),
      liqLtvBps,
      maturity: lock.isPermanent ? null : lock.end,
      expired,
      liquidatable,
      liquidationReason: reason,
      liquidationPriceWad: l.debt === 0n ? null : liquidationPriceWad(l.debt, lock.amount, liqLtvBps),
      auctionStart: inAuction ? l.raw.auctionStart : null,
      auctionEndsAt: inAuction ? l.raw.auctionStart + BigInt(params.auctionDuration) : null,
      auctionPrice: inAuction ? orNull(second[k * 2 + 1] as Settled<bigint>) : null,
      floorPrice: inAuction && value !== null ? (value * BigInt(params.floorBps)) / BPS : null,
    };
  });
}

/** Loans opened by `borrower`, found from `Opened` logs since the deployment block. */
export async function getLoans(ctx: SuretyContext, borrower: Address, at?: At): Promise<LoanView[]> {
  const point = at ?? (await head(ctx));
  const logs = await getLogsChunked(ctx.client, {
    address: ctx.deployment.contracts.veBTCLine,
    event: openedEvent,
    args: { borrower },
    fromBlock: ctx.deployment.deployedAt,
    toBlock: point.blockNumber,
    chunkSize: ctx.logChunkSize,
  });
  const ids = [...new Set(logs.map((l) => l.args.loanId))];
  return loadLoans(ctx, ids, point);
}

export async function getLoan(ctx: SuretyContext, loanId: bigint): Promise<LoanView | null> {
  const [view] = await loadLoans(ctx, [loanId]);
  return view ?? null;
}

/** Every loan of the veBTC line in the given states (all states by default), enumerated by id. */
export async function listLoans(ctx: SuretyContext, options: { states?: LoanState[] } = {}): Promise<AuctionView[]> {
  const at = await head(ctx);
  const line = ctx.deployment.contracts.veBTCLine;
  const [count] = await ctx.reader.values([call(line, veBTCCreditLineAbi, "loanCount")], {
    blockNumber: at.blockNumber,
  });
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const raws = await ctx.reader.values(
    ids.map((id) => call(line, veBTCCreditLineAbi, "loan", [id])),
    { blockNumber: at.blockNumber },
  );
  const wanted = options.states;
  const selected = ids.filter((_, k) => {
    const state = LOAN_STATES[raws[k]!.state] ?? "None";
    return state !== "None" && (!wanted || wanted.includes(state));
  });
  return loadLoans(ctx, selected, at);
}

export async function getAuctions(ctx: SuretyContext): Promise<AuctionView[]> {
  return listLoans(ctx, { states: ["Auction"] });
}

/* Borrow quote */

export async function quoteVeBTCBorrow(ctx: SuretyContext, tokenId: bigint, amount?: bigint): Promise<BorrowQuote> {
  const { blockNumber, timestamp } = await head(ctx);
  const c = ctx.deployment.contracts;
  const ve = ctx.deployment.external.veBTC;
  const line = c.veBTCLine;
  const [
    maxBorrowS,
    paramsS,
    lockS,
    escrowTypeS,
    grantS,
    ownerS,
    priceS,
    cashS,
    debtS,
    pausedS,
    baseAprS,
    kinkAprS,
    maxAprS,
    kinkUtilS,
  ] = await ctx.reader.settle(
    [
      call(line, veBTCCreditLineAbi, "maxBorrow", [tokenId]),
      call(line, veBTCCreditLineAbi, "params"),
      call(ve, veBTCAbi, "locked", [tokenId]),
      call(ve, veBTCAbi, "escrowType", [tokenId]),
      call(ve, veBTCAbi, "grantManager", [tokenId]),
      call(ve, veBTCAbi, "ownerOf", [tokenId]),
      call(c.priceSource, skipPriceSourceAbi, "priceWad"),
      call(line, veBTCCreditLineAbi, "cash"),
      call(line, veBTCCreditLineAbi, "totalDebt"),
      call(line, veBTCCreditLineAbi, "paused"),
      call(c.irmLine, linearKinkIrmAbi, "baseApr"),
      call(c.irmLine, linearKinkIrmAbi, "kinkApr"),
      call(c.irmLine, linearKinkIrmAbi, "maxApr"),
      call(c.irmLine, linearKinkIrmAbi, "kinkUtilWad"),
    ],
    { blockNumber },
  );
  const params = must(paramsS, "VeBTCCreditLine.params");
  const lock = toLock(must(lockS, "veBTC.locked"));
  const owner = orNull(ownerS) ?? ZERO_ADDRESS;
  const cash = must(cashS, "VeBTCCreditLine.cash");
  const debt = must(debtS, "VeBTCCreditLine.totalDebt");
  const price = orNull(priceS);
  const curve: KinkCurve = {
    baseApr: must(baseAprS, "irm.baseApr"),
    kinkApr: must(kinkAprS, "irm.kinkApr"),
    maxApr: must(maxAprS, "irm.maxApr"),
    kinkUtilWad: must(kinkUtilS, "irm.kinkUtilWad"),
  };
  const [isEscrow] = await ctx.reader.settle([call(line, veBTCCreditLineAbi, "isEscrow", [owner])], { blockNumber });

  const reasons: BorrowIneligibility[] = [];
  const escrowType = ESCROW_TYPES[Number(orNull(escrowTypeS) ?? 0)] ?? "NORMAL";
  const grant = orNull(grantS);
  const minTerm = BigInt(params.minTerm);
  if (escrowType !== "NORMAL") reasons.push("not-normal");
  if (grant !== null && grant !== ZERO_ADDRESS) reasons.push("grant-lock");
  if (lock.amount <= 0n) reasons.push("no-lock");
  if (!lock.isPermanent && lock.end < timestamp + minTerm) reasons.push("term-too-short");
  if (orNull(isEscrow) === true) reasons.push("escrowed");
  if (price === null) reasons.push("oracle-unavailable");
  if (orNull(pausedS) === true) reasons.push("line-paused");
  if (cash === 0n) reasons.push("no-liquidity");

  const maxBorrow = orNull(maxBorrowS) ?? 0n;
  const quoted = amount ?? maxBorrow;
  if (amount !== undefined && amount > maxBorrow && reasons.length === 0) reasons.push("above-max");
  const value = price === null ? null : collateralValueMath(lock.amount, price);
  const maxLtvBps = BigInt(lock.isPermanent ? params.maxLtvPermanentBps : params.maxLtvTimedBps);
  const liqLtvBps = BigInt(params.liqLtvBps);
  const supply = cash + debt;
  const aprNow = kinkAprAt(curve, utilizationWad(debt, supply));
  const aprAfter = kinkAprAt(curve, utilizationWad(debt + quoted, supply));

  return {
    tokenId,
    owner,
    eligible: reasons.length === 0 && quoted > 0n,
    reasons,
    lock,
    priceWad: price,
    collateralValue: value,
    maxLtvBps,
    liqLtvBps,
    maxBorrow,
    amount: quoted,
    ltvBps: value === null ? null : ltvBpsMath(quoted, value),
    liquidationPriceWad: quoted === 0n ? null : liquidationPriceWad(quoted, lock.amount, liqLtvBps),
    maturity: lock.isPermanent ? null : lock.end,
    minTerm,
    lineCash: cash,
    borrowAprNow: wadToNumber(aprNow),
    borrowAprAfter: wadToNumber(aprAfter),
    borrowApyAfter: aprToApy(aprAfter),
  };
}


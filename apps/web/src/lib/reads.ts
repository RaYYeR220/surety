// Reads the SDK's high-level views do not cover (wallet balances and allowances, a Morpho position,
// incentives per sponsor, the stress oracle, simulated checkpoints). All of them go through the SDK
// client's batched Reader with the SDK's ABIs, at one block per call.
import {
  call,
  erc20Abi,
  getLogsChunked,
  morphoAbi,
  morphoMarketV1AdapterV2Abi,
  morphoMaxBorrow,
  morphoPriceOracleAbi,
  morphoToAssetsUp,
  orNull,
  skipPriceSourceAbi,
  stressedPriceSourceAbi,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCCreditLineAbi,
  creditVoterAbi,
  type BoardLine,
  type MarketParams,
  type SuretyClient,
} from "@surety/sdk";
import { getAbiItem, type Address, type Hex } from "viem";

import { poolMetaAbi, poolsVoterAbi, votingRewardAbi } from "./mezoAbis";

/* Vault caps per line (VaultV2 ids of the line's adapter) */

export interface LineCap {
  lineId: number;
  /** MUSD the vault may still allocate to the line under its tightest cap. */
  room: bigint;
  /** The binding cap in MUSD (absolute, or relative x total assets). */
  cap: bigint;
  /** Vault allocation under the binding id. */
  allocated: bigint;
  reached: boolean;
}

const DUST = 10n ** 18n; // 1 MUSD

export async function readCaps(client: SuretyClient, lines: BoardLine[], totalAssets: bigint): Promise<LineCap[]> {
  const vault = client.deployment.contracts.vault;
  const idReads = await client.reader.settle(
    lines.map((l) =>
      l.kind === "Morpho" && l.marketParams
        ? call(l.adapter, morphoMarketV1AdapterV2Abi, "ids", [l.marketParams])
        : call(l.adapter, veBTCCreditLineAbi, "ids"),
    ),
  );
  const ids = idReads.map((r) => (orNull(r) as readonly Hex[] | null) ?? []);
  const flat = ids.flatMap((list, i) => list.map((id) => ({ i, id })));
  const caps = await client.reader.settle(
    flat.flatMap(({ id }) => [
      call(vault, vaultV2Abi, "absoluteCap", [id]),
      call(vault, vaultV2Abi, "relativeCap", [id]),
      call(vault, vaultV2Abi, "allocation", [id]),
    ]),
  );
  const out: LineCap[] = [];
  lines.forEach((line, i) => {
    let best: { room: bigint; cap: bigint; allocated: bigint } | null = null;
    flat.forEach((f, k) => {
      if (f.i !== i) return;
      const abs = orNull(caps[k * 3]!) as bigint | null;
      const rel = orNull(caps[k * 3 + 1]!) as bigint | null;
      const allocated = (orNull(caps[k * 3 + 2]!) as bigint | null) ?? 0n;
      if (abs === null) return;
      const relCap = rel === null || rel >= 10n ** 18n ? null : (rel * totalAssets) / 10n ** 18n;
      const cap = relCap !== null && relCap < abs ? relCap : abs;
      const room = cap > allocated ? cap - allocated : 0n;
      if (!best || room < best.room) best = { room, cap, allocated };
    });
    const b = best as { room: bigint; cap: bigint; allocated: bigint } | null;
    if (b) out.push({ lineId: line.id, ...b, reached: b.room < DUST });
  });
  return out;
}

export interface WalletState {
  musd: bigint;
  btc: bigint;
  /** srMUSD shares and their MUSD value. */
  shares: bigint;
  sharesValue: bigint;
  /** MUSD the vault would pay out to this wallet right now (idle liquidity bound). */
  maxWithdraw: bigint | null;
  maxRedeem: bigint | null;
  musdAllowance: { vault: bigint; pool: bigint; line: bigint; morpho: bigint };
  btcAllowance: { morpho: bigint; line: bigint };
}

export async function readWallet(client: SuretyClient, account: Address): Promise<WalletState> {
  const d = client.deployment;
  const c = d.contracts;
  const musd = d.external.musd;
  const btc = d.external.btc;
  const blockNumber = await client.publicClient.getBlockNumber();
  const r = await client.reader.settle(
    [
      call(musd, erc20Abi, "balanceOf", [account]),
      call(btc, erc20Abi, "balanceOf", [account]),
      call(c.vault, vaultV2Abi, "balanceOf", [account]),
      call(c.vault, vaultV2Abi, "maxWithdraw", [account]),
      call(c.vault, vaultV2Abi, "maxRedeem", [account]),
      call(musd, erc20Abi, "allowance", [account, c.vault]),
      call(musd, erc20Abi, "allowance", [account, c.suretyPool]),
      call(musd, erc20Abi, "allowance", [account, c.veBTCLine]),
      call(musd, erc20Abi, "allowance", [account, c.morpho]),
      call(btc, erc20Abi, "allowance", [account, c.morpho]),
      call(btc, erc20Abi, "allowance", [account, c.veBTCLine]),
    ] as const,
    { blockNumber },
  );
  const shares = orNull(r[2]) ?? 0n;
  const [value] = await client.reader.settle([call(c.vault, vaultV2Abi, "convertToAssets", [shares])] as const, {
    blockNumber,
  });
  return {
    musd: orNull(r[0]) ?? 0n,
    btc: orNull(r[1]) ?? 0n,
    shares,
    sharesValue: orNull(value) ?? 0n,
    maxWithdraw: orNull(r[3]),
    maxRedeem: orNull(r[4]),
    musdAllowance: {
      vault: orNull(r[5]) ?? 0n,
      pool: orNull(r[6]) ?? 0n,
      line: orNull(r[7]) ?? 0n,
      morpho: orNull(r[8]) ?? 0n,
    },
    btcAllowance: { morpho: orNull(r[9]) ?? 0n, line: orNull(r[10]) ?? 0n },
  };
}

/** ERC-20 allowance, read fresh before building an approve step. */
export async function readAllowance(
  client: SuretyClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  const [a] = await client.reader.values([call(token, erc20Abi, "allowance", [owner, spender])] as const);
  return a;
}

export async function previewDeposit(client: SuretyClient, assets: bigint): Promise<bigint | null> {
  const [s] = await client.reader.settle([call(client.deployment.contracts.vault, vaultV2Abi, "previewDeposit", [assets])] as const);
  return orNull(s);
}

export async function previewWithdraw(client: SuretyClient, assets: bigint): Promise<bigint | null> {
  const [s] = await client.reader.settle([call(client.deployment.contracts.vault, vaultV2Abi, "previewWithdraw", [assets])] as const);
  return orNull(s);
}

export async function convertToAssets(client: SuretyClient, shares: bigint): Promise<bigint | null> {
  const [s] = await client.reader.settle([call(client.deployment.contracts.vault, vaultV2Abi, "convertToAssets", [shares])] as const);
  return orNull(s);
}

/* Morpho (BTC lines) */

export interface MorphoPosition {
  lineId: number;
  marketId: Hex;
  params: MarketParams;
  collateral: bigint;
  borrowShares: bigint;
  /** Debt in MUSD, rounded up as Morpho does. */
  debt: bigint;
  /** Oracle price scaled 1e36 (null when the oracle reverts: stale). */
  oraclePrice: bigint | null;
  /** BTC/USD in WAD derived from the oracle price. */
  priceWad: bigint | null;
  /** MUSD the collateral supports at the LLTV. */
  maxBorrow: bigint | null;
  /** maxBorrow / debt; null without debt or price. Below 1 = liquidatable. */
  health: number | null;
  /** Free MUSD in the market (supply - borrow). */
  liquidity: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
}

export async function readMorphoPosition(
  client: SuretyClient,
  line: BoardLine,
  account: Address | undefined,
): Promise<MorphoPosition | null> {
  if (line.kind !== "Morpho" || !line.marketId || !line.marketParams) return null;
  const c = client.deployment.contracts;
  const zero: Address = "0x0000000000000000000000000000000000000000";
  const r = await client.reader.settle(
    [
      call(c.morpho, morphoAbi, "market", [line.marketId]),
      call(c.morpho, morphoAbi, "position", [line.marketId, account ?? zero]),
      call(line.marketParams.oracle, morphoPriceOracleAbi, "price"),
    ] as const,
  );
  const market = orNull(r[0]);
  const pos = account ? orNull(r[1]) : null;
  const oraclePrice = orNull(r[2]);
  const totalBorrowAssets = market?.totalBorrowAssets ?? 0n;
  const totalBorrowShares = market?.totalBorrowShares ?? 0n;
  const borrowShares = pos?.borrowShares ?? 0n;
  const collateral = pos?.collateral ?? 0n;
  const debt = borrowShares === 0n ? 0n : morphoToAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
  const maxBorrow = oraclePrice === null ? null : morphoMaxBorrow(collateral, oraclePrice, line.marketParams.lltv);
  return {
    lineId: line.id,
    marketId: line.marketId,
    params: line.marketParams,
    collateral,
    borrowShares,
    debt,
    oraclePrice,
    priceWad: oraclePrice === null ? null : oraclePrice / 10n ** 18n,
    maxBorrow,
    health: maxBorrow === null || debt === 0n ? null : Number((maxBorrow * 10_000n) / debt) / 10_000,
    liquidity: market ? market.totalSupplyAssets - market.totalBorrowAssets : 0n,
    totalBorrowAssets,
    totalBorrowShares,
  };
}

/* Incentives */

export interface IncentiveRow {
  lineId: number;
  epoch: bigint;
  /** Total incentive posted for (line, epoch), MUSD value now. */
  totalAssets: bigint;
  totalShares: bigint;
  /** Votes the line drew in that epoch. */
  lineVotes: bigint;
  /** The connected wallet's part, in shares and MUSD. */
  mineShares: bigint;
  mineAssets: bigint;
  ended: boolean;
}

export async function readIncentives(
  client: SuretyClient,
  args: { lineIds: number[]; currentEpoch: bigint; epochLength: bigint; epochs: number; account: Address | undefined },
): Promise<IncentiveRow[]> {
  const c = client.deployment.contracts;
  const epochs: bigint[] = [];
  for (let k = 0; k < args.epochs; k++) {
    const e = args.currentEpoch - BigInt(k) * args.epochLength;
    if (e >= 0n) epochs.push(e);
  }
  const pairs = epochs.flatMap((epoch) => args.lineIds.map((lineId) => ({ epoch, lineId })));
  const PER = 3;
  const r = await client.reader.settle(
    pairs.flatMap((p) => [
      call(c.suretyPool, suretyPoolAbi, "incentiveShares", [BigInt(p.lineId), p.epoch]),
      call(c.creditVoter, creditVoterAbi, "lineVotes", [p.epoch, BigInt(p.lineId)]),
      args.account
        ? call(c.suretyPool, suretyPoolAbi, "sponsorShares", [BigInt(p.lineId), p.epoch, args.account])
        : call(c.suretyPool, suretyPoolAbi, "incentiveShares", [BigInt(p.lineId), p.epoch]),
    ]),
  );
  const rows = pairs
    .map((p, k) => ({
      ...p,
      totalShares: (orNull(r[k * PER]!) as bigint | null) ?? 0n,
      lineVotes: (orNull(r[k * PER + 1]!) as bigint | null) ?? 0n,
      mineShares: args.account ? ((orNull(r[k * PER + 2]!) as bigint | null) ?? 0n) : 0n,
    }))
    .filter((row) => row.totalShares > 0n || row.mineShares > 0n);
  const values = await client.reader.settle(
    rows.flatMap((row) => [
      call(c.vault, vaultV2Abi, "convertToAssets", [row.totalShares]),
      call(c.vault, vaultV2Abi, "convertToAssets", [row.mineShares]),
    ]),
  );
  return rows.map((row, k) => ({
    lineId: row.lineId,
    epoch: row.epoch,
    totalShares: row.totalShares,
    totalAssets: (orNull(values[k * 2]!) as bigint | null) ?? 0n,
    lineVotes: row.lineVotes,
    mineShares: row.mineShares,
    mineAssets: (orNull(values[k * 2 + 1]!) as bigint | null) ?? 0n,
    ended: row.epoch < args.currentEpoch,
  }));
}

/* Reserve (second loss) */

export async function readReserve(client: SuretyClient): Promise<{ shares: bigint; assets: bigint } | null> {
  const c = client.deployment.contracts;
  const [s] = await client.reader.settle([call(c.suretyPool, suretyPoolAbi, "reserveShares")] as const);
  const shares = orNull(s);
  if (shares === null) return null;
  const assets = await convertToAssets(client, shares);
  return { shares, assets: assets ?? 0n };
}

/* Stress oracle (testnet) */

export interface StressState {
  haircutBps: number;
  shockEndsAt: bigint;
  maxHaircutBps: number;
  maxDuration: number;
  /** Price the lines use now (after any haircut). */
  priceWad: bigint | null;
  /** Unstressed price from the wrapped source. */
  basePriceWad: bigint | null;
}

/** The stress controls when the deployment's price source is a StressedPriceSource; null otherwise. */
export async function readStress(client: SuretyClient): Promise<StressState | null> {
  const src = client.deployment.contracts.priceSource;
  const r = await client.reader.settle(
    [
      call(src, stressedPriceSourceAbi, "haircutBps"),
      call(src, stressedPriceSourceAbi, "shockEndsAt"),
      call(src, stressedPriceSourceAbi, "MAX_HAIRCUT_BPS"),
      call(src, stressedPriceSourceAbi, "MAX_SHOCK_DURATION"),
      call(src, stressedPriceSourceAbi, "base"),
      call(src, skipPriceSourceAbi, "priceWad"),
    ] as const,
  );
  const haircut = orNull(r[0]);
  const base = orNull(r[4]);
  if (haircut === null || base === null) return null;
  const [basePrice] = await client.reader.settle([call(base, skipPriceSourceAbi, "priceWad")] as const);
  return {
    haircutBps: Number(haircut),
    shockEndsAt: orNull(r[1]) ?? 0n,
    maxHaircutBps: Number(orNull(r[2]) ?? 9000),
    maxDuration: Number(orNull(r[3]) ?? 7200),
    priceWad: orNull(r[5]),
    basePriceWad: orNull(basePrice),
  };
}

/* Loss checks: what a checkpoint or cover would do now (eth_call simulation, nothing is sent). */

export interface LossCheck {
  lineId: number;
  /** Loss a checkpoint would record now (null if the call reverts). */
  pendingLoss: bigint | null;
  /** MUSD a cover would move into the line now. */
  coverable: bigint | null;
}

export async function readLossChecks(client: SuretyClient, lineIds: number[]): Promise<LossCheck[]> {
  const pool = client.deployment.contracts.suretyPool;
  const sim = async (functionName: "checkpoint" | "cover", lineId: number): Promise<bigint | null> => {
    try {
      const { result } = await client.publicClient.simulateContract({
        address: pool,
        abi: suretyPoolAbi,
        functionName,
        args: [BigInt(lineId)],
      });
      return result as bigint;
    } catch {
      return null;
    }
  };
  return Promise.all(
    lineIds.map(async (lineId) => ({
      lineId,
      pendingLoss: await sim("checkpoint", lineId),
      coverable: await sim("cover", lineId),
    })),
  );
}

/* Slashes per cohort, from CohortSlashed logs. */

const cohortSlashedEvent = getAbiItem({ abi: suretyPoolAbi, name: "CohortSlashed" });

export async function readSlashes(client: SuretyClient): Promise<Record<string, bigint>> {
  const head = await client.publicClient.getBlockNumber();
  const logs = await getLogsChunked(client.publicClient, {
    address: client.deployment.contracts.suretyPool,
    event: cohortSlashedEvent,
    fromBlock: client.deployment.deployedAt,
    toBlock: head,
  });
  const out: Record<string, bigint> = {};
  for (const log of logs) {
    const key = `${log.args.lineId}:${log.args.epoch}`;
    out[key] = (out[key] ?? 0n) + log.args.shares;
  }
  return out;
}

/* veBTC line parameters (LTV limits, liquidation fee, auction shape) */

export interface LineParams {
  maxLtvTimedBps: number;
  maxLtvPermanentBps: number;
  liqLtvBps: number;
  liqFeeBps: number;
  floorBps: number;
  auctionDuration: number;
  minTerm: number;
}

export async function readLineParams(client: SuretyClient): Promise<LineParams | null> {
  const [p] = await client.reader.settle([call(client.deployment.contracts.veBTCLine, veBTCCreditLineAbi, "params")] as const);
  return orNull(p);
}

/* Mezo pools (PoolsVoter), for voting an escrowed veBTC and claiming its fees and bribes */

const NO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const isSet = (a: Address | null | undefined): a is Address => !!a && a.toLowerCase() !== NO_ADDRESS;

export interface MezoPool {
  pool: Address;
  gauge: Address | null;
  /** The gauge takes votes (killed gauges keep their rewards claimable). */
  alive: boolean;
  /** The pool's symbol ("vAMM-MUSD/BTC"), its token pair ("MUSD/BTC · CL"), or its name. */
  label: string;
  fees: Address | null;
  bribe: Address | null;
}

/** Every pool on Mezo's PoolsVoter with its gauge, reward contracts and a readable label. */
export async function readMezoPools(client: SuretyClient): Promise<MezoPool[]> {
  const voter = client.deployment.external.poolsVoter;
  const [n] = await client.reader.values([call(voter, poolsVoterAbi, "length")] as const);
  const count = Number(n > 200n ? 200n : n);
  const poolReads = await client.reader.settle(
    Array.from({ length: count }, (_, i) => call(voter, poolsVoterAbi, "pools", [BigInt(i)])),
  );
  const pools = poolReads.map((r) => orNull(r) as Address | null).filter(isSet);
  const gaugeReads = await client.reader.settle(pools.map((p) => call(voter, poolsVoterAbi, "gauges", [p])));
  const gauges = gaugeReads.map((r) => orNull(r) as Address | null);

  const PER = 7;
  const meta = await client.reader.settle(
    pools.flatMap((p, i) => {
      const g = gauges[i] ?? NO_ADDRESS;
      return [
        call(voter, poolsVoterAbi, "isAlive", [g]),
        call(voter, poolsVoterAbi, "gaugeToFees", [g]),
        call(voter, poolsVoterAbi, "gaugeToBribe", [g]),
        call(p, poolMetaAbi, "symbol"),
        call(p, poolMetaAbi, "token0"),
        call(p, poolMetaAbi, "token1"),
        call(p, poolMetaAbi, "tickSpacing"),
      ];
    }),
  );
  const rows = pools.map((pool, i) => {
    const at = (k: number) => orNull(meta[i * PER + k]!);
    return {
      pool,
      gauge: isSet(gauges[i]) ? gauges[i]! : null,
      alive: (at(0) as boolean | null) ?? false,
      fees: (at(1) as Address | null) ?? null,
      bribe: (at(2) as Address | null) ?? null,
      symbol: ((at(3) as string | null) ?? "").trim(),
      token0: at(4) as Address | null,
      token1: at(5) as Address | null,
      cl: at(6) !== null,
    };
  });

  // Pools without a symbol of their own: name them by their token pair, else by their name().
  const paired = (r: (typeof rows)[number]) => isSet(r.token0) && isSet(r.token1);
  const needTokens = rows.filter((r) => !r.symbol && paired(r));
  const tokens = [...new Set(needTokens.flatMap((r) => [r.token0!, r.token1!].map((a) => a.toLowerCase())))] as Address[];
  const symReads = await client.reader.settle(tokens.map((t) => call(t, erc20Abi, "symbol")));
  const sym = new Map<string, string | null>(tokens.map((t, k) => [t, (orNull(symReads[k]!) as string | null) ?? null]));
  const needName = rows.filter((r) => !r.symbol && !paired(r));
  const nameReads = await client.reader.settle(needName.map((r) => call(r.pool, poolMetaAbi, "name")));
  const names = new Map(needName.map((r, k) => [r.pool, (orNull(nameReads[k]!) as string | null) ?? null]));

  return rows.map((r) => {
    let label = r.symbol;
    if (!label && isSet(r.token0) && isSet(r.token1)) {
      const a = sym.get(r.token0.toLowerCase()) ?? `${r.token0.slice(0, 6)}…`;
      const b = sym.get(r.token1.toLowerCase()) ?? `${r.token1.slice(0, 6)}…`;
      label = `${a}/${b}${r.cl ? " · CL" : ""}`;
    }
    if (!label) label = names.get(r.pool) ?? `${r.pool.slice(0, 6)}…${r.pool.slice(-4)}`;
    return {
      pool: r.pool,
      gauge: r.gauge,
      alive: r.alive,
      label,
      fees: isSet(r.fees) ? r.fees : null,
      bribe: isSet(r.bribe) ? r.bribe : null,
    };
  });
}

export interface EscrowReward {
  pool: Address;
  label: string;
  kind: "fees" | "bribe";
  /** The fee or bribe reward contract. */
  reward: Address;
  token: Address;
  symbol: string;
  decimals: number;
  earned: bigint;
}

export interface EscrowVoting {
  /** Pools the NFT's PoolsVoter vote points at now, with the power on each. */
  votes: { pool: Address; votes: bigint }[];
  /** Mezo allows one vote or reset per NFT per Mezo epoch. */
  votedThisEpoch: boolean;
  /** Mezo only takes votes inside its epoch's voting window (not in the first and last hour). */
  inVoteWindow: boolean;
  voteStart: bigint;
  voteEnd: bigint;
  maxVotingNum: number;
  /** Fees and bribes the NFT can claim now, across every pool. */
  rewards: EscrowReward[];
}

const MAX_REWARD_TOKENS = 16;

/** The escrowed NFT's Mezo vote, the voting window, and every fee or bribe it has earned. */
export async function readEscrowVoting(client: SuretyClient, pools: MezoPool[], tokenId: bigint): Promise<EscrowVoting> {
  const voter = client.deployment.external.poolsVoter;
  const block = await client.publicClient.getBlock();
  const at = { blockNumber: block.number };
  const now = block.timestamp;
  const head = await client.reader.settle(
    [
      call(voter, poolsVoterAbi, "lastVoted", [tokenId]),
      call(voter, poolsVoterAbi, "epochStart", [now]),
      call(voter, poolsVoterAbi, "epochVoteStart", [now]),
      call(voter, poolsVoterAbi, "epochVoteEnd", [now]),
      call(voter, poolsVoterAbi, "maxVotingNum"),
    ] as const,
    at,
  );
  const voteReads = await client.reader.settle(
    pools.map((p) => call(voter, poolsVoterAbi, "votes", [tokenId, p.pool])),
    at,
  );
  const votes = pools
    .map((p, i) => ({ pool: p.pool, votes: (orNull(voteReads[i]!) as bigint | null) ?? 0n }))
    .filter((v) => v.votes > 0n);

  // Every reward contract, its token list, and what the NFT has earned in each token.
  const contracts = pools.flatMap((p) => [
    ...(p.fees ? [{ pool: p.pool, label: p.label, kind: "fees" as const, reward: p.fees }] : []),
    ...(p.bribe ? [{ pool: p.pool, label: p.label, kind: "bribe" as const, reward: p.bribe }] : []),
  ]);
  const lens = await client.reader.settle(
    contracts.map((c) => call(c.reward, votingRewardAbi, "rewardsListLength")),
    at,
  );
  const slots = contracts.flatMap((c, i) => {
    const count = Number((orNull(lens[i]!) as bigint | null) ?? 0n);
    return Array.from({ length: Math.min(count, MAX_REWARD_TOKENS) }, (_, k) => ({ ...c, k }));
  });
  const tokenReads = await client.reader.settle(
    slots.map((sl) => call(sl.reward, votingRewardAbi, "rewards", [BigInt(sl.k)])),
    at,
  );
  const withToken = slots
    .map((sl, i) => ({ ...sl, token: orNull(tokenReads[i]!) as Address | null }))
    .filter((sl): sl is typeof sl & { token: Address } => isSet(sl.token));
  const earnedReads = await client.reader.settle(
    withToken.map((sl) => call(sl.reward, votingRewardAbi, "earned", [sl.token, tokenId])),
    at,
  );
  const earned = withToken
    .map((sl, i) => ({ ...sl, earned: (orNull(earnedReads[i]!) as bigint | null) ?? 0n }))
    .filter((sl) => sl.earned > 0n);

  const tokens = [...new Set(earned.map((e) => e.token.toLowerCase()))] as Address[];
  const metaReads = await client.reader.settle(
    tokens.flatMap((t) => [call(t, erc20Abi, "symbol"), call(t, erc20Abi, "decimals")]),
    at,
  );
  const meta = new Map<string, { symbol: string; decimals: number }>(
    tokens.map((t, k) => [
      t,
      {
        symbol: (orNull(metaReads[k * 2]!) as string | null) ?? `${t.slice(0, 6)}…`,
        decimals: Number((orNull(metaReads[k * 2 + 1]!) as number | bigint | null) ?? 18),
      },
    ]),
  );

  const lastVoted = orNull(head[0]) ?? 0n;
  const epochStart = orNull(head[1]);
  const voteStart = orNull(head[2]) ?? 0n;
  const voteEnd = orNull(head[3]) ?? 0n;
  return {
    votes,
    votedThisEpoch: epochStart !== null && lastVoted >= epochStart,
    inVoteWindow: voteEnd === 0n || (now > voteStart && now <= voteEnd),
    voteStart,
    voteEnd,
    maxVotingNum: Number(orNull(head[4]) ?? 30n),
    rewards: earned.map((e) => ({
      pool: e.pool,
      label: e.label,
      kind: e.kind,
      reward: e.reward,
      token: e.token,
      earned: e.earned,
      ...(meta.get(e.token.toLowerCase()) ?? { symbol: "?", decimals: 18 }),
    })),
  };
}

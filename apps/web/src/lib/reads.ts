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

"use client";

// React Query hooks over the SDK client of the current environment. Query keys never hold bigints
// (they are hashed with JSON.stringify), so ids are passed as strings.
import { isV2Deployment, type BoardLine } from "@surety/sdk";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";

import { useReady, type ReadyEnv } from "./env";
import {
  readCaps,
  readEscrowVoting,
  readHarvest,
  readIncentives,
  readLineListing,
  readLineParams,
  readLossChecks,
  readMezoPools,
  readMorphoPosition,
  readReserve,
  readSlashes,
  readStress,
  readTreasury,
  readWallet,
  type MezoPool,
} from "./reads";

const LIVE_REFRESH = 15_000;

function opts(env: ReadyEnv | null) {
  return {
    enabled: !!env,
    refetchInterval: env?.mode === "live" ? LIVE_REFRESH : (false as const),
  };
}

function scope(env: ReadyEnv | null): readonly unknown[] {
  return env?.scope ?? ["surety", "none"];
}

/** Whether the environment runs the v2 contracts (peg, savings, ShareMarket, fees, harvest). */
export function isV2(env: ReadyEnv | null): boolean {
  return !!env && isV2Deployment(env.deployment);
}

/** Options for a read that exists only on v2 deployments. */
function v2opts(env: ReadyEnv | null) {
  return { ...opts(env), enabled: isV2(env) };
}

/* v2 reads */

/** The MUSD peg: every source, the median, spread and band, and whether new borrowing is open. */
export function usePeg() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "peg"],
    queryFn: () => env!.client.getPeg(),
    ...v2opts(env),
  });
}

/** Fee schedule: origination, liquidation split, management, performance and ShareMarket fees, the treasury. */
export function useFees() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "fees"],
    queryFn: () => env!.client.getFees(),
    ...v2opts(env),
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
}

/** Idle MUSD: the vault's own and what is parked in sMUSD, and the savings yield. */
export function useSavings() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "savings"],
    queryFn: () => env!.client.getSavings(),
    ...v2opts(env),
  });
}

/** One page of open ShareMarket listings, priced at the live share price. */
export function useShareMarket(start: number, count: number) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "share-market", start, count],
    queryFn: () => env!.client.getShareMarket({ start, count }),
    ...v2opts(env),
    placeholderData: keepPreviousData,
  });
}

/** The connected wallet's open listings. */
export function useMyListings() {
  const env = useReady();
  const account = env?.account;
  return useQuery({
    queryKey: [...scope(env), "my-listings", account ?? "-"],
    queryFn: () => env!.client.getShareListingsOf(account!),
    ...v2opts(env),
    enabled: isV2(env) && !!account,
  });
}

/** What filling `shares` of listing `id` would cost now. */
export function useShareQuote(id: bigint | null, shares: bigint | null) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "share-quote", id?.toString() ?? "-", shares?.toString() ?? "-"],
    queryFn: () => env!.client.quoteShareFill(id!, shares!),
    ...v2opts(env),
    enabled: isV2(env) && id !== null && shares !== null && shares > 0n,
    placeholderData: keepPreviousData,
  });
}

/** What a harvest of the loan's veBTC rewards would claim now (fees, bribes, rebase), labelled. */
export function useHarvest(loanId: bigint | null, pools: MezoPool[] | undefined) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "harvest", loanId?.toString() ?? "-", pools?.length ?? 0],
    queryFn: () => readHarvest(env!.client, loanId!, pools),
    ...v2opts(env),
    enabled: isV2(env) && loanId !== null,
    refetchInterval: env?.mode === "live" ? 60_000 : false,
  });
}

/** The treasury's balances: fee MUSD, management-fee srMUSD, gas BTC. */
export function useTreasury(address: Address | null | undefined) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "treasury", address ?? "-"],
    queryFn: () => readTreasury(env!.client, address!),
    ...opts(env),
    enabled: !!env && !!address,
    refetchInterval: env?.mode === "live" ? 60_000 : false,
  });
}

export function useBoard() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "board"],
    queryFn: () => env!.client.getBoard(),
    ...opts(env),
  });
}

export function usePositions() {
  const env = useReady();
  const account = env?.account;
  return useQuery({
    queryKey: [...scope(env), "positions", account ?? "-"],
    queryFn: () => env!.client.getVeBTCPositions(account!),
    ...opts(env),
    enabled: !!env && !!account,
  });
}

export function useBallot(tokenId: bigint | null) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "ballot", tokenId?.toString() ?? "-"],
    queryFn: () => env!.client.getBallot(tokenId!),
    ...opts(env),
    enabled: !!env && tokenId !== null,
  });
}

export function useCohorts(tokenId: bigint | null) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "cohorts", tokenId?.toString() ?? "-"],
    queryFn: () => env!.client.getCohorts(tokenId!),
    ...opts(env),
    enabled: !!env && tokenId !== null,
  });
}

export function useSlashes() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "slashes"],
    queryFn: () => readSlashes(env!.client),
    enabled: !!env,
    refetchInterval: env?.mode === "live" ? 60_000 : false,
  });
}

export function useLoans() {
  const env = useReady();
  const account = env?.account;
  return useQuery({
    queryKey: [...scope(env), "loans", account ?? "-"],
    queryFn: () => env!.client.getLoans(account!),
    ...opts(env),
    enabled: !!env && !!account,
  });
}

export function useQuote(tokenId: bigint | null, amount: bigint | null) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "quote", tokenId?.toString() ?? "-", amount?.toString() ?? "max"],
    queryFn: () => env!.client.quoteVeBTCBorrow(tokenId!, amount ?? undefined),
    ...opts(env),
    enabled: !!env && tokenId !== null,
    placeholderData: (prev) => prev,
  });
}

export function useAuctions() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "auctions"],
    queryFn: () => env!.client.getAuctions(),
    ...opts(env),
  });
}

/** Active loans the line could auction now (LTV at the liquidation line, or the lock has ended). */
export function useLiquidatable() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "liquidatable"],
    queryFn: async () => (await env!.client.listLoans({ states: ["Active"] })).filter((l) => l.liquidatable),
    ...opts(env),
  });
}

export function useWallet() {
  const env = useReady();
  const account = env?.account;
  return useQuery({
    queryKey: [...scope(env), "wallet", account ?? "-"],
    queryFn: () => readWallet(env!.client, account!),
    ...opts(env),
    enabled: !!env && !!account,
  });
}

export function useMorphoPosition(line: BoardLine | undefined) {
  const env = useReady();
  const account = env?.account;
  return useQuery({
    queryKey: [...scope(env), "morpho", line?.id ?? "-", account ?? "-"],
    queryFn: () => readMorphoPosition(env!.client, line!, account),
    ...opts(env),
    enabled: !!env && !!line,
  });
}

export function useIncentives(args: { lineIds: number[]; currentEpoch: bigint; epochLength: bigint } | null) {
  const env = useReady();
  const account = env?.account;
  return useQuery({
    queryKey: [
      ...scope(env),
      "incentives",
      account ?? "-",
      args?.lineIds.join(",") ?? "-",
      args?.currentEpoch.toString() ?? "-",
    ],
    queryFn: () => readIncentives(env!.client, { ...args!, epochs: 8, account }),
    ...opts(env),
    enabled: !!env && !!args,
  });
}

export function useCaps(lines: BoardLine[] | undefined, totalAssets: bigint | undefined) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "caps", lines?.map((l) => l.id).join(",") ?? "-", totalAssets?.toString() ?? "-"],
    queryFn: () => readCaps(env!.client, lines!, totalAssets!),
    ...opts(env),
    enabled: !!env && !!lines && totalAssets !== undefined,
  });
}

export function useReserve() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "reserve"],
    queryFn: () => readReserve(env!.client),
    ...opts(env),
  });
}

export function useStress() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "stress"],
    queryFn: () => readStress(env!.client),
    ...opts(env),
  });
}

export function useLossChecks(lineIds: number[] | undefined) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "loss-checks", lineIds?.join(",") ?? "-"],
    queryFn: () => readLossChecks(env!.client, lineIds!),
    enabled: !!env && !!lineIds && lineIds.length > 0,
    refetchInterval: env?.mode === "live" ? 30_000 : false,
  });
}

/** Wall-clock ticker (ms), null until mounted so server and client render the same. */
export function useTicker(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Chain time in seconds, ticking: the timestamp of the block the board was read at plus the wall time since.
 * In example mode this runs from the fixture's block time.
 */
export function useChainNow(): number | null {
  const board = useBoard();
  const wall = useTicker(1000);
  if (wall === null || !board.data) return null;
  return Number(board.data.epoch.now) + Math.max(0, (wall - board.dataUpdatedAt) / 1000);
}

/** How new lines get listed, and the proposed lines still waiting out the timelock. */
export function useLineListing() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "line-listing"],
    queryFn: () => readLineListing(env!.client),
    enabled: !!env,
    refetchInterval: env?.mode === "live" ? 60_000 : false,
  });
}

export function useLineParams() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "line-params"],
    queryFn: () => readLineParams(env!.client),
    enabled: !!env,
    staleTime: 5 * 60_000,
  });
}

/** Every pool on Mezo's PoolsVoter (the list changes rarely). */
export function useMezoPools() {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "mezo-pools"],
    queryFn: () => readMezoPools(env!.client),
    enabled: !!env,
    staleTime: 5 * 60_000,
  });
}

/** An escrowed veBTC's Mezo vote, the voting window, and the fees and bribes it can claim. */
export function useEscrowVoting(tokenId: bigint | null, pools: MezoPool[] | undefined) {
  const env = useReady();
  return useQuery({
    queryKey: [...scope(env), "escrow-voting", tokenId?.toString() ?? "-", pools?.length ?? 0],
    queryFn: () => readEscrowVoting(env!.client, pools!, tokenId!),
    enabled: !!env && tokenId !== null && !!pools,
    refetchInterval: env?.mode === "live" ? 60_000 : false,
  });
}

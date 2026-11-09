"use client";

// One read of the selected network for the whole landing page: the board's vote split (this epoch, else the
// last closed one), lent / rate / cover per line, the reserve and the veBTC line's LTV limits. The page opens with
// the build-time snapshot of that network (scripts/snapshot.ts), labelled with its time, and swaps in live reads
// as they arrive; a slow or unreachable RPC only means the snapshot stays up. Without votes or without a
// deployment every figure falls back to an illustrative set that is tagged as such; nothing on the landing says
// "live" unless it came from chain.
import { deployedChainIds, getDeployment, type Board, type SuretyDeployment } from "@surety/sdk";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { CHAIN_NAMES, liveClient, useSelectedChain } from "@/lib/chain";
import { lineColor } from "@/lib/lines";
import { useVisiblePoll } from "@/lib/poll";
import { timeBox } from "@/lib/rpc";
import { readChainSnapshot, type ChainSnapshot, type ChainSnapshots } from "@/lib/snapshot";

/** Where the split comes from: this epoch's live votes, the last closed epoch's, or the illustration. */
export type SplitSource = "current" | "closed" | "illustrative";

export interface LandingLine {
  id: number;
  name: string;
  color: string;
  /** Share of the vote, 0..100. */
  share: number;
  /** The previous epoch's share (for the change and the opening tween), or null. */
  prevShare: number | null;
  /** MUSD the vault has lent into the line (wei). */
  lent: bigint | null;
  /** Borrower APY, fraction. */
  borrowApy: number | null;
  /** Voters' first-loss cover (seasoning rewards + reserve the line can draw), wei. */
  cover: bigint | null;
  /** Borrowed / supplied, fraction. */
  utilization: number | null;
}

export interface LandingData {
  chainId: number;
  chainName: string;
  /** Deployment of the selected network, or null when Surety is not deployed there. */
  deployment: SuretyDeployment | null;
  read: "loading" | "ready" | "error" | "undeployed";
  /** Where the figures were read: live just now, or the build-time snapshot taken at `asOf`. */
  freshness: "live" | "snapshot" | null;
  /** When the figures were read, ms (null without any read). */
  asOf: number | null;
  source: SplitSource;
  lines: LandingLine[];
  /** Epoch length in seconds (from the deployment; weekly when there is none). */
  epochLength: number;
  /** Chain time minus wall time in seconds, once a block has been read. */
  clockSkew: number;
  vault: { total: bigint; reserve: bigint | null; incentives: bigint };
  ltv: { maxTimedBps: number; maxPermanentBps: number; liqBps: number };
}

const WEEK = 604_800;
const e18 = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n;

/* ---------- Illustrative fallback ---------- */

const ILLUSTRATIVE_SPLITS: Record<number, { now: number[]; prev: number[] }> = {
  1: { now: [100], prev: [100] },
  2: { now: [62, 38], prev: [55, 45] },
  3: { now: [48, 33, 19], prev: [44, 36, 20] },
  4: { now: [46, 29, 16, 9], prev: [40, 34, 17, 9] },
  5: { now: [40, 26, 16, 11, 7], prev: [36, 28, 17, 12, 7] },
};
const ILLUSTRATIVE_APR = [0.068, 0.084, 0.061, 0.049, 0.055];
const ILLUSTRATIVE_COVER = [2310, 1840, 690, 260, 180];
const ILLUSTRATIVE_UTIL = [0.82, 0.74, 0.61, 0.55, 0.48];
export const ILLUSTRATIVE_VAULT = 250_000;
export const ILLUSTRATIVE_RESERVE = 3_100;
const ILLUSTRATIVE_INCENTIVES = 4_800;

const FALLBACK_LINES = [
  { id: 0, name: "BTC / MUSD (Morpho)" },
  { id: 1, name: "veBTC credit line" },
];

/** Line names to illustrate with: the selected network's, else any bundled deployment's. */
function namesFor(deployment: SuretyDeployment | null): { id: number; name: string }[] {
  if (deployment?.lines.length) return deployment.lines.map((l) => ({ id: l.id, name: l.name }));
  for (const id of deployedChainIds()) {
    try {
      const d = getDeployment(id);
      if (d?.lines.length) return d.lines.map((l) => ({ id: l.id, name: l.name }));
    } catch {
      /* a malformed bundled file: try the next one */
    }
  }
  return FALLBACK_LINES;
}

function illustrativeLines(names: { id: number; name: string }[]): LandingLine[] {
  const list = names.slice(0, 5);
  const split = ILLUSTRATIVE_SPLITS[list.length] ?? ILLUSTRATIVE_SPLITS[2]!;
  return list.map((l, i) => ({
    id: l.id,
    name: l.name,
    color: lineColor(l.id),
    share: split.now[i] ?? 0,
    prevShare: split.prev[i] ?? null,
    lent: e18(((split.now[i] ?? 0) / 100) * ILLUSTRATIVE_VAULT),
    borrowApy: ILLUSTRATIVE_APR[i] ?? null,
    cover: e18(ILLUSTRATIVE_COVER[i] ?? 0),
    utilization: ILLUSTRATIVE_UTIL[i] ?? null,
  }));
}

const ILLUSTRATIVE_VAULT_STATS = {
  total: e18(ILLUSTRATIVE_VAULT),
  reserve: e18(ILLUSTRATIVE_RESERVE),
  incentives: e18(ILLUSTRATIVE_INCENTIVES),
};

const DEFAULT_LTV = { maxTimedBps: 5000, maxPermanentBps: 4000, liqBps: 7000 };

/* ---------- Live ---------- */

function liveLines(board: Board): { source: SplitSource; lines: LandingLine[] } | null {
  const { currentVotes, lastClosedVotes } = board.totals;
  const source: SplitSource | null = currentVotes > 0n ? "current" : lastClosedVotes > 0n ? "closed" : null;
  if (!source) return null;
  return {
    source,
    lines: board.lines.map((l) => ({
      id: l.id,
      name: l.name,
      color: lineColor(l.id),
      share: (source === "current" ? l.votes.currentShare : l.votes.lastClosedShare) * 100,
      prevShare: source === "current" && lastClosedVotes > 0n ? l.votes.lastClosedShare * 100 : null,
      lent: l.allocation,
      borrowApy: l.borrowApy,
      cover: l.coverCapacity,
      utilization: l.utilizationWad === null ? null : Number(l.utilizationWad) / 1e18,
    })),
  };
}

const LandingContext = createContext<LandingData | null>(null);

/** Live reads: every 60s while the tab is visible, each time-boxed so a stuck RPC never holds the next one. */
const REFRESH_MS = 60_000;
const LIVE_READ_MS = 6_000;

export function LandingDataProvider({ snapshots, children }: { snapshots: ChainSnapshots; children: ReactNode }) {
  const chainId = useSelectedChain();
  const [live, setLive] = useState<ChainSnapshot | null>(null);
  const [failedOn, setFailedOn] = useState<number | null>(null);

  let deployment: SuretyDeployment | null = null;
  try {
    deployment = getDeployment(chainId) ?? null;
  } catch {
    deployment = null;
  }

  useVisiblePoll(
    async () => {
      if (!deployment) return;
      try {
        const snap = await timeBox(readChainSnapshot(liveClient(chainId, deployment), { peg: false }), LIVE_READ_MS);
        setLive(snap);
        setFailedOn(null);
      } catch {
        setFailedOn(chainId);
      }
    },
    REFRESH_MS,
    { key: chainId, enabled: !!deployment },
  );

  const fromLive = live && live.chainId === chainId ? live : null;
  const fromSnapshot = snapshots[chainId] ?? null;
  const current = fromLive ?? (fromSnapshot && fromSnapshot.version === deployment?.version ? fromSnapshot : null);
  const split = current ? liveLines(current.board) : null;
  const value: LandingData = {
    chainId,
    chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
    deployment,
    read: !deployment ? "undeployed" : current ? "ready" : failedOn === chainId ? "error" : "loading",
    freshness: fromLive ? "live" : current ? "snapshot" : null,
    asOf: current?.asOf ?? null,
    source: split?.source ?? "illustrative",
    lines: split?.lines ?? illustrativeLines(namesFor(deployment)),
    epochLength: current ? Number(current.board.epoch.epochLength) : (deployment?.epochLength ?? WEEK),
    clockSkew: current ? Number(current.board.epoch.now) - current.asOf / 1000 : 0,
    vault:
      split && current
        ? {
            total: current.board.vault.totalAssets,
            reserve: current.reserve,
            incentives: current.board.lines.reduce((a, l) => a + l.incentives.assets, 0n),
          }
        : ILLUSTRATIVE_VAULT_STATS,
    ltv: current?.lineParams
      ? {
          maxTimedBps: current.lineParams.maxLtvTimedBps,
          maxPermanentBps: current.lineParams.maxLtvPermanentBps,
          liqBps: current.lineParams.liqLtvBps,
        }
      : DEFAULT_LTV,
  };

  return <LandingContext.Provider value={value}>{children}</LandingContext.Provider>;
}

export function useLanding(): LandingData {
  const v = useContext(LandingContext);
  if (!v) throw new Error("useLanding outside LandingDataProvider");
  return v;
}

/* ---------- Epoch clock ---------- */

/**
 * Seconds to the next epoch flip, ticking every second; null until mounted (server and client render the
 * same). Epochs start at multiples of the epoch length, as the contracts' EpochLib computes them.
 */
export function useFlip(epochLength: number, skew: number): { secondsLeft: number; nextFlip: number } | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now() / 1000);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  if (now === null || epochLength <= 0) return null;
  const chainNow = now + skew;
  const nextFlip = (Math.floor(chainNow / epochLength) + 1) * epochLength;
  return { secondsLeft: Math.max(0, nextFlip - chainNow), nextFlip };
}

/** "5d 04h 25m" for long epochs, "42m 08s" under a day. */
export function formatFlip(seconds: number): string {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d ${pad(Math.floor((s % 86_400) / 3600))}h ${pad(Math.floor((s % 3600) / 60))}m`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
}

/** When the flip lands, in UTC: "Thu 00:00 UTC" for weekly epochs, "21:00 UTC" for shorter ones. */
export function formatFlipAt(nextFlip: number, epochLength: number): string {
  const d = new Date(nextFlip * 1000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  if (epochLength < 86_400) return hm;
  return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${hm}`;
}

/** "week" for weekly epochs, "epoch" otherwise (testnet runs 1-hour epochs). */
export function periodWord(epochLength: number): string {
  return epochLength === WEEK ? "week" : "epoch";
}

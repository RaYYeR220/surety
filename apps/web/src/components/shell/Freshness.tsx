"use client";

// The build snapshot inside the app: it seeds the board query of each chain, so the overview renders real figures
// from the static HTML on, and the strip under the header says whether the figures on screen are the snapshot
// (with its time) or a live read. Live reads replace the snapshot through the normal queries.
import { getDeployment, MEZO_MAINNET_ID, type Board } from "@surety/sdk";
import { hashKey, useQueryClient, type QueryClient, type QueryState } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { Container } from "@/components/layout/Layout";
import { liveScope, useSurety } from "@/lib/env";
import { formatAsOf } from "@/lib/asOf";
import type { ChainSnapshot, ChainSnapshots } from "@/lib/snapshot";

import { AppLink } from "./AppLink";
import styles from "./Shell.module.css";

export const SnapshotContext = createContext<ChainSnapshots>({});

export function useChainSnapshot(chainId: number): ChainSnapshot | null {
  return useContext(SnapshotContext)[chainId] ?? null;
}

const boardKey = (chainId: number) => [...liveScope(chainId), "board"];

/** Puts each chain's snapshot board in the query cache (kept for the visit), unless a read is already there. */
export function seedSnapshots(client: QueryClient, snapshots: ChainSnapshots): void {
  for (const snap of Object.values(snapshots)) {
    if (!snap) continue;
    let version: number | undefined;
    try {
      version = getDeployment(snap.chainId)?.version;
    } catch {
      version = undefined;
    }
    if (version !== snap.version) continue; // read from another deployment than the one bundled
    const key = boardKey(snap.chainId);
    client.setQueryDefaults(key, { gcTime: Infinity });
    if (client.getQueryData(key) === undefined) client.setQueryData(key, snap.board, { updatedAt: snap.asOf });
  }
}

/** The board query's state for `chainId`, watched without adding an observer (so it never fetches by itself). */
function useBoardState(chainId: number): QueryState<Board> | undefined {
  const client = useQueryClient();
  const key = boardKey(chainId);
  const hash = hashKey(key);
  const subscribe = useCallback(
    (onChange: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hash) onChange();
      }),
    [client, hash],
  );
  const read = () => client.getQueryState<Board>(key);
  return useSyncExternalStore(subscribe, read, read);
}

export function FreshnessStrip() {
  const env = useSurety();
  const snap = useChainSnapshot(env.chainId);
  const state = useBoardState(env.chainId);
  const onTry = usePathname()?.startsWith("/app/try") ?? false;
  if (env.demo) return null;

  const at = state?.dataUpdatedAt || null;
  const live = at !== null && (snap === null || at > snap.asOf);
  const board = state?.data;
  const fetching = state?.fetchStatus === "fetching";
  const failed = !live && state?.status === "error";

  let note: string;
  if (live) note = "Live";
  else if (failed) note = `${env.chainName} did not answer; retrying`;
  else if (fetching) note = "Reading the chain…";
  else note = "";

  return (
    <div className={styles.fresh} data-freshness="">
      <Container>
        <div className={styles.freshInner}>
          <span className={styles.freshText}>
            <span className={styles.freshTag} data-live={live ? "true" : undefined}>
              {live ? "Live" : board ? "Snapshot" : "No data yet"}
            </span>
            <span>
              {env.chainName}
              {at !== null ? ` · as of ${formatAsOf(at)}` : ""}
              {board ? <span className={styles.freshBlock}> · block {board.epoch.blockNumber.toLocaleString("en-US")}</span> : null}
            </span>
            {!live && note ? <span className={styles.freshNote}>{note}</span> : null}
          </span>
          {onTry ? null : env.chainId === MEZO_MAINNET_ID ? (
            <AppLink href="/app/try" className={styles.freshLink}>
              Try it on testnet, no wallet needed
            </AppLink>
          ) : (
            <AppLink href="/app/try" className={styles.freshLink}>
              Testnet: get a starter kit
            </AppLink>
          )}
        </div>
      </Container>
    </div>
  );
}

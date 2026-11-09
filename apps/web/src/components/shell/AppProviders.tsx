"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { reconnect } from "wagmi/actions";

import { TxProvider } from "@/components/tx/TxProvider";
import type { DemoScenario } from "@/lib/demo";
import { SuretyProvider } from "@/lib/env";
import type { ChainSnapshots } from "@/lib/snapshot";
import { wagmiConfig } from "@/lib/wagmi";

import { SnapshotContext, seedSnapshots } from "./Freshness";
import { WalletDialogProvider } from "./WalletDialog";

function demoFrom(param: string | null): DemoScenario | null {
  if (param === null || param === "0" || param === "false") return null;
  return param === "stale" || param === "paused" ? param : "default";
}

/**
 * Reads ?demo from the URL. It sits in its own Suspense boundary, so only this empty component waits for the URL
 * in the static export; the rest of the app renders into the HTML (live mode, from the snapshot).
 */
function DemoFromUrl({ onChange }: { onChange: (demo: DemoScenario | null) => void }) {
  const demo = demoFrom(useSearchParams().get("demo"));
  useEffect(() => onChange(demo), [demo, onChange]);
  return null;
}

/** A visitor who last connected a Passport (Bitcoin) wallet gets it back: its code loads only for them. */
function PassportReconnect() {
  useEffect(() => {
    let recent: string | null = null;
    try {
      recent = JSON.parse(window.localStorage.getItem("wagmi.recentConnectorId") ?? "null") as string | null;
    } catch {
      recent = null;
    }
    if (!recent?.startsWith("orangekit-")) return;
    let cancelled = false;
    void (async () => {
      try {
        const { passportWallets } = await import("@/lib/passport");
        const chainId = wagmiConfig.state.chainId;
        const wallet = passportWallets(chainId).find((w) => w.id === recent);
        if (!cancelled && wallet?.installed) await reconnect(wagmiConfig, { connectors: [wallet.connector] });
      } catch {
        /* the wallet stays disconnected; the dialog offers it again */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

export function AppProviders({ snapshots, children }: { snapshots: ChainSnapshots; children: ReactNode }) {
  const [demo, setDemo] = useState<DemoScenario | null>(null);
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 15_000,
          retry: 1,
          retryDelay: 2_000,
          refetchOnWindowFocus: true,
          // Interval polling pauses while the tab is hidden.
          refetchIntervalInBackground: false,
        },
      },
    });
    seedSnapshots(client, snapshots);
    return client;
  });
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SnapshotContext.Provider value={snapshots}>
          <Suspense fallback={null}>
            <DemoFromUrl onChange={setDemo} />
          </Suspense>
          <PassportReconnect />
          <SuretyProvider demo={demo}>
            <WalletDialogProvider>
              <TxProvider>{children}</TxProvider>
            </WalletDialogProvider>
          </SuretyProvider>
        </SnapshotContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

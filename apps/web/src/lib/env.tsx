"use client";

import {
  createMezoPublicClient,
  createSuretyClient,
  explorerUrl,
  getDeployment,
  isMezoChainId,
  MEZO_MAINNET_ID,
  MEZO_TESTNET_ID,
  type SuretyClient,
  type SuretyDeployment,
} from "@surety/sdk";
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";

import type { Demo, DemoScenario } from "./demo";

export const CHAIN_NAMES: Record<number, string> = {
  [MEZO_TESTNET_ID]: "Mezo Testnet",
  [MEZO_MAINNET_ID]: "Mezo Mainnet",
};

export type Mode = "live" | "demo";

interface Common {
  /** Network the app is reading. */
  chainId: number;
  chainName: string;
  /** Pick the network to read (live mode). Also asks a connected wallet to switch. */
  selectChain: (chainId: number) => void;
  /** Example data from the SDK fixture, or null in live mode; undefined while the URL is being read. */
  demo: DemoScenario | null | undefined;
}

export type SuretyEnv =
  | (Common & { status: "loading" })
  | (Common & { status: "undeployed"; mode: "live" })
  | (Common & { status: "error"; mode: Mode; error: Error })
  | (Common & {
      status: "ready";
      mode: Mode;
      client: SuretyClient;
      deployment: SuretyDeployment;
      /** Connected wallet, or the fixture's example wallet in demo mode. */
      account: Address | undefined;
      /** Whether writes can be sent (a real wallet on a deployed network; the flow switches its chain). */
      canSend: boolean;
      /** Explorer link, or null when addresses are not real (demo). */
      explorer: (kind: "tx" | "address" | "block", value: string | bigint) => string | null;
      /** Key prefix for every query of this environment. */
      scope: readonly unknown[];
    });

export type ReadyEnv = Extract<SuretyEnv, { status: "ready" }>;

const SuretyContext = createContext<SuretyEnv | null>(null);

const CHAIN_KEY = "surety-chain";

/* The network picked in the header, kept in localStorage (testnet when nothing is saved). */
const chainListeners = new Set<() => void>();
let memoryChain: number = MEZO_TESTNET_ID;

function readSavedChain(): number {
  try {
    const saved = Number(window.localStorage.getItem(CHAIN_KEY));
    return isMezoChainId(saved) ? saved : memoryChain;
  } catch {
    return memoryChain;
  }
}

function saveChain(id: number) {
  memoryChain = id;
  try {
    window.localStorage.setItem(CHAIN_KEY, String(id));
  } catch {
    /* storage unavailable: kept in memory for this visit */
  }
  chainListeners.forEach((l) => l());
}

function subscribeChain(onChange: () => void) {
  chainListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    chainListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

const liveClients = new Map<number, SuretyClient>();

function liveClient(chainId: number, deployment: SuretyDeployment): SuretyClient {
  let client = liveClients.get(chainId);
  if (!client) {
    client = createSuretyClient({ chainId, deployment, publicClient: createMezoPublicClient(chainId) });
    liveClients.set(chainId, client);
  }
  return client;
}

export function SuretyProvider({ demo, children }: { demo: DemoScenario | null | undefined; children: ReactNode }) {
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const selected = useSyncExternalStore(subscribeChain, readSavedChain, () => MEZO_TESTNET_ID);

  // A wallet on a Mezo chain decides the network; otherwise the picker does.
  const walletOnMezo = isConnected && walletChainId !== undefined && isMezoChainId(walletChainId);
  const chainId = demo ? MEZO_TESTNET_ID : walletOnMezo ? walletChainId : selected;

  const selectChain = useCallback((id: number) => saveChain(id), []);

  const demoQuery = useQuery({
    queryKey: ["demo-fixture", demo ?? "off"],
    queryFn: async (): Promise<Demo> => {
      const { createDemo } = await import("./demo");
      return createDemo(demo ?? "default");
    },
    enabled: !!demo,
    staleTime: Infinity,
    gcTime: Infinity,
    structuralSharing: false,
  });

  const value = useMemo<SuretyEnv>(() => {
    const common: Common = { chainId, chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`, selectChain, demo };
    if (demo === undefined) return { ...common, status: "loading" };
    if (demo) {
      if (demoQuery.error) return { ...common, status: "error", mode: "demo", error: demoQuery.error };
      const d = demoQuery.data;
      if (!d) return { ...common, status: "loading" };
      return {
        ...common,
        status: "ready",
        mode: "demo",
        client: d.client,
        deployment: d.deployment,
        account: d.account,
        canSend: false,
        explorer: () => null,
        scope: ["surety", "demo", demo],
      };
    }
    let deployment: SuretyDeployment | undefined;
    try {
      deployment = getDeployment(chainId);
    } catch (e) {
      return { ...common, status: "error", mode: "live", error: e instanceof Error ? e : new Error(String(e)) };
    }
    if (!deployment) return { ...common, status: "undeployed", mode: "live" };
    return {
      ...common,
      status: "ready",
      mode: "live",
      client: liveClient(chainId, deployment),
      deployment,
      account: isConnected ? address : undefined,
      canSend: isConnected,
      explorer: (kind, v) => explorerUrl(chainId, kind, v),
      scope: ["surety", "live", chainId],
    };
  }, [address, chainId, demo, demoQuery.data, demoQuery.error, isConnected, selectChain]);

  return <SuretyContext.Provider value={value}>{children}</SuretyContext.Provider>;
}

export function useSurety(): SuretyEnv {
  const env = useContext(SuretyContext);
  if (!env) throw new Error("useSurety outside SuretyProvider");
  return env;
}

/** The environment, or null outside the app (the landing page has no provider). */
export function useSuretyOptional(): SuretyEnv | null {
  return useContext(SuretyContext);
}

/** The ready environment, or null while loading / not deployed. */
export function useReady(): ReadyEnv | null {
  const env = useSurety();
  return env.status === "ready" ? env : null;
}

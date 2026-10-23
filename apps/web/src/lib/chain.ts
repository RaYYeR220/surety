"use client";

// The network picked in the app header, kept in localStorage (testnet when nothing is saved). Shared by the
// app (env.tsx) and the landing page, which reads the same network without the wallet providers.
import {
  createMezoPublicClient,
  createSuretyClient,
  isMezoChainId,
  MEZO_TESTNET_ID,
  type SuretyClient,
  type SuretyDeployment,
} from "@surety/sdk";
import { useSyncExternalStore } from "react";

export { CHAIN_NAMES } from "./networks";

const CHAIN_KEY = "surety-chain";

const chainListeners = new Set<() => void>();
let memoryChain: number = MEZO_TESTNET_ID;

export function readSavedChain(): number {
  try {
    const saved = Number(window.localStorage.getItem(CHAIN_KEY));
    return isMezoChainId(saved) ? saved : memoryChain;
  } catch {
    return memoryChain;
  }
}

export function saveChain(id: number) {
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

/** The selected network (testnet on the server and before anything is saved). */
export function useSelectedChain(): number {
  return useSyncExternalStore(subscribeChain, readSavedChain, () => MEZO_TESTNET_ID);
}

const liveClients = new Map<number, SuretyClient>();

/** One SDK client per chain over the public Mezo RPCs, shared by the app and the landing. */
export function liveClient(chainId: number, deployment: SuretyDeployment): SuretyClient {
  let client = liveClients.get(chainId);
  if (!client) {
    client = createSuretyClient({ chainId, deployment, publicClient: createMezoPublicClient(chainId) });
    liveClients.set(chainId, client);
  }
  return client;
}

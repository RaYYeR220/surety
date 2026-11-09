"use client";

// The network the visitor picked, kept in localStorage. Mainnet is the default view (on the server, in the static
// pages and before anything is saved); testnet is one click away. Shared by the app (env.tsx) and the landing
// page, which reads the same network without the wallet providers.
import {
  createSuretyClient,
  isMezoChainId,
  MEZO_MAINNET_ID,
  type SuretyClient,
  type SuretyDeployment,
} from "@surety/sdk";
import { useSyncExternalStore } from "react";

import { createReadClient } from "./rpc";

export { CHAIN_NAMES } from "./networks";

/** The network shown before the visitor picks one. */
export const DEFAULT_CHAIN_ID = MEZO_MAINNET_ID;

const CHAIN_KEY = "surety-chain";

const chainListeners = new Set<() => void>();
let memoryChain: number = DEFAULT_CHAIN_ID;

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

/** The selected network (mainnet on the server and before anything is saved). */
export function useSelectedChain(): number {
  return useSyncExternalStore(subscribeChain, readSavedChain, () => DEFAULT_CHAIN_ID);
}

const liveClients = new Map<string, SuretyClient>();

/**
 * One SDK client per chain and deployment, over the time-boxed fallback transport (lib/rpc.ts). Shared by the
 * app, the landing and the try-it flow.
 */
export function liveClient(chainId: number, deployment: SuretyDeployment): SuretyClient {
  const key = `${chainId}:${deployment.version}:${deployment.contracts.vault}`;
  let client = liveClients.get(key);
  if (!client) {
    client = createSuretyClient({ chainId, deployment, publicClient: createReadClient(chainId) });
    liveClients.set(key, client);
  }
  return client;
}

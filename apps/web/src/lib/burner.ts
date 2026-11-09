"use client";

// A testnet key kept in this browser, and the wagmi connector that signs with it, so a visitor can try every flow
// (borrow, vote, repay) with nothing to install. Mezo Testnet only: the connector refuses any other chain. The key
// lives in localStorage in plain text, which is fine for test BTC and test MUSD and for nothing else; the page
// that creates it says so, and offers export and reset. The signing code (viem/accounts) loads on first use.
import { MEZO_TESTNET_ID } from "@surety/sdk";
import { useSyncExternalStore } from "react";
import {
  createWalletClient,
  getAddress,
  hexToBigInt,
  numberToHex,
  SwitchChainError,
  type Address,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Hex,
  type LocalAccount,
} from "viem";
import { createConnector } from "wagmi";

import { createReadClient, mezoChain, rpcTransport } from "./rpc";

export const BURNER_ID = "surety-burner";
export const BURNER_NAME = "Testnet key in this browser";
export const BURNER_CHAIN_ID = MEZO_TESTNET_ID;

const KEY_ITEM = "surety-burner";
const CONNECTED_ITEM = "surety-burner-connected";

export interface BurnerKey {
  address: Address;
  privateKey: Hex;
  /** When it was created, ms. */
  createdAt: number;
}

/* ---------- Key storage ---------- */

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedKey: BurnerKey | null = null;

function emit() {
  listeners.forEach((l) => l());
}

export function readBurnerKey(): BurnerKey | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY_ITEM);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedKey;
  cachedRaw = raw;
  cachedKey = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<BurnerKey>;
      if (typeof parsed.privateKey === "string" && /^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey) && parsed.address) {
        cachedKey = {
          address: getAddress(parsed.address),
          privateKey: parsed.privateKey as Hex,
          createdAt: Number(parsed.createdAt ?? 0),
        };
      }
    } catch {
      cachedKey = null;
    }
  }
  return cachedKey;
}

/** Creates (or returns the existing) testnet key of this browser. */
export async function createBurnerKey(): Promise<BurnerKey> {
  const existing = readBurnerKey();
  if (existing) return existing;
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const key: BurnerKey = { address: privateKeyToAccount(privateKey).address, privateKey, createdAt: Date.now() };
  window.localStorage.setItem(KEY_ITEM, JSON.stringify(key));
  emit();
  return key;
}

/** Forgets the key. Whatever it holds stays on chain, out of reach unless it was exported. */
export function resetBurnerKey(): void {
  try {
    window.localStorage.removeItem(KEY_ITEM);
    window.localStorage.removeItem(CONNECTED_ITEM);
  } catch {
    /* nothing stored */
  }
  emit();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The key of this browser, or null (always null on the server). */
export function useBurnerKey(): BurnerKey | null {
  return useSyncExternalStore(subscribe, readBurnerKey, () => null);
}

function setConnectedFlag(on: boolean) {
  try {
    if (on) window.localStorage.setItem(CONNECTED_ITEM, "1");
    else window.localStorage.removeItem(CONNECTED_ITEM);
  } catch {
    /* storage unavailable */
  }
}

function connectedFlag(): boolean {
  try {
    return window.localStorage.getItem(CONNECTED_ITEM) === "1";
  } catch {
    return false;
  }
}

/* ---------- EIP-1193 provider ---------- */

class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRpcError";
  }
}

const TESTNET_ONLY = "The testnet key works on Mezo Testnet only.";

type TxParams = {
  from?: Address;
  to?: Address;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
  nonce?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
};

const big = (v: Hex | undefined) => (v === undefined ? undefined : hexToBigInt(v));

function createBurnerProvider() {
  const reads = createReadClient(BURNER_CHAIN_ID);
  let account: LocalAccount | null = null;
  let accountKey: Hex | null = null;

  async function signer(): Promise<LocalAccount> {
    const key = readBurnerKey();
    if (!key) throw new ProviderRpcError(4100, "No testnet key in this browser.");
    if (!account || accountKey !== key.privateKey) {
      const { privateKeyToAccount } = await import("viem/accounts");
      account = privateKeyToAccount(key.privateKey);
      accountKey = key.privateKey;
    }
    return account;
  }

  const request = (async ({ method, params }: EIP1193Parameters) => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts": {
        const key = readBurnerKey();
        return key ? [key.address] : [];
      }
      case "eth_chainId":
        return numberToHex(BURNER_CHAIN_ID);
      case "net_version":
        return String(BURNER_CHAIN_ID);
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain": {
        const id = Number((p[0] as { chainId?: string } | undefined)?.chainId);
        if (id !== BURNER_CHAIN_ID) throw new ProviderRpcError(4902, TESTNET_ONLY);
        return null;
      }
      case "personal_sign": {
        const acc = await signer();
        return acc.signMessage({ message: { raw: p[0] as Hex } });
      }
      case "eth_signTypedData_v4": {
        const acc = await signer();
        const typed = JSON.parse(p[1] as string);
        return acc.signTypedData(typed);
      }
      case "eth_sendTransaction": {
        const acc = await signer();
        const tx = p[0] as TxParams;
        const wallet = createWalletClient({
          account: acc,
          chain: mezoChain(BURNER_CHAIN_ID),
          transport: rpcTransport(BURNER_CHAIN_ID, { batch: false, timeout: 10_000 }),
        });
        const fees =
          tx.maxFeePerGas !== undefined
            ? { maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas) }
            : tx.gasPrice !== undefined
              ? { gasPrice: big(tx.gasPrice) }
              : {};
        return wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: big(tx.value),
          gas: big(tx.gas),
          nonce: tx.nonce === undefined ? undefined : Number(tx.nonce),
          ...fees,
        } as Parameters<typeof wallet.sendTransaction>[0]);
      }
      default:
        if (method.startsWith("wallet_") || method === "eth_sign" || method.startsWith("eth_signTransaction")) {
          throw new ProviderRpcError(4200, `${method} is not supported by the testnet key.`);
        }
        return reads.request({ method, params } as never);
    }
  }) as EIP1193RequestFn;

  return {
    request,
    on: () => undefined,
    removeListener: () => undefined,
  };
}

export type BurnerProvider = ReturnType<typeof createBurnerProvider>;

/* ---------- wagmi connector ---------- */

/** wagmi connector for the testnet key of this browser. */
export function burner() {
  return createConnector<BurnerProvider>((config) => {
    let provider: BurnerProvider | null = null;
    return {
      id: BURNER_ID,
      name: BURNER_NAME,
      type: "burner",
      async connect(parameters) {
        const key = readBurnerKey();
        if (!key) throw new Error("There is no testnet key in this browser yet. Create one on the Try it page.");
        if (parameters?.chainId !== undefined && parameters.chainId !== BURNER_CHAIN_ID) {
          throw new SwitchChainError(new Error(TESTNET_ONLY));
        }
        setConnectedFlag(true);
        return { accounts: [key.address], chainId: BURNER_CHAIN_ID } as never;
      },
      async disconnect() {
        setConnectedFlag(false);
      },
      async getAccounts() {
        const key = readBurnerKey();
        return key ? [key.address] : [];
      },
      async getChainId() {
        return BURNER_CHAIN_ID;
      },
      async getProvider() {
        provider ??= createBurnerProvider();
        return provider;
      },
      async isAuthorized() {
        return !!readBurnerKey() && connectedFlag();
      },
      async switchChain({ chainId }) {
        const chain = config.chains.find((c) => c.id === chainId);
        if (chainId !== BURNER_CHAIN_ID || !chain) throw new SwitchChainError(new Error(TESTNET_ONLY));
        return chain;
      },
      onAccountsChanged(accounts) {
        if (accounts.length === 0) config.emitter.emit("disconnect");
        else config.emitter.emit("change", { accounts: accounts.map((a) => getAddress(a)) });
      },
      onChainChanged(chainId) {
        config.emitter.emit("change", { chainId: Number(chainId) });
      },
      onDisconnect() {
        setConnectedFlag(false);
        config.emitter.emit("disconnect");
      },
    };
  });
}

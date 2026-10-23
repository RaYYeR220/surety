import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient } from "viem";

/** Multicall3, deployed at its canonical address on both Mezo chains (checked with `cast code`). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const MEZO_MAINNET_ID = 31612;
export const MEZO_TESTNET_ID = 31611;

export const mezoMainnet = defineChain({
  id: MEZO_MAINNET_ID,
  name: "Mezo",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://mezo-mainnet.boar.network",
        "https://mezo.drpc.org",
        "https://mainnet.mezo.public.validationcloud.io",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: "https://explorer.mezo.org", apiUrl: "https://api.explorer.mezo.org/api" },
  },
  contracts: {
    multicall3: { address: MULTICALL3_ADDRESS },
  },
});

export const mezoTestnet = defineChain({
  id: MEZO_TESTNET_ID,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.test.mezo.org"] },
  },
  blockExplorers: {
    default: {
      name: "Mezo Testnet Explorer",
      url: "https://explorer.test.mezo.org",
      apiUrl: "https://api.explorer.test.mezo.org/api",
    },
  },
  contracts: {
    multicall3: { address: MULTICALL3_ADDRESS, blockCreated: 3_328_573 },
  },
  testnet: true,
});

export const mezoChains = { [MEZO_MAINNET_ID]: mezoMainnet, [MEZO_TESTNET_ID]: mezoTestnet } as const;

export type MezoChainId = keyof typeof mezoChains;

export function isMezoChainId(chainId: number): chainId is MezoChainId {
  return chainId === MEZO_MAINNET_ID || chainId === MEZO_TESTNET_ID;
}

/** The viem chain for a Mezo chain id. Throws for other ids. */
export function getMezoChain(chainId: number): Chain {
  if (!isMezoChainId(chainId)) throw new Error(`not a Mezo chain id: ${chainId}`);
  return mezoChains[chainId];
}

/** Explorer link for a transaction, address or block on a Mezo chain. */
export function explorerUrl(chainId: number, kind: "tx" | "address" | "block", value: string | bigint): string {
  const base = getMezoChain(chainId).blockExplorers!.default.url;
  return `${base}/${kind}/${value.toString()}`;
}

export interface MezoClientOptions {
  /** RPC URLs to use instead of the chain defaults, tried in order. */
  rpcUrls?: string[];
  /** Per-request timeout in ms (default 15 000). */
  timeout?: number;
}

/**
 * A viem public client for a Mezo chain over HTTP, falling back across the chain's RPC endpoints
 * (or `rpcUrls`) in order.
 */
export function createMezoPublicClient(chainId: number, options: MezoClientOptions = {}): PublicClient {
  const chain = getMezoChain(chainId);
  const urls = options.rpcUrls?.length ? options.rpcUrls : [...chain.rpcUrls.default.http];
  const timeout = options.timeout ?? 15_000;
  const transports = urls.map((url) => http(url, { timeout, retryCount: 2 }));
  return createPublicClient({
    chain,
    transport: transports.length === 1 ? transports[0]! : fallback(transports, { rank: false }),
  }) as PublicClient;
}

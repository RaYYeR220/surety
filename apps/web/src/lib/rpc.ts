// Public Mezo RPCs and the read clients built on them. Every request is time-boxed and falls back across the
// endpoints of its chain, so one slow or dead RPC never holds a page. Imported by the app, the landing, the
// build-time snapshot and the starter-kit function, so it only uses viem and the SDK.
import { getMezoChain, MEZO_MAINNET_ID, MEZO_TESTNET_ID } from "@surety/sdk";
import { createPublicClient, fallback, http, type Chain, type PublicClient, type Transport } from "viem";

/**
 * JSON-RPC endpoints per chain, tried in order (checked 2026-11-09 for eth_call, JSON-RPC batches and open CORS).
 * Mainnet: validationcloud and Mezo's own node also serve eth_getLogs over 10 000-block windows; drpc's free plan
 * serves recent logs only, so it sits second. rpc-http.mezo.org does not resolve.
 * Testnet: rpc.test.mezo.org is the only full public node; routeme is a rate-limited last resort
 * (mezo-testnet.drpc.org answers no methods on its free plan).
 */
export const RPC_URLS: Record<number, readonly string[]> = {
  [MEZO_MAINNET_ID]: [
    "https://mainnet.mezo.public.validationcloud.io",
    "https://mezo.drpc.org",
    "https://rpc-internal.mezo.org",
    "https://mezo-mainnet.boar.network",
  ],
  [MEZO_TESTNET_ID]: ["https://rpc.test.mezo.org", "https://lb.routeme.sh/rpc/evm/31611"],
};

/** Hosts of every RPC above (the load check blocks these to prove pages render without them). */
export const RPC_HOSTS: string[] = [...new Set(Object.values(RPC_URLS).flatMap((urls) => urls.map((u) => new URL(u).host)))];

/** Time box for one live read, ms. */
export const READ_TIMEOUT_MS = 4_000;

export function rpcUrls(chainId: number): readonly string[] {
  const urls = RPC_URLS[chainId];
  if (!urls?.length) throw new Error(`no RPC endpoints for chain ${chainId}`);
  return urls;
}

export interface RpcOptions {
  /** Per-request timeout, ms (default READ_TIMEOUT_MS). */
  timeout?: number;
  /** Combine requests made in the same tick into one HTTP call (default true). */
  batch?: boolean;
}

/** JSON-RPC "internal error" (-32603): rpc.test.mezo.org answers some calls with "method handler crashed". */
function isNodeCrash(error: unknown): boolean {
  for (let e = error as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 6; e = e.cause as typeof e, i++) {
    if (e.code === -32603) return true;
  }
  return false;
}

/** Retries an endpoint's crashed calls (they succeed a moment later) but never its timeouts. */
export function retryCrashes(transport: Transport, attempts = 2, delayMs = 250): Transport {
  return (opts) => {
    const inner = transport(opts);
    const request = (async (args: Parameters<typeof inner.request>[0]) => {
      for (let i = 0; ; i++) {
        try {
          return await inner.request(args);
        } catch (e) {
          if (i >= attempts || !isNodeCrash(e)) throw e;
          await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        }
      }
    }) as typeof inner.request;
    return { ...inner, request };
  };
}

/**
 * HTTP transports over every endpoint of `chainId`, falling back in order. A slow endpoint costs one timeout
 * (no per-endpoint retry), then the next one answers; a crashed call is retried on the same endpoint first.
 * The whole chain is retried once.
 */
export function rpcTransport(chainId: number, options: RpcOptions = {}): Transport {
  const timeout = options.timeout ?? READ_TIMEOUT_MS;
  const batch = options.batch === false ? false : { batchSize: 32, wait: 16 };
  return fallback(
    rpcUrls(chainId).map((url) => retryCrashes(http(url, { timeout, retryCount: 0, batch }))),
    { rank: false, retryCount: 1, retryDelay: 250 },
  );
}

/** The SDK's Mezo chain with the RPC list above (what wallets are asked to add). */
export function mezoChain(chainId: number): Chain {
  const chain = getMezoChain(chainId);
  return { ...chain, rpcUrls: { default: { http: [...rpcUrls(chainId)] } } };
}

/** A read-only client for `chainId` over the fallback transport. */
export function createReadClient(chainId: number, options: RpcOptions = {}): PublicClient {
  return createPublicClient({
    chain: mezoChain(chainId),
    transport: rpcTransport(chainId, options),
    pollingInterval: 4_000,
  }) as PublicClient;
}

export class ReadTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} took longer than ${Math.round(ms / 100) / 10}s`);
    this.name = "ReadTimeoutError";
  }
}

/** Resolves with `promise`, or rejects with ReadTimeoutError after `ms`. The read itself is left to finish. */
export function timeBox<T>(promise: Promise<T>, ms: number = READ_TIMEOUT_MS, what = "The read"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeoutError(what, ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

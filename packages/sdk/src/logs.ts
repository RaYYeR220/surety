import type { AbiEvent, Address, Log, PublicClient } from "viem";

export interface ChunkedLogsParams<event extends AbiEvent> {
  address: Address;
  event: event;
  /** Indexed-argument filter, as for viem `getLogs`. */
  args?: Record<string, unknown>;
  fromBlock: bigint;
  toBlock: bigint;
  /** Blocks per `eth_getLogs` window (default 10 000, the Mezo testnet RPC limit). */
  chunkSize?: bigint;
  /** Called after each window with the last block covered. */
  onProgress?: (toBlock: bigint) => void;
}

/**
 * `eth_getLogs` over `[fromBlock, toBlock]` in fixed windows, sequentially, so public RPC range limits hold.
 * Logs come back in block order.
 */
export async function getLogsChunked<const event extends AbiEvent>(
  client: PublicClient,
  params: ChunkedLogsParams<event>,
): Promise<Log<bigint, number, false, event, true>[]> {
  const chunk = params.chunkSize ?? 10_000n;
  if (chunk <= 0n) throw new Error("chunkSize must be positive");
  const out: Log<bigint, number, false, event, true>[] = [];
  for (let from = params.fromBlock; from <= params.toBlock; from += chunk) {
    const to = from + chunk - 1n < params.toBlock ? from + chunk - 1n : params.toBlock;
    const logs = await client.getLogs({
      address: params.address,
      event: params.event,
      ...(params.args ? { args: params.args } : {}),
      fromBlock: from,
      toBlock: to,
      strict: true,
    } as Parameters<PublicClient["getLogs"]>[0]);
    out.push(...(logs as unknown as Log<bigint, number, false, event, true>[]));
    params.onProgress?.(to);
  }
  return out;
}

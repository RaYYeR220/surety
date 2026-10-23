import type {
  Abi,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  PublicClient,
} from "viem";

type ReadMutability = "pure" | "view";

/** One contract read, carrying its decoded result type. Build with `call()`. */
export interface ReadCall<T = unknown> {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Type marker only; never set. */
  readonly __result?: T;
}

/** A settled read: the decoded value or the error (usually a revert). */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

type ResultOf<C> = C extends ReadCall<infer T> ? T : never;

/** Builds a typed read of `functionName` on `address`. */
export function call<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, ReadMutability>,
  const args extends ContractFunctionArgs<abi, ReadMutability, functionName>,
>(
  address: Address,
  abi: abi,
  functionName: functionName,
  args?: args,
): ReadCall<ContractFunctionReturnType<abi, ReadMutability, functionName, args>> {
  return args === undefined
    ? { address, abi: abi as Abi, functionName }
    : { address, abi: abi as Abi, functionName, args: args as readonly unknown[] };
}

export interface ReaderOptions {
  /** Multicall3 address; without one, reads go out as individual `eth_call`s in parallel. */
  multicallAddress?: Address | undefined;
  /** Max calldata bytes per aggregate3 call (default 16 384). */
  batchSize?: number;
}

export interface ReadOptions {
  /** Block to read at; pin it so one view is consistent across batches. */
  blockNumber?: bigint | undefined;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Batches contract reads through Multicall3 (or parallel `eth_call`s), settling each one independently. */
export class Reader {
  readonly client: PublicClient;
  readonly multicallAddress: Address | undefined;
  readonly batchSize: number;

  constructor(client: PublicClient, options: ReaderOptions = {}) {
    this.client = client;
    this.multicallAddress = options.multicallAddress;
    this.batchSize = options.batchSize ?? 16_384;
  }

  /** Runs every call; a revert settles that call as failed without affecting the others. RPC errors throw. */
  async settle<const T extends readonly ReadCall[]>(
    calls: T,
    options: ReadOptions = {},
  ): Promise<{ -readonly [K in keyof T]: Settled<ResultOf<T[K]>> }> {
    type Out = { -readonly [K in keyof T]: Settled<ResultOf<T[K]>> };
    if (calls.length === 0) return [] as unknown as Out;
    const blockNumber = options.blockNumber;

    if (this.multicallAddress) {
      const results = await this.client.multicall({
        contracts: calls as unknown as readonly {
          address: Address;
          abi: Abi;
          functionName: string;
          args?: readonly unknown[];
        }[],
        allowFailure: true,
        multicallAddress: this.multicallAddress,
        batchSize: this.batchSize,
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
      return results.map((r) =>
        r.status === "success" ? { ok: true, value: r.result } : { ok: false, error: toError(r.error) },
      ) as unknown as Out;
    }

    const settled = await Promise.all(
      calls.map(async (c): Promise<Settled<unknown>> => {
        try {
          const value = await this.client.readContract({
            address: c.address,
            abi: c.abi,
            functionName: c.functionName,
            ...(c.args === undefined ? {} : { args: c.args }),
            ...(blockNumber === undefined ? {} : { blockNumber }),
          } as Parameters<PublicClient["readContract"]>[0]);
          return { ok: true, value };
        } catch (e) {
          if (isRevert(e)) return { ok: false, error: toError(e) };
          throw e;
        }
      }),
    );
    return settled as unknown as Out;
  }

  /** Runs every call and returns the values; throws the first failure. */
  async values<const T extends readonly ReadCall[]>(
    calls: T,
    options: ReadOptions = {},
  ): Promise<{ -readonly [K in keyof T]: ResultOf<T[K]> }> {
    const settled = (await this.settle(calls, options)) as Settled<unknown>[];
    return settled.map((s, i) => {
      if (!s.ok) {
        const c = calls[i]!;
        throw new Error(`read ${c.functionName} on ${c.address} failed: ${s.error.message}`, { cause: s.error });
      }
      return s.value;
    }) as unknown as { -readonly [K in keyof T]: ResultOf<T[K]> };
  }
}

/** Whether an error from a read is a contract revert (as opposed to a transport or RPC failure). */
export function isRevert(e: unknown): boolean {
  const chain: { name?: string; message?: string }[] = [];
  let err: unknown = e;
  for (let depth = 0; err && depth < 10; depth++) {
    chain.push(err as { name?: string; message?: string });
    err = (err as { cause?: unknown }).cause;
  }
  const transport = new Set(["HttpRequestError", "TimeoutError", "WebSocketRequestError", "LimitExceededRpcError"]);
  if (chain.some((x) => x.name !== undefined && transport.has(x.name))) return false;
  return chain.some(
    (x) =>
      x.name === "ContractFunctionRevertedError" ||
      x.name === "ContractFunctionZeroDataError" ||
      /execution reverted/i.test(String(x.message ?? "")),
  );
}

/** The value of a settled read, or `null` if it failed. */
export function orNull<T>(s: Settled<T>): T | null {
  return s.ok ? s.value : null;
}

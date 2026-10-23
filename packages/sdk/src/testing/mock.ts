import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAbiItem,
  multicall3Abi,
  numberToHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";

import { MULTICALL3_ADDRESS } from "../chains.js";

/** A mocked function: a constant result, or a function of the decoded arguments. */
export type MockFunction = unknown;

export interface MockContract {
  address: Address;
  abi: Abi;
  /** Results by function name. Missing functions revert. */
  functions: Record<string, MockFunction>;
}

/** Throw from a mocked function to make the call revert with `data`. */
export class MockRevert extends Error {
  readonly data: Hex;
  constructor(data: Hex = "0x", message = "execution reverted") {
    super(message);
    this.data = data;
  }
}

/** An `eth_getLogs` result entry, in RPC (hex) form. */
export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed: boolean;
}

export interface MockChainOptions {
  chain: Chain;
  blockNumber: bigint;
  timestamp: bigint;
  contracts: MockContract[];
  logs?: RpcLog[];
  /** Handle any method first; return `undefined` to fall through to the defaults. */
  override?: (method: string, params: unknown[]) => unknown;
}

export interface MockRequest {
  method: string;
  params: unknown[];
}

export interface MockChain {
  client: PublicClient;
  /** Every JSON-RPC request the client sent, in order. */
  requests: MockRequest[];
  options: MockChainOptions;
}

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

function lower(a: string): string {
  return a.toLowerCase();
}

/** Builds an RPC log for `eventName` of `abi` with `args`. */
export function mockLog(params: {
  abi: Abi;
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  blockNumber: bigint;
  logIndex?: number;
}): RpcLog {
  const event = getAbiItem({ abi: params.abi, name: params.eventName }) as AbiEvent;
  const topics = encodeEventTopics({
    abi: [event],
    eventName: event.name,
    args: params.args,
  } as Parameters<typeof encodeEventTopics>[0]) as Hex[];
  const dataInputs = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    dataInputs,
    dataInputs.map((i) => params.args[i.name ?? ""]),
  );
  return {
    address: params.address,
    topics,
    data,
    blockNumber: numberToHex(params.blockNumber),
    blockHash: ZERO_HASH,
    transactionHash: numberToHex(params.blockNumber * 1000n + BigInt(params.logIndex ?? 0), { size: 32 }),
    transactionIndex: "0x0",
    logIndex: numberToHex(params.logIndex ?? 0),
    removed: false,
  };
}

function matchesTopics(log: RpcLog, topics: (Hex | Hex[] | null)[] | undefined): boolean {
  if (!topics) return true;
  return topics.every((t, i) => {
    if (t === null || t === undefined) return true;
    const actual = log.topics[i];
    if (actual === undefined) return false;
    return Array.isArray(t) ? t.map(lower).includes(lower(actual)) : lower(t) === lower(actual);
  });
}

function toBlock(tag: unknown, latest: bigint): bigint {
  if (typeof tag !== "string" || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") {
    return latest;
  }
  if (tag === "earliest") return 0n;
  return BigInt(tag);
}

/**
 * A viem public client whose transport answers `eth_call` from mocked contracts (including Multicall3
 * `aggregate3`), `eth_getLogs` from a log list, and block queries from a fixed head.
 */
export function createMockChain(options: MockChainOptions): MockChain {
  const byAddress = new Map(options.contracts.map((c) => [lower(c.address), c]));
  const requests: MockRequest[] = [];

  function dispatch(to: Address, data: Hex): { ok: true; data: Hex } | { ok: false; data: Hex } {
    const contract = byAddress.get(lower(to));
    if (!contract) return { ok: true, data: "0x" }; // no code
    let functionName: string;
    let args: readonly unknown[];
    try {
      const decoded = decodeFunctionData({ abi: contract.abi, data });
      functionName = decoded.functionName;
      args = decoded.args ?? [];
    } catch {
      return { ok: false, data: "0x" };
    }
    if (!(functionName in contract.functions)) return { ok: false, data: "0x" };
    const impl = contract.functions[functionName];
    try {
      const result = typeof impl === "function" ? (impl as (...a: unknown[]) => unknown)(...args) : impl;
      return {
        ok: true,
        data: encodeFunctionResult({ abi: contract.abi, functionName, result } as Parameters<
          typeof encodeFunctionResult
        >[0]),
      };
    } catch (e) {
      if (e instanceof MockRevert) return { ok: false, data: e.data };
      throw e;
    }
  }

  function ethCall(tx: { to: Address; data: Hex }): Hex {
    if (lower(tx.to) === lower(MULTICALL3_ADDRESS)) {
      const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
      if (functionName !== "aggregate3") throw new Error(`mock multicall: unsupported ${functionName}`);
      const calls = (args as unknown as [readonly { target: Address; allowFailure: boolean; callData: Hex }[]])[0];
      const results = calls.map((c) => {
        const r = dispatch(c.target, c.callData);
        if (!r.ok && !c.allowFailure) throw Object.assign(new Error("execution reverted"), { code: 3, data: r.data });
        return { success: r.ok, returnData: r.data };
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
    }
    const r = dispatch(tx.to, tx.data);
    if (!r.ok) throw Object.assign(new Error("execution reverted"), { code: 3, data: r.data });
    return r.data;
  }

  const block = () => ({
    number: numberToHex(options.blockNumber),
    timestamp: numberToHex(options.timestamp),
    hash: numberToHex(options.blockNumber, { size: 32 }),
    parentHash: ZERO_HASH,
    nonce: "0x0000000000000000",
    logsBloom: `0x${"0".repeat(512)}`,
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    gasLimit: numberToHex(30_000_000n),
    gasUsed: "0x0",
    baseFeePerGas: numberToHex(1_000_000_000n),
    extraData: "0x",
    size: "0x0",
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    transactionsRoot: ZERO_HASH,
    sha3Uncles: ZERO_HASH,
    mixHash: ZERO_HASH,
    transactions: [],
    uncles: [],
  });

  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = (Array.isArray(params) ? params : []) as unknown[];
    requests.push({ method, params: p });
    const overridden = options.override?.(method, p);
    if (overridden !== undefined) return overridden;
    switch (method) {
      case "eth_chainId":
        return numberToHex(options.chain.id);
      case "net_version":
        return String(options.chain.id);
      case "eth_blockNumber":
        return numberToHex(options.blockNumber);
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash":
        return block();
      case "eth_call":
        return ethCall(p[0] as { to: Address; data: Hex });
      case "eth_getLogs": {
        const f = p[0] as {
          address?: Address | Address[];
          topics?: (Hex | Hex[] | null)[];
          fromBlock?: string;
          toBlock?: string;
        };
        const from = toBlock(f.fromBlock ?? "earliest", options.blockNumber);
        const to = toBlock(f.toBlock ?? "latest", options.blockNumber);
        const addresses = f.address === undefined ? null : (Array.isArray(f.address) ? f.address : [f.address]).map(lower);
        return (options.logs ?? []).filter((log) => {
          const n = BigInt(log.blockNumber);
          return (
            n >= from &&
            n <= to &&
            (addresses === null || addresses.includes(lower(log.address))) &&
            matchesTopics(log, f.topics)
          );
        });
      }
      default:
        throw new Error(`mock chain: unsupported method ${method}`);
    }
  };

  const client = createPublicClient({ chain: options.chain, transport: custom({ request }) }) as PublicClient;
  return { client, requests, options };
}

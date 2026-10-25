import type { Abi, Account, Address, Hex, PublicClient, WalletClient } from "viem";

import type { Logger } from "./log.js";
import { withRetry, type RetryOptions } from "./retry.js";

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ExecutionResult =
  | { status: "simulated"; result: unknown }
  | { status: "skipped"; result: unknown }
  | { status: "reverted"; reason: string }
  | { status: "success" | "failed"; hash: Hex; gasLimit: bigint; gasUsed: bigint };

export interface ExecutorOptions {
  publicClient: PublicClient;
  /** Required unless `dryRun`. */
  walletClient?: WalletClient;
  /** Sender: the signing account when sending, or just an address for dry-run simulation. */
  account: Account | Address;
  dryRun: boolean;
  log: Logger;
  /** Gas limit = estimate * this / 100 (default 130). Mezo charges at least half the limit, so keep it tight. */
  gasMultiplierPct?: bigint;
  /**
   * Limit to fall back to when a call does not succeed at the estimated limit (default 3,000,000). Mezo's
   * eth_estimateGas occasionally answers ~21k for calls that need hundreds of thousands.
   */
  fallbackGas?: bigint;
  retry?: RetryOptions;
  /** Receipt wait timeout, ms (default 120 000). */
  receiptTimeoutMs?: number;
}

/** Gas limit for an estimate: estimate * pct / 100, rounded up. */
export function gasLimitFor(estimate: bigint, pct = 130n): bigint {
  return (estimate * pct + 99n) / 100n;
}

function reasonOf(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; walk?: (fn: (x: unknown) => boolean) => unknown };
  const revert = err.walk?.((x) => (x as { name?: string }).name === "ContractFunctionRevertedError") as
    | { data?: { errorName?: string }; reason?: string; shortMessage?: string }
    | undefined;
  if (revert?.data?.errorName) return revert.data.errorName;
  if (revert?.reason) return revert.reason;
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!;
}

/**
 * Sends one permissionless call: simulate, estimate, send with a tight gas limit, wait for the receipt.
 * In dry-run mode it stops after the simulation. A simulated revert is logged and not sent.
 */
export class Executor {
  private readonly o: ExecutorOptions;

  constructor(options: ExecutorOptions) {
    if (!options.dryRun && !options.walletClient) throw new Error("a wallet client is required unless dry-run");
    this.o = options;
  }

  /** Whether the call succeeds when given exactly `gas`, so a low estimate is caught before it costs a failed tx. */
  private async passesWith(params: Parameters<PublicClient["simulateContract"]>[0], gas: bigint): Promise<boolean> {
    // One attempt: an RPC hiccup only means this tick doesn't send, and the next tick re-plans from chain state.
    try {
      await this.o.publicClient.simulateContract({ ...params, gas });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param options.skipIfResult Skip sending when the simulated return value says there is nothing to do
   * (a `cover` that would pay zero), so no gas is spent on a no-op.
   */
  async run(
    label: string,
    call: ContractCall,
    fields: Record<string, unknown> = {},
    options: { skipIfResult?: (result: unknown) => boolean } = {},
  ): Promise<ExecutionResult> {
    const { publicClient, walletClient, log } = this.o;
    // Simulate as the signing account so the request carries it and is signed locally.
    const account = walletClient?.account ?? this.o.account;
    const retry = this.o.retry ?? {};
    const params = {
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      ...(call.args ? { args: call.args } : {}),
      account,
    } as Parameters<PublicClient["simulateContract"]>[0];

    let simulated: Awaited<ReturnType<PublicClient["simulateContract"]>>;
    try {
      simulated = await withRetry(() => publicClient.simulateContract(params), retry);
    } catch (e) {
      const reason = reasonOf(e);
      log.warn("simulation reverted", { action: label, ...fields, reason });
      return { status: "reverted", reason };
    }
    if (options.skipIfResult?.(simulated.result)) {
      log.info("skipped: nothing to do", { action: label, ...fields, result: simulated.result });
      return { status: "skipped", result: simulated.result };
    }
    if (this.o.dryRun) {
      log.info("dry-run: simulated", { action: label, ...fields, result: simulated.result });
      return { status: "simulated", result: simulated.result };
    }

    const estimate = await withRetry(
      () => publicClient.estimateContractGas(params as Parameters<PublicClient["estimateContractGas"]>[0]),
      retry,
    );
    let gas = gasLimitFor(estimate, this.o.gasMultiplierPct ?? 130n);
    if (!(await this.passesWith(params, gas))) {
      const fallback = this.o.fallbackGas ?? 3_000_000n;
      log.warn("estimate too low; using the fallback limit", { action: label, ...fields, gasEstimate: estimate, fallback });
      gas = fallback > gas ? fallback : gas;
      if (!(await this.passesWith(params, gas))) {
        log.warn("call does not pass at the fallback limit; not sent", { action: label, ...fields, gasLimit: gas });
        return { status: "reverted", reason: "fails at the fallback gas limit" };
      }
    }
    // Not retried: a send that failed in transit may still land; the next tick re-plans from chain state.
    const hash = await walletClient!.writeContract({
      ...(simulated.request as Parameters<WalletClient["writeContract"]>[0]),
      gas,
    });
    log.info("sent", { action: label, ...fields, hash, gasLimit: gas, gasEstimate: estimate });
    const receipt = await withRetry(
      () => publicClient.waitForTransactionReceipt({ hash, timeout: this.o.receiptTimeoutMs ?? 120_000 }),
      retry,
    );
    const status = receipt.status === "success" ? "success" : "failed";
    const level = status === "success" ? "info" : "error";
    log[level]("mined", {
      action: label,
      ...fields,
      hash,
      status,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      gasLimit: gas,
    });
    return { status, hash, gasLimit: gas, gasUsed: receipt.gasUsed };
  }
}

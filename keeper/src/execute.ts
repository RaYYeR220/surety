import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";

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
  | { status: "reverted"; reason: string }
  | { status: "success" | "failed"; hash: Hex; gasLimit: bigint; gasUsed: bigint };

export interface ExecutorOptions {
  publicClient: PublicClient;
  /** Required unless `dryRun`. */
  walletClient?: WalletClient;
  /** Sender used for simulation and sending. */
  account: Address;
  dryRun: boolean;
  log: Logger;
  /** Gas limit = estimate * this / 100 (default 115). Mezo charges at least half the limit, so keep it tight. */
  gasMultiplierPct?: bigint;
  retry?: RetryOptions;
  /** Receipt wait timeout, ms (default 120 000). */
  receiptTimeoutMs?: number;
}

/** Gas limit for an estimate: estimate * pct / 100, rounded up. */
export function gasLimitFor(estimate: bigint, pct = 115n): bigint {
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

  async run(label: string, call: ContractCall, fields: Record<string, unknown> = {}): Promise<ExecutionResult> {
    const { publicClient, walletClient, account, log } = this.o;
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
    if (this.o.dryRun) {
      log.info("dry-run: simulated", { action: label, ...fields, result: simulated.result });
      return { status: "simulated", result: simulated.result };
    }

    const estimate = await withRetry(
      () => publicClient.estimateContractGas(params as Parameters<PublicClient["estimateContractGas"]>[0]),
      retry,
    );
    const gas = gasLimitFor(estimate, this.o.gasMultiplierPct ?? 115n);
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

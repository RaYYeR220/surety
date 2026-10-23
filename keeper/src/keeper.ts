import { morphoAbi, suretyPoolAbi, veBTCCreditLineAbi, voteAllocatorAbi, creditVoterAbi, type SuretyClient } from "@surety/sdk";
import type { Abi } from "viem";

import { decide, type Action, type KeeperSnapshot } from "./decide.js";
import type { ContractCall, ExecutionResult, Executor } from "./execute.js";
import type { Logger } from "./log.js";
import { backoffDelay, withRetry, type RetryOptions } from "./retry.js";
import type { SnapshotSource } from "./snapshot.js";

export interface KeeperOptions {
  client: SuretyClient;
  source: Pick<SnapshotSource, "take">;
  executor: Pick<Executor, "run">;
  log: Logger;
  /** Seconds after the flip before rebalancing (default 5). */
  flipDelaySeconds?: bigint;
  morphoLiquidations?: boolean;
  /** Retry policy for reading the snapshot (default: 5 retries from 500 ms). */
  snapshotRetry?: RetryOptions;
}

export interface TickResult {
  snapshot: KeeperSnapshot;
  actions: Action[];
  results: ExecutionResult[];
}

/** The contract call behind an action. */
export function callFor(client: SuretyClient, action: Action): ContractCall {
  const c = client.deployment.contracts;
  switch (action.kind) {
    case "startAuction":
      return { address: c.veBTCLine, abi: veBTCCreditLineAbi as Abi, functionName: "startAuction", args: [action.loanId] };
    case "cover":
      return { address: c.suretyPool, abi: suretyPoolAbi as Abi, functionName: "cover", args: [BigInt(action.lineId)] };
    case "checkpoint":
      return {
        address: c.suretyPool,
        abi: suretyPoolAbi as Abi,
        functionName: "checkpoint",
        args: [BigInt(action.lineId)],
      };
    case "poke":
      return { address: c.creditVoter, abi: creditVoterAbi as Abi, functionName: "poke", args: [action.tokenId] };
    case "rebalance":
      return { address: c.voteAllocator, abi: voteAllocatorAbi as Abi, functionName: "rebalance" };
    case "liquidateMorpho":
      return {
        address: c.morpho,
        abi: morphoAbi as Abi,
        functionName: "liquidate",
        args: [action.marketParams, action.borrower, action.seizedAssets, action.repaidShares, "0x"],
      };
  }
}

function fieldsOf(action: Action): Record<string, unknown> {
  const { kind: _kind, ...rest } = action;
  if ("marketParams" in rest) {
    const { marketParams: _m, ...short } = rest;
    return short;
  }
  return rest;
}

export class Keeper {
  private readonly o: KeeperOptions;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(options: KeeperOptions) {
    this.o = options;
  }

  /** One pass: snapshot, decide, then simulate and send each action in order. */
  async tick(): Promise<TickResult> {
    const { log } = this.o;
    const snapshot = await withRetry(() => this.o.source.take(), {
      ...this.o.snapshotRetry,
      onRetry: (e, attempt, delayMs) => log.warn("snapshot failed, retrying", { attempt, delayMs, error: e }),
    });
    const actions = decide(snapshot, {
      flipDelaySeconds: this.o.flipDelaySeconds ?? 5n,
      morphoLiquidations: this.o.morphoLiquidations ?? false,
    });
    log.info("tick", {
      epoch: snapshot.currentEpoch,
      secondsToFlip: snapshot.currentEpoch + snapshot.epochLength - snapshot.now,
      ballots: snapshot.ballots.length,
      activeLoans: snapshot.loans.length,
      actions: actions.map((a) => a.kind),
    });
    const results: ExecutionResult[] = [];
    for (const action of actions) {
      try {
        results.push(await this.o.executor.run(action.kind, callFor(this.o.client, action), fieldsOf(action)));
      } catch (e) {
        log.error("action failed", { action: action.kind, ...fieldsOf(action), error: e });
        results.push({ status: "reverted", reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { snapshot, actions, results };
  }

  /**
   * Ticks until stopped (or once). Sleeps `intervalMs` between ticks, waking early to land `flipDelay` seconds
   * after the next epoch flip; backs off exponentially while ticks fail.
   */
  async run(options: { intervalMs: number; once?: boolean; sleep?: (ms: number) => Promise<void> }): Promise<void> {
    const { log } = this.o;
    const flipDelay = Number(this.o.flipDelaySeconds ?? 5n);
    let failures = 0;
    while (!this.stopped) {
      let delay = options.intervalMs;
      try {
        const { snapshot } = await this.tick();
        failures = 0;
        const toFlip = Number(snapshot.currentEpoch + snapshot.epochLength - snapshot.now);
        delay = Math.max(1_000, Math.min(options.intervalMs, (toFlip + flipDelay) * 1000));
      } catch (e) {
        if (options.once) throw e;
        failures++;
        delay = backoffDelay(failures, 2_000, 5 * 60_000);
        log.error("tick failed", { failures, retryInMs: delay, error: e });
      }
      if (options.once || this.stopped) break;
      await this.pause(delay, options.sleep);
    }
    log.info("keeper stopped");
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private pause(ms: number, sleep?: (ms: number) => Promise<void>): Promise<void> {
    if (sleep) return sleep(ms);
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

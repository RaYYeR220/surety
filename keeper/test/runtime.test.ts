import type { Address, PublicClient, WalletClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { Executor, gasLimitFor } from "../src/execute.js";
import { createLogger, type Level } from "../src/log.js";
import { backoffDelay, withRetry } from "../src/retry.js";

const SENDER = "0x000000000000000000000000000000000000dEaD" as Address;

function memoryLogger(secrets: string[] = []) {
  const lines: { level: Level; entry: Record<string, unknown> }[] = [];
  const log = createLogger({
    level: "debug",
    secrets,
    write: (line, level) => lines.push({ level, entry: JSON.parse(line) as Record<string, unknown> }),
    now: () => new Date("2026-10-23T00:00:00Z"),
  });
  return { log, lines };
}

describe("retry", () => {
  it("doubles the delay up to the cap", () => {
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, 500, 3000))).toEqual([500, 1000, 2000, 3000]);
  });

  it("retries transport errors with backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
        return "ok";
      },
      { sleep: async (ms) => void delays.push(ms), baseMs: 100 },
    );
    expect(value).toBe("ok");
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry a revert and gives up after the limit", async () => {
    const revert = Object.assign(new Error("execution reverted: NothingToPoke()"), {
      name: "ContractFunctionRevertedError",
    });
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw revert;
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBe(revert);
    expect(calls).toBe(1);

    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("socket hang up");
        },
        { retries: 2, sleep: async () => {} },
      ),
    ).rejects.toThrow("socket hang up");
    expect(attempts).toBe(3);
  });
});

describe("logger", () => {
  it("writes one JSON object per line with bigints as strings", () => {
    const { log, lines } = memoryLogger();
    log.child({ chainId: 31611 }).info("tick", { epoch: 10n, actions: ["poke"] });
    expect(lines[0]).toEqual({
      level: "info",
      entry: { ts: "2026-10-23T00:00:00.000Z", level: "info", msg: "tick", chainId: 31611, epoch: "10", actions: ["poke"] },
    });
  });

  it("never prints the private key", () => {
    const key = `0x${"ab12".repeat(16)}`;
    const { log, lines } = memoryLogger([key]);
    log.error("oops", { error: new Error(`bad key ${key}`), raw: key.slice(2) });
    const text = JSON.stringify(lines);
    expect(text).not.toContain("ab12ab12");
    expect(text).toContain("[redacted]");
  });
});

describe("executor", () => {
  function fakes(options: { revert?: boolean; status?: "success" | "reverted" } = {}) {
    const publicClient = {
      simulateContract: vi.fn(async () => {
        if (options.revert) {
          throw Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError", shortMessage: "NotLiquidatable()" });
        }
        return { result: 5n, request: { address: SENDER, functionName: "cover", abi: [], args: [1n] } };
      }),
      estimateContractGas: vi.fn(async () => 200_000n),
      waitForTransactionReceipt: vi.fn(async () => ({
        status: options.status ?? "success",
        blockNumber: 99n,
        gasUsed: 150_000n,
      })),
    };
    const walletClient = { writeContract: vi.fn(async () => "0xabc" as const) };
    return {
      publicClient: publicClient as unknown as PublicClient,
      walletClient: walletClient as unknown as WalletClient,
      spies: { ...publicClient, ...walletClient },
    };
  }
  const call = { address: SENDER, abi: [], functionName: "cover", args: [1n] };

  it("sets the gas limit to the estimate plus 30%", async () => {
    expect(gasLimitFor(200_000n)).toBe(260_000n);
    expect(gasLimitFor(100_001n)).toBe(130_002n); // rounded up
    const { publicClient, walletClient, spies } = fakes();
    const { log } = memoryLogger();
    const ex = new Executor({ publicClient, walletClient, account: SENDER, dryRun: false, log });
    const result = await ex.run("cover", call);
    expect(result).toEqual({ status: "success", hash: "0xabc", gasLimit: 260_000n, gasUsed: 150_000n });
    expect(spies.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 260_000n }));
  });

  it("only simulates in dry-run", async () => {
    const { publicClient, spies } = fakes();
    const { log, lines } = memoryLogger();
    const ex = new Executor({ publicClient, account: SENDER, dryRun: true, log });
    expect(await ex.run("cover", call)).toEqual({ status: "simulated", result: 5n });
    expect(spies.estimateContractGas).not.toHaveBeenCalled();
    expect(spies.writeContract).not.toHaveBeenCalled();
    expect(lines[0]!.entry.msg).toBe("dry-run: simulated");
  });

  it("does not send a call whose simulation reverts", async () => {
    const { publicClient, walletClient, spies } = fakes({ revert: true });
    const { log, lines } = memoryLogger();
    const ex = new Executor({ publicClient, walletClient, account: SENDER, dryRun: false, log });
    const result = await ex.run("startAuction", call, { loanId: 3n });
    expect(result.status).toBe("reverted");
    expect(spies.writeContract).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ level: "warn", entry: { msg: "simulation reverted", loanId: "3" } });
  });

  it("reports a reverted receipt as failed", async () => {
    const { publicClient, walletClient } = fakes({ status: "reverted" });
    const { log, lines } = memoryLogger();
    const ex = new Executor({ publicClient, walletClient, account: SENDER, dryRun: false, log });
    expect((await ex.run("rebalance", call)).status).toBe("failed");
    expect(lines.at(-1)!.level).toBe("error");
  });

  it("skips a send the simulation shows is a no-op", async () => {
    const { publicClient, walletClient, spies } = fakes();
    const { log, lines } = memoryLogger();
    const ex = new Executor({ publicClient, walletClient, account: SENDER, dryRun: false, log });
    expect(await ex.run("cover", call, {}, { skipIfResult: (r) => r === 5n })).toEqual({ status: "skipped", result: 5n });
    expect(spies.writeContract).not.toHaveBeenCalled();
    expect(lines[0]!.entry.msg).toBe("skipped: nothing to do");
  });

  it("simulates as the wallet's signing account", async () => {
    const { publicClient, spies } = fakes();
    const local = { address: SENDER, type: "local" };
    const walletClient = { account: local, writeContract: spies.writeContract } as unknown as WalletClient;
    const ex = new Executor({ publicClient, walletClient, account: SENDER, dryRun: false, log: memoryLogger().log });
    await ex.run("cover", call);
    expect(spies.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ account: local }));
  });

  it("refuses to send without a wallet", () => {
    const { publicClient } = fakes();
    expect(() => new Executor({ publicClient, account: SENDER, dryRun: false, log: memoryLogger().log })).toThrow(
      /wallet client/,
    );
  });
});

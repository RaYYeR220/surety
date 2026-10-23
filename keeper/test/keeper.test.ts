import { creditVoterAbi, suretyPoolAbi, voteAllocatorAbi } from "@surety/sdk";
import { FIXTURE_EPOCH, createSuretyFixture } from "@surety/sdk/testing";
import { decodeFunctionData, encodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";

import type { ContractCall, ExecutionResult } from "../src/execute.js";
import { Keeper } from "../src/keeper.js";
import { createLogger } from "../src/log.js";
import { SnapshotSource } from "../src/snapshot.js";

const SENDER = "0x000000000000000000000000000000000000dEaD" as Address;
const quiet = createLogger({ write: () => {} });

function recordingExecutor() {
  const sent: { label: string; call: ContractCall }[] = [];
  return {
    sent,
    run: async (label: string, call: ContractCall): Promise<ExecutionResult> => {
      sent.push({ label, call });
      return { status: "simulated", result: null };
    },
  };
}

describe("snapshot from chain", () => {
  it("finds ballots from Voted logs and simulates checkpoints", async () => {
    const { client } = createSuretyFixture({
      patch: (s) => {
        s.pool.pendingLoss = [7n, 0n];
      },
    });
    const source = new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet });
    const snap = await source.take();
    expect(source.knownVoters.sort()).toEqual([7n, 9n]);
    expect(snap.currentEpoch).toBe(FIXTURE_EPOCH);
    const nine = snap.ballots.find((b) => b.tokenId === 9n)!;
    expect(nine.epochCast).toBe(FIXTURE_EPOCH - 3600n);
    expect(nine.power).toBe(2n * 10n ** 16n); // permanent lock: full amount
    expect(nine.ownerIsEscrow).toBe(false);
    expect(snap.lines.map((l) => l.pendingLoss)).toEqual([7n, 0n]);
    expect(snap.lines[1]!.uncoveredLoss).toBe(10n ** 19n);
    expect(snap.loans).toEqual([{ loanId: 1n, state: "Active", liquidatable: false, reason: null }]);
  });
});

describe("keeper tick", () => {
  it("covers losses, pokes stale ballots and rebalances after the flip", async () => {
    const { client } = createSuretyFixture({
      patch: (s) => {
        s.now = FIXTURE_EPOCH + 6n; // just past the flip
        s.lastRebalanceEpoch = FIXTURE_EPOCH - 3600n;
        s.pool.pendingLoss = [7n, 0n];
      },
    });
    const executor = recordingExecutor();
    const keeper = new Keeper({
      client,
      source: new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }),
      executor,
      log: quiet,
    });
    const { actions } = await keeper.tick();
    expect(actions.map((a) => a.kind)).toEqual(["cover", "cover", "poke", "rebalance"]);

    const [cover0, cover1, poke, rebalance] = executor.sent;
    const d = client.deployment.contracts;
    expect(cover0!.call.address).toBe(d.suretyPool);
    expect(
      encodeFunctionData({
        abi: suretyPoolAbi,
        functionName: "cover",
        args: cover0!.call.args as [bigint],
      }),
    ).toBe(encodeFunctionData({ abi: suretyPoolAbi, functionName: "cover", args: [0n] }));
    expect(cover1!.call.args).toEqual([1n]);
    expect(poke!.call).toMatchObject({ address: d.creditVoter, functionName: "poke", args: [9n] });
    expect(rebalance!.call).toMatchObject({ address: d.voteAllocator, functionName: "rebalance" });
    // Calls encode against the real ABIs.
    const data = encodeFunctionData({ abi: creditVoterAbi, functionName: "poke", args: [9n] });
    expect(decodeFunctionData({ abi: creditVoterAbi, data }).args).toEqual([9n]);
    expect(rebalance!.call.abi).toBe(voteAllocatorAbi);
  });

  it("starts the auction of an underwater loan", async () => {
    const { client } = createSuretyFixture({ patch: (s) => (s.priceWad = 40_000n * 10n ** 18n) });
    const executor = recordingExecutor();
    const keeper = new Keeper({
      client,
      source: new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }),
      executor,
      log: quiet,
    });
    const { actions } = await keeper.tick();
    expect(actions[0]).toEqual({ kind: "startAuction", loanId: 1n, reason: "ltv" });
    expect(executor.sent[0]!.call.functionName).toBe("startAuction");
  });

  it("runs once and stops", async () => {
    const { client } = createSuretyFixture();
    const executor = recordingExecutor();
    const keeper = new Keeper({
      client,
      source: new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }),
      executor,
      log: quiet,
    });
    await keeper.run({ intervalMs: 60_000, once: true });
    // Mid-epoch and already rebalanced: cover line 1's recorded loss and carry token 9's old ballot forward.
    expect(executor.sent.map((s) => s.label)).toEqual(["cover", "poke"]);
  });
});

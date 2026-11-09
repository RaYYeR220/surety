import { savingsAdapterAbi, veBTCCreditLineAbi } from "@surety/sdk";
import { FIXTURE_BRIBE, FIXTURE_EPOCH, FIXTURE_FEES, FIXTURE_USDC, createSuretyFixture, fakeAddress } from "@surety/sdk/testing";
import { decodeFunctionData, encodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  decide,
  harvestsDue,
  MEZO_WEEK,
  mezoEpochOf,
  savingsHarvestDue,
  type HarvestCandidate,
  type KeeperSnapshot,
} from "../src/decide.js";
import { gasLimitFor, type ContractCall, type ExecutionResult } from "../src/execute.js";
import { Keeper } from "../src/keeper.js";
import { createLogger } from "../src/log.js";
import { SnapshotSource } from "../src/snapshot.js";

const SENDER = "0x000000000000000000000000000000000000dEaD" as Address;
const quiet = createLogger({ write: () => {} });
const EPOCH = 1_792_771_200n;
const L = 3600n;
const REWARD = "0x00000000000000000000000000000000000000f1" as Address;
const MUSD = "0x00000000000000000000000000000000000000e1" as Address;

function snapshot(over: Partial<KeeperSnapshot> = {}): KeeperSnapshot {
  return {
    now: EPOCH + 60n,
    currentEpoch: EPOCH,
    epochLength: L,
    lastRebalanceEpoch: EPOCH,
    vaultIdle: 0n,
    ballots: [],
    lines: [],
    loans: [],
    morphoPositions: [],
    ...over,
  };
}

function candidate(over: Partial<HarvestCandidate> = {}): HarvestCandidate {
  return { loanId: 1n, rewards: [REWARD], tokens: [[MUSD]], claimableRebase: 0n, ...over };
}

describe("harvest decisions", () => {
  it("counts Mezo epochs from Thursday 00:00 UTC", () => {
    // 2026-11-12 is a Thursday.
    const thursday = BigInt(Date.UTC(2026, 10, 12) / 1000);
    expect(mezoEpochOf(thursday)).toBe(thursday);
    expect(mezoEpochOf(thursday + MEZO_WEEK - 1n)).toBe(thursday);
    expect(mezoEpochOf(thursday - 1n)).toBe(thursday - MEZO_WEEK);
  });

  it("harvests auto-repay loans with fees, bribes or a rebase to claim", () => {
    const s = snapshot({
      mezoEpoch: 100n,
      harvests: [
        candidate({ loanId: 1n }),
        candidate({ loanId: 2n, rewards: [], tokens: [], claimableRebase: 5n }),
        candidate({ loanId: 3n, rewards: [], tokens: [], claimableRebase: 0n }),
      ],
    });
    expect(harvestsDue(s).map((a) => (a.kind === "harvest" ? a.loanId : null))).toEqual([1n, 2n]);
    expect(harvestsDue(s)[0]).toEqual({ kind: "harvest", loanId: 1n, rewards: [REWARD], tokens: [[MUSD]], mezoEpoch: 100n });
  });

  it("harvests each loan once per Mezo epoch", () => {
    const s = snapshot({ mezoEpoch: 100n, harvests: [candidate({ loanId: 1n }), candidate({ loanId: 2n })] });
    const done = new Map([[1n, 100n]]);
    expect(harvestsDue(s, done).map((a) => (a.kind === "harvest" ? a.loanId : null))).toEqual([2n]);
    // The next Mezo epoch is open again.
    expect(harvestsDue({ ...s, mezoEpoch: 100n + MEZO_WEEK }, done)).toHaveLength(2);
  });

  it("harvests savings yield with the epoch's rebalance only", () => {
    expect(savingsHarvestDue(snapshot({ savingsYield: 10n }), true)).toEqual([{ kind: "savingsHarvest", yield: 10n }]);
    expect(savingsHarvestDue(snapshot({ savingsYield: 10n }), false)).toEqual([]);
    expect(savingsHarvestDue(snapshot({ savingsYield: 0n }), true)).toEqual([]);
    expect(savingsHarvestDue(snapshot({ savingsYield: 10n }), true, 11n)).toEqual([]);
    expect(savingsHarvestDue(snapshot(), true)).toEqual([]);
  });

  it("orders the rebalance before the savings harvest and the loan harvests", () => {
    const s = snapshot({
      now: EPOCH + 10n,
      lastRebalanceEpoch: EPOCH - L,
      savingsYield: 3n,
      mezoEpoch: 100n,
      harvests: [candidate()],
    });
    expect(decide(s).map((a) => a.kind)).toEqual(["rebalance", "savingsHarvest", "harvest"]);
  });
});

describe("gas limits", () => {
  it("leave room for the v2 calls that read the peg", () => {
    // open ~980k and rebalance ~1.25M with peg reads: estimate * 1.3 stays under the 3M fallback and Mezo's 10M
    // block, and the fallback still covers them when Mezo under-estimates.
    expect(gasLimitFor(980_000n)).toBe(1_274_000n);
    expect(gasLimitFor(1_250_000n)).toBe(1_625_000n);
    expect(gasLimitFor(1_250_000n)).toBeLessThan(3_000_000n);
  });
});

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

describe("keeper on a v2 deployment", () => {
  it("snapshots auto-repay harvests, savings yield and idle MUSD in savings", async () => {
    const { client } = createSuretyFixture({ version: 2, patch: (s) => (s.loans[0]!.autoRepay = true) });
    const snap = await new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }).take();
    expect(snap.harvests).toEqual([
      { loanId: 1n, rewards: [FIXTURE_FEES, FIXTURE_BRIBE], tokens: [[FIXTURE_USDC], [fakeAddress(0x101)]], claimableRebase: 1_000n },
    ]);
    expect(snap.savingsYield).toBe(10n ** 16n);
    expect(snap.vaultIdle).toBe(1_400n * 10n ** 18n);
    expect(snap.mezoEpoch).toBe(mezoEpochOf(snap.now));
    expect(snap.loans.map((l) => l.loanId)).toEqual([1n]);
  });

  it("harvests once per Mezo epoch and the savings yield with the rebalance", async () => {
    const { client, deployment } = createSuretyFixture({
      version: 2,
      patch: (s) => {
        s.now = FIXTURE_EPOCH + 6n;
        s.lastRebalanceEpoch = FIXTURE_EPOCH - 3600n;
        s.loans[0]!.autoRepay = true;
      },
    });
    const executor = recordingExecutor();
    const keeper = new Keeper({
      client,
      source: new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }),
      executor,
      log: quiet,
    });
    await keeper.tick();
    const labels = executor.sent.map((s) => s.label);
    expect(labels).toContain("rebalance");
    expect(labels.indexOf("savingsHarvest")).toBeGreaterThan(labels.indexOf("rebalance"));
    const harvest = executor.sent.find((s) => s.label === "harvest")!;
    expect(harvest.call.address).toBe(deployment.contracts.veBTCLine);
    expect(
      decodeFunctionData({ abi: veBTCCreditLineAbi, data: encode(harvest.call) }).args,
    ).toEqual([1n, [FIXTURE_FEES, FIXTURE_BRIBE], [[FIXTURE_USDC], [fakeAddress(0x101)]]]);
    const savings = executor.sent.find((s) => s.label === "savingsHarvest")!;
    expect(savings.call.address).toBe(deployment.contracts.savingsAdapter);
    expect(savings.call.abi).toBe(savingsAdapterAbi);

    // The next pass in the same Mezo epoch does not harvest again.
    executor.sent.length = 0;
    await keeper.tick();
    expect(executor.sent.map((s) => s.label)).not.toContain("harvest");
  });

  it("leaves loans without auto-repay alone", async () => {
    const { client } = createSuretyFixture({ version: 2 });
    const snap = await new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }).take();
    expect(snap.harvests).toEqual([]);
  });

  it("keeps v1 deployments on the v1 actions", async () => {
    const { client } = createSuretyFixture();
    const snap = await new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }).take();
    expect(snap.harvests).toBeUndefined();
    expect(snap.savingsYield).toBeUndefined();
  });
});

/** Calldata of a recorded call, for decoding. */
function encode(call: ContractCall) {
  return encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] } as Parameters<
    typeof encodeFunctionData
  >[0]);
}

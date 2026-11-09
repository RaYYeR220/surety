import { tigrisBasicPoolAbi } from "@surety/sdk";
import { FIXTURE_EPOCH, createSuretyFixture, fakeAddress } from "@surety/sdk/testing";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { decide, POOL_SYNC_AFTER, POOL_SYNC_INTERVAL, syncPegPools, type KeeperSnapshot } from "../src/decide.js";
import type { ContractCall, ExecutionResult } from "../src/execute.js";
import { Keeper } from "../src/keeper.js";
import { createLogger } from "../src/log.js";
import { SnapshotSource } from "../src/snapshot.js";

const SENDER = "0x000000000000000000000000000000000000dEaD" as Address;
const quiet = createLogger({ write: () => {} });
const NOW = 1_800_000_000n;
const USDC_POOL = "0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356" as Address;
const USDT_POOL = "0x10906a9E9215939561597b4C8e4b98F93c02031A" as Address;

function snapshot(over: Partial<KeeperSnapshot> = {}): KeeperSnapshot {
  return {
    now: NOW,
    currentEpoch: NOW - (NOW % 604_800n),
    epochLength: 604_800n,
    lastRebalanceEpoch: NOW - (NOW % 604_800n),
    vaultIdle: 0n,
    ballots: [],
    lines: [],
    loans: [],
    morphoPositions: [],
    ...over,
  };
}

const pools = (usdcAge: bigint, usdtAge: bigint) => [
  { pool: USDC_POOL, observedAt: NOW - usdcAge },
  { pool: USDT_POOL, observedAt: NOW - usdtAge },
];

describe("peg pool syncs", () => {
  it("syncs a pool once its latest observation is about 50 minutes old", () => {
    expect(POOL_SYNC_AFTER).toBe(3_000n);
    const actions = syncPegPools(snapshot({ pegPools: pools(3_000n, 2_999n) }));
    expect(actions).toEqual([{ kind: "syncPegPool", pool: USDC_POOL, age: 3_000n }]);
    expect(syncPegPools(snapshot({ pegPools: pools(20n * 3_600n, 57n * 3_600n) }))).toHaveLength(2);
  });

  it("syncs each pool at most hourly", () => {
    const s = snapshot({ pegPools: pools(4_000n, 4_000n) });
    const recently = new Map([[USDC_POOL.toLowerCase(), NOW - 1_800n]]);
    expect(syncPegPools(s, recently).map((a) => (a.kind === "syncPegPool" ? a.pool : null))).toEqual([USDT_POOL]);
    const anHourAgo = new Map([[USDC_POOL.toLowerCase(), NOW - POOL_SYNC_INTERVAL]]);
    expect(syncPegPools(s, anHourAgo)).toHaveLength(2);
  });

  it("does nothing without peg pools (testnet, v1)", () => {
    expect(syncPegPools(snapshot())).toEqual([]);
    expect(syncPegPools(snapshot({ pegPools: [] }))).toEqual([]);
  });

  it("syncs before the rebalance, so the peg gate reads fresh pools", () => {
    const s = snapshot({
      now: NOW,
      currentEpoch: NOW - 10n,
      lastRebalanceEpoch: NOW - 10n - 604_800n,
      pegPools: pools(4_000n, 100n),
    });
    expect(decide(s).map((a) => a.kind)).toEqual(["syncPegPool", "rebalance"]);
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

describe("keeper and the peg pools", () => {
  it("snapshots the basic pools behind the StableTwap sources", async () => {
    const { client, state } = createSuretyFixture({ version: 2 });
    const snap = await new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }).take();
    expect(snap.pegPools).toEqual([{ pool: fakeAddress(0x31), observedAt: state.peg.poolObservedAt }]);
  });

  it("sends sync() to a stale pool, then waits an hour before the next one", async () => {
    const { client } = createSuretyFixture({
      version: 2,
      patch: (s) => {
        s.now = FIXTURE_EPOCH + 600n;
        s.peg.poolObservedAt = s.now - 4_000n;
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
    const sync = executor.sent.filter((s) => s.label === "syncPegPool");
    expect(sync).toHaveLength(1);
    expect(sync[0]!.call).toMatchObject({ address: fakeAddress(0x31), functionName: "sync" });
    expect(sync[0]!.call.abi).toBe(tigrisBasicPoolAbi);

    // The fixture's pool did not move (the call was only simulated): no second sync within the hour.
    executor.sent.length = 0;
    await keeper.tick();
    expect(executor.sent.map((s) => s.label)).not.toContain("syncPegPool");
  });

  it("leaves a v1 deployment's pools alone", async () => {
    const { client } = createSuretyFixture();
    const snap = await new SnapshotSource(client, { account: SENDER, morphoLiquidations: false, log: quiet }).take();
    expect(snap.pegPools).toBeUndefined();
  });
});

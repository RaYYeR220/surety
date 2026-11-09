// node --test api/starter.test.ts — the starter-kit handler against a stand-in chain (no network, no key).
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { sponsorAbi } from "@surety/sdk";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  TimeoutError,
  type Address,
  type Hex,
} from "viem";

import {
  GAS_FALLBACK,
  handleStarter,
  resetRateLimits,
  type StarterContext,
  type StarterReadClient,
  type StarterWriteClient,
} from "./starter.ts";

const SPONSOR: Address = "0x5e00000000000000000000000000000000000012";
const RELAYER: Address = "0x030E00FE424e98327332BC4f946975C4927c7DdC";
const USER: Address = "0x1111111111111111111111111111111111111111";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const NOW = 1_794_200_000; // a fixed second, so "today" is known
const TODAY = BigInt(Math.floor(NOW / 86_400));

function revert(errorName: string, args: readonly unknown[] = []): Error {
  const cause = new ContractFunctionRevertedError({
    abi: sponsorAbi,
    data: encodeErrorResult({ abi: sponsorAbi, errorName, args } as never),
    functionName: "starterKit",
  });
  return new ContractFunctionExecutionError(cause, {
    abi: sponsorAbi,
    functionName: "starterKit",
    args: [USER],
    contractAddress: SPONSOR,
  });
}

function starterKitLog(tokenId: bigint) {
  const topics = encodeEventTopics({ abi: sponsorAbi, eventName: "StarterKit", args: { user: USER, tokenId } });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [50_000_000_000_000n, 1_000_000_000_000_000n, 50n * 10n ** 18n],
  );
  return { address: SPONSOR, topics, data } as never;
}

interface Calls {
  reads: string[];
  simulateGas: bigint | null;
  writeGas: bigint | null;
  kitsOnDayArg: unknown;
}

function chain(overrides: {
  claimed?: boolean;
  kitsLeft?: bigint;
  dailyLimit?: bigint;
  kitsToday?: bigint;
  isRelayer?: boolean;
  estimate?: () => Promise<bigint>;
  simulate?: () => Promise<{ result: unknown }>;
  write?: () => Promise<Hex>;
  receipt?: () => Promise<{ status: "success" | "reverted"; logs: never[] }>;
  sponsor?: Address | null;
  relayer?: boolean;
} = {}): { ctx: StarterContext; calls: Calls } {
  const calls: Calls = { reads: [], simulateGas: null, writeGas: null, kitsOnDayArg: null };
  const reads: StarterReadClient = {
    async readContract({ functionName, args }) {
      calls.reads.push(functionName);
      switch (functionName) {
        case "claimed":
          return overrides.claimed ?? false;
        case "kitsLeft":
          return overrides.kitsLeft ?? 40n;
        case "dailyLimit":
          return overrides.dailyLimit ?? 100n;
        case "kitsOnDay":
          calls.kitsOnDayArg = args?.[0];
          return overrides.kitsToday ?? 3n;
        case "isRelayer":
          return overrides.isRelayer ?? true;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    estimateContractGas: overrides.estimate ?? (async () => 1_000_000n),
    async simulateContract(args) {
      calls.simulateGas = args.gas;
      return overrides.simulate ? overrides.simulate() : { result: 4242n };
    },
    waitForTransactionReceipt: (overrides.receipt ??
      (async () => ({ status: "success", logs: [starterKitLog(4243n)] }))) as StarterReadClient["waitForTransactionReceipt"],
  };
  const relayer: StarterWriteClient = {
    address: RELAYER,
    async writeContract(args) {
      calls.writeGas = args.gas;
      return overrides.write ? overrides.write() : HASH;
    },
  };
  return {
    ctx: {
      sponsor: overrides.sponsor === undefined ? SPONSOR : overrides.sponsor,
      reads,
      relayer: overrides.relayer === false ? null : relayer,
      now: () => NOW,
    },
    calls,
  };
}

const post = (address: unknown, ip = "203.0.113.7") => ({ method: "POST", body: { address }, ip });

describe("POST /api/starter", () => {
  beforeEach(() => resetRateLimits());

  it("only accepts POST", async () => {
    const { ctx } = chain();
    const r = await handleStarter({ method: "GET", body: null, ip: "x" }, ctx);
    assert.equal(r.status, 405);
  });

  it("rejects malformed and zero addresses before touching the chain", async () => {
    const { ctx, calls } = chain();
    for (const bad of [undefined, "", "0x123", "not an address", 42]) {
      const r = await handleStarter(post(bad), ctx);
      assert.equal(r.status, 400);
      assert.equal(r.body.ok, false);
    }
    const zero = await handleStarter(post("0x0000000000000000000000000000000000000000"), ctx);
    assert.equal(zero.status, 400);
    assert.deepEqual(calls.reads, []);
  });

  it("accepts a lowercase address", async () => {
    const { ctx } = chain();
    const r = await handleStarter(post(USER.toLowerCase()), ctx);
    assert.equal(r.status, 200);
  });

  it("says when no Sponsor is deployed yet", async () => {
    const { ctx } = chain({ sponsor: null });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 503);
    assert.equal(r.body.ok === false && r.body.code, "NotDeployed");
  });

  it("says when the relayer key is not configured", async () => {
    const { ctx } = chain({ relayer: false });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.body.ok === false && r.body.code, "NotConfigured");
  });

  it("refuses a wallet that already claimed, without sending", async () => {
    const { ctx, calls } = chain({ claimed: true });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 409);
    assert.equal(r.body.ok === false && r.body.code, "AlreadyClaimed");
    assert.equal(calls.writeGas, null);
  });

  it("refuses when the fund is empty", async () => {
    const { ctx } = chain({ kitsLeft: 0n });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.body.ok === false && r.body.code, "OutOfFunds");
  });

  it("checks today's kits against the daily limit, by UTC day", async () => {
    const { ctx, calls } = chain({ dailyLimit: 5n, kitsToday: 5n });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 429);
    assert.equal(r.body.ok === false && r.body.code, "DailyLimitReached");
    assert.equal(calls.kitsOnDayArg, TODAY);
  });

  it("refuses when the relayer is not allowed on the Sponsor", async () => {
    const { ctx } = chain({ isRelayer: false });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.body.ok === false && r.body.code, "NotRelayer");
  });

  it("sends with the estimate × 1.3 after simulating at that limit, and returns the hash and token id", async () => {
    const { ctx, calls } = chain();
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 200);
    assert.equal(calls.simulateGas, 1_300_000n);
    assert.equal(calls.writeGas, 1_300_000n);
    assert.deepEqual(r.body, {
      ok: true,
      hash: HASH,
      tokenId: "4243",
      confirmed: true,
      explorer: `https://explorer.test.mezo.org/tx/${HASH}`,
    });
  });

  it("falls back to 3M gas when the estimate fails without a revert", async () => {
    const { ctx, calls } = chain({ estimate: async () => Promise.reject(new TimeoutError({ body: {}, url: "rpc" })) });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 200);
    assert.equal(calls.simulateGas, GAS_FALLBACK);
    assert.equal(calls.writeGas, GAS_FALLBACK);
  });

  it("maps a revert in the estimate to its message", async () => {
    const { ctx, calls } = chain({ estimate: async () => Promise.reject(revert("KitNotSet")) });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 503);
    assert.equal(r.body.ok === false && r.body.code, "KitNotSet");
    assert.equal(calls.writeGas, null);
  });

  it("maps a revert in the simulation to its message and never sends", async () => {
    const { ctx, calls } = chain({ simulate: async () => Promise.reject(revert("AlreadyClaimed", [USER])) });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 409);
    assert.equal(r.body.ok === false && r.body.code, "AlreadyClaimed");
    assert.equal(calls.writeGas, null);
  });

  for (const name of ["OutOfFunds", "DailyLimitReached", "NotRelayer"]) {
    it(`gives ${name} a friendly message`, async () => {
      const { ctx } = chain({ simulate: async () => Promise.reject(revert(name)) });
      const r = await handleStarter(post(USER), ctx);
      assert.equal(r.body.ok, false);
      if (r.body.ok === false) {
        assert.equal(r.body.code, name);
        assert.doesNotMatch(r.body.error, /0x|revert|error/i);
      }
    });
  }

  it("returns the hash with confirmed false when the receipt does not come in time", async () => {
    const { ctx } = chain({ receipt: async () => Promise.reject(new Error("timed out")) });
    const r = await handleStarter(post(USER), ctx);
    assert.equal(r.status, 202);
    assert.equal(r.body.ok && r.body.confirmed, false);
    assert.equal(r.body.ok && r.body.tokenId, "4242");
  });

  it("limits each IP to three requests per ten minutes", async () => {
    const { ctx } = chain({ claimed: true });
    for (let i = 0; i < 3; i++) assert.equal((await handleStarter(post(USER, "198.51.100.1"), ctx)).status, 409);
    const limited = await handleStarter(post(USER, "198.51.100.1"), ctx);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.ok === false && limited.body.code, "RateLimited");
    assert.equal((await handleStarter(post(USER, "198.51.100.2"), ctx)).status, 409);
  });
});

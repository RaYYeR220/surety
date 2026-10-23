import { decodeFunctionData, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  creditVoterAbi,
  erc20Abi,
  morphoAbi,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCAbi,
  veBTCCreditLineAbi,
  voteAllocatorAbi,
} from "../src/abis/index.js";
import * as b from "../src/builders.js";
import { ALICE, fixtureDeployment as d, fixtureMarketParams } from "../src/testing/index.js";

describe("transaction builders", () => {
  it("builds a vote on the CreditVoter", () => {
    const tx = b.buildVote(d, { tokenId: 7, lineIds: [0, 1], weightsBps: [6000, 4000] });
    expect(tx.to).toBe(d.contracts.creditVoter);
    expect(tx.value).toBe(0n);
    const call = decodeFunctionData({ abi: creditVoterAbi, data: tx.data });
    expect(call.functionName).toBe("vote");
    expect(call.args).toEqual([7n, [0n, 1n], [6000n, 4000n]]);
  });

  it("rejects ballots that do not sum to 10000 bps or have the wrong shape", () => {
    expect(() => b.buildVote(d, { tokenId: 7, lineIds: [0, 1], weightsBps: [6000, 3000] })).toThrow(/10000/);
    expect(() => b.buildVote(d, { tokenId: 7, lineIds: [0], weightsBps: [5000, 5000] })).toThrow(/length/);
    expect(() => b.buildVote(d, { tokenId: 7, lineIds: [], weightsBps: [] })).toThrow(/1 to 10/);
    expect(() => b.buildVote(d, { tokenId: -1, lineIds: [0], weightsBps: [10000] })).toThrow(/negative/);
  });

  it("opens a loan with the veBTC approve first", () => {
    const [approve, open] = b.buildOpenLoan(d, { tokenId: "7", amount: 10n ** 21n });
    expect(approve!.to).toBe(d.external.veBTC);
    expect(decodeFunctionData({ abi: veBTCAbi, data: approve!.data }).args).toEqual([d.contracts.veBTCLine, 7n]);
    expect(open!.to).toBe(d.contracts.veBTCLine);
    const call = decodeFunctionData({ abi: veBTCCreditLineAbi, data: open!.data });
    expect(call.functionName).toBe("open");
    expect(call.args).toEqual([7n, 10n ** 21n]);
  });

  it("encodes vault, line and pool calls against the right contracts", () => {
    const cases = [
      [b.buildDeposit(d, { assets: 5n, receiver: ALICE }), d.contracts.vault, vaultV2Abi, "deposit", [5n, ALICE]],
      [
        b.buildWithdraw(d, { assets: 5n, receiver: ALICE, owner: ALICE }),
        d.contracts.vault,
        vaultV2Abi,
        "withdraw",
        [5n, ALICE, ALICE],
      ],
      [b.buildRepay(d, { loanId: 1, amount: 9n }), d.contracts.veBTCLine, veBTCCreditLineAbi, "repay", [1n, 9n]],
      [b.buildExtend(d, { loanId: 1, duration: 3600 }), d.contracts.veBTCLine, veBTCCreditLineAbi, "extend", [1n, 3600n]],
      [b.buildStartAuction(d, { loanId: 2 }), d.contracts.veBTCLine, veBTCCreditLineAbi, "startAuction", [2n]],
      [b.buildBid(d, { loanId: 2, maxPrice: 7n }), d.contracts.veBTCLine, veBTCCreditLineAbi, "bid", [2n, 7n]],
      [b.buildPoke(d, { tokenId: 9 }), d.contracts.creditVoter, creditVoterAbi, "poke", [9n]],
      [b.buildRebalance(d), d.contracts.voteAllocator, voteAllocatorAbi, "rebalance", undefined],
      [b.buildPostIncentive(d, { lineId: 1, assets: 3n }), d.contracts.suretyPool, suretyPoolAbi, "postIncentive", [1n, 3n]],
      [b.buildCheckpoint(d, { lineId: 0 }), d.contracts.suretyPool, suretyPoolAbi, "checkpoint", [0n]],
      [b.buildCover(d, { lineId: 1 }), d.contracts.suretyPool, suretyPoolAbi, "cover", [1n]],
      [b.buildClaim(d, { tokenId: 7, lineId: 0, epoch: 1_792_771_200 }), d.contracts.suretyPool, suretyPoolAbi, "claim", [7n, 0n, 1_792_771_200n]],
      [
        b.buildApprove({ token: d.external.musd, spender: d.contracts.vault, amount: 1n }),
        d.external.musd,
        erc20Abi,
        "approve",
        [d.contracts.vault, 1n],
      ],
    ] as const;
    for (const [tx, to, abi, fn, args] of cases) {
      expect(tx.to).toBe(to);
      const call = decodeFunctionData({ abi, data: tx.data });
      expect(call.functionName).toBe(fn);
      expect(call.args).toEqual(args);
    }
  });

  it("builds Morpho borrower calls with the line's market params", () => {
    const params = b.morphoMarketParams(d, 0);
    expect(params).toEqual(fixtureMarketParams);
    expect(() => b.morphoMarketParams(d, 1)).toThrow(/not a Morpho line/);

    const supply = decodeFunctionData({
      abi: morphoAbi,
      data: b.buildSupplyCollateral(d, { marketParams: params, assets: 2n, onBehalf: ALICE }).data,
    });
    expect(supply.functionName).toBe("supplyCollateral");
    expect(supply.args).toEqual([params, 2n, ALICE, "0x"]);

    const borrow = decodeFunctionData({
      abi: morphoAbi,
      data: b.buildBorrow(d, { marketParams: params, assets: 3n, onBehalf: ALICE, receiver: ALICE }).data,
    });
    expect(borrow.args).toEqual([params, 3n, 0n, ALICE, ALICE]);

    const repay = decodeFunctionData({
      abi: morphoAbi,
      data: b.buildRepayMorpho(d, { marketParams: params, shares: 4n, onBehalf: ALICE }).data,
    });
    expect(repay.args).toEqual([params, 0n, 4n, ALICE, "0x"]);
    expect(() => b.buildRepayMorpho(d, { marketParams: params, onBehalf: ALICE })).toThrow(/exactly one/);
    expect(() =>
      b.buildRepayMorpho(d, { marketParams: params, assets: 1n, shares: 1n, onBehalf: zeroAddress }),
    ).toThrow(/exactly one/);
  });

  it("parses integer inputs strictly", () => {
    expect(b.toBigInt("0x10")).toBe(16n);
    expect(b.toBigInt(" 42 ")).toBe(42n);
    expect(() => b.toBigInt("1.5")).toThrow();
    expect(() => b.toBigInt(2 ** 60)).toThrow(/safe integer/);
  });
});

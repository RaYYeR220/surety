import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { creditVoterAbi, erc20Abi, vaultV2Abi } from "@surety/sdk";
import { ALICE, FIXTURE_EPOCH, createSuretyFixture } from "@surety/sdk/testing";
import { decodeFunctionData } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { startHttpServer } from "../src/http.js";
import { TOOL_NAMES, createSuretyMcpServer } from "../src/server.js";

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function connect() {
  const fixture = createSuretyFixture();
  const server = createSuretyMcpServer({ client: fixture.client });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as TextResult;
    return { result, json: result.isError ? null : (JSON.parse(result.content[0]!.text) as Record<string, unknown>) };
  };
  return { client, call, fixture };
}

describe("MCP server", () => {
  it("lists the six Surety tools with input schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const quote = tools.find((t) => t.name === "surety_quote_vebtc_borrow")!;
    expect(quote.inputSchema.required).toEqual(["tokenId"]);
    const build = tools.find((t) => t.name === "surety_build_tx")!;
    expect(JSON.stringify(build.inputSchema)).toContain("open_loan");
  });

  it("answers surety_epoch from the chain", async () => {
    const { call } = await connect();
    const { json } = await call("surety_epoch");
    expect(json).toMatchObject({
      currentEpoch: FIXTURE_EPOCH.toString(),
      epochLengthSeconds: 3600,
      secondsToFlip: 1800,
      rebalanceDue: false,
      seasonEpochs: 4,
    });
  });

  it("summarises the board in MUSD and percent", async () => {
    const { call } = await connect();
    const { json } = await call("surety_board");
    const board = json as { vault: Record<string, unknown>; lines: Record<string, unknown>[] };
    expect(board.vault.tvlMusd).toBe("10000");
    expect(board.lines).toHaveLength(2);
    expect(board.lines[0]).toMatchObject({ id: 0, kind: "Morpho", voteSharePct: 60, utilizationPct: 75 });
    expect(board.lines[1]).toMatchObject({ id: 1, kind: "VeBTC", uncoveredLossMusd: "10", paused: false });
  });

  it("quotes a veBTC borrow and reports loan health", async () => {
    const { call } = await connect();
    const quote = (await call("surety_quote_vebtc_borrow", { tokenId: "7", amount: "500" })).json!;
    expect(quote).toMatchObject({ eligible: true, quotedMusd: "500", ltvPct: 12.5, maxBorrowMusd: "1800" });

    const loan = (await call("surety_loan_health", { loanId: "1" })).json!;
    expect(loan).toMatchObject({ loanId: "1", state: "Active", ltvPct: 37.5, liquidatable: false });

    const auctions = (await call("surety_loan_health")).json as { loans: Record<string, unknown>[] };
    expect(auctions.loans).toHaveLength(1);
    expect(auctions.loans[0]).toMatchObject({ state: "Auction", auctionPriceMusd: "1088" });
  });

  it("reports cohorts with the current ballot", async () => {
    const { call } = await connect();
    const json = (await call("surety_cohorts", { tokenId: "7" })).json as {
      cohorts: { status: string }[];
      ballot: { castThisEpoch: boolean };
    };
    expect(json.cohorts.map((c) => c.status)).toContain("claimable");
    expect(json.ballot.castThisEpoch).toBe(true);
  });

  it("builds unsigned calldata and never signs", async () => {
    const { call, fixture } = await connect();
    const d = fixture.deployment;

    const vote = (await call("surety_build_tx", {
      action: "vote",
      params: { tokenId: "7", lineIds: [0, 1], weightsBps: [7000, 3000] },
    })).json as { chainId: number; transactions: { to: string; data: `0x${string}`; value: string }[] };
    expect(vote.chainId).toBe(31611);
    expect(vote.transactions).toHaveLength(1);
    expect(vote.transactions[0]!.to).toBe(d.contracts.creditVoter);
    expect(decodeFunctionData({ abi: creditVoterAbi, data: vote.transactions[0]!.data }).args).toEqual([
      7n,
      [0n, 1n],
      [7000n, 3000n],
    ]);

    const deposit = (await call("surety_build_tx", {
      action: "deposit",
      params: { assets: "250.5", receiver: ALICE },
    })).json as { transactions: { to: string; data: `0x${string}` }[] };
    expect(deposit.transactions.map((t) => t.to)).toEqual([d.external.musd, d.contracts.vault]);
    expect(decodeFunctionData({ abi: erc20Abi, data: deposit.transactions[0]!.data }).args).toEqual([
      d.contracts.vault,
      250_500_000_000_000_000_000n,
    ]);
    expect(decodeFunctionData({ abi: vaultV2Abi, data: deposit.transactions[1]!.data }).args).toEqual([
      250_500_000_000_000_000_000n,
      ALICE,
    ]);

    const open = (await call("surety_build_tx", { action: "open_loan", params: { tokenId: "7", amount: "100" } }))
      .json as { transactions: unknown[] };
    expect(open.transactions).toHaveLength(2);
  });

  it("rejects invalid input with a readable error", async () => {
    const { call } = await connect();
    const bad = await call("surety_build_tx", { action: "vote", params: { tokenId: "7", lineIds: [0], weightsBps: [9000] } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]!.text).toMatch(/10000/);

    const missing = await call("surety_build_tx", { action: "repay", params: { loanId: "1" } });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0]!.text).toMatch(/amount/);

    const wrongType = await call("surety_quote_vebtc_borrow", { tokenId: "seven" });
    expect(wrongType.result.isError).toBe(true);
  });
});

describe("streamable HTTP", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("serves the tools statelessly over HTTP", async () => {
    const fixture = createSuretyFixture();
    const http = await startHttpServer({ createServer: () => createSuretyMcpServer({ client: fixture.client }), port: 0 });
    close = () => new Promise((resolve) => http.close(() => resolve()));
    const { port } = http.address() as AddressInfo;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);

    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const result = (await client.callTool({ name: "surety_epoch", arguments: {} })) as TextResult;
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ currentEpoch: FIXTURE_EPOCH.toString() });
    await client.close();
  });
});

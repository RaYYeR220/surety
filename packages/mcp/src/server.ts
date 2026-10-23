import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SuretyClient } from "@surety/sdk";
import { getAddress, parseUnits } from "viem";
import { z } from "zod";

import { ACTION_HELP, BUILD_ACTIONS, buildTx } from "./build.js";
import { presentBallot, presentBoard, presentCohorts, presentEpoch, presentLoan, presentQuote } from "./format.js";

export const TOOL_NAMES = [
  "surety_board",
  "surety_epoch",
  "surety_quote_vebtc_borrow",
  "surety_loan_health",
  "surety_cohorts",
  "surety_build_tx",
] as const;

export interface SuretyMcpOptions {
  client: SuretyClient;
  name?: string;
  version?: string;
}

const tokenId = z
  .string()
  .regex(/^\d+$/)
  .describe("veBTC NFT token id, as a decimal string");

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function failure(e: unknown): CallToolResult {
  const err = e as { shortMessage?: string; message?: string };
  const message = (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
  return { isError: true, content: [{ type: "text", text: message ?? "error" }] };
}

async function run(fn: () => Promise<unknown> | unknown): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return failure(e);
  }
}

/** An MCP server exposing Surety reads and unsigned transaction building. It never signs or sends. */
export function createSuretyMcpServer(options: SuretyMcpOptions): McpServer {
  const { client } = options;
  const server = new McpServer({ name: options.name ?? "surety", version: options.version ?? "0.1.0" });
  const network = client.chainId === 31612 ? "Mezo mainnet" : "Mezo testnet";
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "surety_board",
    {
      title: "Surety credit board",
      description:
        `The Surety credit board on ${network}: each credit line's vote share (this epoch and last), ` +
        "vault allocation and target, utilisation, supply and borrow APY, sponsor incentives, first-loss cover " +
        "capacity and uncovered loss, plus vault TVL, share price and estimated depositor APY. Amounts in MUSD.",
      annotations: readOnly,
    },
    () => run(async () => presentBoard(await client.getBoard())),
  );

  server.registerTool(
    "surety_epoch",
    {
      title: "Surety epoch",
      description:
        "Current Surety epoch: start, next flip, seconds to flip, epoch length, the tally epoch driving the " +
        "allocation, last rebalance epoch, whether a rebalance is due, and the seasoning length.",
      annotations: readOnly,
    },
    () => run(async () => presentEpoch(await client.getEpoch())),
  );

  server.registerTool(
    "surety_quote_vebtc_borrow",
    {
      title: "Quote a veBTC-backed borrow",
      description:
        "Quote borrowing MUSD against a locked veBTC NFT on the Surety veBTC line: eligibility (with reasons), " +
        "collateral value, max LTV, max borrow, LTV and BTC liquidation price for the amount, maturity (lock end), " +
        "and the borrow APR before and after. Optional amount in MUSD (decimal string); defaults to the max.",
      inputSchema: {
        tokenId,
        amount: z
          .string()
          .regex(/^\d+(\.\d{1,18})?$/)
          .optional()
          .describe("MUSD to borrow, decimal string (default: max borrow)"),
      },
      annotations: readOnly,
    },
    ({ tokenId: id, amount }) =>
      run(async () =>
        presentQuote(await client.quoteVeBTCBorrow(id, amount === undefined ? undefined : parseUnits(amount, 18))),
      ),
  );

  server.registerTool(
    "surety_loan_health",
    {
      title: "veBTC loan health",
      description:
        "Health of Surety veBTC loans: debt, collateral value, LTV against the max and liquidation LTV, BTC " +
        "liquidation price, maturity, whether it can be auctioned now, and the live Dutch auction price. Pass a " +
        "loanId for one loan, a borrower address for theirs, or neither for every loan in auction.",
      inputSchema: {
        loanId: z.string().regex(/^\d+$/).optional().describe("loan id, decimal string"),
        borrower: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .optional()
          .describe("borrower address"),
      },
      annotations: readOnly,
    },
    ({ loanId, borrower }) =>
      run(async () => {
        if (loanId !== undefined && borrower !== undefined) throw new Error("pass loanId or borrower, not both");
        if (loanId !== undefined) {
          const loan = await client.getLoan(loanId);
          if (!loan) throw new Error(`loan ${loanId} does not exist`);
          return presentLoan(loan);
        }
        const loans = borrower !== undefined ? await client.getLoans(getAddress(borrower)) : await client.getAuctions();
        return { loans: loans.map(presentLoan) };
      }),
  );

  server.registerTool(
    "surety_cohorts",
    {
      title: "Voter reward cohorts",
      description:
        "A veBTC NFT's Surety reward cohorts per line and epoch: claimable (matured), maturing (seasoning, first " +
        "loss for the line) and at risk (seasoning while the line has an uncovered loss), with values in MUSD, " +
        "plus the ballot it currently has.",
      inputSchema: { tokenId },
      annotations: readOnly,
    },
    ({ tokenId: id }) =>
      run(async () => {
        const [cohorts, ballot] = await Promise.all([client.getCohorts(id), client.getBallot(id)]);
        return { ...presentCohorts(cohorts), ballot: presentBallot(ballot) };
      }),
  );

  server.registerTool(
    "surety_build_tx",
    {
      title: "Build an unsigned Surety transaction",
      description:
        `Unsigned calldata for a Surety action on ${network}, to be signed and sent by the user's wallet; this ` +
        "server never signs. Returns transactions to send in order (token approvals first unless " +
        "includeApproval is false). Amounts are decimal token units (MUSD, BTC and srMUSD have 18 decimals). " +
        `Actions and params: ${ACTION_HELP}.`,
      inputSchema: {
        action: z.enum(BUILD_ACTIONS).describe("action to build"),
        params: z.record(z.string(), z.unknown()).default({}).describe("action parameters"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ action, params }) => run(() => buildTx(client, action, params)),
  );

  return server;
}

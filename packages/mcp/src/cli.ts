#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMezoPublicClient, createSuretyClient, getDeployment, isMezoChainId, parseDeployment } from "@surety/sdk";

import { startHttpServer } from "./http.js";
import { createSuretyMcpServer } from "./server.js";

const USAGE = `Usage: surety-mcp [--http] [options]

Serves the Surety MCP tools over stdio (default) or streamable HTTP.

Options:
  --http                 serve streamable HTTP instead of stdio
  --port <n>             HTTP port (default 3333, env PORT)
  --host <addr>          HTTP bind address (default 127.0.0.1, env HOST)
  --chain <id>           31611 (testnet, default) or 31612 (mainnet) (env SURETY_CHAIN_ID)
  --rpc <url>            RPC URL; repeat or comma-separate for fallbacks (env SURETY_RPC_URL)
  --deployment <path>    deployment JSON to use instead of the bundled one (env SURETY_DEPLOYMENT)
  --help                 show this help
`;

// stdout carries the MCP protocol in stdio mode, so everything else goes to stderr.
function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      chain: { type: "string" },
      rpc: { type: "string", multiple: true },
      deployment: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stderr.write(USAGE);
    return;
  }

  const chainId = Number(values.chain ?? process.env.SURETY_CHAIN_ID ?? 31611);
  if (!isMezoChainId(chainId)) throw new Error(`unsupported chain ${chainId}; use 31611 or 31612`);
  const rpcUrls = [...(values.rpc ?? []), ...(process.env.SURETY_RPC_URL ? [process.env.SURETY_RPC_URL] : [])]
    .flatMap((u) => u.split(","))
    .map((u) => u.trim())
    .filter(Boolean);
  const deploymentPath = values.deployment ?? process.env.SURETY_DEPLOYMENT;
  const deployment = deploymentPath ? parseDeployment(JSON.parse(readFileSync(deploymentPath, "utf8"))) : undefined;
  if (!deployment && !getDeployment(chainId)) {
    throw new Error(`no Surety deployment bundled for chain ${chainId}; pass --deployment <path> or SURETY_DEPLOYMENT`);
  }

  const publicClient = createMezoPublicClient(chainId, rpcUrls.length ? { rpcUrls } : {});
  const client = createSuretyClient({ chainId, publicClient, ...(deployment ? { deployment } : {}) });

  if (values.http) {
    const port = Number(values.port ?? process.env.PORT ?? 3333);
    const host = values.host ?? process.env.HOST ?? "127.0.0.1";
    await startHttpServer({
      createServer: () => createSuretyMcpServer({ client }),
      port,
      host,
      onError: (e) => note(`request failed: ${e instanceof Error ? e.message : String(e)}`),
    });
    note(`surety-mcp: chain ${chainId}, streamable HTTP on http://${host}:${port}/mcp`);
    return;
  }

  const server = createSuretyMcpServer({ client });
  await server.connect(new StdioServerTransport());
  note(`surety-mcp: chain ${chainId}, stdio`);
}

main().catch((e: unknown) => {
  note(`surety-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});

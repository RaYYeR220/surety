#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  MEZO_MAINNET_ID,
  createMezoPublicClient,
  createSuretyClient,
  getDeployment,
  getMezoChain,
  isMezoChainId,
  parseDeployment,
} from "@surety/sdk";
import { createWalletClient, fallback, http, isHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Executor } from "./execute.js";
import { Keeper } from "./keeper.js";
import { createLogger, type Level, type Logger } from "./log.js";
import { SnapshotSource } from "./snapshot.js";

const USAGE = `Usage: surety-keeper --chain <31611|31612> [options]

Options:
  --chain <id>             Mezo chain id (required)
  --dry-run                simulate every action, send nothing (no key needed)
  --once                   run one pass and exit
  --interval <seconds>     time between passes (default 60 on testnet, 600 on mainnet)
  --flip-delay <seconds>   wait after an epoch flip before rebalancing (default 5)
  --rpc <url>              RPC URL; repeat or comma-separate for fallbacks (env KEEPER_RPC_URL)
  --deployment <path>      deployment JSON to use instead of the bundled one
  --morpho-liquidations    also liquidate unhealthy Morpho positions (off by default; needs MUSD)
  --log-level <level>      debug | info | warn | error (default info)
  --help                   show this help

Environment:
  KEEPER_PRIVATE_KEY       hex private key of the sending account (required unless --dry-run)
  KEEPER_ADDRESS           simulation sender in --dry-run without a key
  KEEPER_RPC_URL           RPC URL(s), comma-separated
`;

const DRY_RUN_SENDER: Address = "0x000000000000000000000000000000000000dEaD";

/** Logger for fatal errors; replaced once the key is known so it is redacted there too. */
let fatalLog: Logger = createLogger();

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      chain: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      interval: { type: "string" },
      "flip-delay": { type: "string", default: "5" },
      rpc: { type: "string", multiple: true },
      deployment: { type: "string" },
      "morpho-liquidations": { type: "boolean", default: false },
      "log-level": { type: "string", default: "info" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const chainId = Number(values.chain);
  if (!values.chain || !isMezoChainId(chainId)) fail("--chain must be 31611 (testnet) or 31612 (mainnet)");
  const dryRun = values["dry-run"];
  const level = values["log-level"] as Level;
  if (!["debug", "info", "warn", "error"].includes(level)) fail("--log-level must be debug, info, warn or error");

  const rawKey = process.env.KEEPER_PRIVATE_KEY?.trim();
  const key = rawKey ? ((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`) : undefined;
  const log = createLogger({ level, secrets: key ? [key] : [] }, { chainId });
  fatalLog = log;
  if (!key && !dryRun) fail("KEEPER_PRIVATE_KEY is required unless --dry-run");
  if (key && (!isHex(key) || key.length !== 66)) fail("KEEPER_PRIVATE_KEY must be a 32-byte hex key");
  const account = key ? privateKeyToAccount(key) : undefined;
  const sender = (account?.address ?? (process.env.KEEPER_ADDRESS as Address | undefined) ?? DRY_RUN_SENDER) as Address;

  const rpcUrls = [...(values.rpc ?? []), ...(process.env.KEEPER_RPC_URL ? [process.env.KEEPER_RPC_URL] : [])]
    .flatMap((u) => u.split(","))
    .map((u) => u.trim())
    .filter(Boolean);
  const publicClient = createMezoPublicClient(chainId, rpcUrls.length ? { rpcUrls } : {});
  const chain = getMezoChain(chainId);
  const walletClient = account
    ? createWalletClient({
        account,
        chain,
        transport: fallback((rpcUrls.length ? rpcUrls : [...chain.rpcUrls.default.http]).map((u) => http(u))),
      })
    : undefined;

  const deployment = values.deployment
    ? parseDeployment(JSON.parse(readFileSync(values.deployment, "utf8")))
    : undefined;
  if (!deployment && !getDeployment(chainId)) {
    fail(`no Surety deployment bundled for chain ${chainId}; pass --deployment <path>`);
  }
  const client = createSuretyClient({ chainId, publicClient, ...(deployment ? { deployment } : {}) });

  const intervalSeconds = values.interval ? Number(values.interval) : chainId === MEZO_MAINNET_ID ? 600 : 60;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) fail("--interval must be a positive number");
  const flipDelay = BigInt(Math.max(1, Math.floor(Number(values["flip-delay"]))));

  const executor = new Executor({
    publicClient,
    ...(walletClient ? { walletClient } : {}),
    account: account ?? sender,
    dryRun,
    log,
  });
  const source = new SnapshotSource(client, {
    account: sender,
    morphoLiquidations: values["morpho-liquidations"],
    log,
  });
  const keeper = new Keeper({
    client,
    source,
    executor,
    log,
    flipDelaySeconds: flipDelay,
    morphoLiquidations: values["morpho-liquidations"],
  });

  log.info("keeper starting", {
    sender,
    dryRun,
    once: values.once,
    intervalSeconds,
    morphoLiquidations: values["morpho-liquidations"],
    contracts: client.deployment.contracts,
  });
  const stop = () => keeper.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await keeper.run({ intervalMs: intervalSeconds * 1000, once: values.once });
}

// exitCode rather than exit(): exiting while sockets are closing can abort Node on Windows.
main().catch((e: unknown) => {
  fatalLog.error("fatal", { error: e });
  process.exitCode = 1;
});

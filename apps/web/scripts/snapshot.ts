// Build-time snapshot: reads both Mezo chains through the SDK and writes .snapshot/snapshot.json, which the static
// pages render with an "as of" time before any live read. Runs before `next build` (and `next dev`).
//
//   node scripts/snapshot.ts               read both chains and the ledgers
//   node scripts/snapshot.ts --if-missing  only when no snapshot exists yet (dev)
//   SNAPSHOT_OFFLINE=1                     no network: keep the previous file, or write an empty one
//
// A chain that cannot be read keeps its entry from the previous snapshot (its own "as of" says how old it is), so
// a flaky RPC at build time never fails the build or blanks the pages.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSuretyClient, getDeployment, getDeployments, MEZO_MAINNET_ID, MEZO_TESTNET_ID, type SuretyClient } from "@surety/sdk";

import { collectLedger, type LedgerSnapshots } from "../src/lib/ledger.ts";
import { createReadClient, timeBox } from "../src/lib/rpc.ts";
import { decodeJson, encodeJson, readChainSnapshot, type ChainSnapshots } from "../src/lib/snapshot.ts";
import type { SiteSnapshot } from "../src/lib/snapshot.server.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_FILE = join(here, "..", ".snapshot", "snapshot.json");

const CHAINS = [MEZO_MAINNET_ID, MEZO_TESTNET_ID];
const NAMES: Record<number, string> = { [MEZO_MAINNET_ID]: "mainnet", [MEZO_TESTNET_ID]: "testnet" };

function previous(): SiteSnapshot | null {
  try {
    return decodeJson<SiteSnapshot>(readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function attempt<T>(what: string, run: () => Promise<T>, tries = 3, ms = 30_000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await timeBox(run(), ms, what);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1_000 * (i + 1)));
    }
  }
  throw last;
}

function brief(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160);
}

async function main() {
  const ifMissing = process.argv.includes("--if-missing");
  const prev = previous();
  if (ifMissing && prev) {
    console.log(`snapshot: kept ${SNAPSHOT_FILE} (built ${new Date(prev.builtAt).toISOString()})`);
    return;
  }

  const chains: ChainSnapshots = {};
  const ledger: LedgerSnapshots = {};
  if (process.env.SNAPSHOT_OFFLINE) {
    console.log("snapshot: offline, keeping the previous entries");
  } else {
    await Promise.all(
      CHAINS.map(async (chainId) => {
        const name = NAMES[chainId];
        const deployment = getDeployment(chainId);
        if (!deployment) {
          console.log(`snapshot: ${name} has no deployment bundled`);
          return;
        }
        const publicClient = createReadClient(chainId, { timeout: 10_000 });
        const client = createSuretyClient({ chainId, deployment, publicClient });
        try {
          chains[chainId] = await attempt(`${name} board`, () => readChainSnapshot(client));
          const s = chains[chainId]!;
          console.log(
            `snapshot: ${name} v${s.version} at block ${s.board.epoch.blockNumber}, TVL ${s.board.vault.totalAssets} wei, ${s.board.lines.length} lines`,
          );
        } catch (e) {
          console.warn(`snapshot: ${name} board unreadable (${brief(e)}); keeping the previous entry`);
        }

        const clients: Partial<Record<number, SuretyClient>> = {};
        for (const d of getDeployments(chainId)) clients[d.version] = createSuretyClient({ chainId, deployment: d, publicClient });
        try {
          const l = await attempt(`${name} ledger`, () => collectLedger(chainId, { clients }), 2, 60_000);
          ledger[chainId] = l;
          const outside = l.wallets.filter((w) => !w.team).length;
          console.log(
            `snapshot: ${name} ledger ${l.wallets.length} wallets (${outside} outside)${l.errors.length ? `, ${l.errors.length} partial` : ""}`,
          );
        } catch (e) {
          console.warn(`snapshot: ${name} ledger unreadable (${brief(e)}); keeping the previous entry`);
        }
      }),
    );
  }

  for (const id of CHAINS) {
    if (!chains[id] && prev?.chains[id]) chains[id] = prev.chains[id];
    if (!ledger[id] && prev?.ledger[id]) ledger[id] = prev.ledger[id];
  }
  const out: SiteSnapshot = { builtAt: Date.now(), chains, ledger };
  mkdirSync(dirname(SNAPSHOT_FILE), { recursive: true });
  writeFileSync(SNAPSHOT_FILE, encodeJson(out));
  console.log(`snapshot: wrote ${SNAPSHOT_FILE}`);
}

await main();

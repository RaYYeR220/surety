// Reads the build-time snapshot (scripts/snapshot.ts) for server components. Static export runs these at build
// time, so the figures land in the HTML. A missing or unreadable file simply means no snapshot.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LedgerSnapshots } from "./ledger";
import { decodeJson, type ChainSnapshots } from "./snapshot";

export interface SiteSnapshot {
  /** When the snapshot script ran, ms. */
  builtAt: number;
  chains: ChainSnapshots;
  ledger: LedgerSnapshots;
}

let cached: SiteSnapshot | null | undefined;

export function loadSnapshot(): SiteSnapshot | null {
  if (cached !== undefined) return cached;
  try {
    cached = decodeJson<SiteSnapshot>(readFileSync(join(process.cwd(), ".snapshot", "snapshot.json"), "utf8"));
  } catch {
    cached = null;
  }
  return cached;
}

/** The chain snapshots only (what the landing and the app shell need). */
export function loadChainSnapshots(): ChainSnapshots {
  return loadSnapshot()?.chains ?? {};
}

export function loadLedgerSnapshots(): LedgerSnapshots {
  return loadSnapshot()?.ledger ?? {};
}

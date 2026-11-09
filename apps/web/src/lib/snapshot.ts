// The figures the landing and the app overview open with, read through the SDK at build time
// (scripts/snapshot.ts) and rendered into the static pages with an "as of" time. Live reads replace them as they
// arrive, so first paint never waits on an RPC. Shared by the build script and the browser: viem and the SDK only.
import {
  call,
  isV2Deployment,
  normalizeLineParams,
  orNull,
  suretyPoolAbi,
  vaultV2Abi,
  veBTCCreditLineAbiFor,
  type Board,
  type LineParams,
  type PegView,
  type ProofTx,
  type ReadCall,
  type Settled,
  type SuretyClient,
} from "@surety/sdk";

/** One chain as read at `asOf`. */
export interface ChainSnapshot {
  chainId: number;
  /** Schema version of the deployment that was read. */
  version: 1 | 2;
  /** Wall-clock time of the read, ms since epoch. */
  asOf: number;
  /** The SDK's board: epoch, vault (TVL, idle, fees), lines (votes, allocations, rates, cover). */
  board: Board;
  /** MUSD the SuretyPool reserve holds (second loss), or null when unreadable. */
  reserve: bigint | null;
  /** The veBTC credit line's parameters, or null when unreadable. */
  lineParams: LineParams | null;
  /** The MUSD peg (v2 deployments), or null. */
  peg: PegView | null;
  /** The deployment's recorded proof transactions, newest last (at most 12). */
  proofTxs: ProofTx[];
}

/** Snapshots per chain id; a chain is missing when it could not be read at build time. */
export type ChainSnapshots = Partial<Record<number, ChainSnapshot>>;

/** Reads one chain's snapshot. Board must succeed; the rest is best-effort. `peg: false` skips the peg read. */
export async function readChainSnapshot(client: SuretyClient, options: { peg?: boolean } = {}): Promise<ChainSnapshot> {
  const d = client.deployment;
  const board = await client.getBoard();
  const blockNumber = board.epoch.blockNumber;
  const [reserveSharesS, paramsS] = await client.reader.settle(
    [
      call(d.contracts.suretyPool, suretyPoolAbi, "reserveShares"),
      call(d.contracts.veBTCLine, veBTCCreditLineAbiFor(d), "params"),
    ] as ReadCall[],
    { blockNumber },
  );
  const reserveShares = orNull(reserveSharesS as Settled<bigint>);
  let reserve: bigint | null = null;
  if (reserveShares !== null) {
    const [assets] = await client.reader.settle([call(d.contracts.vault, vaultV2Abi, "convertToAssets", [reserveShares])], {
      blockNumber,
    });
    reserve = orNull(assets!) ?? null;
  }
  const rawParams = orNull(paramsS as Settled<Partial<LineParams>>);
  const peg = options.peg !== false && isV2Deployment(d) ? await client.getPeg().catch(() => null) : null;
  return {
    chainId: client.chainId,
    version: d.version,
    asOf: Date.now(),
    board,
    reserve,
    lineParams: rawParams ? normalizeLineParams(rawParams) : null,
    peg,
    proofTxs: d.proof.txs.slice(-12),
  };
}

/* ---------- JSON with bigints ---------- */

const BIG = "$bigint";

/** JSON.stringify that keeps bigints as `{"$bigint": "<decimal>"}`. */
export function encodeJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? { [BIG]: v.toString() } : v), space);
}

/** JSON.parse that restores what encodeJson wrote. */
export function decodeJson<T>(text: string): T {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const big = o[BIG];
      if (typeof big === "string" && Object.keys(o).length === 1) return BigInt(big);
    }
    return v;
  }) as T;
}

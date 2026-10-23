// Pure decision logic: state snapshot in, ordered list of permissionless actions out.
import {
  morphoLiquidationIncentiveFactor,
  morphoMaxBorrow,
  morphoToAssetsDown,
  morphoToAssetsUp,
  MORPHO_ORACLE_PRICE_SCALE,
  WAD,
  type LineKind,
  type LoanState,
  type MarketParams,
} from "@surety/sdk";
import type { Address } from "viem";

export interface BallotState {
  tokenId: bigint;
  lineIds: number[];
  /** Epoch the ballot was last cast into. */
  epochCast: bigint;
  /** Current NFT owner; zero once burned (merged or withdrawn). */
  owner: Address;
  ownerIsEscrow: boolean;
  /** Voting power at the current epoch start. */
  power: bigint;
}

export interface LineState {
  id: number;
  kind: LineKind;
  active: boolean;
  /** Recorded and not covered yet. */
  uncoveredLoss: bigint;
  /** Loss a checkpoint would record now (simulated); null if the simulation failed. */
  pendingLoss: bigint | null;
  coverCapacity: bigint;
  /**
   * Morpho lines: whether SuretyPool has a supply-price high-water mark for the line (set by the first
   * checkpoint; losses are measured against it). null for veBTC lines or when unknown.
   */
  markSet: boolean | null;
}

export interface LoanStateView {
  loanId: bigint;
  state: LoanState;
  /** null when it cannot be decided (oracle down). */
  liquidatable: boolean | null;
  reason: "ltv" | "expiry" | null;
}

export interface MorphoPosition {
  lineId: number;
  marketParams: MarketParams;
  borrower: Address;
  borrowShares: bigint;
  collateral: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  /** Morpho oracle price (1e36 scale); null if the oracle reverts. */
  oraclePrice: bigint | null;
}

export interface KeeperSnapshot {
  now: bigint;
  currentEpoch: bigint;
  epochLength: bigint;
  lastRebalanceEpoch: bigint;
  /** MUSD idle in the vault: `cover` can pay at most this. */
  vaultIdle: bigint;
  ballots: BallotState[];
  lines: LineState[];
  loans: LoanStateView[];
  morphoPositions: MorphoPosition[];
}

export interface DecideOptions {
  /** Seconds after the flip before `rebalance` (default 5). */
  flipDelaySeconds?: bigint;
  /** Morpho liquidation backstop (off by default). */
  morphoLiquidations?: boolean;
}

export type Action =
  | { kind: "startAuction"; loanId: bigint; reason: "ltv" | "expiry" }
  | { kind: "cover"; lineId: number; loss: bigint }
  | { kind: "checkpoint"; lineId: number; reason: CheckpointReason; loss: bigint }
  | { kind: "poke"; tokenId: bigint }
  | { kind: "rebalance"; epoch: bigint }
  | {
      kind: "liquidateMorpho";
      lineId: number;
      marketParams: MarketParams;
      borrower: Address;
      seizedAssets: bigint;
      repaidShares: bigint;
    };

/**
 * loss: a new loss to record. mark: a Morpho line without a high-water mark yet (a loss before the first
 * checkpoint would go unmeasured). pre-rebalance: ratchets a Morpho line's mark up with interest once per epoch,
 * right before the rebalance reallocates it.
 */
export type CheckpointReason = "loss" | "mark" | "pre-rebalance";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Ballots `poke` would recast now: stored in an earlier epoch, NFT alive and not escrowed, with power and a live line. */
export function ballotsToPoke(s: KeeperSnapshot): bigint[] {
  // CreditVoter rejects ballots in the first second of an epoch (the snapshot can still move).
  if (s.now <= s.currentEpoch) return [];
  const active = new Set(s.lines.filter((l) => l.active).map((l) => l.id));
  return s.ballots
    .filter(
      (b) =>
        b.lineIds.length > 0 &&
        b.epochCast < s.currentEpoch &&
        b.owner.toLowerCase() !== ZERO &&
        !b.ownerIsEscrow &&
        b.power > 0n &&
        b.lineIds.some((id) => active.has(id)),
    )
    .map((b) => b.tokenId);
}

/** Whether this epoch still needs its one rebalance, at least `flipDelay` seconds after the flip. */
export function rebalanceDue(s: KeeperSnapshot, flipDelaySeconds = 5n): boolean {
  return s.lastRebalanceEpoch < s.currentEpoch && s.now >= s.currentEpoch + flipDelaySeconds;
}

/**
 * Loss handling per line: `cover` (which checkpoints first) when there is a loss and something to pay it with,
 * otherwise `checkpoint` alone so a new loss is at least recorded (until it is, the vault's DepositGate holds new
 * deposits back). Morpho lines are also checkpointed when they have no mark yet, and before each rebalance, because
 * SuretyPool measures Morpho losses against the supply price and adapter shares of the line's last checkpoint.
 */
export function lossActions(s: KeeperSnapshot, options: { rebalancing?: boolean } = {}): Action[] {
  const out: Action[] = [];
  for (const line of s.lines) {
    const pending = line.pendingLoss ?? 0n;
    const loss = line.uncoveredLoss + pending;
    if (loss > 0n && line.coverCapacity > 0n && s.vaultIdle > 0n) {
      out.push({ kind: "cover", lineId: line.id, loss });
    } else if (pending > 0n) {
      out.push({ kind: "checkpoint", lineId: line.id, reason: "loss", loss: pending });
    } else if (line.kind === "Morpho" && line.markSet === false) {
      out.push({ kind: "checkpoint", lineId: line.id, reason: "mark", loss: 0n });
    } else if (line.kind === "Morpho" && options.rebalancing) {
      out.push({ kind: "checkpoint", lineId: line.id, reason: "pre-rebalance", loss: 0n });
    }
  }
  return out;
}

export function auctionsToStart(s: KeeperSnapshot): Action[] {
  return s.loans
    .filter((l) => l.state === "Active" && l.liquidatable === true && l.reason !== null)
    .map((l) => ({ kind: "startAuction", loanId: l.loanId, reason: l.reason! }));
}

/**
 * Sizes a Morpho liquidation: repay all borrow shares if the collateral covers the incentive, else seize all
 * collateral (Morpho then realises any bad debt). Returns null for healthy positions or an unknown price.
 */
export function sizeMorphoLiquidation(p: MorphoPosition): { seizedAssets: bigint; repaidShares: bigint } | null {
  if (p.oraclePrice === null || p.oraclePrice === 0n || p.borrowShares === 0n) return null;
  const borrowed = morphoToAssetsUp(p.borrowShares, p.totalBorrowAssets, p.totalBorrowShares);
  if (borrowed <= morphoMaxBorrow(p.collateral, p.oraclePrice, p.marketParams.lltv)) return null;
  const lif = morphoLiquidationIncentiveFactor(p.marketParams.lltv);
  const repaidAssets = morphoToAssetsDown(p.borrowShares, p.totalBorrowAssets, p.totalBorrowShares);
  const seizeForFull = (((repaidAssets * lif) / WAD) * MORPHO_ORACLE_PRICE_SCALE) / p.oraclePrice;
  if (seizeForFull <= p.collateral) return { seizedAssets: 0n, repaidShares: p.borrowShares };
  if (p.collateral === 0n) return null;
  return { seizedAssets: p.collateral, repaidShares: 0n };
}

export function morphoLiquidations(s: KeeperSnapshot): Action[] {
  const out: Action[] = [];
  for (const p of s.morphoPositions) {
    const size = sizeMorphoLiquidation(p);
    if (size) {
      out.push({ kind: "liquidateMorpho", lineId: p.lineId, marketParams: p.marketParams, borrower: p.borrower, ...size });
    }
  }
  return out;
}

/**
 * Everything worth sending now, in order: auctions (lender safety first), loss checkpoints and covers (a
 * checkpoint must precede reallocating the line), ballot pokes (they matter for a bootstrap tally), then the
 * epoch's rebalance, then the optional Morpho backstop.
 */
export function decide(s: KeeperSnapshot, options: DecideOptions = {}): Action[] {
  const rebalancing = rebalanceDue(s, options.flipDelaySeconds ?? 5n);
  const actions: Action[] = [
    ...auctionsToStart(s),
    ...lossActions(s, { rebalancing }),
    ...ballotsToPoke(s).map((tokenId): Action => ({ kind: "poke", tokenId })),
  ];
  if (rebalancing) actions.push({ kind: "rebalance", epoch: s.currentEpoch });
  if (options.morphoLiquidations) actions.push(...morphoLiquidations(s));
  return actions;
}

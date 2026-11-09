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

/** A loan with auto-repay on, and what a harvest of its escrowed NFT's rewards would claim now. */
export interface HarvestCandidate {
  loanId: bigint;
  /** Reward contracts with something earned, and the tokens to claim from each (`harvest`'s arguments). */
  rewards: Address[];
  tokens: Address[][];
  /** veBTC rebase the distributor reports claimable. */
  claimableRebase: bigint;
}

export interface KeeperSnapshot {
  now: bigint;
  currentEpoch: bigint;
  epochLength: bigint;
  lastRebalanceEpoch: bigint;
  /** MUSD not lent out (the vault's own plus what is parked in sMUSD): `cover` can pay at most this. */
  vaultIdle: bigint;
  ballots: BallotState[];
  lines: LineState[];
  loans: LoanStateView[];
  morphoPositions: MorphoPosition[];
  /** Start of the current Mezo epoch (weeks from Thursday 00:00 UTC), when veBTC rewards become claimable. */
  mezoEpoch?: bigint;
  /** v2: loans with auto-repay on (Active or Auction). */
  harvests?: HarvestCandidate[];
  /** v2: the savings adapter's claimable sMUSD yield; undefined without one. */
  savingsYield?: bigint;
  /** v2 mainnet: the basic pools behind the peg's StableTwap sources, with their latest observation's time. */
  pegPools?: { pool: Address; observedAt: bigint }[];
}

export interface DecideOptions {
  /** Seconds after the flip before `rebalance` (default 5). */
  flipDelaySeconds?: bigint;
  /** Morpho liquidation backstop (off by default). */
  morphoLiquidations?: boolean;
  /** Mezo epoch each loan was last harvested in; a loan is harvested at most once per Mezo epoch. */
  lastHarvest?: ReadonlyMap<bigint, bigint>;
  /** Least claimable sMUSD yield worth a `harvest()` (default 1: anything). */
  savingsHarvestMin?: bigint;
  /** When the keeper last synced each peg pool (lowercase address -> timestamp). */
  lastPoolSync?: ReadonlyMap<string, bigint>;
}

export type Action =
  | { kind: "startAuction"; loanId: bigint; reason: "ltv" | "expiry" }
  | { kind: "cover"; lineId: number; loss: bigint }
  | { kind: "checkpoint"; lineId: number; reason: CheckpointReason; loss: bigint }
  | { kind: "poke"; tokenId: bigint }
  | { kind: "rebalance"; epoch: bigint }
  | { kind: "harvest"; loanId: bigint; rewards: Address[]; tokens: Address[][]; mezoEpoch: bigint }
  | { kind: "savingsHarvest"; yield: bigint }
  | { kind: "syncPegPool"; pool: Address; age: bigint }
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

/** Mezo epochs are weeks from Thursday 00:00 UTC (the unix epoch was a Thursday). */
export const MEZO_WEEK = 604_800n;
export const mezoEpochOf = (ts: bigint) => ts - (ts % MEZO_WEEK);

/**
 * Harvests for auto-repay loans: fees and bribes become claimable when the Mezo epoch they were earned in ends, so
 * each loan is harvested once per Mezo epoch, as soon as it has fees, bribes or a rebase to claim. A rebase the
 * distributor still refuses (before it books the week) does not stop the harvest, and is not retried within the
 * epoch.
 */
export function harvestsDue(s: KeeperSnapshot, lastHarvest: ReadonlyMap<bigint, bigint> = new Map()): Action[] {
  const mezoEpoch = s.mezoEpoch ?? mezoEpochOf(s.now);
  return (s.harvests ?? [])
    .filter((h) => (h.rewards.length > 0 || h.claimableRebase > 0n) && lastHarvest.get(h.loanId) !== mezoEpoch)
    .map((h) => ({ kind: "harvest", loanId: h.loanId, rewards: h.rewards, tokens: h.tokens, mezoEpoch }));
}

/** A peg pool is synced once its latest observation is this old (seconds)... */
export const POOL_SYNC_AFTER = 3_000n;
/** ...and at most this often by this keeper. */
export const POOL_SYNC_INTERVAL = 3_600n;

/**
 * Syncs of the basic pools behind the peg's StableTwap sources. A source reads not ok once its pool's latest
 * observation is older than its `maxAge`, and the pools observe only when someone trades or syncs; `sync()` is
 * permissionless and stores a fresh observation. Each pool is synced when its latest observation is about 50 minutes
 * old, at most hourly, which keeps both stable sources reading and limits how long a quiet pool can hide a move.
 */
export function syncPegPools(s: KeeperSnapshot, lastSync: ReadonlyMap<string, bigint> = new Map()): Action[] {
  return (s.pegPools ?? [])
    .filter((p) => {
      const age = s.now > p.observedAt ? s.now - p.observedAt : 0n;
      const last = lastSync.get(p.pool.toLowerCase());
      return age >= POOL_SYNC_AFTER && (last === undefined || s.now - last >= POOL_SYNC_INTERVAL);
    })
    .map((p) => ({ kind: "syncPegPool", pool: p.pool, age: s.now > p.observedAt ? s.now - p.observedAt : 0n }));
}

/** The savings adapter's yield, claimed and parked again once per epoch with the rebalance. */
export function savingsHarvestDue(s: KeeperSnapshot, rebalancing: boolean, min = 1n): Action[] {
  if (!rebalancing || s.savingsYield === undefined || s.savingsYield < min) return [];
  return [{ kind: "savingsHarvest", yield: s.savingsYield }];
}

/**
 * Everything worth sending now, in order: auctions (lender safety first), loss checkpoints and covers (a
 * checkpoint must precede reallocating the line), ballot pokes (they matter for a bootstrap tally), peg pool syncs
 * (so the rebalance's peg gate reads fresh pools), then the epoch's rebalance and savings harvest, auto-repay
 * harvests, then the optional Morpho backstop.
 */
export function decide(s: KeeperSnapshot, options: DecideOptions = {}): Action[] {
  const rebalancing = rebalanceDue(s, options.flipDelaySeconds ?? 5n);
  const actions: Action[] = [
    ...auctionsToStart(s),
    ...lossActions(s, { rebalancing }),
    ...ballotsToPoke(s).map((tokenId): Action => ({ kind: "poke", tokenId })),
  ];
  actions.push(...syncPegPools(s, options.lastPoolSync));
  if (rebalancing) actions.push({ kind: "rebalance", epoch: s.currentEpoch });
  actions.push(...savingsHarvestDue(s, rebalancing, options.savingsHarvestMin ?? 1n));
  actions.push(...harvestsDue(s, options.lastHarvest));
  if (options.morphoLiquidations) actions.push(...morphoLiquidations(s));
  return actions;
}

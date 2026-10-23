import {
  call,
  creditVoterAbi,
  getLogsChunked,
  morphoAbi,
  morphoPriceOracleAbi,
  orNull,
  suretyPoolAbi,
  veBTCAbi,
  veBTCCreditLineAbi,
  votedEvent,
  type ReadCall,
  type Settled,
  type SuretyClient,
} from "@surety/sdk";
import { getAbiItem, type Address, type Hex } from "viem";

import type { BallotState, KeeperSnapshot, LineState, MorphoPosition } from "./decide.js";
import type { Logger } from "./log.js";

const borrowEvent = getAbiItem({ abi: morphoAbi, name: "Borrow" });
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export interface SnapshotOptions {
  /** Sender for simulations. */
  account: Address;
  morphoLiquidations: boolean;
  log: Logger;
}

/** Reads the chain into a `KeeperSnapshot`. Keeps log cursors so each tick only scans new blocks. */
export class SnapshotSource {
  private readonly voters = new Set<bigint>();
  private votedFrom: bigint;
  private readonly borrowers = new Map<Hex, Set<Address>>();
  private borrowFrom: bigint;

  constructor(
    private readonly client: SuretyClient,
    private readonly options: SnapshotOptions,
  ) {
    this.votedFrom = client.deployment.deployedAt;
    this.borrowFrom = client.deployment.deployedAt;
  }

  /** Token ids seen in `Voted` logs so far. */
  get knownVoters(): bigint[] {
    return [...this.voters];
  }

  async take(): Promise<KeeperSnapshot> {
    const { client } = this;
    const board = await client.getBoard();
    const head = board.epoch.blockNumber;
    const currentEpoch = board.epoch.currentEpoch;

    const pending = await Promise.all(board.lines.map((l) => this.simulateCheckpoint(l.id)));
    const lines: LineState[] = board.lines.map((l, i) => ({
      id: l.id,
      kind: l.kind,
      active: l.active,
      uncoveredLoss: l.uncoveredLoss ?? 0n,
      pendingLoss: pending[i] ?? null,
      coverCapacity: l.coverCapacity ?? 0n,
    }));

    await this.scanVoters(head);
    const ballots = await this.readBallots(currentEpoch, head);

    const loans = (await client.listLoans({ states: ["Active"] })).map((l) => ({
      loanId: l.loanId,
      state: l.state,
      liquidatable: l.liquidatable,
      reason: l.liquidationReason,
    }));

    const morphoPositions = this.options.morphoLiquidations
      ? await this.readMorphoPositions(
          board.lines.filter((l) => l.kind === "Morpho" && l.marketId && l.marketParams),
          head,
        )
      : [];

    return {
      now: board.epoch.now,
      currentEpoch,
      epochLength: board.epoch.epochLength,
      lastRebalanceEpoch: board.epoch.lastRebalanceEpoch,
      vaultIdle: board.vault.idle,
      ballots,
      lines,
      loans,
      morphoPositions,
    };
  }

  /** What `checkpoint(lineId)` would record now, or null if the simulation fails. */
  private async simulateCheckpoint(lineId: number): Promise<bigint | null> {
    try {
      const { result } = await this.client.publicClient.simulateContract({
        address: this.client.deployment.contracts.suretyPool,
        abi: suretyPoolAbi,
        functionName: "checkpoint",
        args: [BigInt(lineId)],
        account: this.options.account,
      });
      return result;
    } catch (e) {
      this.options.log.debug("checkpoint simulation failed", { lineId, error: e });
      return null;
    }
  }

  private async scanVoters(head: bigint): Promise<void> {
    if (this.votedFrom > head) return;
    const logs = await getLogsChunked(this.client.publicClient, {
      address: this.client.deployment.contracts.creditVoter,
      event: votedEvent,
      fromBlock: this.votedFrom,
      toBlock: head,
    });
    for (const log of logs) this.voters.add(log.args.tokenId);
    this.votedFrom = head + 1n;
  }

  private async readBallots(currentEpoch: bigint, head: bigint): Promise<BallotState[]> {
    const ids = [...this.voters];
    if (ids.length === 0) return [];
    const c = this.client.deployment.contracts;
    const ve = this.client.deployment.external.veBTC;
    const reader = this.client.reader;
    const first = await reader.settle(
      ids.flatMap((id) => [
        call(c.creditVoter, creditVoterAbi, "ballotOf", [id]),
        call(ve, veBTCAbi, "ownerOf", [id]),
      ]) as ReadCall[],
      { blockNumber: head },
    );
    const rows = ids.map((tokenId, k) => {
      const ballot = orNull(first[k * 2] as Settled<readonly [readonly bigint[], readonly bigint[], bigint]>);
      return {
        tokenId,
        lineIds: ballot ? ballot[0].map(Number) : [],
        epochCast: ballot ? ballot[2] : 0n,
        owner: orNull(first[k * 2 + 1] as Settled<Address>) ?? ZERO,
      };
    });
    // Escrow and power only matter for ballots a poke could move.
    const stale = rows.filter((r) => r.lineIds.length > 0 && r.epochCast < currentEpoch && r.owner !== ZERO);
    const second = await reader.settle(
      stale.flatMap((r) => [
        call(c.veBTCLine, veBTCCreditLineAbi, "isEscrow", [r.owner]),
        call(ve, veBTCAbi, "votingPowerOfNFTAt", [r.tokenId, currentEpoch]),
      ]) as ReadCall[],
      { blockNumber: head },
    );
    const extra = new Map(
      stale.map((r, k) => [
        r.tokenId,
        {
          ownerIsEscrow: orNull(second[k * 2] as Settled<boolean>) ?? false,
          power: orNull(second[k * 2 + 1] as Settled<bigint>) ?? 0n,
        },
      ]),
    );
    return rows.map((r) => ({ ...r, ownerIsEscrow: false, power: 0n, ...extra.get(r.tokenId) }));
  }

  private async readMorphoPositions(
    lines: { id: number; marketId?: Hex; marketParams?: MorphoPosition["marketParams"] }[],
    head: bigint,
  ): Promise<MorphoPosition[]> {
    if (lines.length === 0) return [];
    const morpho = this.client.deployment.contracts.morpho;
    if (this.borrowFrom <= head) {
      for (const line of lines) {
        const logs = await getLogsChunked(this.client.publicClient, {
          address: morpho,
          event: borrowEvent,
          args: { id: line.marketId },
          fromBlock: this.borrowFrom,
          toBlock: head,
        });
        const set = this.borrowers.get(line.marketId!) ?? new Set<Address>();
        for (const log of logs) set.add(log.args.onBehalf);
        this.borrowers.set(line.marketId!, set);
      }
      this.borrowFrom = head + 1n;
    }

    const targets = lines.flatMap((line) =>
      [...(this.borrowers.get(line.marketId!) ?? [])].map((borrower) => ({ line, borrower })),
    );
    if (targets.length === 0) return [];
    const reads = await this.client.reader.settle(
      [
        ...lines.flatMap((line) => [
          call(morpho, morphoAbi, "market", [line.marketId!]),
          call(line.marketParams!.oracle, morphoPriceOracleAbi, "price"),
        ]),
        ...targets.map((t) => call(morpho, morphoAbi, "position", [t.line.marketId!, t.borrower])),
      ] as ReadCall[],
      { blockNumber: head },
    );
    type Market = { totalBorrowAssets: bigint; totalBorrowShares: bigint };
    type Position = { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
    const marketOf = new Map(
      lines.map((line, k) => [
        line.id,
        { market: orNull(reads[k * 2] as Settled<Market>), price: orNull(reads[k * 2 + 1] as Settled<bigint>) },
      ]),
    );
    const out: MorphoPosition[] = [];
    targets.forEach((t, k) => {
      const position = orNull(reads[lines.length * 2 + k] as Settled<Position>);
      const m = marketOf.get(t.line.id);
      if (!position || !m?.market || position.borrowShares === 0n) return;
      out.push({
        lineId: t.line.id,
        marketParams: t.line.marketParams!,
        borrower: t.borrower,
        borrowShares: position.borrowShares,
        collateral: position.collateral,
        totalBorrowAssets: m.market.totalBorrowAssets,
        totalBorrowShares: m.market.totalBorrowShares,
        oraclePrice: m.price,
      });
    });
    return out;
  }
}

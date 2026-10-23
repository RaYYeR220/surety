"use client";

import type { Board, BoardLine } from "@surety/sdk";
import type { CSSProperties } from "react";

import { Stack } from "@/components/layout/Layout";
import { AppLink } from "@/components/shell/AppLink";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useTx, type TxPlan } from "@/components/tx/TxProvider";
import {
  Meter,
  Muted,
  Notice,
  PageHead,
  Pill,
  SectionTitle,
  Skeleton,
  Stat,
  Tag,
  type MeterMarker,
} from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { ReadyEnv } from "@/lib/env";
import {
  formatBps,
  formatCountdown,
  formatDateTime,
  formatDuration,
  formatMusd,
  formatPct,
  fraction,
  wadToFraction,
} from "@/lib/format";
import { epochCadence, kindLabel, lineColor } from "@/lib/lines";
import { useBoard, useCaps, useChainNow, useLossChecks } from "@/lib/queries";
import type { LineCap, LossCheck } from "@/lib/reads";

import styles from "./Board.module.css";
import { StressPanel } from "./StressPanel";

export function BoardView({ env }: { env: ReadyEnv }) {
  const board = useBoard();
  const lineIds = board.data?.lines.map((l) => l.id);
  const caps = useCaps(board.data?.lines, board.data?.vault.totalAssets);
  const checks = useLossChecks(lineIds);

  return (
    <Stack gap={6}>
      <PageHead
        title="Credit board"
        lead="Where the vault's MUSD is lent this epoch, decided by veBTC votes. The voters' rewards stand first in line if a line they back takes a loss."
      />
      {board.error ? <ReadError what="the credit board" error={board.error} onRetry={() => void board.refetch()} /> : null}
      {board.data ? (
        <>
          <EpochStrip board={board.data} env={env} />
          <VaultSummary board={board.data} />
          <Stack gap={4}>
            <div className={styles.linesHead}>
              <SectionTitle>Credit lines</SectionTitle>
              <Muted small>
                {board.data.lines.length} {board.data.lines.length === 1 ? "line" : "lines"} · votes move capital at
                the next flip
              </Muted>
            </div>
            <div className={styles.lines}>
              {board.data.lines.map((line) => (
                <LineCard
                  key={line.id}
                  env={env}
                  line={line}
                  cap={caps.data?.find((c) => c.lineId === line.id)}
                  check={checks.data?.find((c) => c.lineId === line.id)}
                />
              ))}
            </div>
          </Stack>
          <StressPanel env={env} />
        </>
      ) : board.isPending ? (
        <BoardSkeleton />
      ) : null}
    </Stack>
  );
}

function BoardSkeleton() {
  return (
    <Stack gap={5}>
      <Skeleton height={120} label="Loading the board" />
      <Skeleton height={80} />
      <div className={styles.lines}>
        <Skeleton height={420} />
        <Skeleton height={420} />
      </div>
    </Stack>
  );
}

/* ---------- Epoch strip ---------- */

function EpochStrip({ board, env }: { board: Board; env: ReadyEnv }) {
  const { epoch } = board;
  const tx = useTx();
  const now = useChainNow();
  const remaining = now === null ? Number(epoch.secondsToFlip) : Math.max(0, Number(epoch.nextFlip) - now);
  const elapsed = Number(epoch.epochLength) - remaining;
  const tallyLabel =
    epoch.activeTallyEpoch === epoch.currentEpoch
      ? "this epoch's tally (bootstrap: no closed epoch yet)"
      : epoch.activeTallyEpoch === epoch.lastClosedEpoch
        ? `the tally that closed at ${formatDateTime(epoch.currentEpoch)}`
        : `the tally of the epoch from ${formatDateTime(epoch.activeTallyEpoch)}`;

  const runEpoch = (): TxPlan => ({
    title: "Run epoch",
    summary:
      "Moves the vault's MUSD toward the vote-weighted targets: each line gets its share of the last closed tally, inside its cap. Lines with a stale price feed or a pause get nothing new. Anyone can run it; you only pay gas.",
    rows: [
      { label: "Allocation follows", value: epoch.rebalanceDue ? "the tally that just closed" : tallyLabel },
      ...board.lines.map((l) => ({
        label: `${l.name}`,
        value: `${formatMusd(l.allocation)} → ${formatMusd(l.target)} MUSD`,
      })),
      { label: "Kept idle", value: formatBps(board.vault.idleBufferBps, 0) },
    ],
    notes: [
      "Safe to run more than once: it finishes a partial rebalance and otherwise changes nothing.",
      "It also books each line's interest since the last run, which becomes the voters' fee share.",
    ],
    steps: [{ label: "Rebalance the vault", detail: "VoteAllocator.rebalance()", tx: env.client.buildRebalance() }],
    confirmLabel: "Run epoch",
    successMessage: "Rebalanced. Allocations on the board now follow the latest tally.",
  });

  return (
    <Card tone="strong" label="Epoch">
      <div className={styles.epoch}>
        <div className={styles.countdownBlock}>
          <span className={styles.countLabel}>Next epoch flip in</span>
          <span className={styles.countdown} role="timer" aria-live="off">
            {formatCountdown(remaining)}
          </span>
          <Meter
            value={fraction(BigInt(Math.round(elapsed)), epoch.epochLength)}
            label="Epoch progress"
            valueText={`${formatDuration(remaining)} left`}
            size="sm"
          />
          <Muted small>
            Flips at {formatDateTime(epoch.nextFlip)} · {epochCadence(epoch.epochLength)}
          </Muted>
        </div>
        <div className={styles.epochFacts}>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Votes cast now</span>
            <span className={styles.factValue}>Count for the epoch that started {formatDateTime(epoch.currentEpoch)} and move capital after the flip.</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Capital now follows</span>
            <span className={styles.factValue}>{tallyLabel.charAt(0).toUpperCase() + tallyLabel.slice(1)}.</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Last rebalance</span>
            <span className={styles.factValue}>
              {epoch.lastRebalanceEpoch === 0n
                ? "Never run yet"
                : epoch.rebalanceDue
                  ? `In the epoch from ${formatDateTime(epoch.lastRebalanceEpoch)}: due now`
                  : "This epoch: up to date"}
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Rewards season</span>
            <span className={styles.factValue}>
              {epoch.season.toString()} epochs ({formatDuration(Number(epoch.season * epoch.epochLength))}) of first loss
              before voters can claim.
            </span>
          </div>
        </div>
        <div className={styles.epochAction}>
          {epoch.rebalanceDue ? <Pill tone="warning" dot>Rebalance due</Pill> : <Pill tone="positive" dot>Up to date</Pill>}
          <Button variant={epoch.rebalanceDue ? "primary" : "secondary"} onClick={() => tx.review(runEpoch())}>
            Run epoch
          </Button>
          <span className={styles.actionHint}>Permissionless. The keeper runs it at every flip; you can too.</span>
        </div>
      </div>
    </Card>
  );
}

/* ---------- Vault summary ---------- */

function VaultSummary({ board }: { board: Board }) {
  const v = board.vault;
  const idleShare = fraction(v.idle, v.totalAssets);
  return (
    <Card label="Vault">
      <div className={styles.vault}>
        <Stat label="Total lent in (TVL)" value={formatMusd(v.totalAssets, 0)} unit="MUSD" size="lg" />
        <Stat
          label={`1 ${v.symbol || "srMUSD"} is worth`}
          value={formatMusd(v.sharePrice, 4)}
          unit="MUSD"
          hint="Rises as interest accrues"
        />
        <Stat
          label="Idle in the vault"
          value={formatMusd(v.idle, 0)}
          unit="MUSD"
          hint={`${formatPct(idleShare)} now · target ${formatBps(v.idleBufferBps, 0)} for withdrawals and cover`}
        />
        <Stat
          label="Voters' fee"
          value={formatPct(wadToFraction(v.performanceFee), 0)}
          hint="Of interest, paid to the voters of each line"
        />
        <Stat
          label="Depositor APY"
          tag="est."
          value={formatPct(v.supplyApy, 2)}
          hint="Line rates weighted by allocation, after fees"
        />
      </div>
    </Card>
  );
}

/* ---------- Line card ---------- */

/** Target and cap ticks on the allocation bar; one shared tick when they (nearly) coincide. */
function allocationMarkers(target: bigint | null, cap: LineCap | undefined, scale: bigint): MeterMarker[] {
  const t = target === null ? null : fraction(target, scale);
  const c = cap ? fraction(cap.cap, scale) : null;
  if (t !== null && c !== null && Math.abs(t - c) < 0.08) {
    return [{ at: Math.max(t, c), label: "target = cap", color: "var(--color-warning)" }];
  }
  return [
    ...(t !== null ? [{ at: t, label: "target" }] : []),
    ...(c !== null ? [{ at: c, label: "cap", color: "var(--color-warning)" }] : []),
  ];
}

function LineCard({
  env,
  line,
  cap,
  check,
}: {
  env: ReadyEnv;
  line: BoardLine;
  cap: LineCap | undefined;
  check: LossCheck | undefined;
}) {
  const tx = useTx();
  const color = lineColor(line.id);
  const allocation = line.allocation ?? 0n;
  const target = line.target;
  const coverCap = line.coverCapacity ?? 0n;
  const uncovered = line.uncoveredLoss ?? 0n;
  const pending = check?.pendingLoss ?? 0n;
  const scale = [allocation, target ?? 0n, cap?.cap ?? 0n].reduce((a, b) => (b > a ? b : a), 0n);
  const coverRatio = allocation === 0n ? (coverCap > 0n ? 1 : 0) : fraction(coverCap, allocation);
  const failClosed = line.oracleLive === false;

  const coverPlan = (): TxPlan => {
    const amount = check?.coverable ?? (uncovered < coverCap ? uncovered : coverCap);
    return {
      title: `Cover ${line.name}`,
      summary:
        "Pays the line's recorded loss from the voters' seasoning rewards for this line first, then from the pool reserve. Lenders are made whole up to what that can pay. Never more than the recorded loss.",
      rows: [
        { label: "Uncovered loss", value: `${formatMusd(uncovered)} MUSD` },
        { label: "First-loss cover available", value: `${formatMusd(coverCap)} MUSD` },
        { label: "Moves into the line now", value: `${formatMusd(amount)} MUSD` },
        uncovered > coverCap && {
          label: "Left for lenders",
          value: `${formatMusd(uncovered - coverCap)} MUSD`,
        },
      ],
      notes: ["Seasoning voters of this line lose that amount pro rata. Matured, already-claimable rewards are not touched."],
      steps: [{ label: "Checkpoint and cover", detail: "SuretyPool.cover(lineId)", tx: env.client.buildCover({ lineId: line.id }) }],
      confirmLabel: "Cover the loss",
    };
  };

  const checkpointPlan = (): TxPlan => ({
    title: `Record loss on ${line.name}`,
    summary:
      "Measures the line's bad debt from the Morpho market's supply share price and records it, so cover can pay it. Permissionless.",
    rows: [{ label: "Loss it would record now", value: `${formatMusd(pending)} MUSD` }],
    steps: [
      { label: "Checkpoint the line", detail: "SuretyPool.checkpoint(lineId)", tx: env.client.buildCheckpoint({ lineId: line.id }) },
    ],
    confirmLabel: "Record the loss",
  });

  return (
    <Card className={styles.line} label={line.name} style={{ "--line-color": color } as CSSProperties}>
        <div className={styles.lineHead}>
          <h3 className={styles.lineName}>
            <span className={styles.lineSwatch} aria-hidden="true" />
            {line.name}
          </h3>
          <div className={styles.pills}>
            <Pill tone="outline">{kindLabel(line.kind)}</Pill>
            {line.active ? <Pill tone="positive" dot>Active</Pill> : <Pill tone="warning" dot>Inactive</Pill>}
            {line.oracleLive === false ? (
              <Pill tone="danger" dot title="The BTC price feed is stale or invalid: the line refuses new allocation and new loans">
                Price feed stale · fail-closed
              </Pill>
            ) : line.oracleLive ? (
              <Pill tone="neutral" dot>Price feed live</Pill>
            ) : null}
            {line.paused ? <Pill tone="danger" dot>Paused for new loans</Pill> : null}
            {cap?.reached ? (
              <Pill tone="warning" dot title="The vault's cap for this line is full: votes cannot push more capital here">
                Cap reached
              </Pill>
            ) : null}
            {uncovered > 0n ? <Pill tone="danger" dot>Uncovered loss</Pill> : null}
          </div>
        </div>

        <div className={styles.block}>
          <div className={styles.blockHead}>
            <span className={styles.blockTitle}>Vote share</span>
          </div>
          <div className={styles.voteRow}>
            <span>This epoch</span>
            <Meter value={line.votes.currentShare} color={color} label={`${line.name} vote share this epoch`} valueText={formatPct(line.votes.currentShare)} size="sm" />
            <span className={styles.blockValue}>{formatPct(line.votes.currentShare)}</span>
          </div>
          <div className={styles.voteRow}>
            <span>Last closed</span>
            <Meter value={line.votes.lastClosedShare} color={color} label={`${line.name} vote share last closed epoch`} valueText={formatPct(line.votes.lastClosedShare)} size="sm" />
            <span className={styles.blockValue}>{formatPct(line.votes.lastClosedShare)}</span>
          </div>
        </div>

        <div className={styles.block}>
          <div className={styles.blockHead}>
            <span className={styles.blockTitle}>Lent from the vault</span>
            <span className={styles.blockValue}>
              {formatMusd(allocation, 0)} <Muted small>now</Muted> · {formatMusd(target, 0)} <Muted small>target</Muted>
            </span>
          </div>
          <Meter
            value={fraction(allocation, scale)}
            color={color}
            label={`${line.name} allocation`}
            valueText={`${formatMusd(allocation, 0)} MUSD now, target ${formatMusd(target, 0)} MUSD`}
            markers={allocationMarkers(target, cap, scale)}
          />
          <Muted small>
            {cap
              ? cap.reached
                ? `At its vault cap of ${formatMusd(cap.cap, 0)} MUSD: extra votes cannot send more here.`
                : `Vault cap ${formatMusd(cap.cap, 0)} MUSD · room for ${formatMusd(cap.room, 0)} more.`
              : "Cap not readable."}
            {failClosed ? " Held back from new allocation while the price feed is stale." : ""}
          </Muted>
        </div>

        <div className={styles.stats}>
          <Stat size="sm" label="Utilisation" value={formatPct(wadToFraction(line.utilizationWad))} />
          <Stat size="sm" label="Supply APY" tag="est." value={formatPct(line.supplyApy, 2)} />
          <Stat size="sm" label="Borrow APY" tag="est." value={formatPct(line.borrowApy, 2)} />
          <Stat size="sm" label="Incentives" value={formatMusd(line.incentives.assets, 0)} unit="MUSD" hint="this epoch" />
        </div>

        <div className={styles.cover}>
          <div className={styles.block}>
            <div className={styles.blockHead}>
              <span className={styles.blockTitle}>First-loss cover</span>
              <span className={styles.blockValue}>
                {formatMusd(coverCap, 0)} / {formatMusd(allocation, 0)} MUSD
              </span>
            </div>
            <Meter
              value={coverRatio}
              color={uncovered > 0n ? "var(--color-danger)" : color}
              label={`${line.name} first-loss cover against exposure`}
              valueText={`${formatPct(coverRatio)} of the MUSD lent here`}
              size="lg"
            />
            <p className={styles.coverText}>
              Voters&apos; seasoning rewards and the pool reserve can absorb {formatMusd(coverCap, 0)} MUSD of bad debt
              here before lenders lose anything ({formatPct(coverRatio)} of what is lent).
            </p>
          </div>
        </div>

        {uncovered > 0n ? (
          <div className={styles.loss} role="alert">
            <span className={styles.blockTitle}>Recorded loss not covered yet</span>
            <span className={styles.lossFigure}>{formatMusd(uncovered)} MUSD</span>
            <span className={styles.lossText}>
              Lenders carry this until someone runs cover. Recorded so far {formatMusd(line.lossRecorded)} MUSD, covered{" "}
              {formatMusd(line.lossCovered)} MUSD.
            </span>
            <div>
              <Button variant="danger" size="sm" onClick={() => tx.review(coverPlan())}>
                Cover now
              </Button>
            </div>
          </div>
        ) : (line.lossRecorded ?? 0n) > 0n ? (
          <Muted small>
            Past losses: {formatMusd(line.lossRecorded)} MUSD recorded, all covered by voters and the reserve.
          </Muted>
        ) : null}

        {pending > 0n ? (
          <Notice
            tone="warning"
            title={`${formatMusd(pending)} MUSD of loss not recorded yet`}
            action={
              <Button size="sm" variant="secondary" onClick={() => tx.review(checkpointPlan())}>
                Checkpoint
              </Button>
            }
          >
            The Morpho market socialised bad debt since the last checkpoint. Recording it lets cover pay it.
          </Notice>
        ) : null}

        <div className={styles.lineFoot}>
          <AppLink href="/app/vote">Vote for this line</AppLink>
          <AppLink href="/app/sponsor">Post an incentive</AppLink>
          {line.kind === "VeBTC" ? <AppLink href="/app/borrow">Borrow against veBTC</AppLink> : <AppLink href="/app/borrow?tab=btc">Borrow against BTC</AppLink>}
          {line.borrowRateSource === "derived" ? <Tag title="Morpho's live rate view was unavailable; derived from the stored rate at target">rate derived</Tag> : null}
        </div>
    </Card>
  );
}

export function BoardPage() {
  return <EnvGate>{(env) => <BoardView env={env} />}</EnvGate>;
}

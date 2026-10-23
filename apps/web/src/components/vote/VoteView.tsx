"use client";

import type { Ballot, Board, CohortPosition, VeBTCPosition } from "@surety/sdk";
import { useMemo, useState, type CSSProperties } from "react";

import { GATE_BLOCKED, GateNotice, isPaused } from "@/components/gate/DepositGate";
import { Grid, Split, Stack } from "@/components/layout/Layout";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { useTx, type TxPlan } from "@/components/tx/TxProvider";
import { Empty, LineName, Muted, Notice, PageHead, Pill, Skeleton, Stat } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChoiceList, DataTable, Slider, type Column } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatBtc, formatDate, formatDateTime, formatDuration, formatMusd, formatPct } from "@/lib/format";
import { lineColor } from "@/lib/lines";
import { useBallot, useBoard, useChainNow, useCohorts, usePositions, useSlashes } from "@/lib/queries";

import styles from "./Vote.module.css";

const WAD = 10n ** 18n;

export function VotePage() {
  return <EnvGate>{(env) => <VoteView env={env} />}</EnvGate>;
}

function VoteView({ env }: { env: ReadyEnv }) {
  const wallet = useWalletDialog();
  const board = useBoard();
  const positions = usePositions();
  const [picked, setSelected] = useState<string | null>(null);

  const list = positions.data ?? [];
  // Until the user picks, preselect the first NFT that can vote here.
  const selected = picked ?? (list.find((p) => !p.escrowed) ?? list[0])?.tokenId.toString() ?? null;
  const position = list.find((p) => p.tokenId.toString() === selected) ?? null;

  return (
    <Stack gap={6}>
      <PageHead
        title="Vote"
        lead="Point your veBTC at the credit lines you trust. Votes move the vault's MUSD at the next flip and earn you a share of the interest plus any sponsor incentives."
      />
      {!env.account ? (
        <Empty
          title="Connect a wallet to vote"
          action={<Button onClick={wallet.open}>Connect wallet</Button>}
        >
          Voting uses your veBTC NFTs on {env.chainName}. Nothing leaves your wallet: the vote is a signed transaction and
          the NFT stays yours.
        </Empty>
      ) : (
        <Split main="3fr" side="2fr" gap={5}>
          <Stack gap={5}>
            <Card title="Your veBTC" description="Voting power is the NFT's boosted power at the start of this epoch.">
              {positions.error ? (
                <ReadError what="your veBTC" error={positions.error} onRetry={() => void positions.refetch()} />
              ) : positions.isPending ? (
                <Stack gap={2}>
                  <Skeleton height={64} label="Loading your veBTC" />
                  <Skeleton height={64} />
                </Stack>
              ) : list.length === 0 ? (
                <Empty title="No veBTC in this wallet">
                  Lock BTC on Mezo to get a veBTC NFT, then come back: it can vote here from the next epoch.
                </Empty>
              ) : (
                <ChoiceList
                  name="vebtc"
                  label="Choose a veBTC NFT"
                  value={selected}
                  onChange={setSelected}
                  options={list.map((p) => ({ value: p.tokenId.toString(), content: <NftOption p={p} /> }))}
                />
              )}
            </Card>
            {position && board.data ? <BallotEditor env={env} board={board.data} position={position} /> : null}
          </Stack>
          <Stack gap={5}>
            <FirstLossCard season={board.data?.epoch.season} epochLength={board.data?.epoch.epochLength} />
            {position ? <StoredBallot env={env} position={position} board={board.data} /> : null}
          </Stack>
        </Split>
      )}
      {position && board.data ? <CohortsSection env={env} board={board.data} position={position} /> : null}
    </Stack>
  );
}

function NftOption({ p }: { p: VeBTCPosition }) {
  const now = useChainNow();
  const left = !p.lock.isPermanent && now !== null ? Number(p.lock.end) - now : null;
  return (
    <div>
      <div className={styles.nftTop}>
        <span className={styles.nftId}>veBTC #{p.tokenId.toString()}</span>
        <span style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {p.escrowed ? <Pill tone="warning">In loan #{p.loanId?.toString()}</Pill> : null}
          {p.lock.isPermanent ? <Pill tone="outline">Permanent lock</Pill> : null}
          {p.ballotEpoch > 0n ? <Pill tone="neutral">Has a Surety ballot</Pill> : null}
        </span>
      </div>
      <div className={styles.nftMeta}>
        <span>
          <span className="num">{formatBtc(p.lock.amount)}</span> BTC locked
        </span>
        <span>
          {p.lock.isPermanent
            ? "No unlock date"
            : `Unlocks ${formatDate(p.lock.end)}${left !== null ? ` (${left > 0 ? `in ${formatDuration(left)}` : "ended"})` : ""}`}
        </span>
        <span>
          Power at epoch start <span className="num">{formatBtc(p.powerAtEpochStart)}</span>
        </span>
      </div>
      {p.escrowed ? (
        <Muted small>Escrowed in a Surety loan: it keeps voting on Mezo through the escrow, but cannot vote on Surety lines.</Muted>
      ) : p.powerAtEpochStart === 0n ? (
        <Muted small>No power at this epoch&apos;s start: new or changed locks count from the next epoch.</Muted>
      ) : null}
    </div>
  );
}

function FirstLossCard({ season, epochLength }: { season: bigint | undefined; epochLength: bigint | undefined }) {
  const seasonText =
    season !== undefined && epochLength !== undefined
      ? `${season.toString()} epochs (${formatDuration(Number(season * epochLength))})`
      : "4 epochs";
  return (
    <Card tone="accent" eyebrow="First loss">
      <Stack gap={3}>
        <p className={styles.firstLoss}>
          Your rewards from a line season for {seasonText}; if that line takes bad debt meanwhile, they pay lenders back
          first.
        </p>
        <div className={styles.legend}>
          <span className={styles.legendRow}>
            <span className={styles.season} aria-hidden="true">
              <span className={styles.seasonTick} data-state="done" />
              <span className={styles.seasonTick} data-state="now" />
              <span className={styles.seasonTick} />
            </span>
            Seasoning: still first loss for its line
          </span>
          <span className={styles.legendRow}>
            <Pill tone="positive">Claimable</Pill> Matured: yours, no longer at risk
          </span>
          <span className={styles.legendRow}>
            <Pill tone="danger">At risk</Pill> Its line has a loss waiting for cover
          </span>
        </div>
        <Muted small>
          Timeline: votes cast in epoch t steer capital in t+1, the interest earned is booked at t+2, and the cohort
          matures {seasonText} after that.
        </Muted>
      </Stack>
    </Card>
  );
}

/* ---------- Ballot ---------- */

function evenSplit(lines: Board["lines"]): Record<number, number> {
  const next: Record<number, number> = {};
  for (const l of lines) next[l.id] = 0;
  const active = lines.filter((l) => l.active);
  active.forEach((l, k) => (next[l.id] = Math.floor(100 / active.length) + (k < 100 % active.length ? 1 : 0)));
  return next;
}

/** The stored ballot in whole percent, or an even split when there is none. */
function startingWeights(b: Ballot | undefined, lines: Board["lines"]): Record<number, number> {
  if (!b || b.lineIds.length === 0) return evenSplit(lines);
  const next: Record<number, number> = {};
  for (const l of lines) next[l.id] = 0;
  b.lineIds.forEach((id, k) => (next[id] = Math.round((b.weightsBps[k] ?? 0) / 100)));
  return next;
}

function BallotEditor({ env, board, position }: { env: ReadyEnv; board: Board; position: VeBTCPosition }) {
  const tx = useTx();
  const ballot = useBallot(position.tokenId);
  const lines = board.lines;
  // Edits belong to one NFT and stored ballot; a different NFT or a new ballot starts from the stored one again.
  const key = `${position.tokenId}:${ballot.data?.epochCast ?? "-"}`;
  const [edit, setEdit] = useState<{ key: string; weights: Record<number, number> } | null>(null);
  const weights = edit && edit.key === key ? edit.weights : startingWeights(ballot.data, lines);
  const setWeights = (next: Record<number, number> | ((w: Record<number, number>) => Record<number, number>)) =>
    setEdit({ key, weights: typeof next === "function" ? next(weights) : next });

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const power = ballot.data?.powerAtEpochStart ?? position.powerAtEpochStart;
  const chosen = lines.filter((l) => (weights[l.id] ?? 0) > 0);
  const disabledReason = position.escrowed
    ? "This veBTC is escrowed in a Surety loan, so it cannot vote on Surety lines."
    : power === 0n
      ? "This veBTC had no voting power at the start of this epoch. New or changed locks count from the next one."
      : null;

  const set = (id: number, v: number) => setWeights((w) => ({ ...w, [id]: Math.max(0, Math.min(100, Math.round(v))) }));
  const even = () => setWeights(evenSplit(lines));

  const plan = (): TxPlan => ({
    title: `Vote with veBTC #${position.tokenId}`,
    summary: `Counts ${formatBtc(power)} voting power in this epoch's tally. At the flip (${formatDateTime(board.epoch.nextFlip)}) the vault moves MUSD toward these shares.`,
    rows: [
      ...chosen.map((l) => ({
        label: l.name,
        value: `${weights[l.id]}% · ${formatBtc((power * BigInt(weights[l.id] ?? 0)) / 100n)} power`,
      })),
      { rule: true, label: "", value: "" },
      { label: "Your rewards season for", value: `${board.epoch.season} epochs` },
    ],
    notes: [
      "Your share of each line's interest and incentives seasons first; if a backed line takes bad debt before it matures, that share pays lenders back first.",
      "A later ballot in the same epoch replaces this one. The ballot is stored, so it can be recast into later epochs (poke) at the new power.",
    ],
    blocked: disabledReason ?? (total !== 100 ? "Your allocation must add up to exactly 100%." : undefined),
    steps: [
      {
        label: "Cast the ballot",
        detail: "CreditVoter.vote(tokenId, lineIds, weightsBps)",
        tx: env.client.buildVote({
          tokenId: position.tokenId,
          lineIds: chosen.map((l) => l.id),
          weightsBps: chosen.map((l) => (weights[l.id] ?? 0) * 100),
        }),
      },
    ],
    confirmLabel: "Vote",
  });

  return (
    <Card
      title={`Allocate veBTC #${position.tokenId}`}
      description="Split your vote across lines. The vault lends in proportion to all votes, inside each line's cap."
      actions={
        <Button size="sm" variant="secondary" onClick={even}>
          Split evenly
        </Button>
      }
    >
      {disabledReason ? (
        <Notice tone="warning">{disabledReason}</Notice>
      ) : null}
      <div>
        {lines.map((l) => {
          const w = weights[l.id] ?? 0;
          return (
            <div key={l.id} className={styles.ballotRow}>
              <div>
                <LineName id={l.id} name={l.name} />
                <div className={styles.lineSub}>
                  {l.active ? `${formatPct(l.votes.currentShare)} of votes now` : "Inactive: cannot take votes"}
                </div>
              </div>
              <Slider
                value={w}
                onChange={(v) => set(l.id, v)}
                label={`${l.name} share of your vote`}
                valueText={`${w}%`}
                color={lineColor(l.id)}
                disabled={!l.active || !!disabledReason}
              />
              <label className={styles.pctInput}>
                <span className="sr-only">{l.name} percent</span>
                <input
                  inputMode="numeric"
                  value={String(w)}
                  disabled={!l.active || !!disabledReason}
                  onChange={(e) => set(l.id, Number(e.target.value.replace(/\D/g, "") || 0))}
                />
                %
              </label>
            </div>
          );
        })}
      </div>
      <div className={styles.total}>
        <span>
          Total{" "}
          <span className={`${styles.totalFigure} ${total === 100 ? styles.totalOk : styles.totalBad}`}>{total}%</span>
          {total !== 100 ? <Muted small> · must be exactly 100%</Muted> : null}
        </span>
        <Button disabled={total !== 100 || !!disabledReason || chosen.length === 0} onClick={() => tx.review(plan())}>
          Review vote
        </Button>
      </div>
    </Card>
  );
}

function StoredBallot({ env, position, board }: { env: ReadyEnv; position: VeBTCPosition; board: Board | undefined }) {
  const tx = useTx();
  const ballot = useBallot(position.tokenId);
  const b = ballot.data;
  const name = (id: number) => board?.lines.find((l) => l.id === id)?.name ?? `Line ${id}`;
  if (ballot.error) return <ReadError what="the stored ballot" error={ballot.error} onRetry={() => void ballot.refetch()} />;
  if (!b) return <Skeleton height={160} label="Loading the stored ballot" />;
  const poke = (): TxPlan => ({
    title: `Recast ballot of veBTC #${position.tokenId}`,
    summary: `Re-casts the stored ballot into this epoch at today's power (${formatBtc(b.powerAtEpochStart)}). Anyone can do this for any NFT; the keeper pokes every ballot at the flip.`,
    rows: b.lineIds.map((id, k) => ({ label: name(id), value: `${((b.weightsBps[k] ?? 0) / 100).toFixed(0)}%` })),
    steps: [{ label: "Poke", detail: "CreditVoter.poke(tokenId)", tx: env.client.buildPoke({ tokenId: position.tokenId }) }],
    confirmLabel: "Poke",
  });
  return (
    <Card title="Stored ballot" headingLevel={2}>
      {b.lineIds.length === 0 ? (
        <Muted small>No ballot stored for this NFT yet. Your first vote is stored and can be recast later.</Muted>
      ) : (
        <Stack gap={3}>
          <Stack gap={2}>
            {b.lineIds.map((id, k) => (
              <div key={id} style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
                <LineName id={id} name={name(id)} />
                <span className="num">{((b.weightsBps[k] ?? 0) / 100).toFixed(0)}%</span>
              </div>
            ))}
          </Stack>
          {b.castThisEpoch ? (
            <Notice tone="positive">Counts in this epoch&apos;s tally with {formatBtc(b.powerAtEpochStart)} power.</Notice>
          ) : (
            <Notice
              tone="warning"
              title="Not counted this epoch yet"
              action={
                b.pokeable ? (
                  <Button size="sm" onClick={() => tx.review(poke())}>
                    Poke
                  </Button>
                ) : undefined
              }
            >
              Last cast in the epoch from {formatDateTime(b.epochCast)}. Poke recasts it now at today&apos;s power.
            </Notice>
          )}
        </Stack>
      )}
    </Card>
  );
}

/* ---------- Cohorts ---------- */

interface CohortRow extends CohortPosition {
  lineName: string;
  slashedAssets: bigint;
}

function SeasonTicks({ c, board, now }: { c: CohortPosition; board: Board; now: number | null }) {
  const len = board.epoch.epochLength;
  const total = Number((c.maturity - c.epoch) / len);
  const passed = now === null ? 0 : Math.floor((now - Number(c.epoch)) / Number(len));
  const left = now === null ? null : Number(c.maturity) - now;
  return (
    <div className={styles.seasonCell}>
      <span
        className={styles.season}
        role="img"
        aria-label={`${Math.min(passed, total)} of ${total} epochs passed`}
        style={{ "--tick": lineColor(c.lineId) } as CSSProperties}
      >
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={styles.seasonTick} data-state={i < passed ? "done" : i === passed ? "now" : undefined} />
        ))}
      </span>
      <Muted small>
        {left === null
          ? "—"
          : left > 0
            ? `${Math.ceil(left / Number(len))} epochs left · matures ${formatDateTime(c.maturity)}`
            : `Matured ${formatDateTime(c.maturity)}`}
      </Muted>
    </div>
  );
}

function CohortsSection({ env, board, position }: { env: ReadyEnv; board: Board; position: VeBTCPosition }) {
  const tx = useTx();
  const cohorts = useCohorts(position.tokenId);
  const slashes = useSlashes();
  const now = useChainNow();

  const rows: CohortRow[] = useMemo(() => {
    const list = cohorts.data?.cohorts ?? [];
    return list.map((c) => {
      const slashedShares = slashes.data?.[`${c.lineId}:${c.epoch}`] ?? 0n;
      const mine = c.lineVotes === 0n ? 0n : (slashedShares * c.votes) / c.lineVotes;
      return {
        ...c,
        lineName: board.lines.find((l) => l.id === c.lineId)?.name ?? `Line ${c.lineId}`,
        slashedAssets: (mine * board.vault.sharePrice) / WAD,
      };
    });
  }, [cohorts.data, slashes.data, board]);

  const claimPlan = (list: CohortRow[]): TxPlan => ({
    title: list.length === 1 ? "Claim matured rewards" : `Claim ${list.length} matured cohorts`,
    summary:
      "Pays your share of each matured cohort in srMUSD (vault shares that keep earning) to the NFT's owner. Matured rewards are no longer first loss.",
    rows: [
      ...list.map((c) => ({ label: `${c.lineName} · ${formatDateTime(c.epoch)}`, value: `${formatMusd(c.assets)} MUSD` })),
      { rule: true, label: "", value: "" },
      { label: "Total", value: `${formatMusd(list.reduce((a, c) => a + c.assets, 0n))} MUSD` },
    ],
    steps: list.map((c) => ({
      label: `Claim ${c.lineName}, epoch ${formatDateTime(c.epoch)}`,
      detail: "SuretyPool.claim(tokenId, lineId, epoch)",
      tx: env.client.buildClaim({ tokenId: position.tokenId, lineId: c.lineId, epoch: c.epoch }),
    })),
    blocked: isPaused(board) ? GATE_BLOCKED.claim : undefined,
    confirmLabel: "Claim",
  });

  const claimable = rows.filter((r) => r.status === "claimable");
  // Claims pay srMUSD, which the DepositGate holds back while a loss or its cover is pending.
  const gated = isPaused(board);
  const columns: Column<CohortRow>[] = [
    { key: "line", header: "Line", cell: (r) => <LineName id={r.lineId} name={r.lineName} /> },
    { key: "epoch", header: "Voted in epoch", cell: (r) => <span className="num">{formatDateTime(r.epoch)}</span> },
    { key: "value", header: "Your share", align: "end", cell: (r) => <span className="num">{formatMusd(r.assets)} MUSD</span> },
    { key: "season", header: "Seasoning", cell: (r) => <SeasonTicks c={r} board={board} now={now} /> },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Stack gap={1}>
          <span>
            {r.status === "claimable" ? (
              <Pill tone="positive">Claimable</Pill>
            ) : r.status === "maturing" ? (
              <Pill tone="neutral">Seasoning · first loss</Pill>
            ) : r.status === "at-risk" ? (
              <Pill tone="danger">At risk: line has a loss</Pill>
            ) : r.status === "claimed" ? (
              <Pill tone="outline">Claimed</Pill>
            ) : (
              <Pill tone="outline">Nothing to claim</Pill>
            )}
          </span>
          {r.slashedAssets > 0n ? (
            <span className={styles.slashed}>−{formatMusd(r.slashedAssets)} MUSD slashed to cover a loss</span>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "action",
      header: "",
      align: "end",
      cell: (r) =>
        r.status === "claimable" ? (
          <Button size="sm" disabled={gated} title={gated ? GATE_BLOCKED.claim : undefined} onClick={() => tx.review(claimPlan([r]))}>
            {gated ? "Waits" : "Claim"}
          </Button>
        ) : null,
    },
  ];

  return (
    <Card
      flat
      title={`Rewards of veBTC #${position.tokenId}`}
      description="One cohort per line and epoch you voted in: your share of that line's voter fees and incentives."
      actions={
        claimable.length > 1 && !gated ? (
          <Button size="sm" onClick={() => tx.review(claimPlan(claimable))}>
            Claim all ({claimable.length})
          </Button>
        ) : undefined
      }
    >
      {gated ? (
        <div style={{ padding: "0 var(--space-5) var(--space-4)" }}>
          <GateNotice board={board} context="claim" />
        </div>
      ) : null}
      {cohorts.data ? (
        <Grid min="160px" gap={4} className="">
          <div style={{ padding: "0 var(--space-5)" }}>
            <Stat label="Claimable now" value={formatMusd(cohorts.data.totals.claimableAssets)} unit="MUSD" tone="positive" />
          </div>
          <div style={{ padding: "0 var(--space-5)" }}>
            <Stat label="Seasoning (first loss)" value={formatMusd(cohorts.data.totals.maturingAssets)} unit="MUSD" />
          </div>
          <div style={{ padding: "0 var(--space-5)" }}>
            <Stat
              label="Of which at risk"
              value={formatMusd(cohorts.data.totals.atRiskAssets)}
              unit="MUSD"
              tone={cohorts.data.totals.atRiskAssets > 0n ? "danger" : undefined}
            />
          </div>
        </Grid>
      ) : null}
      <div style={{ marginTop: "var(--space-4)" }}>
        {cohorts.error ? (
          <div style={{ padding: "var(--space-5)" }}>
            <ReadError what="your reward cohorts" error={cohorts.error} onRetry={() => void cohorts.refetch()} />
          </div>
        ) : cohorts.isPending ? (
          <div style={{ padding: "var(--space-5)" }}>
            <Skeleton height={120} label="Loading cohorts" />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "var(--space-5)" }}>
            <Muted small>No cohorts yet. Vote, and your share of each backed line&apos;s rewards shows up here.</Muted>
          </div>
        ) : (
          <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.lineId}:${r.epoch}`} caption="Reward cohorts" />
        )}
      </div>
    </Card>
  );
}

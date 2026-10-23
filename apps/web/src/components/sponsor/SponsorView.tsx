"use client";

import type { Board } from "@surety/sdk";
import { useState } from "react";

import { Split, Stack } from "@/components/layout/Layout";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { FactList, LineName, Muted, PageHead, Pill, Skeleton } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, ChoiceList, DataTable, type Column } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatDateTime, formatDuration, formatMusd, formatPct, parseAmount, toInput } from "@/lib/format";
import { useBoard, useIncentives, useWallet } from "@/lib/queries";
import { readAllowance, type IncentiveRow } from "@/lib/reads";

export function SponsorPage() {
  return <EnvGate>{(env) => <SponsorView env={env} />}</EnvGate>;
}

function SponsorView({ env }: { env: ReadyEnv }) {
  const board = useBoard();
  return (
    <Stack gap={6}>
      <PageHead
        title="Sponsor"
        lead="Post MUSD to reward this epoch's voters of a line, to pull votes (and capital) toward it. The incentive joins that line's first-loss cohort and pays out to its voters when it matures."
      />
      {board.error ? <ReadError what="the lines" error={board.error} onRetry={() => void board.refetch()} /> : null}
      {board.data ? (
        <>
          <Split main="3fr" side="2fr" gap={5}>
            <PostIncentive env={env} board={board.data} />
            <HowIncentives board={board.data} />
          </Split>
          <IncentivesTable env={env} board={board.data} />
        </>
      ) : (
        <Skeleton height={360} label="Loading" />
      )}
    </Stack>
  );
}

function PostIncentive({ env, board }: { env: ReadyEnv; board: Board }) {
  const tx = useTx();
  const wallet = useWallet();
  const dialog = useWalletDialog();
  const active = board.lines.filter((l) => l.active);
  const [picked, setLineId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const lineId = picked ?? active[0]?.id.toString() ?? null;
  const line = board.lines.find((l) => l.id.toString() === lineId);
  const amount = parseAmount(input);
  const musd = wallet.data?.musd;
  const error =
    input && amount === null
      ? "Enter a number."
      : musd !== undefined && amount !== null && amount > musd
        ? `Your wallet holds ${formatMusd(musd)} MUSD.`
        : null;

  const plan = async (): Promise<TxPlan> => {
    const a = amount!;
    const pool = env.deployment.contracts.suretyPool;
    const allowance = await readAllowance(env.client, env.deployment.external.musd, env.account!, pool);
    const steps: TxStep[] = [];
    if (allowance < a) {
      steps.push({
        label: `Allow the pool to take ${formatMusd(a)} MUSD`,
        detail: "MUSD.approve(pool, amount)",
        tx: env.client.buildApprove({ token: env.deployment.external.musd, spender: pool, amount: a }),
      });
    }
    steps.push({
      label: `Post ${formatMusd(a)} MUSD to ${line!.name}`,
      detail: "SuretyPool.postIncentive(lineId, assets)",
      tx: env.client.buildPostIncentive({ lineId: line!.id, assets: a }),
    });
    return {
      title: "Post an incentive",
      summary: `${formatMusd(a)} MUSD goes to whoever votes for ${line!.name} in this epoch, pro rata to their votes.`,
      rows: [
        { label: "Line", value: line!.name },
        { label: "Epoch", value: `${formatDateTime(board.epoch.currentEpoch)} → ${formatDateTime(board.epoch.nextFlip)}` },
        { label: "Already posted this epoch", value: `${formatMusd(line!.incentives.assets)} MUSD` },
        { label: "Votes for the line so far", value: formatPct(line!.votes.currentShare) },
      ],
      notes: [
        "It is deposited into the vault as srMUSD, so it earns while it seasons.",
        `It is first loss for the line like the voters' fees, and matures ${board.epoch.season.toString()} epochs after the cohort's interest is booked.`,
        "If the line draws no votes this epoch, you can refund it once the epoch ends.",
      ],
      blocked: !line!.active ? "This line is not active, so it cannot take incentives." : undefined,
      steps,
      confirmLabel: steps.length > 1 ? "Approve and post" : "Post incentive",
    };
  };

  return (
    <Card title="Post an incentive" description={`For the epoch ending ${formatDateTime(board.epoch.nextFlip)}.`}>
      <Stack gap={4}>
        <ChoiceList
          name="sponsor-line"
          label="Line to sponsor"
          value={lineId}
          onChange={setLineId}
          options={board.lines.map((l) => ({
            value: l.id.toString(),
            disabled: !l.active,
            content: (
              <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
                <LineName id={l.id} name={l.name} />
                <Muted small>
                  {formatPct(l.votes.currentShare)} of votes · {formatMusd(l.incentives.assets, 0)} MUSD posted
                  {l.active ? "" : " · inactive"}
                </Muted>
              </div>
            ),
          }))}
        />
        <AmountField
          label="Incentive"
          unit="MUSD"
          value={input}
          onChange={setInput}
          aside={musd !== undefined ? `Wallet: ${formatMusd(musd)} MUSD` : undefined}
          onMax={musd ? () => setInput(toInput(musd, 18, 2)) : undefined}
          error={error}
        />
        {env.account ? (
          <Button block disabled={!line || !amount || !!error} onClick={() => tx.review(plan)}>
            Review incentive
          </Button>
        ) : (
          <Button block onClick={dialog.open}>
            Connect wallet
          </Button>
        )}
      </Stack>
    </Card>
  );
}

function HowIncentives({ board }: { board: Board }) {
  const left = Number(board.epoch.secondsToFlip);
  return (
    <Card tone="accent" eyebrow="How it works" title="Pay for votes, carry the first loss with them">
      <FactList
        items={[
          <>Your MUSD rewards the voters of one line for the current epoch ({formatDuration(left)} left).</>,
          <>Votes steer the vault&apos;s capital at the next flip, so incentives are how a line attracts lending.</>,
          <>Until it matures the incentive sits in the line&apos;s cohort and is slashed first if the line takes bad debt.</>,
          <>No votes, no payout: refund it after the epoch ends.</>,
        ]}
      />
    </Card>
  );
}

type Status = "open" | "voters" | "refundable" | "unbacked";

function statusOf(r: IncentiveRow): Status {
  if (!r.ended) return "open";
  if (r.lineVotes > 0n) return "voters";
  return r.mineShares > 0n ? "refundable" : "unbacked";
}

function IncentivesTable({ env, board }: { env: ReadyEnv; board: Board }) {
  const tx = useTx();
  const incentives = useIncentives({
    lineIds: board.lines.map((l) => l.id),
    currentEpoch: board.epoch.currentEpoch,
    epochLength: board.epoch.epochLength,
  });
  const name = (id: number) => board.lines.find((l) => l.id === id)?.name ?? `Line ${id}`;

  const refund = (r: IncentiveRow): TxPlan => ({
    title: "Refund an incentive",
    summary: `${name(r.lineId)} drew no votes in the epoch from ${formatDateTime(r.epoch)}, so your incentive comes back to you as srMUSD.`,
    rows: [{ label: "You get back (about)", value: `${formatMusd(r.mineAssets)} MUSD in srMUSD` }],
    notes: ["If a loss was covered while the epoch was open, the refund is what is left of your part."],
    steps: [
      {
        label: "Refund",
        detail: "SuretyPool.refundIncentive(lineId, epoch)",
        tx: env.client.buildRefundIncentive({ lineId: r.lineId, epoch: r.epoch }),
      },
    ],
    confirmLabel: "Refund",
  });

  const columns: Column<IncentiveRow>[] = [
    { key: "line", header: "Line", cell: (r) => <LineName id={r.lineId} name={name(r.lineId)} /> },
    { key: "epoch", header: "Epoch", cell: (r) => <span className="num">{formatDateTime(r.epoch)}</span> },
    { key: "total", header: "Posted", align: "end", cell: (r) => <span className="num">{formatMusd(r.totalAssets)} MUSD</span> },
    {
      key: "votes",
      header: "Line got votes",
      cell: (r) => (r.lineVotes > 0n ? "Yes" : r.ended ? "None" : "Not yet"),
    },
    {
      key: "mine",
      header: "Yours",
      align: "end",
      cell: (r) => <span className="num">{r.mineShares > 0n ? `${formatMusd(r.mineAssets)} MUSD` : "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const s = statusOf(r);
        return s === "open" ? (
          <Pill tone="neutral">Open this epoch</Pill>
        ) : s === "voters" ? (
          <Pill tone="positive">Goes to voters</Pill>
        ) : s === "refundable" ? (
          <Pill tone="warning">No votes: refundable</Pill>
        ) : (
          <Pill tone="outline">No votes</Pill>
        );
      },
    },
    {
      key: "action",
      header: "",
      align: "end",
      cell: (r) =>
        statusOf(r) === "refundable" ? (
          <Button size="sm" onClick={() => tx.review(refund(r))}>
            Refund
          </Button>
        ) : null,
    },
  ];

  return (
    <Card flat title="Incentives" description="Every incentive posted in the last 8 epochs, per line.">
      <div style={{ marginTop: "var(--space-2)" }}>
        {incentives.error ? (
          <div style={{ padding: "var(--space-5)" }}>
            <ReadError what="incentives" error={incentives.error} onRetry={() => void incentives.refetch()} />
          </div>
        ) : !incentives.data ? (
          <div style={{ padding: "var(--space-5)" }}>
            <Skeleton height={100} label="Loading incentives" />
          </div>
        ) : incentives.data.length === 0 ? (
          <div style={{ padding: "0 var(--space-5) var(--space-5)" }}>
            <Muted small>No incentives in the last 8 epochs. Be the first: post one above.</Muted>
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={incentives.data}
            rowKey={(r) => `${r.lineId}:${r.epoch}`}
            caption="Incentives by line and epoch"
          />
        )}
      </div>
    </Card>
  );
}

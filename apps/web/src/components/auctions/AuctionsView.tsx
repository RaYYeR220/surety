"use client";

import { auctionPrice, type AuctionView } from "@surety/sdk";
import { useState } from "react";

import { Stack } from "@/components/layout/Layout";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { Empty, KeyValues, Muted, Notice, PageHead, Pill, SectionTitle, Skeleton } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, DataTable, type Column } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import {
  formatBps,
  formatBtc,
  formatCountdown,
  formatDate,
  formatDuration,
  formatMusd,
  parseAmount,
  toInput,
} from "@/lib/format";
import { useAuctions, useBoard, useChainNow, useLineParams, useLiquidatable, useWallet } from "@/lib/queries";
import { readAllowance } from "@/lib/reads";

import styles from "./Auctions.module.css";

const BPS = 10_000n;

export function AuctionsPage() {
  return <EnvGate>{(env) => <AuctionsView env={env} />}</EnvGate>;
}

function AuctionsView({ env }: { env: ReadyEnv }) {
  const auctions = useAuctions();
  const board = useBoard();
  const params = useLineParams();
  const fee = params.data ? params.data.liqFeeBps : null;
  return (
    <Stack gap={6}>
      <PageHead
        title="Auctions"
        lead="When a veBTC loan reaches its liquidation line or its lock ends, anyone can auction the NFT. The price starts at the collateral's full value and falls in a straight line to a floor; the first bid at the live price wins the veBTC."
      />
      {auctions.error ? (
        <ReadError what="auctions" error={auctions.error} onRetry={() => void auctions.refetch()} />
      ) : auctions.isPending ? (
        <Skeleton height={360} label="Loading auctions" />
      ) : auctions.data.length === 0 ? (
        <Empty title="No auctions running">
          Loans that cross their liquidation line or reach their lock end can be auctioned; they show up below first.
        </Empty>
      ) : (
        auctions.data.map((a) => <AuctionCard key={a.loanId.toString()} env={env} a={a} fee={fee} />)
      )}
      <Liquidatable env={env} />
      {board.data && board.data.lines.some((l) => l.kind === "VeBTC" && l.oracleLive === false) ? (
        <Notice tone="danger" title="Price feed stale" role="alert">
          While the BTC price is stale the line refuses to start auctions and to take bids. Repaying a loan always works.
        </Notice>
      ) : null}
    </Stack>
  );
}

/* ---------- Curve ---------- */

const W = 640;
const H = 260;
const PAD = { l: 64, r: 16, t: 20, b: 36 };

function AuctionCurve({ a, now }: { a: AuctionView; now: number | null }) {
  if (a.collateralValue === null || a.auctionStart === null || a.auctionEndsAt === null || a.floorPrice === null) {
    return <Muted small>The price curve needs a live BTC price; the feed is stale right now.</Muted>;
  }
  const start = Number(a.auctionStart);
  const end = Number(a.auctionEndsAt);
  const duration = end - start;
  const tail = duration * 0.15;
  const value = Number(a.collateralValue) / 1e18;
  const floor = Number(a.floorPrice) / 1e18;
  const debt = Number(a.debt) / 1e18;
  const yMax = Math.max(value, debt) * 1.04;
  const yMin = Math.min(floor, debt) * 0.9;
  const x = (t: number) => PAD.l + ((t - start) / (duration + tail)) * (W - PAD.l - PAD.r);
  const y = (p: number) => PAD.t + (1 - (p - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const t = now === null ? start : Math.min(Math.max(now, start), end + tail);
  const elapsed = BigInt(Math.max(0, Math.floor(t - start)));
  const floorBps = (a.floorPrice * BPS) / a.collateralValue;
  const live = Number(auctionPrice(a.collateralValue, elapsed, BigInt(duration), floorBps)) / 1e18;
  // Where the falling price crosses the debt (shortfall starts), if it does.
  const crossT = debt < value && debt > floor ? start + ((value - debt) / (value - floor)) * duration : null;
  const curve = `M ${x(start)} ${y(value)} L ${x(end)} ${y(floor)} L ${x(end + tail)} ${y(floor)}`;
  const area = `${curve} L ${x(end + tail)} ${y(yMin)} L ${x(start)} ${y(yMin)} Z`;
  const past = `M ${x(start)} ${y(value)} L ${x(Math.min(t, end))} ${y(t >= end ? floor : live)}${t > end ? ` L ${x(t)} ${y(floor)}` : ""}`;
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Auction price falls from ${fmt(value)} to ${fmt(floor)} MUSD over ${formatDuration(duration)}; now ${fmt(live)} MUSD; debt ${fmt(debt)} MUSD.`}
    >
      <path className={styles.area} d={area} />
      {crossT !== null ? (
        <path
          className={styles.shortfall}
          d={`M ${x(crossT)} ${y(debt)} L ${x(end)} ${y(floor)} L ${x(end + tail)} ${y(floor)} L ${x(end + tail)} ${y(debt)} Z`}
        />
      ) : null}
      {[value, floor].map((v) => (
        <g key={v}>
          <line className={styles.grid} x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
          <text className={styles.label} x={PAD.l - 8} y={y(v) + 4} textAnchor="end">
            {fmt(v)}
          </text>
        </g>
      ))}
      <line className={styles.axis} x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} />
      <line className={styles.debt} x1={PAD.l} x2={W - PAD.r} y1={y(debt)} y2={y(debt)} />
      <text className={styles.labelDanger} x={W - PAD.r} y={y(debt) - 6} textAnchor="end">
        debt {fmt(debt)}: a bid below it is bad debt
      </text>
      <path className={styles.curve} d={curve} />
      <path className={styles.curvePast} d={past} />
      <text className={styles.label} x={x(start)} y={H - PAD.b + 18} textAnchor="start">
        start · 100%
      </text>
      <text className={styles.label} x={x(end)} y={H - PAD.b + 18} textAnchor="middle">
        floor · {formatBps(floorBps, 0)}
      </text>
      <line className={styles.nowLine} x1={x(t)} x2={x(t)} y1={PAD.t} y2={H - PAD.b} />
      <circle className={styles.nowDot} cx={x(t)} cy={y(t >= end ? floor : live)} r={7} />
      <text
        className={styles.labelStrong}
        x={x(t) + (x(t) > W * 0.7 ? -10 : 10)}
        y={PAD.t + 12}
        textAnchor={x(t) > W * 0.7 ? "end" : "start"}
      >
        now {fmt(t >= end ? floor : live)}
      </text>
    </svg>
  );
}

/* ---------- Auction card ---------- */

function AuctionCard({ env, a, fee }: { env: ReadyEnv; a: AuctionView; fee: number | null }) {
  const tx = useTx();
  const wallet = useWallet();
  const now = useChainNow();
  const [input, setInput] = useState("");

  const start = a.auctionStart === null ? null : Number(a.auctionStart);
  const end = a.auctionEndsAt === null ? null : Number(a.auctionEndsAt);
  const priceNow =
    a.collateralValue !== null && a.floorPrice !== null && start !== null && end !== null && now !== null
      ? auctionPrice(
          a.collateralValue,
          BigInt(Math.max(0, Math.floor(now - start))),
          BigInt(end - start),
          (a.floorPrice * BPS) / a.collateralValue,
        )
      : a.auctionPrice;
  const left = end === null || now === null ? null : end - now;
  const maxPrice = parseAmount(input);
  const suggested = priceNow === null ? null : (priceNow * 1005n) / 1000n;
  const musd = wallet.data?.musd;
  const error =
    input && maxPrice === null
      ? "Enter a number."
      : maxPrice !== null && priceNow !== null && maxPrice < priceNow
        ? "Below the live price: the bid would be refused. The price keeps falling, so you can wait."
        : maxPrice !== null && musd !== undefined && maxPrice > musd
          ? `Your wallet holds ${formatMusd(musd)} MUSD.`
          : null;
  const shortfall = priceNow !== null && priceNow < a.debt ? a.debt - priceNow : 0n;

  const plan = async (): Promise<TxPlan> => {
    const m = maxPrice!;
    const line = env.deployment.contracts.veBTCLine;
    const steps: TxStep[] = [];
    if (env.account) {
      const allowance = await readAllowance(env.client, env.deployment.external.musd, env.account, line);
      if (allowance < m) {
        steps.push({
          label: `Allow the line to take up to ${formatMusd(m)} MUSD`,
          detail: "MUSD.approve(line, maxPrice)",
          tx: env.client.buildApprove({ token: env.deployment.external.musd, spender: line, amount: m }),
        });
      }
    }
    steps.push({
      label: `Bid on loan #${a.loanId} (max ${formatMusd(m)} MUSD)`,
      detail: "VeBTCCreditLine.bid(loanId, maxPrice)",
      tx: env.client.buildBid({ loanId: a.loanId, maxPrice: m }),
    });
    return {
      title: `Buy veBTC #${a.tokenId}`,
      summary: `You pay the live auction price at the moment your bid lands, never more than ${formatMusd(m)} MUSD, and receive veBTC #${a.tokenId}.`,
      rows: [
        { label: "Live price now", value: `${formatMusd(priceNow)} MUSD` },
        { label: "Your max", value: `${formatMusd(m)} MUSD` },
        { label: "You receive", value: `veBTC #${a.tokenId}: ${formatBtc(a.lock.amount)} BTC locked` },
        { label: "Lock", value: a.lock.isPermanent ? "Permanent" : `Until ${formatDate(a.lock.end)}` },
      ],
      notes: [
        fee === null
          ? "The line keeps the debt plus its liquidation fee; anything above goes to the borrower."
          : `The line keeps the debt plus a ${formatBps(fee, 0)} liquidation fee; anything above goes to the borrower.`,
        "A price below the debt is recorded as bad debt, which cover takes from the line's voters first.",
      ],
      blocked: priceNow === null ? "The BTC price feed is stale, so bids are refused until it updates." : undefined,
      steps,
      confirmLabel: "Bid",
    };
  };

  return (
    <Card tone="strong" label={`Auction of loan ${a.loanId}`}>
      <div className={styles.head}>
        <span className={styles.title}>
          Loan #{a.loanId.toString()} · veBTC #{a.tokenId.toString()}
        </span>
        <span style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <Pill tone="danger" dot>
            Dutch auction
          </Pill>
          {left !== null && left <= 0 ? <Pill tone="warning">At the floor</Pill> : null}
          {shortfall > 0n ? <Pill tone="danger-soft">Below debt</Pill> : null}
        </span>
      </div>
      <div className={styles.auction}>
        <AuctionCurve a={a} now={now} />
        <div className={styles.side}>
          <div>
            <Muted small>Live price</Muted>
            <div className={styles.price}>{formatMusd(priceNow)}</div>
            <Muted small>
              MUSD ·{" "}
              {left === null ? "—" : left > 0 ? `${formatCountdown(left)} to the floor` : "price stays at the floor"}
            </Muted>
          </div>
          <KeyValues
            label="Auction"
            items={[
              { label: "Collateral", value: `${formatBtc(a.lock.amount)} BTC` },
              { label: "Collateral value", value: `${formatMusd(a.collateralValue, 0)} MUSD` },
              { label: "Floor", value: `${formatMusd(a.floorPrice, 0)} MUSD` },
              { label: "Debt", value: `${formatMusd(a.debt, 0)} MUSD` },
              shortfall > 0n && { label: "Shortfall at this price", value: `${formatMusd(shortfall, 0)} MUSD` },
            ]}
          />
          <AmountField
            label="Your max price"
            unit="MUSD"
            value={input}
            onChange={setInput}
            onMax={suggested ? () => setInput(toInput(suggested, 18, 2)) : undefined}
            maxLabel="Live +0.5%"
            error={error}
            help="Protects you if the price moves before your bid lands. You pay the live price."
          />
          <Button block disabled={!maxPrice || !!error} onClick={() => tx.review(plan)}>
            Review bid
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ---------- Loans that can be auctioned ---------- */

function Liquidatable({ env }: { env: ReadyEnv }) {
  const tx = useTx();
  const list = useLiquidatable();
  const start = (l: AuctionView): TxPlan => ({
    title: `Start the auction of loan #${l.loanId}`,
    summary: `Puts veBTC #${l.tokenId} up for a Dutch auction from its full value down to the floor. Anyone can do this once a loan is past its line.`,
    rows: [
      { label: "Why", value: l.liquidationReason === "expiry" ? "Lock ended" : `LTV ${formatBps(l.ltvBps)} ≥ ${formatBps(l.liqLtvBps, 0)}` },
      { label: "Debt", value: `${formatMusd(l.debt)} MUSD` },
    ],
    steps: [{ label: "Start auction", detail: "VeBTCCreditLine.startAuction(loanId)", tx: env.client.buildStartAuction({ loanId: l.loanId }) }],
    confirmLabel: "Start auction",
  });
  const columns: Column<AuctionView>[] = [
    { key: "loan", header: "Loan", cell: (l) => `#${l.loanId} · veBTC #${l.tokenId}` },
    { key: "debt", header: "Debt", align: "end", cell: (l) => <span className="num">{formatMusd(l.debt)} MUSD</span> },
    { key: "ltv", header: "LTV", align: "end", cell: (l) => <span className="num">{formatBps(l.ltvBps)}</span> },
    { key: "why", header: "Reason", cell: (l) => (l.liquidationReason === "expiry" ? "Lock ended" : `Past ${formatBps(l.liqLtvBps, 0)} LTV`) },
    {
      key: "go",
      header: "",
      align: "end",
      cell: (l) => (
        <Button size="sm" variant="danger" onClick={() => tx.review(start(l))}>
          Start auction
        </Button>
      ),
    },
  ];
  return (
    <Stack gap={4}>
      <SectionTitle>Ready to auction</SectionTitle>
      {list.error ? (
        <ReadError what="loans" error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Skeleton height={80} label="Loading loans" />
      ) : list.data.length === 0 ? (
        <Muted small>No loan is past its line right now: every active loan is under its liquidation LTV and inside its lock.</Muted>
      ) : (
        <Card flat>
          <DataTable columns={columns} rows={list.data} rowKey={(l) => l.loanId.toString()} caption="Loans that can be auctioned" />
        </Card>
      )}
    </Stack>
  );
}

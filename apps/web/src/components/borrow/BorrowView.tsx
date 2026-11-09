"use client";

import type { Board, BorrowIneligibility, VeBTCPosition } from "@surety/sdk";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Split, Stack } from "@/components/layout/Layout";
import { PegBadge } from "@/components/peg/PegBadge";
import { AppLink } from "@/components/shell/AppLink";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { useTx, type TxPlan } from "@/components/tx/TxProvider";
import { Empty, FactList, KeyValues, Muted, Notice, PageHead, Pill, Skeleton } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, ChoiceList, TabPanel, Tabs } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import {
  formatBps,
  formatBtc,
  formatDate,
  formatDuration,
  formatMusd,
  formatPct,
  formatUsdWad,
  parseAmount,
  toInput,
} from "@/lib/format";
import { isV2, useBoard, useChainNow, useLineParams, usePeg, usePositions, useQuote } from "@/lib/queries";

import styles from "./Borrow.module.css";
import { HealthBar } from "./HealthBar";
import { Loans } from "./Loans";
import { MorphoPanel } from "./MorphoPanel";

type Tab = "vebtc" | "btc";

export function BorrowPage() {
  return <EnvGate>{(env) => <BorrowView env={env} />}</EnvGate>;
}

function BorrowView({ env }: { env: ReadyEnv }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: Tab = params.get("tab") === "btc" ? "btc" : "vebtc";
  const board = useBoard();
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params.toString());
    if (t === "btc") next.set("tab", "btc");
    else next.delete("tab");
    const q = next.toString();
    router.replace(`${pathname}${q ? `?${q}` : ""}`, { scroll: false });
  };

  return (
    <Stack gap={6}>
      <PageHead
        title="Borrow"
        lead="Borrow MUSD against your veBTC without unlocking it, or against BTC in a Morpho market. No redemptions: your position only changes when you change it, or if it crosses its liquidation line."
        actions={<PegBadge />}
      />
      <Tabs
        idPrefix="borrow"
        label="Borrow against"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "vebtc", label: "Against veBTC" },
          { id: "btc", label: "Against BTC (Morpho)" },
        ]}
      />
      {board.error ? <ReadError what="the lines" error={board.error} onRetry={() => void board.refetch()} /> : null}
      <TabPanel idPrefix="borrow" id={tab}>
        {tab === "vebtc" ? (
          <Stack gap={6}>
            <Split main="3fr" side="2fr" gap={5}>
              {board.data ? <OpenLoan env={env} /> : <Skeleton height={420} label="Loading" />}
              <HowItWorks env={env} board={board.data} />
            </Split>
            <Loans env={env} board={board.data} />
          </Stack>
        ) : board.data ? (
          <MorphoPanel env={env} board={board.data} />
        ) : (
          <Skeleton height={420} label="Loading" />
        )}
      </TabPanel>
    </Stack>
  );
}

const REASONS: Record<BorrowIneligibility, string> = {
  "not-normal": "Only regular veBTC locks can be borrowed against (not managed or locked-escrow NFTs).",
  "grant-lock": "This is a vesting grant lock, which cannot be collateral.",
  "no-lock": "This NFT has no BTC locked.",
  "term-too-short": "The lock ends too soon. Extend it on Mezo first, then come back.",
  escrowed: "This NFT is already in a Surety loan.",
  "oracle-unavailable": "The BTC price feed is stale, so the line refuses new loans until it updates (fail-closed).",
  "no-liquidity": "The line has no MUSD free to lend right now. It refills at the next rebalance if votes send it more.",
  "line-paused": "The line is paused for new loans. Repaying existing loans still works.",
  "above-max": "That is more than this veBTC can borrow now. Lower the amount.",
  "peg-unhealthy":
    "MUSD is off its peg (or its price sources disagree), so the line takes no new loans until it recovers. Repaying, auctions and withdrawals still work.",
};

function OpenLoan({ env }: { env: ReadyEnv }) {
  const tx = useTx();
  const wallet = useWalletDialog();
  const positions = usePositions();
  const [picked, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const free = (positions.data ?? []).filter((p) => !p.escrowed);
  // Until the user picks, preselect the NFT that can borrow the most.
  const best = [...free].sort((a, b) => Number((b.maxBorrow ?? 0n) - (a.maxBorrow ?? 0n)))[0];
  const selected = picked ?? best?.tokenId.toString() ?? null;

  const position = free.find((p) => p.tokenId.toString() === selected) ?? null;
  const amount = parseAmount(input);
  const quote = useQuote(position?.tokenId ?? null, amount !== null && amount > 0n ? amount : null);
  const q = quote.data && position && quote.data.tokenId === position.tokenId ? quote.data : null;
  const params = useLineParams().data;
  const v2 = isV2(env);
  const feeLabel = formatBps(params?.originationFeeBps ?? 0, 2);
  // On v2 the line values BTC in MUSD (BTC/USD over the MUSD peg); v1 took MUSD as $1.
  const priceIn = (wad: bigint | null) => (wad === null ? "—" : v2 ? `${formatUsdWad(wad)} MUSD` : `$${formatUsdWad(wad)}`);

  if (!env.account) {
    return (
      <Empty title="Connect a wallet to borrow" action={<Button onClick={wallet.open}>Connect wallet</Button>}>
        You will pick one of your veBTC NFTs, see exactly what it can borrow, and review the loan before anything is
        sent.
      </Empty>
    );
  }

  const plan = (): TxPlan => {
    const a = amount!;
    const [approve, open] = env.client.buildOpenLoan({ tokenId: position!.tokenId, amount: a });
    const fee = q!.originationFee;
    return {
      title: `Borrow against veBTC #${position!.tokenId}`,
      summary:
        fee > 0n
          ? `You receive ${formatMusd(q!.receives)} MUSD and your debt is ${formatMusd(a)} MUSD. veBTC #${position!.tokenId} moves into its own loan escrow, where it keeps voting and earning until you repay.`
          : `You borrow ${formatMusd(a)} MUSD. veBTC #${position!.tokenId} moves into its own loan escrow, where it keeps voting and earning until you repay.`,
      rows: [
        { label: "You receive", value: `${formatMusd(q!.receives)} MUSD` },
        fee > 0n && { label: `Origination fee (${feeLabel})`, value: `${formatMusd(fee)} MUSD to the treasury` },
        { label: "Your debt", value: `${formatMusd(a)} MUSD, plus interest` },
        { label: "Collateral", value: `${formatBtc(q!.lock.amount)} BTC · ${formatMusd(q!.collateralValue)} MUSD` },
        { label: "Loan-to-value", value: `${formatBps(q!.ltvBps)} (max ${formatBps(q!.maxLtvBps, 0)})` },
        { label: "Auction starts at", value: `${formatBps(q!.liqLtvBps, 0)} LTV · BTC at ${priceIn(q!.liquidationPriceWad)}` },
        { label: "Borrow rate", value: `${formatPct(q!.borrowAprAfter, 2)} APR (${formatPct(q!.borrowApyAfter, 2)} APY)` },
        {
          label: "Repay by",
          value: q!.maturity === null ? "No date (permanent lock)" : `${formatDate(q!.maturity)} (lock end)`,
        },
      ],
      notes: [
        "Repay any time, in part or in full. Full repayment returns the NFT to you.",
        `Repay or extend the lock before it ends; after the lock end, or at ${formatBps(q!.liqLtvBps, 0)} LTV, anyone can start a Dutch auction of the NFT.`,
        v2
          ? "The price feed must be fresh and MUSD on its peg to open a loan; repaying never needs either."
          : "The price feed must be fresh to open a loan; repaying never needs it.",
      ],
      steps: [
        { label: `Approve veBTC #${position!.tokenId} for the line`, detail: "veBTC.approve(line, tokenId): this one NFT only", tx: approve! },
        { label: `Open the loan for ${formatMusd(a)} MUSD`, detail: "VeBTCCreditLine.open(tokenId, amount)", tx: open! },
      ],
      confirmLabel: "Approve and borrow",
    };
  };

  const blocked = q && !q.eligible;
  return (
    <Card title="Borrow against veBTC" description="Pick an NFT, choose an amount, check the quote.">
      <Stack gap={5}>
        {positions.error ? (
          <ReadError what="your veBTC" error={positions.error} onRetry={() => void positions.refetch()} />
        ) : positions.isPending ? (
          <Skeleton height={120} label="Loading your veBTC" />
        ) : free.length === 0 ? (
          <Muted small>No free veBTC in this wallet. NFTs already in a loan are listed under Your loans.</Muted>
        ) : (
          <ChoiceList
            name="borrow-nft"
            label="veBTC to borrow against"
            value={selected}
            onChange={(v) => {
              setSelected(v);
              setInput("");
            }}
            options={free.map((p) => ({ value: p.tokenId.toString(), content: <NftLine p={p} /> }))}
          />
        )}
        {position ? (
          <>
            <AmountField
              label="Borrow"
              unit="MUSD"
              value={input}
              onChange={setInput}
              aside={q ? `Up to ${formatMusd(q.maxBorrow)} MUSD` : undefined}
              onMax={q ? () => setInput(toInput(q.maxBorrow, 18, 2)) : undefined}
              error={input && amount === null ? "Enter a number, like 500." : null}
              help="Leave empty to see the maximum."
            />
            {quote.error ? <ReadError what="the quote" error={quote.error} onRetry={() => void quote.refetch()} /> : null}
            {q ? (
              <div className={styles.quote}>
                {q.amount > 0n ? (
                  <p className={styles.receive}>
                    You receive <strong className="num">{formatMusd(q.receives)} MUSD</strong>, your debt is{" "}
                    <strong className="num">{formatMusd(q.amount)} MUSD</strong>
                    {q.originationFee > 0n ? (
                      <Muted small>
                        {" "}
                        · {feeLabel} origination fee, {formatMusd(q.originationFee)} MUSD, goes to the treasury
                      </Muted>
                    ) : null}
                  </p>
                ) : null}
                <KeyValues
                  label="Quote"
                  items={[
                    { label: "Collateral", value: `${formatBtc(q.lock.amount)} BTC` },
                    {
                      label: v2 ? "BTC price in MUSD (oracle)" : "BTC price (oracle)",
                      value: q.priceWad === null ? "stale" : priceIn(q.priceWad),
                    },
                    { label: "Collateral value", value: `${formatMusd(q.collateralValue)} MUSD` },
                    { label: "Max loan-to-value", value: formatBps(q.maxLtvBps, 0) },
                    { label: "Most you can borrow now", value: `${formatMusd(q.maxBorrow)} MUSD` },
                    { rule: true, label: "", value: "" },
                    { label: "This loan (your debt)", value: `${formatMusd(q.amount)} MUSD` },
                    q.originationFee > 0n && {
                      label: `Origination fee (${feeLabel})`,
                      value: `${formatMusd(q.originationFee)} MUSD`,
                    },
                    { label: "You receive", value: `${formatMusd(q.receives)} MUSD` },
                    {
                      label: `Auction line (${formatBps(q.liqLtvBps, 0)} LTV)`,
                      value: q.liquidationPriceWad === null ? "—" : `BTC at ${priceIn(q.liquidationPriceWad)}`,
                    },
                    {
                      label: "Rate",
                      value: `${formatPct(q.borrowAprNow, 2)} → ${formatPct(q.borrowAprAfter, 2)} APR`,
                    },
                    {
                      label: "Maturity",
                      value: q.maturity === null ? "None (permanent lock)" : `${formatDate(q.maturity)} (lock end)`,
                    },
                    { label: "Line has free", value: `${formatMusd(q.lineCash)} MUSD` },
                  ]}
                />
                {params && q.ltvBps !== null && q.amount > 0n ? (
                  <div className={styles.quoteBar}>
                    <HealthBar
                      label="This loan's loan-to-value"
                      ltvBps={Number(q.ltvBps)}
                      lines={{ maxLtvBps: Number(q.maxLtvBps), liqLtvBps: params.liqLtvBps, floorBps: params.floorBps }}
                      compact
                    />
                  </div>
                ) : null}
              </div>
            ) : quote.isPending ? (
              <Skeleton height={220} label="Quoting" />
            ) : null}
            {blocked ? (
              <Notice tone="danger" title="This loan would be refused now" role="alert">
                <ul className={styles.reasons}>
                  {q.reasons.map((r) => (
                    <li key={r}>
                      {REASONS[r]}
                      {r === "peg-unhealthy" ? (
                        <>
                          {" "}
                          <AppLink href="/app/peg">See the peg</AppLink>
                        </>
                      ) : null}
                    </li>
                  ))}
                  {q.reasons.length === 0 && q.amount === 0n ? <li>Enter an amount above zero.</li> : null}
                </ul>
              </Notice>
            ) : null}
            <Button
              block
              disabled={!q || !q.eligible || amount === null || amount === 0n}
              onClick={() => tx.review(plan())}
            >
              Review loan
            </Button>
          </>
        ) : null}
      </Stack>
    </Card>
  );
}

function NftLine({ p }: { p: VeBTCPosition }) {
  const now = useChainNow();
  const left = !p.lock.isPermanent && now !== null ? Number(p.lock.end) - now : null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
      <span>
        <strong>veBTC #{p.tokenId.toString()}</strong>{" "}
        <Muted small>
          · <span className="num">{formatBtc(p.lock.amount)}</span> BTC ·{" "}
          {p.lock.isPermanent ? "permanent" : `unlocks ${formatDate(p.lock.end)}${left !== null ? ` (${formatDuration(Math.max(0, left))})` : ""}`}
        </Muted>
      </span>
      <span>
        {p.maxBorrow === null ? (
          <Pill tone="danger-soft">Price stale</Pill>
        ) : p.maxBorrow === 0n ? (
          <Pill tone="outline">Not eligible</Pill>
        ) : (
          <Pill tone="neutral">
            up to <span className="num">{formatMusd(p.maxBorrow, 0)}</span> MUSD
          </Pill>
        )}
      </span>
    </div>
  );
}

function HowItWorks({ env, board }: { env: ReadyEnv; board: Board | undefined }) {
  const line = board?.lines.find((l) => l.kind === "VeBTC");
  const p = useLineParams().data;
  const v2 = isV2(env);
  const peg = usePeg();
  const musd = v2 ? (
    <>
      MUSD is priced from Mezo&apos;s pools, never above $1 for your collateral; <AppLink href="/app/peg">see the peg</AppLink>.
    </>
  ) : (
    <>MUSD is valued at $1.</>
  );
  return (
    <Card tone="accent" eyebrow="While it is borrowed" title="Your veBTC keeps working">
      <FactList
        items={[
          <>It moves into its own escrow contract, one per loan. No pooled custody, no generic calls.</>,
          <>It keeps its boost, keeps voting on Mezo (you steer it from here) and keeps earning fees, bribes and rebase.</>,
          ...(v2
            ? [<>Turn on auto-repay and those fees and bribes pay the loan down: anyone can harvest them into repayment.</>]
            : []),
          p ? (
            <>
              Max loan-to-value {formatBps(p.maxLtvTimedBps, 0)} for timed locks, {formatBps(p.maxLtvPermanentBps, 0)} for
              permanent ones. {musd}
            </>
          ) : (
            <>Loan-to-value is capped lower for permanent locks than for timed ones. {musd}</>
          ),
          p ? (
            <>
              The loan matures at the lock end: repay or extend before it. At {formatBps(p.liqLtvBps, 0)} LTV, or after
              maturity, anyone can start a Dutch auction from 100% down to {formatBps(p.floorBps, 0)} of the collateral
              value over {formatDuration(p.auctionDuration)}; any surplus comes back to you.
            </>
          ) : (
            <>The loan matures at the lock end: repay or extend before it, or the NFT can be auctioned.</>
          ),
          ...(p && p.originationFeeBps > 0
            ? [
                <>
                  A one-off {formatBps(p.originationFeeBps, 2)} origination fee comes out of what you borrow and goes to the
                  treasury. <AppLink href="/app/business">Where fees go</AppLink>
                </>,
              ]
            : []),
          <>No redemptions: nobody can repay your loan with your collateral while it is healthy.</>,
        ]}
      />
      {line ? (
        <div style={{ marginTop: "var(--space-4)", display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {line.oracleLive === false ? <Pill tone="danger" dot>Price feed stale: new loans refused</Pill> : null}
          {peg.data && !peg.data.healthyOnChain ? <Pill tone="danger" dot>MUSD off peg: new loans refused</Pill> : null}
          {line.paused ? <Pill tone="danger" dot>Line paused</Pill> : null}
          <Pill tone="outline">Borrow APY {formatPct(line.borrowApy, 2)} est.</Pill>
        </div>
      ) : null}
    </Card>
  );
}

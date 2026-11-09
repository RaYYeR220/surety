"use client";

import { getDeployment, isV2Deployment, MEZO_MAINNET_ID, type FeeSchedule } from "@surety/sdk";
import type { ReactNode } from "react";

import { V2Notice } from "@/components/gate/V2Notice";
import { Split, Stack } from "@/components/layout/Layout";
import { AppLink } from "@/components/shell/AppLink";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { FactList, KeyValues, Muted, Notice, PageHead, Skeleton, Stat, Tag } from "@/components/ui/Bits";
import { Card } from "@/components/ui/Card";
import { DataTable, ExplorerLink, type Column } from "@/components/ui/Controls";
import {
  ASSUMPTIONS,
  breakEvenTvl,
  COSTS,
  DESIGNED_RATES,
  liquidationSplitShares,
  yearlyRevenue,
  type FeeRates,
  type YearlyRevenue,
} from "@/lib/economics";
import type { ReadyEnv } from "@/lib/env";
import { formatBps, formatBtc, formatMusd, formatMusdNumber, formatPct, wadToFraction } from "@/lib/format";
import { repoFile, REPO_DOCS } from "@/lib/proof";
import { isV2, useFees, useTreasury } from "@/lib/queries";

import styles from "./Business.module.css";

/** The mainnet cap on each line while the contracts are new, MUSD. */
const STATED_MAINNET_LINE_CAP = 2_000;
const MAINNET_LINES = 2;

export function BusinessPage() {
  return <EnvGate>{(env) => <BusinessView env={env} />}</EnvGate>;
}

/** The live fee schedule as model rates; the designed v2 schedule when there is none to read. */
function ratesFrom(fees: FeeSchedule | undefined): { rates: FeeRates; live: boolean } {
  if (!fees) return { rates: DESIGNED_RATES, live: false };
  return {
    live: true,
    rates: {
      originationBps: fees.line.originationFeeBps,
      liqFeeBps: fees.line.liqFeeBps,
      protocolShareBps: fees.line.protocolShareBps,
      keeperShareBps: fees.line.keeperShareBps,
      // Not wadToFraction: its six-decimal cut would turn 0.20% (a per-second rate times a year) into 0.1999%.
      managementApr: Number(fees.managementFeeAprWad) / 1e18,
      marketFeeBps: fees.shareMarketFeeBps ?? DESIGNED_RATES.marketFeeBps,
    },
  };
}

/** Each mainnet line's cap: from the v2 mainnet deployment once it is published, else the stated cap. */
function mainnetLineCap(): number {
  const d = getDeployment(MEZO_MAINNET_ID);
  if (d && isV2Deployment(d)) return Number(d.caps.line / 10n ** 18n);
  return STATED_MAINNET_LINE_CAP;
}

function BusinessView({ env }: { env: ReadyEnv }) {
  const v2 = isV2(env);
  const fees = useFees();
  const { rates, live } = ratesFrom(fees.data);
  const capTvl = mainnetLineCap() * MAINNET_LINES;
  return (
    <Stack gap={6}>
      <PageHead
        title="Who pays whom"
        lead="Where every fee comes from, where it goes and what it pays for, and what it adds up to. In short: borrowers pay lenders, lenders pay voters for standing first in line, and small fees fund the keeper, operations and audits. At today's caps those fees are tiny."
      />
      {!v2 ? (
        <V2Notice what="The fee schedule and the treasury">
          {`${env.chainName} still runs Surety's first deployment, which charges only the voters' fee. The figures below use the v2 schedule as designed; they read from chain once the v2 deployment is published.`}
        </V2Notice>
      ) : fees.error ? (
        <ReadError what="the fee schedule" error={fees.error} onRetry={() => void fees.refetch()} />
      ) : null}
      <Streams rates={rates} live={live} fees={fees.data} />
      <Split main="1fr" side="1fr" gap={5}>
        <Treasury env={env} fees={fees.data} pending={v2 && fees.isPending} />
        <Funds rates={rates} />
      </Split>
      <Economics rates={rates} live={live} capTvl={capTvl} />
      <Team />
    </Stack>
  );
}

/* ---------- Fee streams ---------- */

interface Stream {
  key: string;
  name: string;
  payer: ReactNode;
  rate: ReactNode;
  to: ReactNode;
  funds: ReactNode;
}

function Streams({ rates, live, fees }: { rates: FeeRates; live: boolean; fees: FeeSchedule | undefined }) {
  const split = liquidationSplitShares(rates);
  const perf = fees ? wadToFraction(fees.performanceFee) : 0.1;
  const rows: Stream[] = [
    {
      key: "interest",
      name: "Interest",
      payer: "Borrowers, on both lines",
      rate: "Set by each line's rate curve",
      to: "Lenders, through the srMUSD share price",
      funds: "The lenders' yield",
    },
    {
      key: "voters",
      name: "Voters' fee",
      payer: "Lenders, out of interest",
      rate: `${formatPct(perf, 0)} of interest`,
      to: "veBTC voters, as seasoning rewards in the SuretyPool",
      funds: "First-loss capital: slashed first if the line they back goes bad",
    },
    {
      key: "origination",
      name: "Origination fee",
      payer: "veBTC borrowers, once per amount borrowed",
      rate: formatBps(rates.originationBps, 2),
      to: "Treasury",
      funds: "Operations and security reviews",
    },
    {
      key: "liquidation",
      name: "Liquidation fee",
      payer: "A defaulted borrower, out of the auction proceeds",
      rate: `${formatBps(rates.liqFeeBps, 0)} of the debt`,
      to: (
        <>
          {formatPct(split.lenders, 0)} lenders · {formatPct(split.treasury, 0)} treasury · {formatPct(split.keeper, 0)} the
          keeper that started the auction
        </>
      ),
      funds: "Lenders first; the keeper's gas; reviews",
    },
    {
      key: "management",
      name: "Management fee",
      payer: "Lenders, as a slightly slower share price",
      rate: `${formatPct(rates.managementApr, 2)} of vault assets a year`,
      to: "Treasury, as srMUSD",
      funds: "Operations and security reviews",
    },
    {
      key: "market",
      name: "Share market fee",
      payer: "Lenders who sell srMUSD on the share market",
      rate: `${formatBps(rates.marketFeeBps, 2)} of each fill`,
      to: "Treasury",
      funds: "Operations",
    },
    {
      key: "incentives",
      name: "Sponsor incentives",
      payer: "Anyone who wants credit to go to a line",
      rate: "Whatever they post",
      to: "That line's voters, as rewards",
      funds: "Votes for the line; refunded if it draws none",
    },
  ];
  const columns: Column<Stream>[] = [
    { key: "name", header: "Stream", cell: (s) => <span className={styles.stream}>{s.name}</span> },
    { key: "payer", header: "Who pays", cell: (s) => s.payer },
    { key: "rate", header: "How much", cell: (s) => s.rate },
    { key: "to", header: "Who receives", cell: (s) => s.to },
    { key: "funds", header: "What it pays for", cell: (s) => s.funds },
  ];
  return (
    <Card
      flat
      title="Fee streams"
      description={
        live
          ? "Rates read from the contracts now."
          : "Rates as the v2 contracts are configured; they read from chain once v2 is live here."
      }
    >
      <DataTable columns={columns} rows={rows} rowKey={(s) => s.key} caption="Who pays whom" />
    </Card>
  );
}

/* ---------- Treasury ---------- */

function Treasury({ env, fees, pending }: { env: ReadyEnv; fees: FeeSchedule | undefined; pending: boolean }) {
  const address = fees?.treasury ?? env.deployment.contracts.treasury ?? null;
  const treasury = useTreasury(isV2(env) ? address : null);
  const t = treasury.data;
  return (
    <Card title="Treasury, live" description="One address receives every protocol fee.">
      {!isV2(env) ? (
        <Muted small>This deployment has no treasury: it charges no protocol fee.</Muted>
      ) : pending ? (
        <Skeleton height={140} label="Reading the treasury" />
      ) : !address ? (
        <Muted small>The deployment names no treasury.</Muted>
      ) : treasury.error ? (
        <ReadError what="the treasury" error={treasury.error} onRetry={() => void treasury.refetch()} />
      ) : !t ? (
        <Skeleton height={140} label="Reading the treasury" />
      ) : (
        <Stack gap={4}>
          <div className={styles.treasury}>
            <Stat label="MUSD" value={formatMusd(t.musd)} hint="Origination, liquidation and share market fees" />
            <Stat
              label="srMUSD"
              value={formatMusd(t.shares)}
              hint={`Worth ${formatMusd(t.sharesValue)} MUSD · management fee`}
            />
            <Stat label="BTC" value={formatBtc(t.btc)} hint="Gas" />
          </div>
          <KeyValues
            label="Treasury"
            items={[
              { label: "Address", value: <ExplorerLink kind="address" value={address} /> },
              { label: "Held in total", value: `${formatMusd(t.musd + t.sharesValue)} MUSD` },
              { label: "Controlled by", value: "The deployer's key today; a multisig is next" },
            ]}
          />
        </Stack>
      )}
    </Card>
  );
}

function Funds({ rates }: { rates: FeeRates }) {
  const split = liquidationSplitShares(rates);
  return (
    <Card title="What the fees pay for" description="In this order.">
      <FactList
        items={[
          <>
            <strong>The keeper.</strong> It rebalances at every epoch flip, records and covers losses, harvests
            auto-repay loans and starts auctions. Mezo gas is paid in BTC and is cheap; the{" "}
            {formatPct(split.keeper, 0)} keeper share of each liquidation fee goes to whoever starts the auction, so
            anyone can run one.
          </>,
          <>
            <strong>Operations.</strong> Hosting and RPC. On free tiers today; a paid endpoint is about{" "}
            {formatMusdNumber(COSTS.ops)} MUSD a year.
          </>,
          <>
            <strong>Security reviews.</strong> One independent review per major version, about{" "}
            {formatMusdNumber(COSTS.audits)} MUSD each. The reviews so far are in{" "}
            <a href={repoFile(REPO_DOCS.security)} target="_blank" rel="noopener noreferrer">
              {REPO_DOCS.security}
            </a>
            .
          </>,
        ]}
      />
    </Card>
  );
}

/* ---------- Unit economics ---------- */

interface Row {
  key: string;
  label: ReactNode;
  pick: (r: YearlyRevenue) => number;
  strong?: boolean;
  negative?: boolean;
}

function Economics({ rates, live, capTvl }: { rates: FeeRates; live: boolean; capTvl: number }) {
  const sizes = [
    { key: "caps", label: `At the caps (${formatMusdNumber(capTvl)} MUSD)`, tvl: capTvl },
    { key: "1m", label: "At $1M", tvl: 1_000_000 },
    { key: "10m", label: "At $10M", tvl: 10_000_000 },
  ];
  const results = sizes.map((s) => yearlyRevenue(s.tvl, rates));
  const costs = COSTS.ops + COSTS.audits;
  const rows: Row[] = [
    { key: "debt", label: "veBTC debt outstanding", pick: (r) => r.debt },
    { key: "mgmt", label: `Management fee (${formatPct(rates.managementApr, 2)})`, pick: (r) => r.management },
    { key: "orig", label: `Origination fees (${formatBps(rates.originationBps, 2)})`, pick: (r) => r.origination },
    { key: "liq", label: "Liquidation fees, treasury part", pick: (r) => r.liquidationToTreasury },
    { key: "mkt", label: `Share market fees (${formatBps(rates.marketFeeBps, 2)})`, pick: (r) => r.market },
    { key: "total", label: "Treasury income", pick: (r) => r.treasury, strong: true },
    { key: "keeper", label: "Keeper share of liquidation fees", pick: (r) => r.liquidationToKeeper },
    { key: "costs", label: "Running costs (ops and one review)", pick: () => costs, negative: true },
    { key: "net", label: "Left over", pick: (r) => r.treasury - costs, strong: true },
  ];
  const breakEven = breakEvenTvl(rates);
  return (
    <Card
      title="Unit economics"
      description="A year of protocol income at three sizes, from the fee rates above and the assumptions below. Interest is not in it: it belongs to lenders and voters."
      actions={live ? undefined : <Tag title="The v2 schedule as configured, not read from chain">as designed</Tag>}
    >
      <Stack gap={5}>
        <Notice tone="warning" title="At today's caps the protocol earns almost nothing">
          With {formatMusdNumber(capTvl / MAINNET_LINES)} MUSD a line on mainnet, the treasury takes in about{" "}
          {formatMusdNumber(results[0]!.treasury)} MUSD a year. That pays for nothing; the caps are there to limit what
          can go wrong while the contracts are new, not to earn. The fees only cover a yearly review and operations
          from about {formatMusdNumber(Math.round(breakEven / 100_000) / 10)}M MUSD in the vault.
        </Notice>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Yearly protocol income by vault size, MUSD</caption>
            <thead>
              <tr>
                <th scope="col">MUSD a year</th>
                {sizes.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} data-strong={row.strong || undefined}>
                  <th scope="row">{row.label}</th>
                  {results.map((r, i) => {
                    const v = row.pick(r);
                    return (
                      <td key={sizes[i]!.key} className="num" data-negative={(row.negative || v < 0) || undefined}>
                        {row.negative ? "−" : v < 0 ? "−" : ""}
                        {formatMusdNumber(Math.abs(v))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className={styles.listHead}>Assumptions</p>
          <FactList
            items={[
              <>The caps column is two lines of {formatMusdNumber(capTvl / MAINNET_LINES)} MUSD each, fully allocated.</>,
              <>
                {formatPct(ASSUMPTIONS.veBtcShare, 0)} of the vault sits in the veBTC line, {formatPct(ASSUMPTIONS.utilization, 0)}{" "}
                of it borrowed.
              </>,
              <>
                Each MUSD of veBTC debt is borrowed anew {ASSUMPTIONS.turnover} times a year (veBTC locks run up to four
                weeks; extending a lock pays no fee).
              </>,
              <>{formatPct(ASSUMPTIONS.auctionedShare, 0)} of that debt ends in an auction each year, paying the full liquidation fee.</>,
              <>{formatPct(ASSUMPTIONS.marketVolumeShare, 0)} of the vault changes hands on the share market each year.</>,
              <>
                Costs: {formatMusdNumber(COSTS.ops)} MUSD a year of operations and one {formatMusdNumber(COSTS.audits)} MUSD
                review. Estimates, not quotes. 1 MUSD ≈ $1.
              </>,
            ]}
          />
        </div>
        <Muted small>
          The same figures, with the reasoning, are in{" "}
          <a href={repoFile(REPO_DOCS.business)} target="_blank" rel="noopener noreferrer">
            {REPO_DOCS.business}
          </a>
          . Fee rates are live on the <AppLink href="/app/lend">Lend</AppLink>, <AppLink href="/app/borrow">Borrow</AppLink>{" "}
          and <AppLink href="/app/auctions">Auctions</AppLink> pages.
        </Muted>
      </Stack>
    </Card>
  );
}

/* ---------- The team ---------- */

function Team() {
  return (
    <Card tone="accent" eyebrow="Plainly" title="Who pays the team">
      <FactList
        items={[
          <>Nobody, yet. The team builds Surety on its own time; no fee goes to it today.</>,
          <>
            The treasury pays running costs first: the keeper&apos;s gas, operations, then security reviews. Only income
            above those would pay the team, and at the caps there is none.
          </>,
          <>
            Growth comes from raising the caps as the contracts prove themselves, and from veBTC holders voting for the
            lines and bringing sponsors to them. Sponsor incentives reward voters directly; they are not protocol income.
          </>,
        ]}
      />
    </Card>
  );
}
